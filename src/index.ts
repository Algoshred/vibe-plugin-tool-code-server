/**
 * @vibecontrols/vibe-plugin-tool-code-server
 *
 * Browser-based VS Code via code-server — reverse-proxied through the
 * VibeControls agent. Manages code-server lifecycle (install, start, stop)
 * and proxies all traffic at /code-server/* with session cookie auth.
 *
 * Registers:
 *   - Elysia routes: /api/code-server/*  (REST API)
 *   - Proxy routes:  /code-server/*      (reverse proxy to code-server)
 *   - CLI command:   vibe code-server {status,install,start,stop,restart}
 *
 * Migrated to consume `@vibecontrols/plugin-sdk` for the contract,
 * lifecycle, telemetry, CLI multimode, and redaction helpers.
 */

import type { Command } from "commander";

import {
  createLifecycleHooks,
  pickOutputMode,
  redact,
  runMultimode,
  maybePrintJson,
  TelemetryEmitter,
  type HostServices,
  type OutputFlags,
  type ProfileContext,
  type VibePlugin,
  type VibePluginFactory,
} from "@vibecontrols/plugin-sdk";

import type { CodeServerStatus } from "./types.js";
import { getRunningPort, stopCodeServer } from "./lib/process.js";
import { interactiveDetail } from "./utils/interactive.js";

export type {
  CodeServerConfig,
  CodeServerStatus,
  StartBody,
  RestartBody,
} from "./types.js";

/**
 * Local extension of the SDK contract — agrees additive fields the host
 * agent reads from the registry (`publicPaths` allowlist) that the SDK
 * contract leaves to the host implementation.
 */
type CodeServerVibePlugin = VibePlugin & {
  publicPaths?: string[];
};

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

const PLUGIN_NAME = "code-server";
const PLUGIN_VERSION = "2026.509.1";

export const createPlugin: VibePluginFactory = (
  _ctx: ProfileContext,
): VibePlugin => {
  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: "tool.ready",
    onInit: (hostServices: HostServices) => {
      const telemetry = new TelemetryEmitter(
        PLUGIN_NAME,
        PLUGIN_VERSION,
        hostServices,
      );
      telemetry.emitEvent("tool.ready", { provider: "code-server" });
    },
  });

  const plugin: CodeServerVibePlugin = {
    capabilities: {
      storage: "rw",
      subprocess: true,
      audit: true,
      telemetry: true,
    },
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "Browser-based VS Code via code-server — reverse-proxied through the agent",
    tags: ["backend", "cli"],
    cliCommand: "code-server",
    apiPrefix: "/api/code-server",
    publicPaths: ["/code-server/"],

    async onServerStart(app: unknown, hostServices: HostServices) {
      await lifecycle.onServerStart(app, hostServices);

      // The host agent passes a real Elysia instance.
      const elysiaApp = app as {
        use: (plugin: unknown) => unknown;
        decorator?: { apiKey?: string };
      };

      // Register REST API routes
      const { createCodeServerRoutes } = await import("./routes.js");
      elysiaApp.use(createCodeServerRoutes(hostServices));

      // Snapshot the API key from the app's decorator — used only as a
      // fallback for hosts that don't expose a live validator (below).
      try {
        agentApiKey = elysiaApp.decorator?.apiKey ?? null;
      } catch {
        agentApiKey = process.env.AGENT_API_KEY ?? null;
      }

      // Prefer the host's LIVE key validator. The agent rotates its API key
      // at finalize (bindApiKey), so the snapshot captured here goes stale and
      // would 401 the *current* valid key — which is exactly what broke the
      // editor proxy. `validateApiKey` is optional on older hosts, so fall
      // back to the captured key when it's absent.
      const liveValidate = (
        hostServices as { validateApiKey?: (key: string) => boolean }
      ).validateApiKey;
      const validateKey = (key: string): boolean => {
        if (typeof liveValidate === "function") return liveValidate(key);
        return !!agentApiKey && key === agentApiKey;
      };

      // Mount reverse proxy at /code-server/*
      const { createCodeServerProxy } = await import("./lib/proxy.js");
      elysiaApp.use(createCodeServerProxy(() => getRunningPort(), validateKey));

      process.stdout.write(
        "  Plugin 'code-server' registered routes: /api/code-server, /code-server\n",
      );
    },

    async onServerStop() {
      await stopCodeServer();
      process.stdout.write("  Plugin 'code-server' stopped\n");
    },

    onCliSetup(programArg: unknown) {
      const program = programArg as Command;
      const cs = program
        .command("code-server")
        .description("Browser-based VS Code via code-server");

      // vibe code-server status
      cs.command("status")
        .description("Show code-server status")
        .option("--json", "Emit JSON")
        .option("--plain", "Force plain text output")
        .action(async (opts: OutputFlags) => {
          await runMultimode<CodeServerStatus>({
            mode: pickOutputMode(opts),
            fetchData: async () => {
              const res = await apiFetch("/api/code-server/status");
              return (await res.json()) as CodeServerStatus;
            },
            plain: (data) => {
              process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
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
          if (!opts.json) process.stdout.write("Installing code-server...\n");
          const res = await apiFetch("/api/code-server/install", {
            method: "POST",
          });
          const data = await res.json();
          if (
            maybePrintJson(opts, { ok: true, action: "install", result: data })
          )
            return;
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        });

      // vibe code-server start [--path <dir>] [--port <port>]
      cs.command("start")
        .description("Start code-server")
        .option("--path <dir>", "Workspace directory to open")
        .option("--port <port>", "Port to bind to")
        .option("--json", "Emit JSON")
        .action(
          async (opts: { path?: string; port?: string } & OutputFlags) => {
            const body: Record<string, unknown> = {};
            if (opts.path) body.workspacePath = opts.path;
            if (opts.port) body.port = parseInt(opts.port, 10);

            const res = await apiFetch("/api/code-server/start", {
              method: "POST",
              body: JSON.stringify(body),
            });
            const data = await res.json();
            if (
              maybePrintJson(opts, { ok: true, action: "start", result: data })
            )
              return;
            process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
          },
        );

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
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
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
          if (
            maybePrintJson(opts, { ok: true, action: "restart", result: data })
          )
            return;
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        });
    },
  };

  return plugin;
};

export default createPlugin;
