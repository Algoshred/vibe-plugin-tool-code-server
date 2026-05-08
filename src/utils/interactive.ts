/**
 * Reusable opentui primitives for read-style commands.
 *
 *   • interactiveTable — a focusable single-column list with a detail pane
 *     on the right. The user picks rows with ↑/↓; we render the detail of
 *     the focused row in a fixed-width panel. Enter exits and runs an
 *     optional callback (e.g. print full detail to stdout). q/Esc cancels.
 *
 *   • interactiveDetail — a static key/value panel (great for `vibe profile
 *     show`, `vibe info`, etc.). Mostly identical to plain output but inside
 *     the alternate screen so it's pretty.
 *
 * Both helpers throw if @opentui/core fails to import — callers should pair
 * them with a plain fallback through `runMultimode`.
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

export interface TableRow {
  /** Stable identifier — exposed to onSelect. */
  id: string;
  /** Short label rendered in the left pane. */
  label: string;
  /** Optional one-line muted hint shown below the label. */
  hint?: string;
  /** Detail rendered in the right pane (multiline, ANSI ok). */
  detail: string;
}

export interface InteractiveTableOptions {
  title: string;
  rows: TableRow[];
  /** Footer hint — overrides the default `↑/↓ navigate · Enter select · q quit`. */
  footer?: string;
  /** Width of the left list pane in columns. Default: 28. */
  listWidth?: number;
  /**
   * Called when the user hits Enter on a row. If omitted, Enter quits.
   * The handler runs AFTER the renderer is destroyed, so it's free to
   * write to stdout.
   */
  onSelect?: (row: TableRow) => void | Promise<void>;
}

/**
 * Render a focusable list with a live detail pane. Resolves once the user
 * hits Enter or quits.
 */
export async function interactiveTable(
  opts: InteractiveTableOptions,
): Promise<TableRow | null> {
  if (opts.rows.length === 0) {
    return null;
  }

  const core = await loadCore();
  const {
    createCliRenderer,
    BoxRenderable,
    TextRenderable,
    SelectRenderable,
    SelectRenderableEvents,
  } = core;

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

  const footer = new TextRenderable(ctx, {
    content: `  ${opts.footer ?? "↑/↓ navigate · Enter select · q quit"}`,
    fg: "#6c7086",
    height: 1,
  });

  const body = new BoxRenderable(ctx, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
  });

  const list = new SelectRenderable(ctx, {
    width: opts.listWidth ?? 28,
    height: "100%",
    options: opts.rows.map((r) => ({
      name: r.label,
      description: r.hint ?? "",
      value: r.id,
    })),
    selectedIndex: 0,
    showDescription: true,
    backgroundColor: "#0b0d12",
    textColor: "#cdd6f4",
    focusedBackgroundColor: "#0b0d12",
    focusedTextColor: "#cdd6f4",
    selectedBackgroundColor: "#1f2335",
    selectedTextColor: "#a6e3a1",
    descriptionColor: "#6c7086",
    selectedDescriptionColor: "#9399b2",
    showScrollIndicator: true,
    wrapSelection: true,
  });

  const detailPane = new BoxRenderable(ctx, {
    flexGrow: 1,
    height: "100%",
    flexDirection: "column",
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: "#11141c",
  });

  const detailText = new TextRenderable(ctx, {
    content: "",
    fg: "#cdd6f4",
  });

  detailPane.add(detailText);
  body.add(list);
  body.add(detailPane);
  root.add(title);
  root.add(body);
  root.add(footer);
  renderer.root.add(root);
  list.focus();

  const renderDetail = (idx: number) => {
    const row = opts.rows[idx];
    if (!row) return;
    detailText.content = `\n${row.detail}\n`;
  };

  renderDetail(0);

  list.on(SelectRenderableEvents.SELECTION_CHANGED, (idx: number) => {
    renderDetail(idx);
  });

  return await new Promise<TableRow | null>((resolve) => {
    const cleanup = (chosen: TableRow | null) => {
      try {
        renderer.destroy();
      } catch {
        /* ignore */
      }
      resolve(chosen);
    };

    list.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      const row = opts.rows[list.getSelectedIndex()];
      cleanup(row ?? null);
    });

    renderer.keyInput.on("keypress", (key) => {
      if (key.name === "escape" || key.name === "q") {
        cleanup(null);
      }
    });
  }).then(async (chosen) => {
    if (chosen && opts.onSelect) await opts.onSelect(chosen);
    return chosen;
  });
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
