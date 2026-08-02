// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
import type { ReactNode } from "react";

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
  /** Always-visible header row (summary line). */
  header: (ctx: Ctx) => ReactNode;
  /** Panel body, shown when expanded. */
  render: (ctx: Ctx) => ReactNode;
};
