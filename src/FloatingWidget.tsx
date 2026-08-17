// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * FloatingWidget — one widget's chrome, in either of two presentations.
 *
 * FLOAT (the 0.1.0 behavior, unchanged): a draggable panel that is either
 * "snapped" (placed by the LayoutContext coordinator) or "floating" (user-owned
 * absolute position). Renders via React Portal (document.body), position:fixed.
 * Drag is pointer events + setPointerCapture — no external library, React 19
 * compatible, zero re-renders during a drag gesture. (#156, coordinator #257.)
 *
 * DOCK (0.2.0): the same widget as one row of the docked accordion. Renders
 * INLINE — the stack owns the single portal in this presentation — with no
 * grip, no drag, no coordinator registration and no position writes. Only
 * collapse state is live, and it is the same collapse state as float, read
 * from the same localStorage entry.
 *
 * Switching presentation remounts this component (its parent in the element
 * tree changes). That is accepted rather than worked around: every persistent
 * concern — collapsed, mode, position — lives in localStorage and is re-read on
 * mount, and the only transient state is a drag in progress and the z-order,
 * both meaningless in the dock. Preserving the instance would mean a mutable
 * portal target and an extra render for no user-visible benefit.
 *
 * Snapped vs floating
 * -------------------
 *   - snapped  → `left` is the right-edge anchor and `top` is DERIVED from the
 *                coordinator (`topFor(id)` = stackOrigin + heights stacked
 *                above). The widget registers its `order` and reports its
 *                measured height (ResizeObserver) so siblings reflow when it
 *                collapses/expands. The stored position is ignored.
 *   - floating → `left`/`top` come from the persisted `state.position`, clamped
 *                to the viewport AT READ TIME (see useWidgetLayout's header:
 *                the stored value is the user's intent and is never rewritten
 *                to fit a narrower window).
 * Dragging the grip flips the widget to floating (the user takes ownership);
 * the parent's SnapTo flips every widget back to snapped via the ref handle.
 *
 * Header layout:
 *   [Grip | drag-only zone]  [header content · click to expand/collapse]  [Chevron]
 *
 * The header content and chevron both toggle collapse on click. The grip
 * is exclusively a drag affordance (pointer events only, no click action).
 * The chevron is the *accessible* control — it carries aria-expanded and
 * aria-controls. The header content stays a plain click target rather than a
 * <button>, deliberately: it holds arbitrary consumer markup from
 * `WidgetDef.header`, and wrapping that in a button would nest interactive
 * elements for any consumer whose summary line contains one.
 *
 * Sizing: the width is emitted as `--fw-widget-width` (default 17rem) so it is
 * overridable from CSS. Every geometry computation that depends on it — the
 * right-edge anchor, the drag clamp, the snap-zone test — measures the node's
 * offsetWidth rather than assuming WIDGET_W, so an override stays consistent.
 *
 * Bring-to-front: any mousedown increments a module-level z-counter and
 * updates the node's style.zIndex directly — no setState, no re-render.
 *
 * Position, collapsed state, and mode persist to localStorage via
 * useWidgetLayout.
 *
 * ref handle: exposes reset() and snap() so a parent can flip all widgets back
 * under the coordinator in one call (SessionFlow.snapAllToCorner).
 */

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";

import { avoidOffset, type AvoidRect } from "./avoid";
import { useDock, useLayout } from "./LayoutContext";
import { partProps, type PartClassNames, type PartStyling } from "./parts";
import {
  clampPosition,
  useWidgetLayout,
  WIDGET_W,
  WIDGET_MARGIN,
  type WidgetPosition,
} from "./useWidgetLayout";

/** Module-level z counter — direct DOM mutation keeps it out of React state. */
let zTop = 50;

/** Default X for a right-edge-anchored widget at the *current* viewport width.
 *  Read at call time (not frozen at mount) so the snapped anchor and the
 *  mount default both track window resizes — widening lands on the true edge.
 *  Takes the measured width so a `--fw-widget-width` override still anchors
 *  flush to the edge. */
function rightEdgeX(width: number): number {
  if (typeof window === "undefined") return 0;
  return Math.max(0, window.innerWidth - width - WIDGET_MARGIN);
}

/** Pointer travel (px) separating a click from the start of a drag — sub-slop
 *  movement is ignored so a press-and-release never begins a drag. */
const DRAG_START_SLOP = 5;
/** Horizontal distance (px) from the right-edge dock anchor within which a
 *  released drag re-docks (snaps) instead of staying floating. The inverse of
 *  the footprint snap-back: drop a widget back near the dock and it re-joins
 *  the coordinator stack at its canonical slot. x-only — snaps anywhere along
 *  the right edge regardless of vertical position. */
const SNAP_ZONE = 96;
/** Position transitions. Kept as constants because they're re-applied by hand
 *  when restoring after a click or a snap-back: in those cases the widget stays
 *  snapped, so React sees no style change and won't re-set the inline value. */
const SNAPPED_TRANSITION =
  "top 200ms ease-out, left 200ms ease-out, transform 200ms ease-out";
const FLOATING_TRANSITION = "transform 200ms ease-out";

/** Imperative handle exposed to parents via ref. */
export interface FloatingWidgetHandle {
  /** Reset position + collapsed state + mode to their original defaults. */
  reset: () => void;
  /**
   * Flip the widget back to "snapped" — the coordinator re-derives its top
   * and it tracks the header + reflows around its snapped siblings. Preserves
   * collapsed state (non-collapsing snap, #257). Used by snapAllToCorner().
   */
  snap: () => void;
}

type FloatingWidgetProps = {
  /** Unique stable ID — keys the localStorage entry and the coordinator slot. */
  id: string;
  /** Stack position (0-based) within the snapped stack. Lower sits higher. */
  order: number;
  /** Always shown in the widget header. */
  header: React.ReactNode;
  /** Panel body — shown when not collapsed. */
  children: React.ReactNode;
  /** Whether the widget starts collapsed. Default false. */
  defaultCollapsed?: boolean;
  /** Y used only as the floating fallback before the widget is ever dragged.
   *  Snapped widgets ignore this (the coordinator derives top). Default 64. */
  defaultFloatY?: number;
  /**
   * Regions to keep clear — a side sheet, the software keyboard, a toast
   * stack. The widget slides by *only* as much as needed to escape them; one
   * already clear doesn't move. The shift is a CSS transform, so the stored
   * left/top are untouched and removing the rect springs the widget back to
   * exactly where it was — unless the user dragged it while shifted, in which
   * case it stays put.
   *
   * Snapped widgets move on x only (the coordinator owns their y). Float
   * presentation only: a docked widget has nothing to get out of the way of.
   */
  avoidRects?: readonly AvoidRect[];
  /** Stack-level class overrides, keyed by `data-fw-part`. */
  classNames?: PartClassNames;
  /** Per-widget class overrides, applied after the stack-level ones. */
  widgetClassNames?: PartClassNames;
  /** Drop all default classes; keep structure, data attributes and geometry. */
  unstyled?: boolean;
};

export const FloatingWidget = forwardRef<FloatingWidgetHandle, FloatingWidgetProps>(
  function FloatingWidget({
    id,
    order,
    header,
    children,
    defaultCollapsed = false,
    defaultFloatY = 64,
    avoidRects,
    classNames,
    widgetClassNames,
    unstyled,
  }, ref) {
    // Default position computed once on mount — right edge of viewport.
    const defaultPos = useRef<WidgetPosition>({
      x: rightEdgeX(WIDGET_W),
      y: defaultFloatY,
    });

    const { state, setPosition, setCollapsed, snap, reset } = useWidgetLayout(
      id,
      defaultCollapsed,
      defaultPos.current,
    );

    // The coordinator — derives `top` for snapped widgets and reflows them
    // around each other's measured heights.
    const { registerSnapped, unregisterSnapped, setHeight, topFor } = useLayout();
    const { isDock } = useDock();

    const snapped = state.mode === "snapped";

    const nodeRef  = useRef<HTMLDivElement>(null);
    const zRef     = useRef(++zTop);
    const bodyId   = useId();
    const dragStart = useRef<{
      mouseX: number; mouseY: number;
      startX: number; startY: number;
      width: number; height: number;
    } | null>(null);
    // True once the pointer has travelled past DRAG_START_SLOP since pointerdown.
    // Separates a click (press + release in place) from a real drag.
    const dragMoved = useRef(false);

    const styling: PartStyling = {
      presentation: isDock ? "dock" : "float",
      classNames,
      widgetClassNames,
      unstyled,
    };

    /** The node's real width, or the default before it has been measured. */
    function measuredWidth(): number {
      return nodeRef.current?.offsetWidth || WIDGET_W;
    }

    // ── Coordinator registration + height reporting ──────────────────────────
    // While snapped AND floating-presentation: register this slot and feed the
    // coordinator our measured outer height so siblings reflow when we
    // collapse/expand. While floating, docked, or on unmount: unregister so the
    // stack gap closes. Docked widgets are laid out by the dock, so they must
    // stay out of the coordinator entirely.
    useLayoutEffect(() => {
      if (isDock || !snapped) {
        unregisterSnapped(id);
        return;
      }
      registerSnapped(id, order);
      const node = nodeRef.current;
      if (!node) return;
      setHeight(id, node.offsetHeight);
      const ro = new ResizeObserver(() => setHeight(id, node.offsetHeight));
      ro.observe(node);
      return () => {
        ro.disconnect();
        unregisterSnapped(id);
      };
    }, [isDock, snapped, id, order, registerSnapped, unregisterSnapped, setHeight]);

    // Re-read derived geometry on resize. Snapped widgets re-anchor to the
    // right edge; floating widgets re-run the read-time clamp (which replaced
    // 0.1.0's clamp-and-save, so the resize no longer destroys their stored
    // position). Both presentations listen — the dock ignores the result.
    const [, forceTick] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      const onResize = () => forceTick();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, []);

    // One tick after mount so the first paint's WIDGET_W assumption is replaced
    // by the node's real width — otherwise a consumer that overrides
    // --fw-widget-width would anchor off the right edge until something else
    // re-rendered.
    useLayoutEffect(() => {
      forceTick();
    }, []);

    // ── Minimal shift out of the way of `avoidRects` (was #270) ──────────────
    // Slide this widget by *only* as much as needed to escape the rects — one
    // already clear computes {0,0} and doesn't move. The shift is a CSS
    // transform, so stored left/top are untouched and removing the rect springs
    // the widget back. `shiftRef` mirrors the state for the pointer handlers
    // (which close over stale state otherwise).
    const ZERO_SHIFT = { x: 0, y: 0 };
    const [shift, setShift] = useState<{ x: number; y: number }>(ZERO_SHIFT);
    const shiftRef = useRef<{ x: number; y: number }>(ZERO_SHIFT);
    function applyShift(v: { x: number; y: number }) {
      // Bail when unchanged: the effect below runs on every avoidRects change,
      // and an unconditional setState there would re-render → re-run → loop.
      if (shiftRef.current.x === v.x && shiftRef.current.y === v.y) return;
      shiftRef.current = v;
      setShift(v);
    }
    // The widget's current rendered left — derived (right edge) when snapped,
    // stored-and-clamped position when floating. Used as the shift baseline and
    // the drag start.
    function currentLeft(): number {
      const w = measuredWidth();
      return snapped ? rightEdgeX(w) : clampPosition(state.position, w).x;
    }
    function currentTop(): number {
      return snapped ? topFor(id) : clampPosition(state.position, measuredWidth()).y;
    }
    // Depend on the rects' VALUES, not the array's identity. A consumer passing
    // an inline `[{...}]` would otherwise give this effect a new dep every
    // render; combined with the setState it does, that is an infinite loop.
    // Serializing makes the hook correct regardless of caller memoization.
    const avoidKey = (avoidRects ?? [])
      .map((r) => `${r.left},${r.top},${r.right},${r.bottom}`)
      .join("|");

    useEffect(() => {
      // A docked widget has nothing to dodge and no inline position to shift.
      if (isDock || !avoidRects || avoidRects.length === 0) {
        // Spring back — a no-op if a mid-shift drag already committed
        // (onGripPointerDown bakes the shift into left/top and clears it).
        applyShift(ZERO_SHIFT);
        return;
      }
      const el = nodeRef.current;
      const width = el?.offsetWidth || WIDGET_W;
      const height = el?.offsetHeight || 0;
      // Read from the DOM where available so the baseline is where the widget
      // actually is, not where a mid-animation state says it should be.
      const left = el ? parseFloat(el.style.left) || currentLeft() : currentLeft();
      const top = el ? parseFloat(el.style.top) || currentTop() : currentTop();
      applyShift(
        avoidOffset(
          { left, top, width, height },
          avoidRects,
          // The coordinator owns y for snapped widgets — moving one vertically
          // would slide it into siblings that don't know to reflow.
          snapped ? "x" : "xy",
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
      // A drag while shifted commits via onGripPointerDown rather than by
      // re-running this effect.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [avoidKey, isDock, snapped]);

    // Expose reset() + snap() to parent (see snapAllToCorner in SessionFlow).
    useImperativeHandle(ref, () => ({
      reset,
      snap: () => snap(),
    }));

    // ── Bring-to-front (direct DOM — never triggers a re-render) ─────────────
    function bringToFront() {
      zRef.current = ++zTop;
      if (nodeRef.current) nodeRef.current.style.zIndex = String(zRef.current);
    }

    // Returns x,y clamped so the widget stays within the viewport.
    // Reads actual offsetWidth from the DOM so the clamp is exact.
    function clampDrag(x: number, y: number): { x: number; y: number } {
      const w = measuredWidth();
      return {
        x: Math.max(0, Math.min(x, window.innerWidth  - w)),
        y: Math.max(0, Math.min(y, window.innerHeight - 40)),
      };
    }

    // ── Drag handlers (pointer events on the grip span) ──────────────────────
    function onGripPointerDown(e: React.PointerEvent<HTMLSpanElement>) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      bringToFront();
      const node = nodeRef.current;
      // Kill the position transition for the duration of the drag so pointer
      // moves track the cursor 1:1 (no lag). React restores the inline
      // transition on the next render (after setPosition flips to floating).
      if (node) node.style.transition = "none";
      // If shifted out of an avoided rect's way, a drag means the user is
      // deliberately repositioning. Bake the transform offset into the stored
      // left/top (instantly, no animation) and clear the shift, so the widget
      // stays where the user put it when the rect goes away instead of
      // springing back — which also guards against restoring it off-screen.
      if (node && (shiftRef.current.x !== 0 || shiftRef.current.y !== 0)) {
        const baseLeft = parseFloat(node.style.left) || currentLeft();
        const baseTop = parseFloat(node.style.top) || currentTop();
        const bakedX = baseLeft + shiftRef.current.x;
        const bakedY = baseTop + shiftRef.current.y;
        node.style.left = `${bakedX}px`;
        node.style.top = `${bakedY}px`;
        node.style.transform = "";
        setPosition({ x: bakedX, y: bakedY });
        applyShift(ZERO_SHIFT);
      }
      // Read current DOM position so the drag starts from wherever the widget
      // actually is (may differ from state.position when snapped/mid-animation).
      const el = nodeRef.current;
      const startX = el ? parseFloat(el.style.left) || currentLeft() : currentLeft();
      const startY = el ? parseFloat(el.style.top)  || currentTop()  : currentTop();
      // Capture the widget's footprint so pointerup can decide whether a snapped
      // widget has cleared its own slot (detach → floating) or merely jiggled
      // (snap back). Equal-size rects stop overlapping once separated by a full
      // width on x OR a full height on y.
      const width  = el?.offsetWidth  ?? WIDGET_W;
      const height = el?.offsetHeight ?? 0;
      dragStart.current = { mouseX: e.clientX, mouseY: e.clientY, startX, startY, width, height };
      dragMoved.current = false;
    }

    function onGripPointerMove(e: React.PointerEvent<HTMLSpanElement>) {
      const start = dragStart.current;
      if (!start || !nodeRef.current) return;
      const dx = e.clientX - start.mouseX;
      const dy = e.clientY - start.mouseY;
      // Slop gate: ignore sub-threshold travel so a press-and-release never
      // begins a drag (and never flips a snapped widget to floating). Once the
      // gesture crosses the threshold it stays a drag for the rest of the press.
      if (!dragMoved.current && Math.hypot(dx, dy) < DRAG_START_SLOP) return;
      dragMoved.current = true;
      // Clamp during drag so the widget never escapes the viewport.
      const { x, y } = clampDrag(start.startX + dx, start.startY + dy);
      nodeRef.current.style.left = `${x}px`;
      nodeRef.current.style.top  = `${y}px`;
    }

    function onGripPointerUp(e: React.PointerEvent<HTMLSpanElement>) {
      const start = dragStart.current;
      if (!start) return;
      dragStart.current = null;
      const node = nodeRef.current;

      // ── Click (never crossed the slop) → pure no-op ──────────────────────
      // The widget didn't move, so nothing to commit. Just restore the inline
      // transition we killed on pointerdown. React won't re-apply it for a
      // still-snapped widget (it sees no style change), so set it by hand.
      if (!dragMoved.current) {
        if (node) node.style.transition = snapped ? SNAPPED_TRANSITION : FLOATING_TRANSITION;
        return;
      }
      dragMoved.current = false;

      const { x, y } = clampDrag(
        start.startX + (e.clientX - start.mouseX),
        start.startY + (e.clientY - start.mouseY),
      );

      const nearDock = Math.abs(x - rightEdgeX(measuredWidth())) <= SNAP_ZONE;

      // ── Snapped widget: detach only if it cleared its own footprint AND
      //    wasn't dropped back near the dock ─────────────────────────────────
      if (snapped) {
        const clearedFootprint =
          Math.abs(x - start.startX) >= start.width ||
          Math.abs(y - start.startY) >= start.height;
        if (clearedFootprint && !nearDock) {
          // Left its slot entirely and released away from the dock → take
          // ownership, flip to floating.
          setPosition({ x, y });
        } else if (node) {
          // Stayed within its slot, OR dropped back near the dock → snap home.
          // Restore the transition (by hand — still snapped, so React won't)
          // and animate to the coordinator's derived position.
          node.style.transition = SNAPPED_TRANSITION;
          node.style.left = `${currentLeft()}px`;
          node.style.top  = `${currentTop()}px`;
        }
        return;
      }

      // ── Floating widget: re-dock if dropped near the dock, else commit ────
      // the new floating position. snap() flips mode → snapped, so a re-render
      // reconciles left/top to the coordinator's slot and animates it home.
      if (nearDock) {
        snap();
      } else {
        setPosition({ x, y });
      }
    }

    const isCollapsed = state.collapsed;

    /* ── Shared chrome ──────────────────────────────────────────────────────
       The header row and body are identical in both presentations; only the
       grip and the wrapper differ. `grip` is passed in rather than branched on
       inside, so the float path keeps its exact 0.1.0 markup. */
    function chrome(grip: React.ReactNode) {
      return (
        <div {...partProps("card", styling)}>

          {/* ── Header ──────────────────────────────────────────────────── */}
          <div {...partProps("header", styling)}>

            {grip}

            {/* Header content — click anywhere here to expand / collapse.
                A plain click target, not a <button>: it holds arbitrary
                consumer markup and must not nest interactive elements. */}
            <div
              {...partProps("title", styling)}
              onClick={() => setCollapsed(!isCollapsed)}
            >
              {header}
            </div>

            {/* Chevron — the accessible expand/collapse control */}
            <button
              type="button"
              {...partProps("toggle", styling)}
              aria-expanded={!isCollapsed}
              aria-controls={isCollapsed ? undefined : bodyId}
              title={isCollapsed ? "Expand" : "Collapse"}
              onClick={() => setCollapsed(!isCollapsed)}
            >
              {isCollapsed
                ? <ChevronDown className="h-4 w-4" />
                : <ChevronUp   className="h-4 w-4" />}
            </button>
          </div>

          {/* ── Body ────────────────────────────────────────────────────── */}
          {!isCollapsed && (
            <div id={bodyId} {...partProps("body", styling)}>
              {children}
            </div>
          )}

        </div>
      );
    }

    // ── Dock presentation: inline, no portal, no drag, no positioning ────────
    if (isDock) {
      return (
        <div
          ref={nodeRef}
          {...partProps("root", styling)}
          data-fw-id={id}
          data-presentation="dock"
          data-state={isCollapsed ? "collapsed" : "expanded"}
        >
          {chrome(null)}
        </div>
      );
    }

    // ── Float presentation ───────────────────────────────────────────────────
    return createPortal(
      <div
        ref={nodeRef}
        {...partProps("root", styling)}
        data-fw-id={id}
        data-presentation="float"
        data-mode={snapped ? "snapped" : "floating"}
        data-state={isCollapsed ? "collapsed" : "expanded"}
        style={{
          position: "fixed",
          left: currentLeft(),
          top: currentTop(),
          zIndex: zRef.current,
          // Emitted as a custom property so the width is overridable from CSS
          // without a prop. All geometry that depends on it measures the node.
          width: "var(--fw-widget-width, 17rem)",
          // Minimal shift out of `avoidRects`' way, computed per-widget in the
          // effect above. Applied as a transform so the stored left/top are
          // untouched — removing the rect springs back to the prior position
          // with no re-snap. The transition is the "spring back"; transform
          // doesn't affect hit-testing, so the widget stays interactive while
          // shifted.
          transform:
            shift.x || shift.y
              ? `translate(${shift.x}px, ${shift.y}px)`
              : undefined,
          // Snapped widgets animate `top` so coordinator reflow (a sibling
          // collapsing/expanding, the header banner toggling) glides instead of
          // jumping. Floating widgets only animate the Settings-shift transform;
          // their drag mutates `top` directly with the transition killed.
          transition: snapped ? SNAPPED_TRANSITION : FLOATING_TRANSITION,
        }}
        // Pointer, not mouse: a touch on a widget must raise it too, or on a
        // touch device the z-order can only ever be changed by dragging.
        onPointerDown={bringToFront}
      >
        {chrome(
          /* Grip — drag affordance only, no click action */
          <span
            {...partProps("grip", styling)}
            style={{
              // Drag correctness, so inline rather than in the default class:
              // without touch-action:none a touch drag scrolls the page instead
              // of moving the widget, and `unstyled` would otherwise silently
              // remove the only thing making drag work on a phone or iPad.
              touchAction: "none",
              userSelect: "none",
            }}
            onPointerDown={onGripPointerDown}
            onPointerMove={onGripPointerMove}
            onPointerUp={onGripPointerUp}
          >
            <GripVertical className="h-4 w-4" />
          </span>,
        )}
      </div>,
      document.body,
    );
  }
);
