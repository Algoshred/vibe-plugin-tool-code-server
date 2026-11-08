/**
 * Reusable opentui primitives for read-style commands.
 *
 *   • interactiveDetail — a static key/value panel (great for `vibe profile
 *     show`, `vibe info`, etc.). Mostly identical to plain output but inside
 *     the alternate screen so it's pretty.
 *
 * The helper throws if @opentui/core fails to import — callers should pair
 * it with a plain fallback through `runMultimode`.
 */

// Structural shim — we don't depend on @opentui/core at type-check time.
// The dynamic import below will throw at runtime if the package isn't
// installed, and `runMultimode` will fall back to plain.
interface OpenTuiRenderer {
  root: { ctx: unknown; add: (r: unknown) => void };
  keyInput: {
    on: (event: string, cb: (key: { name: string }) => void) => void;
  };
  destroy: () => void;
}

interface OpenTuiSelect {
  focus: () => void;
  on: (event: string, cb: (idx: number) => void) => void;
  getSelectedIndex: () => number;
}

interface OpenTuiText {
  content: string;
}

interface OpenTuiBox {
  add: (r: unknown) => void;
}

interface OpenTuiCore {
  createCliRenderer: (cfg: Record<string, unknown>) => Promise<OpenTuiRenderer>;
  BoxRenderable: new (
    ctx: unknown,
    opts: Record<string, unknown>,
  ) => OpenTuiBox;
  TextRenderable: new (
    ctx: unknown,
    opts: Record<string, unknown>,
  ) => OpenTuiText;
  SelectRenderable: new (
    ctx: unknown,
    opts: Record<string, unknown>,
  ) => OpenTuiSelect;
  SelectRenderableEvents: {
    SELECTION_CHANGED: string;
    ITEM_SELECTED: string;
  };
}

async function loadCore(): Promise<OpenTuiCore> {
  // @ts-expect-error — optional dep not declared in plugin package.json
  return (await import("@opentui/core")) as unknown as OpenTuiCore;
}

export interface InteractiveDetailOptions {
  title: string;
  /** Pre-rendered ANSI body (may be multiline). */
  body: string;
  /** Footer hint. Default: `q to quit`. */
  footer?: string;
}

/**
 * Static key-value detail screen. Mostly used for `show` style commands
 * when the user wants the alt-screen polish; equivalent content is
 * available via the plain renderer.
 */
export async function interactiveDetail(
  opts: InteractiveDetailOptions,
): Promise<void> {
  const core = await loadCore();
  const { createCliRenderer, BoxRenderable, TextRenderable } = core;

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  });

  const ctx = renderer.root.ctx;

  const root = new BoxRenderable(ctx, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#0b0d12",
  });

  const title = new TextRenderable(ctx, {
    content: `  ${opts.title}`,
    fg: "#8be9fd",
    height: 1,
  });

  const bodyBox = new BoxRenderable(ctx, {
    width: "100%",
    flexGrow: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: "#11141c",
  });

  const bodyText = new TextRenderable(ctx, {
    content: `\n${opts.body}\n`,
    fg: "#cdd6f4",
  });

  const footer = new TextRenderable(ctx, {
    content: `  ${opts.footer ?? "q to quit"}`,
    fg: "#6c7086",
    height: 1,
  });

  bodyBox.add(bodyText);
  root.add(title);
  root.add(bodyBox);
  root.add(footer);
  renderer.root.add(root);

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      try {
        renderer.destroy();
      } catch {
        /* ignore */
      }
      resolve();
    };
    renderer.keyInput.on("keypress", (key) => {
      if (key.name === "escape" || key.name === "q" || key.name === "return") {
        cleanup();
      }
    });
  });
}
