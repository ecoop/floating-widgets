// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
import type { ReactNode } from "react";

import type { PartClassNames } from "./parts";

/**
 * One floating widget's declarative registration, generic over the host app's
 * live-context type `Ctx`. Array ORDER (in the registry passed to
 * FloatingWidgetStack) is the stack/layout order.
 *
 * `id` MUST stay stable: it keys both the localStorage layout entry
 * (useWidgetLayout) and the imperative-handle ref map. The header/render/
 * mountWhen functions read everything from their `ctx` argument, so the
 * registry array can be a stable useMemo([]) — it never needs to change
 * identity as live state changes.
 */
export type WidgetDef<Ctx> = {
  /** Unique, stable id — localStorage key + ref-map key. */
  id: string;
  /** Whether the widget starts collapsed. Default false. */
  defaultCollapsed?: boolean;
  /** Gate the widget's mount on live state. Omit for always-mounted. */
  mountWhen?: (ctx: Ctx) => boolean;
  /**
   * Gate the widget on the DOCKED presentation only — a widget that is useful
   * beside desktop content but not worth a row on a phone returns false here.
   * Orthogonal to `mountWhen`: this hides the widget in the dock without
   * unmounting it from the registry, so nothing about its state changes.
   * Omit to show it in both presentations.
   */
  dockWhen?: (ctx: Ctx) => boolean;
  /** Always-visible header row (summary line). */
  header: (ctx: Ctx) => ReactNode;
  /** Panel body, shown when expanded. */
  render: (ctx: Ctx) => ReactNode;
  /**
   * One-line summary offered to the dock trigger while the dock is CLOSED, so
   * a glanceable value survives collapse. Defaults to `header(ctx)`. Keep it
   * short — several widgets' peeks share one affordance.
   */
  peek?: (ctx: Ctx) => ReactNode;
  /**
   * Class overrides for this widget alone, keyed by `data-fw-part`. Applied
   * after the stack-level `classNames`, and appended to (not merged with) the
   * defaults — see `parts.ts`.
   */
  classNames?: PartClassNames;
};
