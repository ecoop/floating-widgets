// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * FloatingWidgetStack — the declarative host for a stack of FloatingWidgets.
 * Packages the wiring that used to live inline in Pitchcraft's SessionFlow
 * (the .map(), the imperative-handle ref map, snapAllToCorner): the app hands
 * over a registry of WidgetDefs and a live context object, and the stack
 * renders each mounted widget and exposes a snapAll()/resetAll() handle.
 *
 * Generic over the app's context type `Ctx` — the bundle of already-computed
 * live state (a view-model / props bag) that every widget reads. The stack
 * never inspects Ctx; it only threads it into each def's mountWhen/header/render
 * at call time. So the app calls all of ITS hooks normally (at the top of its
 * own component), packs the results into `ctx`, and passes it down — no hooks
 * are ever called from inside the .map(), which keeps the Rules of Hooks
 * trivially satisfied even as widgets mount/unmount.
 *
 * Placement
 * ---------
 * Render this INSIDE a <LayoutProvider>, as a sibling of <StackOriginReporter>
 * and of the header element you pass to the reporter as headerRef:
 *
 *   <LayoutProvider>
 *     <StackOriginReporter headerRef={pageHeaderRef} />
 *     <header ref={pageHeaderRef}>…</header>
 *     …page…
 *     <FloatingWidgetStack ref={stackRef} ctx={ctx} widgets={WIDGETS}
 *                          settingsOpen={settingsOpen} />
 *   </LayoutProvider>
 *
 * The stack deliberately does NOT render its own LayoutProvider: the provider
 * must also enclose the header (which reports the stack origin), and that
 * boundary belongs to the host, not to this component.
 *
 * mountWhen
 * ---------
 * We map the FULL registry every render and gate each entry with mountWhen,
 * passing the array index as `order`. The coordinator sorts snapped widgets by
 * order and stacks only the mounted ones, so an optional widget being absent
 * (e.g. Demo/Telemetry) doesn't disturb the others' positions.
 */

import {
  useCallback,
  useImperativeHandle,
  useRef,
  type Ref,
} from "react";

import { FloatingWidget, type FloatingWidgetHandle } from "./FloatingWidget";
import type { WidgetDef } from "./types";

/** Imperative handle: flip/reset every mounted widget in one call. */
export interface FloatingWidgetStackHandle {
  /**
   * Flip every mounted widget back to "snapped" — the coordinator re-derives
   * each one's top and it tracks the header again. Collapsed state preserved
   * (non-collapsing snap). This is the old snapAllToCorner().
   */
  snapAll: () => void;
  /** Reset every mounted widget to its defaults (position + collapse + mode). */
  resetAll: () => void;
}

export interface FloatingWidgetStackProps<Ctx> {
  /**
   * Declarative registry. ORDER is the stack/layout order. Keep its identity
   * stable across renders (useMemo([]) in the host) — the functions read
   * everything from `ctx` at call time, so the array itself never needs to
   * change. Each `id` MUST stay stable: it keys both the localStorage layout
   * entry and the ref map.
   */
  widgets: WidgetDef<Ctx>[];
  /**
   * Live app state, rebuilt each render and threaded into every def function.
   * A plain object (view-model), NOT a place to call hooks.
   */
  ctx: Ctx;
  /** Forwarded to each widget for the Settings-sheet minimal-shift (Pitchcraft #270). */
  settingsOpen?: boolean;
  /** Width (px) of the Settings sheet; forwarded unchanged. Default lives in FloatingWidget. */
  settingsPanelWidth?: number;
  /**
   * Optional localStorage namespace, prefixed to each widget id, so two apps
   * sharing an origin don't collide on `widget:<id>` keys. Omit for the
   * historical single-app behavior (bare ids).
   */
  storagePrefix?: string;
  /**
   * Imperative handle. React 19 delivers `ref` as an ordinary prop, so we take
   * it directly — no forwardRef wrapper, and the component stays generic over
   * Ctx with no type cast. (Requires React 19+; see peerDependencies.)
   */
  ref?: Ref<FloatingWidgetStackHandle>;
}

export function FloatingWidgetStack<Ctx>({
  widgets,
  ctx,
  settingsOpen = false,
  settingsPanelWidth,
  storagePrefix,
  ref,
}: FloatingWidgetStackProps<Ctx>) {
  // Imperative handles keyed by widget id. A callback ref populates this map;
  // an unmounted widget self-clears to null when React calls its ref with null.
  const refs = useRef<Record<string, FloatingWidgetHandle | null>>({});

  const isMounted = useCallback(
    (w: WidgetDef<Ctx>) => (w.mountWhen ? w.mountWhen(ctx) : true),
    [ctx],
  );

  useImperativeHandle(
    ref,
    () => ({
      snapAll: () => {
        for (const w of widgets) {
          if (isMounted(w)) refs.current[w.id]?.snap();
        }
      },
      resetAll: () => {
        for (const w of widgets) {
          if (isMounted(w)) refs.current[w.id]?.reset();
        }
      },
    }),
    [widgets, isMounted],
  );

  return (
    <>
      {widgets.map((w, i) =>
        isMounted(w) ? (
          <FloatingWidget
            key={w.id}
            ref={(h) => {
              refs.current[w.id] = h;
            }}
            id={storagePrefix ? `${storagePrefix}:${w.id}` : w.id}
            order={i}
            header={w.header(ctx)}
            defaultCollapsed={w.defaultCollapsed ?? false}
            settingsOpen={settingsOpen}
            settingsPanelWidth={settingsPanelWidth}
          >
            {w.render(ctx)}
          </FloatingWidget>
        ) : null,
      )}
    </>
  );
}
