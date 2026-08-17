// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * parts — the styling seam.
 *
 * Every element this package renders carries a stable `data-fw-part` attribute
 * and takes an optional consumer className for the same part name. Three
 * mechanisms, layered so that an imperfect part list stays recoverable:
 *
 *   A. `data-fw-part="grip"` — always present, additive-only, never breaking.
 *      A consumer can style ANY element from its own stylesheet with no prop:
 *          [data-fw-part="grip"] { cursor: move; }
 *      This is what makes committing to part names safe: a part we failed to
 *      anticipate costs an attribute selector, not a major version.
 *
 *   B. `classNames` — a bag keyed by part name, passed to FloatingWidgetStack
 *      (all widgets) and/or WidgetDef.classNames (one widget). Consumer classes
 *      are APPENDED to the defaults, never merged token-by-token: this package
 *      has no `tailwind-merge` dependency, so "append and let CSS order decide"
 *      would be the unpredictable half of a merge. Appending adds; `unstyled`
 *      subtracts. Those two together cover the ground a merge would.
 *
 *   C. `unstyled` — drop every default class, keep structure, data attributes
 *      and inline geometry. The path for a consumer with no shadcn tokens.
 *
 * Responsibility boundary
 * -----------------------
 * The library owns GEOMETRY and applies it inline (position, edge offsets,
 * z-index, drag transform, transition, the float↔dock reflow). The consumer
 * owns the SKIN. Where a "geometry" value is really a style decision — the
 * widget's 17rem width, the dock's z-index — it is emitted as a CSS custom
 * property with the historical value as its fallback, so it stays overridable
 * from CSS without a prop:
 *
 *     --fw-widget-width   (default 17rem)
 *     --fw-dock-z         (default 50)
 */

/** Every element this package renders. Stable; additive-only. */
export type WidgetPart =
  /** Positioned wrapper. Fixed + coordinator-placed when floating; plain when docked. */
  | "root"
  /** The bordered panel surface. */
  | "card"
  /** Header row: grip + title + toggle. */
  | "header"
  /** Drag affordance. Float presentation only. */
  | "grip"
  /** Slot holding the consumer's `header(ctx)` output. */
  | "title"
  /** Chevron button — the accessible expand/collapse control. */
  | "toggle"
  /** Panel body, holding `render(ctx)`. Absent while collapsed. */
  | "body"
  /** Fixed container pinned to the dock edge. Dock presentation only. */
  | "dock"
  /** The open dock surface. */
  | "dockPanel"
  /** Accordion list inside the panel. */
  | "dockList"
  /** Closed-state affordance. */
  | "dockTrigger"
  /** Scrim, rendered only when `dockModal`. */
  | "dockBackdrop";

/** Consumer class overrides, keyed by part. Appended to the defaults. */
export type PartClassNames = Partial<Record<WidgetPart, string>>;

/** Which presentation a part is being rendered in. */
export type Presentation = "float" | "dock";

/**
 * Float defaults — the exact strings this package shipped in 0.1.0, so an
 * upgrade with no `classNames` and no `unstyled` renders identical markup.
 */
const FLOAT_DEFAULTS: Record<WidgetPart, string> = {
  root: "",
  card: "rounded-lg border bg-card text-card-foreground shadow-lg overflow-hidden",
  header: "flex items-center select-none",
  // `touch-action: none` and `user-select: none` are NOT here — they are drag
  // correctness, not skin, and are applied inline so `unstyled` can't delete
  // them. See FloatingWidget's grip.
  grip: "flex items-center px-2 py-2 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground",
  title: "min-w-0 flex-1 overflow-hidden py-1.5 cursor-pointer",
  toggle: "shrink-0 px-2 py-1.5 text-foreground/70 hover:text-foreground",
  body: "border-t",
  // Dock parts never render in the float presentation.
  dock: "",
  dockPanel: "",
  dockList: "",
  dockTrigger: "",
  dockBackdrop: "",
};

/**
 * Dock overrides. A docked widget sits INSIDE the dock panel, which already
 * supplies the border/background/shadow — so the per-widget `card` drops its
 * own surface rather than nesting a second one.
 */
const DOCK_OVERRIDES: Partial<Record<WidgetPart, string>> = {
  card: "overflow-hidden",
  title: "min-w-0 flex-1 overflow-hidden py-2 cursor-pointer",
  dockPanel: "border bg-card text-card-foreground shadow-lg overflow-hidden",
  // Height containment and scrolling are inline (geometry) — an `unstyled`
  // dock must not be able to grow past the viewport. Only the divider is skin.
  dockList: "divide-y",
  dockTrigger:
    "rounded-full border bg-card text-card-foreground shadow-lg px-3 py-2 text-xs",
  dockBackdrop: "bg-black/50",
};

function defaultClass(part: WidgetPart, presentation: Presentation): string {
  if (presentation === "dock") {
    const override = DOCK_OVERRIDES[part];
    if (override !== undefined) return override;
  }
  return FLOAT_DEFAULTS[part];
}

/** Join defined, non-empty class strings. */
function cx(...parts: (string | undefined)[]): string | undefined {
  const joined = parts.filter((p) => p).join(" ").trim();
  return joined === "" ? undefined : joined;
}

/** Everything needed to resolve a part's className. */
export interface PartStyling {
  presentation: Presentation;
  /** Stack-level overrides. */
  classNames?: PartClassNames;
  /** Per-widget overrides, applied after the stack-level ones. */
  widgetClassNames?: PartClassNames;
  /** Drop the defaults entirely; consumer classes still apply. */
  unstyled?: boolean;
}

/**
 * Props to spread onto a rendered element: the stable data attribute plus the
 * resolved className. Precedence is default → stack classNames → widget
 * classNames, appended in that order.
 */
export function partProps(
  part: WidgetPart,
  styling: PartStyling,
): { "data-fw-part": WidgetPart; className?: string } {
  const base = styling.unstyled ? undefined : defaultClass(part, styling.presentation);
  return {
    "data-fw-part": part,
    className: cx(base, styling.classNames?.[part], styling.widgetClassNames?.[part]),
  };
}
