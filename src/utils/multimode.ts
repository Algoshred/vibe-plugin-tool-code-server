/**
 * Multi-mode output dispatcher.
 *
 * Every read-style command (list/show/status/dashboard) should funnel its
 * output through `runMultimode`. The data is fetched ONCE by `fetchData`,
 * then handed to one of three renderers:
 *
 *   • interactive — opentui UI (default in TTY when an interactive renderer
 *     is provided AND @opentui/core imports cleanly)
 *   • plain       — ANSI text written to stdout (the legacy / pipe-friendly
 *     output)
 *   • json        — `JSON.stringify(data, null, 2)` to stdout (or a
 *     custom shaper) — friendly for jq/scripting
 *
 * Mutating commands (start/stop/install/...) typically don't need this —
 * they print progress and exit. They MAY still call `runMultimode` to emit
 * a result object in JSON when `--json` is set; see `pickOutputMode`.
 *
 * The selection rules:
 *
 *   ┌─────────────────────┬──────────────────────────────────────────────┐
 *   │ explicit --json     │ json renderer (or default JSON.stringify)    │
 *   │ explicit --plain    │ plain renderer                               │
 *   │ stdout is not a TTY │ plain renderer                               │
 *   │ NO_COLOR, CI=true   │ plain renderer                               │
 *   │ no interactive fn   │ plain renderer                               │
 *   │ otherwise           │ interactive renderer (falls back to plain    │
 *   │                     │ if @opentui/core fails to import)            │
 *   └─────────────────────┴──────────────────────────────────────────────┘
 */

function isInteractive(): boolean {
  return !!process.stdout.isTTY && !!process.stdin.isTTY;
}

export type OutputMode = "auto" | "interactive" | "plain" | "json";

export interface OutputFlags {
  json?: boolean;
  plain?: boolean;
  interactive?: boolean;
}

export interface MultimodeOptions<T> {
  /** Pure data fetcher. Called once. */
  fetchData: () => Promise<T> | T;
  /** Plain-text renderer. Required — every command needs a pipe-friendly fallback. */
  plain: (data: T) => void | Promise<void>;
  /**
   * Optional opentui renderer. Only used when stdout is a TTY and opentui
   * imports cleanly. If omitted or it fails, we fall back to `plain`.
   */
  interactive?: (data: T) => Promise<void>;
  /**
   * Optional JSON shaper. Defaults to `JSON.stringify(data, null, 2)`.
   * Override when you need to redact secrets or reshape for scripting.
   */
  json?: (data: T) => unknown;
  /** Output mode (resolved from CLI flags by `pickOutputMode`). */
  mode?: OutputMode;
}

/**
 * Resolve the desired output mode from CLI flags. The caller should pass the
 * merged opts of the local command + the global program (since `--json`
 * lives on the program level too).
 */
export function pickOutputMode(flags: OutputFlags): OutputMode {
  if (flags.json) return "json";
  if (flags.plain) return "plain";
  if (flags.interactive) return "interactive";
  return "auto";
}

function isCi(): boolean {
  return (
    !!process.env.CI ||
    !!process.env.NO_COLOR ||
    process.env.TERM === "dumb"
  );
}

export async function runMultimode<T>(opts: MultimodeOptions<T>): Promise<void> {
  const data = await opts.fetchData();
  const mode = opts.mode ?? "auto";

  if (mode === "json") {
    const shaped = opts.json ? opts.json(data) : data;
    process.stdout.write(`${JSON.stringify(shaped, null, 2)}\n`);
    return;
  }

  if (mode === "plain") {
    await opts.plain(data);
    return;
  }

  // auto / interactive
  const wantInteractive =
    (mode === "interactive" || (isInteractive() && !isCi())) &&
    !!opts.interactive;

  if (wantInteractive && opts.interactive) {
    try {
      await opts.interactive(data);
      return;
    } catch {
      // opentui failed (missing dep, render glitch). Fall through to plain.
    }
  }

  await opts.plain(data);
}

/**
 * Convenience: emit the data shape as JSON (used by mutating commands that
 * still want a `--json` opt-in for scripting). Returns true if it printed.
 */
export function maybePrintJson(flags: OutputFlags, data: unknown): boolean {
  if (!flags.json) return false;
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  return true;
}
