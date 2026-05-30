/**
 * REST API routes for the code-server plugin.
 *
 * Prefix: /api/code-server
 *
 * Routes:
 *   GET  /status   — Current code-server status
 *   POST /install  — Install code-server (async)
 *   POST /start    — Start code-server with optional workspace path
 *   POST /stop     — Stop code-server
 *   POST /restart  — Restart with optional new workspace path
 *
 * Built on `RoutesBuilder` from `@vibecontrols/plugin-sdk/routes` —
 * concerns like prefix, error handler, and logging fold through the SDK.
 */

import { homedir } from "node:os";

import type { Elysia } from "elysia";

import { RoutesBuilder } from "@vibecontrols/plugin-sdk/routes";
import type { HostServices } from "@vibecontrols/plugin-sdk/contract";

import type { AgentStorageProvider, StartBody, RestartBody } from "./types.js";
import {
  checkInstallation,
  installCodeServer,
  getBinaryPath,
} from "./lib/installer.js";
import {
  startCodeServer,
  stopCodeServer,
  getStatus as getProcessStatus,
} from "./lib/process.js";

// Module-level install state
let isInstalling = false;
let installError: string | null = null;

export function createCodeServerRoutes(hostServices: HostServices): Elysia {
  // Storage is required for installer state — narrow via a structural cast.
  const storage = hostServices.storage as unknown as AgentStorageProvider;

  const app = new RoutesBuilder("code-server", hostServices)
    .withPrefix("/api/code-server")
    .withErrorHandler()
    .build();

  const wired = app

    // GET /api/code-server/status
    .get("/status", async () => {
      const installInfo = await checkInstallation(storage);
      const processStatus = getProcessStatus();

      return {
        installed: installInfo.installed,
        installing: isInstalling,
        running: processStatus.running,
        pid: processStatus.pid,
        port: processStatus.port,
        workspacePath: processStatus.workspacePath,
        version: installInfo.version,
        error: installError || processStatus.error || undefined,
      };
    })

    // POST /api/code-server/install
    .post("/install", async ({ set }) => {
      if (isInstalling) {
        set.status = 409;
        return { error: "Installation already in progress" };
      }

      // Check if already installed
      const check = await checkInstallation(storage);
      if (check.installed) {
        return {
          message: "code-server is already installed",
          version: check.version,
          binaryPath: check.binaryPath,
        };
      }

      // Start async installation
      isInstalling = true;
      installError = null;

      // Fire and forget — caller polls /status
      void (async () => {
        try {
          const result = await installCodeServer(storage);
          if (!result.success) {
            installError = result.error || "Installation failed";
          }
        } catch (err) {
          installError =
            err instanceof Error ? err.message : "Installation failed";
        } finally {
          isInstalling = false;
        }
      })();

      return {
        message: "Installation started — poll GET /api/code-server/status",
      };
    })

    // POST /api/code-server/start
    .post("/start", async ({ body, set }) => {
      const { workspacePath, port } = (body as StartBody) || {};

      // Ensure installed
      const binaryPath = await getBinaryPath(storage);
      if (!binaryPath) {
        set.status = 400;
        return {
          error:
            "code-server is not installed. POST /api/code-server/install first",
        };
      }

      try {
        const result = await startCodeServer(binaryPath, {
          workspacePath,
          port,
        });
        return {
          message: "code-server started",
          pid: result.pid,
          port: result.port,
          workspacePath: workspacePath || homedir(),
        };
      } catch (err) {
        set.status = 500;
        return {
          error: err instanceof Error ? err.message : "Failed to start",
        };
      }
    })

    // POST /api/code-server/stop
    .post("/stop", async () => {
      await stopCodeServer();
      return { message: "code-server stopped" };
    })

    // POST /api/code-server/restart
    .post("/restart", async ({ body, set }) => {
      const { workspacePath } = (body as RestartBody) || {};

      const binaryPath = await getBinaryPath(storage);
      if (!binaryPath) {
        set.status = 400;
        return { error: "code-server is not installed" };
      }

      await stopCodeServer();

      try {
        const result = await startCodeServer(binaryPath, { workspacePath });
        return {
          message: "code-server restarted",
          pid: result.pid,
          port: result.port,
          workspacePath: workspacePath || homedir(),
        };
      } catch (err) {
        set.status = 500;
        return {
          error: err instanceof Error ? err.message : "Failed to restart",
        };
      }
    });

  return wired as unknown as Elysia;
}
