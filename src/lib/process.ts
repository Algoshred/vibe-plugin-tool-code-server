/**
 * code-server Process Lifecycle Manager
 *
 * Manages starting, stopping, and monitoring the code-server child process.
 * code-server binds to 127.0.0.1 only — access is via the agent reverse proxy.
 */

import type { Subprocess } from "bun";
import type { CodeServerStatus } from "../types.js";

// ── Module-level state (not persisted — on-demand only) ──────────────────

let childProcess: Subprocess | null = null;
let currentPort: number | null = null;
let currentWorkspacePath: string | null = null;
let currentPid: number | null = null;
let lastError: string | null = null;
let isStarting = false;

const DEFAULT_PORT = 13337;
const PORT_RANGE_END = 13347;

/**
 * Check if a port is available by attempting to listen on it briefly.
 */
async function isPortAvailable(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch() {
        return new Response();
      },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an available port in the range [DEFAULT_PORT, PORT_RANGE_END].
 */
async function findAvailablePort(preferred?: number): Promise<number> {
  const start = preferred ?? DEFAULT_PORT;

  if (await isPortAvailable(start)) return start;

  for (let port = DEFAULT_PORT; port <= PORT_RANGE_END; port++) {
    if (port === start) continue;
    if (await isPortAvailable(port)) return port;
  }

  throw new Error(
    `No available port in range ${DEFAULT_PORT}-${PORT_RANGE_END}`,
  );
}

/**
 * Start code-server as a child process.
 */
export async function startCodeServer(
  binaryPath: string,
  options?: { port?: number; workspacePath?: string },
): Promise<{ pid: number; port: number }> {
  if (childProcess && currentPid) {
    // Already running — check if still alive
    if (isProcessAlive(currentPid)) {
      return { pid: currentPid, port: currentPort! };
    }
    // Process died, clean up
    childProcess = null;
    currentPid = null;
  }

  if (isStarting) {
    throw new Error("code-server is already starting");
  }

  isStarting = true;
  lastError = null;

  try {
    const port = await findAvailablePort(options?.port);
    const workspacePath = options?.workspacePath || process.env.HOME || "/";

    const args = [
      binaryPath,
      "--auth",
      "none",
      "--bind-addr",
      `127.0.0.1:${port}`,
      "--base-path",
      "/code-server",
      "--disable-telemetry",
      "--disable-update-check",
      workspacePath,
    ];

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Disable code-server's own proxy auth
        CS_DISABLE_GETTING_STARTED_OVERRIDE: "1",
      },
    });

    childProcess = proc;
    currentPort = port;
    currentWorkspacePath = workspacePath;
    currentPid = proc.pid;

    // Monitor for unexpected exit
    proc.exited.then((code) => {
      if (childProcess === proc) {
        childProcess = null;
        currentPid = null;
        if (code !== 0 && code !== null) {
          lastError = `code-server exited with code ${code}`;
        }
      }
    });

    // Wait briefly for startup
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Verify it started
    if (!isProcessAlive(proc.pid)) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`code-server failed to start: ${stderr}`);
    }

    return { pid: proc.pid, port };
  } catch (err) {
    lastError = err instanceof Error ? err.message : "Failed to start";
    throw err;
  } finally {
    isStarting = false;
  }
}

/**
 * Stop the code-server process.
 */
export async function stopCodeServer(): Promise<void> {
  if (!childProcess || !currentPid) {
    childProcess = null;
    currentPid = null;
    return;
  }

  const proc = childProcess;
  const pid = currentPid;

  // Clear references immediately
  childProcess = null;
  currentPid = null;
  currentPort = null;
  currentWorkspacePath = null;
  lastError = null;

  // Send SIGTERM
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may already be dead
    return;
  }

  // Wait up to 5 seconds for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Force kill if still alive
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }

  // Wait for the process handle
  try {
    await proc.exited;
  } catch {
    // Ignore
  }
}

/**
 * Get the current status of code-server.
 */
export function getStatus(): CodeServerStatus {
  const running = Boolean(currentPid && isProcessAlive(currentPid));

  // Clean up stale state
  if (!running && childProcess) {
    childProcess = null;
    currentPid = null;
  }

  return {
    installed: true, // Caller checks installation separately
    installing: false,
    running,
    pid: running ? (currentPid ?? undefined) : undefined,
    port: running ? (currentPort ?? undefined) : undefined,
    workspacePath: running ? (currentWorkspacePath ?? undefined) : undefined,
    error: lastError ?? undefined,
  };
}

/**
 * Get the port code-server is currently running on.
 */
export function getRunningPort(): number | null {
  if (!currentPid || !isProcessAlive(currentPid)) return null;
  return currentPort;
}

/**
 * Check if a process is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
