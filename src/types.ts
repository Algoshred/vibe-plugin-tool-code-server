/**
 * Type declarations for the vibe-plugin-code-server plugin.
 *
 * All interfaces are defined locally so the plugin does not hard-import
 * from the core agent package.  At runtime the host agent injects concrete
 * implementations via HostServices.
 */

import type { Elysia } from "elysia";
import type { Command } from "commander";

// ── KV Storage provider ─────────────────────────────────────────────────

export interface StorageProvider {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
  keys(namespace: string): Promise<string[]>;
}

// ── Event bus ────────────────────────────────────────────────────────────

export interface EventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
}

// ── Service registry ─────────────────────────────────────────────────────

export interface ServiceRegistry {
  get<T = unknown>(name: string): T | undefined;
}

// ── Host services ────────────────────────────────────────────────────────

export interface HostServices {
  telemetry?: {
    emit: (name: string, payload?: Record<string, unknown>) => void;
  };
  storage: StorageProvider;
  eventBus?: EventBus;
  serviceRegistry?: ServiceRegistry;
}

// ── Plugin contract ──────────────────────────────────────────────────────

export interface PluginCapabilities {
  storage?: "none" | "read" | "rw";
  secrets?: "none" | "read" | "rw";
  gateway?: boolean;
  broadcast?: boolean;
  subprocess?: boolean;
  audit?: boolean;
  telemetry?: boolean;
}

export interface VibePlugin {
  capabilities?: PluginCapabilities;
  name: string;
  version: string;
  description?: string;
  tags?: Array<
    "backend" | "frontend" | "cli" | "provider" | "adapter" | "integration"
  >;
  cliCommand?: string;
  apiPrefix?: string;
  publicPaths?: string[];
  onCliSetup?: (program: Command) => void | Promise<void>;
  onServerStart?: (
    app: Elysia,
    hostServices: HostServices,
  ) => void | Promise<void>;
  onServerStop?: () => void | Promise<void>;
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
