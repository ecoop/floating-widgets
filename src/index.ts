// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * floating-widgets — a draggable/snappable stack of corner-docked panels
 * ("floating widgets"). Chrome + coordinator + persistence, app-agnostic.
 *
 * Runtime contract (NOT expressible in package.json):
 *   - A shadcn/Tailwind CSS-variable theme must be in scope. FloatingWidget
 *     uses the tokens: bg-card, text-card-foreground, border, shadow-lg,
 *     text-muted-foreground, text-foreground. Provide them or the panels
 *     render unstyled.
 *   - Render <FloatingWidgetStack> and <StackOriginReporter> INSIDE a single
 *     <LayoutProvider>, alongside the header element you pass as headerRef.
 */

// ── Composition surface (what most consumers import) ─────────────────────────
export { LayoutProvider } from "./LayoutContext";
export { FloatingWidgetStack } from "./FloatingWidgetStack";
export { StackOriginReporter } from "./StackOriginReporter";
export type {
  FloatingWidgetStackHandle,
  FloatingWidgetStackProps,
} from "./FloatingWidgetStack";
export type { WidgetDef } from "./types";

// ── Lower-level primitives (escape hatch — custom layouts) ───────────────────
export { FloatingWidget } from "./FloatingWidget";
export type { FloatingWidgetHandle } from "./FloatingWidget";
export { useLayout } from "./LayoutContext";
export type { LayoutContextValue } from "./LayoutContext";
export {
  useWidgetLayout,
  WIDGET_W,
  WIDGET_MARGIN,
} from "./useWidgetLayout";
export type {
  WidgetState,
  WidgetMode,
  WidgetPosition,
} from "./useWidgetLayout";
