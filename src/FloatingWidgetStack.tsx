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
 *   <LayoutProvider dockBelow={1024}>
 *     <StackOriginReporter headerRef={pageHeaderRef} />
 *     <header ref={pageHeaderRef}>…</header>
 *     …page…
 *     <FloatingWidgetStack ref={stackRef} ctx={ctx} widgets={WIDGETS}
 *                          avoidRects={avoidRects} />
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
 *
 * Two presentations
 * -----------------
 * FLOAT (`dockBelow` unset, or a wide viewport): exactly the 0.1.0 behavior —
 * every widget self-portals to document.body and is placed by the coordinator
 * or by the user's drag.
 *
 * DOCK (viewport narrower than `dockBelow`): the stack renders ONE portal
 * holding a single docked surface, and the widgets render inline inside it as
 * an accordion. An accordion rather than tabs, because these widgets' summary
 * lines are the point — tabs would hide every widget but one; and rather than a
 * plain scrolling list, because N expanded widgets on a phone is unbounded
 * height.
 *
 * Nothing about the float state is touched while docked (see LayoutContext),
 * so crossing the breakpoint back and forth is lossless.
 */

import {
  useCallback,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useEffect,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

import { FloatingWidget, type FloatingWidgetHandle } from "./FloatingWidget";
import { useDock } from "./LayoutContext";
import type { AvoidRect } from "./avoid";
import { partProps, type PartClassNames, type PartStyling } from "./parts";
import type { WidgetDef } from "./types";

/** Elements a Tab cycle should visit inside a modal dock. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** What a custom dock trigger is handed. */
export interface DockTriggerApi {
  /** Always false — the trigger only renders while the dock is closed. */
  open: boolean;
  /** Flip the dock open. */
  toggle: () => void;
  setOpen: (open: boolean) => void;
  /**
   * One `peek(ctx)` (falling back to `header(ctx)`) per docked widget, in
   * registry order, so a closed dock can still show a glanceable summary.
   */
  peek: ReactNode[];
  /** How many widgets the dock is holding. */
  count: number;
}

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
  /** Open the docked surface. No-op in the float presentation. */
  openDock: () => void;
  /** Close the docked surface. */
  closeDock: () => void;
  /** Flip the docked surface open/closed. */
  toggleDock: () => void;
  /**
   * Whether the docked surface is open, read at call time.
   *
   * For DRIVING the dock this handle is fine. For REFLECTING its state in your
   * own chrome — a header icon that shows open vs closed — use `useDock()`
   * instead: a ref read can't re-render the component holding it, so an icon
   * derived from this would go stale.
   */
  isDockOpen: () => boolean;
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
  /**
   * Regions every widget should stay clear of, in viewport coordinates — a
   * side sheet, the software keyboard, a toast stack. Each widget slides by
   * only as much as it needs, as a transform, so stored positions are
   * untouched. `useAvoidRects([sheetRef])` measures live elements for you.
   * Ignored while docked.
   */
  avoidRects?: readonly AvoidRect[];
  /**
   * Optional localStorage namespace, prefixed to each widget id, so two apps
   * sharing an origin don't collide on `widget:<id>` keys. Omit for the
   * historical single-app behavior (bare ids).
   */
  storagePrefix?: string;
  /**
   * Class overrides keyed by `data-fw-part`, applied to every widget and to the
   * dock chrome. Appended to the defaults — see `parts.ts` for the part list
   * and for why appending (rather than merging) is the contract.
   */
  classNames?: PartClassNames;
  /** Drop all default classes; keep structure, data attributes and geometry. */
  unstyled?: boolean;
  /** Accessible name for the docked surface and its trigger. Default "Widgets". */
  dockLabel?: string;
  /**
   * Replace the default closed-dock affordance. Return `null` if your own
   * chrome drives the dock (a header toggle wired to `useDock()`), so the dock
   * renders nothing at all while closed.
   */
  renderDockTrigger?: (api: DockTriggerApi) => ReactNode;
  /**
   * Treat the open dock as a modal: render a scrim, mark the surface
   * `role="dialog" aria-modal`, trap Tab inside it, and close on scrim click.
   * Default false — the dock is a persistent HUD, and trapping focus in one
   * would strand keyboard users on the rest of the page.
   */
  dockModal?: boolean;
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
  avoidRects,
  storagePrefix,
  classNames,
  unstyled,
  dockLabel = "Widgets",
  renderDockTrigger,
  dockModal = false,
  ref,
}: FloatingWidgetStackProps<Ctx>) {
  // Imperative handles keyed by widget id. A callback ref populates this map;
  // an unmounted widget self-clears to null when React calls its ref with null.
  const refs = useRef<Record<string, FloatingWidgetHandle | null>>({});

  const { isDock, dockEdge, open, setOpen, toggle } = useDock();

  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // Where focus was when the dock opened, so closing can put it back. Captured
  // from document.activeElement rather than a trigger ref, because the trigger
  // may be the consumer's own chrome outside this component (or absent).
  const restoreFocusRef = useRef<Element | null>(null);
  // Seeded with the initial value so a dock that starts open (defaultDockOpen)
  // doesn't steal focus on mount — only genuine transitions move it.
  const prevOpenRef = useRef(open);

  const isMounted = useCallback(
    (w: WidgetDef<Ctx>) => (w.mountWhen ? w.mountWhen(ctx) : true),
    [ctx],
  );

  const openRef = useRef(open);
  openRef.current = open;

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
      openDock: () => setOpen(true),
      closeDock: () => setOpen(false),
      toggleDock: toggle,
      isDockOpen: () => openRef.current,
    }),
    [widgets, isMounted, setOpen, toggle],
  );

  // Focus into the panel on open; restore it on close. Runs only on real
  // transitions (see prevOpenRef) so mounting an already-open dock, or a
  // breakpoint crossing, doesn't yank focus out of whatever the user was doing.
  useEffect(() => {
    if (open === prevOpenRef.current) return;
    prevOpenRef.current = open;
    if (!isDock) return;
    if (open) {
      restoreFocusRef.current = document.activeElement;
      panelRef.current?.focus();
    } else {
      const prev = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (prev instanceof HTMLElement && document.contains(prev)) prev.focus();
    }
  }, [open, isDock]);

  const onPanelKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        return;
      }
      // Tab cycling, modal only — a non-modal HUD must let Tab leave.
      if (!dockModal || e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [dockModal, setOpen],
  );

  const styling: PartStyling = {
    presentation: isDock ? "dock" : "float",
    classNames,
    unstyled,
  };

  // Widgets to show in the dock: mounted, minus any the app has excluded from
  // the docked presentation. Registry index is kept as `order` so a widget's
  // identity is the same in both presentations.
  const dockEntries = useMemo(
    () =>
      widgets
        .map((w, i) => ({ w, i }))
        .filter(
          ({ w }) => isMounted(w) && (w.dockWhen ? w.dockWhen(ctx) : true),
        ),
    [widgets, isMounted, ctx],
  );

  // ── Float presentation — unchanged from 0.1.0 ────────────────────────────
  if (!isDock) {
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
              avoidRects={avoidRects}
              classNames={classNames}
              widgetClassNames={w.classNames}
              unstyled={unstyled}
            >
              {w.render(ctx)}
            </FloatingWidget>
          ) : null,
        )}
      </>
    );
  }

  // ── Dock presentation ────────────────────────────────────────────────────
  // Geometry is inline and owned by the library; everything else is the
  // consumer's. The container is pointer-transparent so a closed (or narrow)
  // dock never swallows clicks meant for the page behind it — only the panel
  // and the trigger take pointer events back.
  const dockStyle: CSSProperties = {
    position: "fixed",
    pointerEvents: "none",
    // A custom property so the stacking order is overridable from CSS without
    // another prop. csstype types zIndex as number-or-keyword, hence the cast.
    zIndex: "var(--fw-dock-z, 50)" as unknown as number,
    // Safe-area insets are geometry, and the dock is the one surface in this
    // package pinned to a viewport edge — on an iPhone a bottom dock otherwise
    // renders under the home indicator, putting its last row partly out of
    // reach, and a landscape dock runs under the notch.
    ...(dockEdge === "bottom"
      ? {
          left: 0,
          right: 0,
          bottom: 0,
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)",
        }
      : {
          top: 0,
          bottom: 0,
          right: 0,
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingRight: "env(safe-area-inset-right)",
        }),
  };

  const peek = dockEntries.map(({ w }) => (w.peek ?? w.header)(ctx));

  const trigger = renderDockTrigger ? (
    renderDockTrigger({ open, toggle, setOpen, peek, count: dockEntries.length })
  ) : (
    <button
      type="button"
      {...partProps("dockTrigger", styling)}
      style={{ pointerEvents: "auto" }}
      aria-expanded={false}
      aria-label={`Show ${dockLabel}`}
      onClick={() => setOpen(true)}
    >
      {peek[0] ?? dockLabel}
    </button>
  );

  return createPortal(
    <>
      {dockModal && open && (
        <div
          {...partProps("dockBackdrop", styling)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: "var(--fw-dock-z, 50)" as unknown as number,
          }}
          onClick={() => setOpen(false)}
        />
      )}
      <div
        {...partProps("dock", styling)}
        data-state={open ? "open" : "closed"}
        data-edge={dockEdge}
        style={dockStyle}
      >
        {open ? (
          <div
            ref={panelRef}
            id={panelId}
            {...partProps("dockPanel", styling)}
            // A persistent HUD is a region, not a dialog — unless the consumer
            // explicitly asked for modal behavior, which brings the scrim and
            // the Tab trap with it.
            role={dockModal ? "dialog" : "region"}
            aria-modal={dockModal ? true : undefined}
            aria-label={dockLabel}
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
            style={{
              pointerEvents: "auto",
              ...(dockEdge === "right" ? { height: "100%" } : null),
            }}
          >
            <div
              {...partProps("dockList", styling)}
              style={{
                // Containment is geometry: N expanded widgets must never grow
                // past the viewport, including when `unstyled` drops every
                // class. `dvh` rather than `vh` because iOS Safari's `vh`
                // ignores the dynamic toolbar and would overshoot the screen.
                maxHeight: "var(--fw-dock-max-h, 60dvh)",
                overflowY: "auto",
              }}
            >
              {dockEntries.map(({ w, i }) => (
                <FloatingWidget
                  key={w.id}
                  ref={(h) => {
                    refs.current[w.id] = h;
                  }}
                  id={storagePrefix ? `${storagePrefix}:${w.id}` : w.id}
                  order={i}
                  header={w.header(ctx)}
                  defaultCollapsed={w.defaultCollapsed ?? false}
                  classNames={classNames}
                  widgetClassNames={w.classNames}
                  unstyled={unstyled}
                >
                  {w.render(ctx)}
                </FloatingWidget>
              ))}
            </div>
          </div>
        ) : (
          trigger
        )}
      </div>
    </>,
    document.body,
  );
}
