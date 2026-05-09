/**
 * Domain models for the vibe-plugin-tool-code-server plugin.
 *
 * Plugin contract types (VibePlugin / HostServices / PluginCapabilities /
 * StorageProvider / ServiceRegistry / EventBus) are imported from
 * `@vibecontrols/plugin-sdk` — do NOT redeclare them here.
 *
 * We keep a thin AgentStorageProvider alias for this plugin's internal
 * helpers (installer.ts) that only need string get/set + delete.
 */

export interface AgentStorageProvider {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
  keys?(namespace: string): Promise<string[]>;
}

// ── Domain models ────────────────────────────────────────────────────────

export interface CodeServerConfig {
  /** Port for code-server to bind to. Default: 13337 */
  port?: number;
  /** Directory to open as workspace root */
  workspacePath?: string;
}

export interface CodeServerStatus {
  installed: boolean;
  installing: boolean;
  running: boolean;
  pid?: number;
  port?: number;
  workspacePath?: string;
  version?: string;
  error?: string;
}

// ── Request body shapes ──────────────────────────────────────────────────

export interface StartBody {
  workspacePath?: string;
  port?: number;
}

export interface RestartBody {
  workspacePath?: string;
}
