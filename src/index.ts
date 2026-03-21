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
  name: "code-server",
  version: "1.0.0",
  description:
    "Browser-based VS Code via code-server — reverse-proxied through the agent",
  tags: ["backend", "cli"],
  cliCommand: "code-server",
  apiPrefix: "/api/code-server",
  publicPaths: ["/code-server/"],

  async onServerStart(app: Elysia, hostServices: HostServices) {
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
      .action(async () => {
        const res = await apiFetch("/api/code-server/status");
        const data = await res.json();
        console.log(JSON.stringify(data, null, 2));
      });

    // vibe code-server install
    cs.command("install")
      .description("Install code-server on this machine")
      .action(async () => {
        console.log("Installing code-server...");
        const res = await apiFetch("/api/code-server/install", {
          method: "POST",
        });
        const data = await res.json();
        console.log(JSON.stringify(data, null, 2));
      });

    // vibe code-server start [--path <dir>] [--port <port>]
    cs.command("start")
      .description("Start code-server")
      .option("--path <dir>", "Workspace directory to open")
      .option("--port <port>", "Port to bind to")
      .action(async (opts: { path?: string; port?: string }) => {
        const body: Record<string, unknown> = {};
        if (opts.path) body.workspacePath = opts.path;
        if (opts.port) body.port = parseInt(opts.port, 10);

        const res = await apiFetch("/api/code-server/start", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const data = await res.json();
        console.log(JSON.stringify(data, null, 2));
      });

    // vibe code-server stop
    cs.command("stop")
      .description("Stop code-server")
      .action(async () => {
        const res = await apiFetch("/api/code-server/stop", {
          method: "POST",
        });
        const data = await res.json();
        console.log(JSON.stringify(data, null, 2));
      });

    // vibe code-server restart [--path <dir>]
    cs.command("restart")
      .description("Restart code-server with optional new workspace")
      .option("--path <dir>", "New workspace directory")
      .action(async (opts: { path?: string }) => {
        const body: Record<string, unknown> = {};
        if (opts.path) body.workspacePath = opts.path;

        const res = await apiFetch("/api/code-server/restart", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const data = await res.json();
        console.log(JSON.stringify(data, null, 2));
      });
  },
};

export default vibePlugin;
