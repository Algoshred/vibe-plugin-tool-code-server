/**
 * @burdenoff/vibe-plugin-code-server v1.0.0
 *
 * Browser-based VS Code via code-server — reverse-proxied through the
 * VibeControls agent. Manages code-server lifecycle (install, start, stop)
 * and proxies all traffic at /code-server/* with session cookie auth.
 *
 * Registers:
 *   - Elysia routes: /api/code-server/*  (REST API)
 *   - Proxy routes:  /code-server/*      (reverse proxy to code-server)
 *   - CLI command:   vibe code-server {status,install,start,stop}
 *
 * Install: vibe plugin install @burdenoff/vibe-plugin-code-server
 */

import type { Elysia } from "elysia";
import type { Command } from "commander";
import type { HostServices, VibePlugin } from "./types.js";
import { getRunningPort, stopCodeServer } from "./lib/process.js";
import {
  runMultimode,
  pickOutputMode,
  maybePrintJson,
  type OutputFlags,
} from "./utils/multimode.js";
import { interactiveDetail } from "./utils/interactive.js";

// ---------------------------------------------------------------------------
// JSON shaping helpers
// ---------------------------------------------------------------------------

const SECRET_RX = /(token|secret|password|apikey|api_key)/i;

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_RX.test(k) ? "[redacted]" : redact(v);
  }
  return out;
}

// Re-export types for external consumers
export type {
  VibePlugin,
  HostServices,
  StorageProvider,
  EventBus,
  ServiceRegistry,
  CodeServerConfig,
  CodeServerStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

const AGENT_BASE_URL = process.env.VIBE_AGENT_URL ?? "http://localhost:3005";
const API_KEY = process.env.VIBE_AGENT_API_KEY ?? "";

async function apiFetch(
  urlPath: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${AGENT_BASE_URL}${urlPath}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-agent-api-key": API_KEY,
      ...options?.headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Captured API key (set during onServerStart for proxy auth validation)
// ---------------------------------------------------------------------------

let agentApiKey: string | null = null;

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const vibePlugin: VibePlugin = {
  capabilities: {
    storage: "rw",
    subprocess: true,
    audit: true,
    telemetry: true,
  },
  name: "code-server",
  version: "1.0.0",
  description:
    "Browser-based VS Code via code-server — reverse-proxied through the agent",
  tags: ["backend", "cli"],
  cliCommand: "code-server",
  apiPrefix: "/api/code-server",
  publicPaths: ["/code-server/"],

  async onServerStart(app: Elysia, hostServices: HostServices) {
    hostServices?.telemetry?.emit("tool.ready", { provider: "code-server" });
    // Register REST API routes
    const { createCodeServerRoutes } = await import("./routes.js");
    app.use(createCodeServerRoutes(hostServices));

    // Capture the API key from the app's decorator for proxy auth
    // The auth plugin decorates the app with `apiKey`
    try {
      const decorated = app as unknown as { decorator: { apiKey?: string } };
      agentApiKey = decorated.decorator?.apiKey ?? null;
    } catch {
      // Fallback: use env var
      agentApiKey = process.env.AGENT_API_KEY ?? null;
    }

    // Mount reverse proxy at /code-server/*
    const { createCodeServerProxy } = await import("./lib/proxy.js");
    app.use(
      createCodeServerProxy(
        () => getRunningPort(),
        (key: string) => {
          if (!agentApiKey) return false;
          return key === agentApiKey;
        },
      ),
    );

    console.log(
      "  Plugin 'code-server' registered routes: /api/code-server, /code-server",
    );
  },

  async onServerStop() {
    await stopCodeServer();
    console.log("  Plugin 'code-server' stopped");
  },

  onCliSetup(program: Command) {
    const cs = program
      .command("code-server")
      .description("Browser-based VS Code via code-server");

    // vibe code-server status
    cs.command("status")
      .description("Show code-server status")
      .option("--json", "Emit JSON")
      .option("--plain", "Force plain text output")
      .action(async (opts: OutputFlags) => {
        await runMultimode<unknown>({
          mode: pickOutputMode(opts),
          fetchData: async () => {
            const res = await apiFetch("/api/code-server/status");
            return await res.json();
          },
          plain: (data) => {
            console.log(JSON.stringify(data, null, 2));
          },
          interactive: async (data) => {
            await interactiveDetail({
              title: "code-server — status",
              body: JSON.stringify(data, null, 2),
            });
          },
          json: (data) => redact(data),
        });
      });

    // vibe code-server install
    cs.command("install")
      .description("Install code-server on this machine")
      .option("--json", "Emit JSON")
      .action(async (opts: OutputFlags) => {
        if (!opts.json) console.log("Installing code-server...");
        const res = await apiFetch("/api/code-server/install", {
          method: "POST",
        });
        const data = await res.json();
        if (maybePrintJson(opts, { ok: true, action: "install", result: data }))
          return;
        console.log(JSON.stringify(data, null, 2));
      });

    // vibe code-server start [--path <dir>] [--port <port>]
    cs.command("start")
      .description("Start code-server")
      .option("--path <dir>", "Workspace directory to open")
      .option("--port <port>", "Port to bind to")
      .option("--json", "Emit JSON")
      .action(async (opts: { path?: string; port?: string } & OutputFlags) => {
        const body: Record<string, unknown> = {};
        if (opts.path) body.workspacePath = opts.path;
        if (opts.port) body.port = parseInt(opts.port, 10);

        const res = await apiFetch("/api/code-server/start", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (maybePrintJson(opts, { ok: true, action: "start", result: data }))
          return;
        console.log(JSON.stringify(data, null, 2));
      });

    // vibe code-server stop
    cs.command("stop")
      .description("Stop code-server")
      .option("--json", "Emit JSON")
      .action(async (opts: OutputFlags) => {
        const res = await apiFetch("/api/code-server/stop", {
          method: "POST",
        });
        const data = await res.json();
        if (maybePrintJson(opts, { ok: true, action: "stop", result: data }))
          return;
        console.log(JSON.stringify(data, null, 2));
      });

    // vibe code-server restart [--path <dir>]
    cs.command("restart")
      .description("Restart code-server with optional new workspace")
      .option("--path <dir>", "New workspace directory")
      .option("--json", "Emit JSON")
      .action(async (opts: { path?: string } & OutputFlags) => {
        const body: Record<string, unknown> = {};
        if (opts.path) body.workspacePath = opts.path;

        const res = await apiFetch("/api/code-server/restart", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (maybePrintJson(opts, { ok: true, action: "restart", result: data }))
          return;
        console.log(JSON.stringify(data, null, 2));
      });
  },
};

export default vibePlugin;
