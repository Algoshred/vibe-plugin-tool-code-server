/**
 * code-server Installation Manager
 *
 * Handles checking, installing, and versioning code-server on the agent machine.
 * Uses the official install script with --method standalone --prefix ~/.local
 * so no root access is required.
 */

import os from "node:os";
import path from "node:path";
import type { AgentStorageProvider as StorageProvider } from "../types.js";

const STORAGE_NS = "code-server";
const KEY_INSTALLED = "installed";
const KEY_VERSION = "version";
const KEY_BINARY_PATH = "binary-path";

/** Paths where code-server may be found after installation */
const SEARCH_PATHS = [
  path.join(os.homedir(), ".local", "bin", "code-server"),
  "/usr/local/bin/code-server",
  "/usr/bin/code-server",
];

/**
 * Resolve the code-server binary path by checking `command -v` first,
 * then falling back to known installation locations.
 */
async function resolveBinaryPath(): Promise<string | null> {
  // Bun.which works on every platform (POSIX + Windows) and honors PATHEXT
  // so it picks up `code-server.cmd` on Windows automatically.
  const found = Bun.which("code-server", { PATH: process.env.PATH });
  if (found) return found;

  // Check known paths
  for (const p of SEARCH_PATHS) {
    try {
      const file = Bun.file(p);
      if (await file.exists()) {
        return p;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Get the installed version of code-server.
 */
async function getVersion(binaryPath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([binaryPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      // code-server --version outputs something like "4.96.4\n..."
      const firstLine = output.trim().split("\n")[0];
      return firstLine.trim();
    }
  } catch {
    // version check failed
  }
  return null;
}

/**
 * Check if code-server is installed and return its status.
 */
export async function checkInstallation(storage: StorageProvider): Promise<{
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
}> {
  const binaryPath = await resolveBinaryPath();

  if (!binaryPath) {
    return { installed: false, version: null, binaryPath: null };
  }

  const version = await getVersion(binaryPath);

  // Cache the result
  await storage.set(STORAGE_NS, KEY_INSTALLED, "true");
  if (version) await storage.set(STORAGE_NS, KEY_VERSION, version);
  await storage.set(STORAGE_NS, KEY_BINARY_PATH, binaryPath);

  return { installed: true, version, binaryPath };
}

/**
 * Install code-server using the official install script.
 * Uses --method standalone --prefix ~/.local to avoid needing root.
 *
 * Returns the binary path on success.
 */
export async function installCodeServer(
  storage: StorageProvider,
  onLog?: (line: string) => void,
): Promise<{ success: boolean; binaryPath: string | null; error?: string }> {
  onLog?.("Downloading and installing code-server...");

  try {
    // The official install script is bash-only. On Windows, point the user
    // at the standalone download (code-server doesn't ship an installer
    // we can pipe through `cmd /c`). Refuse cleanly rather than spawn a
    // missing `sh`.
    if (process.platform === "win32") {
      return {
        success: false,
        binaryPath: null,
        error:
          "Automated install is unsupported on Windows. Install code-server manually from https://github.com/coder/code-server/releases and re-run.",
      };
    }
    const installPrefix = path.join(os.homedir(), ".local");
    const proc = Bun.spawn(
      [
        "sh",
        "-c",
        `curl -fsSL https://code-server.dev/install.sh | sh -s -- --method standalone --prefix ${installPrefix}`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${installPrefix}/bin:${process.env.PATH}`,
        },
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (stdout) onLog?.(stdout);
    if (stderr) onLog?.(stderr);

    if (exitCode !== 0) {
      const errorMsg = `Installation failed with exit code ${exitCode}: ${stderr}`;
      onLog?.(errorMsg);
      return { success: false, binaryPath: null, error: errorMsg };
    }

    // Verify installation
    const check = await checkInstallation(storage);
    if (!check.installed) {
      return {
        success: false,
        binaryPath: null,
        error: "Installation script succeeded but binary not found",
      };
    }

    onLog?.(`code-server ${check.version} installed at ${check.binaryPath}`);
    return { success: true, binaryPath: check.binaryPath };
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Unknown installation error";
    onLog?.(errorMsg);
    return { success: false, binaryPath: null, error: errorMsg };
  }
}

/**
 * Get the cached binary path from storage, or re-resolve it.
 */
export async function getBinaryPath(
  storage: StorageProvider,
): Promise<string | null> {
  const cached = await storage.get(STORAGE_NS, KEY_BINARY_PATH);
  if (cached) {
    // Verify it still exists
    try {
      const file = Bun.file(cached);
      if (await file.exists()) return cached;
    } catch {
      // Fall through to re-resolve
    }
  }

  return resolveBinaryPath();
}
