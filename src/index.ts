// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * floating-widgets — a draggable/snappable stack of corner-docked panels
 * ("floating widgets") that presents as a single docked surface on narrow
 * viewports. Chrome + coordinator + persistence, app-agnostic.
 *
 * Runtime contract (NOT expressible in package.json):
 *   - Default styling uses shadcn/Tailwind CSS-variable tokens (bg-card,
 *     text-card-foreground, border, shadow-lg, text-muted-foreground,
 *     text-foreground). Provide them, override them per part via `classNames`,
 *     or turn them off with `unstyled` and style `[data-fw-part]` yourself.
 *   - Render <FloatingWidgetStack> and <StackOriginReporter> INSIDE a single
 *     <LayoutProvider>, alongside the header element you pass as headerRef.
 */

// ── Composition surface (what most consumers import) ─────────────────────────
export { LayoutProvider } from "./LayoutContext";
export { FloatingWidgetStack } from "./FloatingWidgetStack";
export { StackOriginReporter } from "./StackOriginReporter";
export type {
  DockTriggerApi,
  FloatingWidgetStackHandle,
  FloatingWidgetStackProps,
} from "./FloatingWidgetStack";
export type { WidgetDef } from "./types";

// ── Responsive dock ──────────────────────────────────────────────────────────
// useDock is the reactive read: use it to reflect and drive dock state from
// your own chrome. The imperative handle's dock methods are for actions only.
export { useDock } from "./LayoutContext";
export type {
  DockContextValue,
  DockEdge,
  LayoutProviderProps,
} from "./LayoutContext";

// ── Styling seam ─────────────────────────────────────────────────────────────
export type { PartClassNames, Presentation, WidgetPart } from "./parts";

// ── Staying clear of other UI (sheets, the software keyboard, toasts) ────────
export { useAvoidElement, useAvoidRects, avoidOffset, AVOID_GAP } from "./avoid";
export type { AvoidRect, AvoidAxes, AvoidBox } from "./avoid";

// ── Lower-level primitives (escape hatch — custom layouts) ───────────────────
export { FloatingWidget } from "./FloatingWidget";
export type { FloatingWidgetHandle } from "./FloatingWidget";
export { useLayout } from "./LayoutContext";
export type { LayoutContextValue } from "./LayoutContext";
export { useBelowWidth } from "./useBelowWidth";
export {
  clampPosition,
  useWidgetLayout,
  WIDGET_W,
  WIDGET_MARGIN,
} from "./useWidgetLayout";
export type {
  WidgetState,
  WidgetMode,
  WidgetPosition,
} from "./useWidgetLayout";
