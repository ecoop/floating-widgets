// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * FloatingWidget — a draggable panel that is either "snapped" (placed by the
 * LayoutContext coordinator) or "floating" (user-owned absolute position).
 * (#156, coordinator #257.)
 *
 * Always renders via React Portal (document.body), always position: fixed.
 * Drag is implemented with pointer events + setPointerCapture — no external
 * library, React 19 compatible, zero re-renders during a drag gesture.
 *
 * Snapped vs floating
 * -------------------
 *   - snapped  → `left` is the right-edge anchor and `top` is DERIVED from the
 *                coordinator (`topFor(id)` = stackOrigin + heights stacked
 *                above). The widget registers its `order` and reports its
 *                measured height (ResizeObserver) so siblings reflow when it
 *                collapses/expands. The stored position is ignored.
 *   - floating → `left`/`top` come from the persisted `state.position`.
 * Dragging the grip flips the widget to floating (the user takes ownership);
 * the parent's SnapTo flips every widget back to snapped via the ref handle.
 *
 * Header layout:
 *   [Grip | drag-only zone]  [header content · click to expand/collapse]  [Chevron]
 *
 * The header content and chevron both toggle collapse on click. The grip
 * is exclusively a drag affordance (pointer events only, no click action).
 *
 * Bring-to-front: any mousedown increments a module-level z-counter and
 * updates the node's style.zIndex directly — no setState, no re-render.
 *
 * Drag clamping: pointer move and pointer up clamp to the viewport using the
 * widget's actual offsetWidth so the grip is always reachable.
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
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";

import { useLayout } from "./LayoutContext";
import {
  useWidgetLayout,
  WIDGET_W,
  WIDGET_MARGIN,
  type WidgetPosition,
} from "./useWidgetLayout";

/** Module-level z counter — direct DOM mutation keeps it out of React state. */
let zTop = 50;

/** Default X for a right-edge-anchored widget at the *current* viewport width.
 *  Read at call time (not frozen at mount) so the snapped anchor and the
 *  mount default both track window resizes — widening lands on the true edge. */
function rightEdgeX(): number {
  return Math.max(0, window.innerWidth - WIDGET_W - WIDGET_MARGIN);
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
   * Whether the Settings sheet is open (#270). When true the widget slides
   * left by *only* as much as needed to clear the panel (see settingsPanelWidth);
   * a widget already clear of the panel doesn't move. The shift is a CSS
   * transform (x-only), so the stored left/top are untouched and closing the
   * sheet springs the widget back to exactly where it was — unless the user
   * dragged it while shifted, in which case it stays put. Default false.
   */
  settingsOpen?: boolean;
  /**
   * Width (px) of the Settings sheet, used to compute the panel's left edge
   * (innerWidth − settingsPanelWidth) and hence each widget's minimal shift.
   * Default 448 (28rem, shadcn `sm:max-w-md`).
   */
  settingsPanelWidth?: number;
};

export const FloatingWidget = forwardRef<FloatingWidgetHandle, FloatingWidgetProps>(
  function FloatingWidget({
    id,
    order,
    header,
    children,
    defaultCollapsed = false,
    defaultFloatY = 64,
    settingsOpen = false,
    settingsPanelWidth = 448,
  }, ref) {
    // Default position computed once on mount — right edge of viewport.
    const defaultPos = useRef<WidgetPosition>({
      x: rightEdgeX(),
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

    const snapped = state.mode === "snapped";

    const nodeRef  = useRef<HTMLDivElement>(null);
    const zRef     = useRef(++zTop);
    const dragStart = useRef<{
      mouseX: number; mouseY: number;
      startX: number; startY: number;
      width: number; height: number;
    } | null>(null);
    // True once the pointer has travelled past DRAG_START_SLOP since pointerdown.
    // Separates a click (press + release in place) from a real drag.
    const dragMoved = useRef(false);

    // ── Coordinator registration + height reporting ──────────────────────────
    // While snapped: register this slot and feed the coordinator our measured
    // outer height so siblings reflow when we collapse/expand. While floating
    // (or on unmount): unregister so the stack gap closes.
    useLayoutEffect(() => {
      if (!snapped) {
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
    }, [snapped, id, order, registerSnapped, unregisterSnapped, setHeight]);

    // Snapped widgets track the right edge on window resize. (Floating widgets
    // are re-clamped by useWidgetLayout; this just re-reads rightEdgeX/topFor.)
    const [, forceTick] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      if (!snapped) return;
      const onResize = () => forceTick();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, [snapped]);

    // ── Settings-aware minimal X-shift (#270) ────────────────────────────────
    // When the Settings sheet opens, slide this widget left by *only* as much
    // as needed to clear the panel — a widget already left of the panel edge
    // computes 0 and doesn't move. The shift is a CSS transform (x-only), so
    // stored left/top are untouched and closing the sheet springs the widget
    // back. `shiftRef` mirrors the state for the pointer handlers (which close
    // over stale state otherwise).
    const [shift, setShift] = useState(0);
    const shiftRef = useRef(0);
    function applyShift(v: number) {
      shiftRef.current = v;
      setShift(v);
    }
    // The widget's current rendered left — derived (right edge) when snapped,
    // stored position when floating. Used as the shift baseline and drag start.
    function currentLeft(): number {
      return snapped ? rightEdgeX() : state.position.x;
    }
    function currentTop(): number {
      return snapped ? topFor(id) : state.position.y;
    }
    useEffect(() => {
      if (settingsOpen) {
        const el = nodeRef.current;
        const w = el?.offsetWidth ?? 272;
        const left = el ? parseFloat(el.style.left) || currentLeft() : currentLeft();
        const panelLeft = window.innerWidth - settingsPanelWidth;
        const gap = 16;
        const overlap = left + w + gap - panelLeft;
        applyShift(overlap > 0 ? -overlap : 0);
      } else {
        // Spring back to 0 — a no-op if a mid-open drag already committed
        // (onGripPointerDown bakes the shift into `left` and clears it).
        applyShift(0);
      }
      // Recompute only on open/close (or panel resize); a drag while open
      // commits via onGripPointerDown rather than re-running this effect.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settingsOpen, settingsPanelWidth]);

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
      const w = nodeRef.current?.offsetWidth ?? 272;
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
      // If shifted out of the Settings sheet's way, a drag means the user is
      // deliberately repositioning. Bake the transform offset into the stored
      // `left` (instantly, no animation) and clear the shift, so the widget
      // stays where the user put it when Settings closes instead of springing
      // back — which also guards against restoring it off the right edge.
      if (node && shiftRef.current !== 0) {
        const baseLeft = parseFloat(node.style.left) || currentLeft();
        const baked = baseLeft + shiftRef.current;
        node.style.left = `${baked}px`;
        node.style.transform = "";
        setPosition({ x: baked, y: currentTop() });
        applyShift(0);
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

      const nearDock = Math.abs(x - rightEdgeX()) <= SNAP_ZONE;

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

    return createPortal(
      <div
        ref={nodeRef}
        style={{
          position: "fixed",
          left: currentLeft(),
          top: currentTop(),
          zIndex: zRef.current,
          width: "17rem",
          // X-only minimal shift out of the Settings sheet's way (#270),
          // computed per-widget in the effect above. Applied as a transform so
          // the stored left/top are untouched — closing Settings springs back
          // to the prior position with no re-snap. The transition is the
          // "spring back"; transform doesn't affect hit-testing, so the widget
          // stays interactive while shifted.
          transform: shift ? `translateX(${shift}px)` : undefined,
          // Snapped widgets animate `top` so coordinator reflow (a sibling
          // collapsing/expanding, the header banner toggling) glides instead of
          // jumping. Floating widgets only animate the Settings-shift transform;
          // their drag mutates `top` directly with the transition killed.
          transition: snapped ? SNAPPED_TRANSITION : FLOATING_TRANSITION,
        }}
        onMouseDown={bringToFront}
      >
        <div className="rounded-lg border bg-card text-card-foreground shadow-lg overflow-hidden">

          {/* ── Header ──────────────────────────────────────────────────── */}
          <div className="flex items-center select-none">

            {/* Grip — drag affordance only, no click action */}
            <span
              className="flex items-center px-2 py-2 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground touch-none"
              onPointerDown={onGripPointerDown}
              onPointerMove={onGripPointerMove}
              onPointerUp={onGripPointerUp}
            >
              <GripVertical className="h-4 w-4" />
            </span>

            {/* Header content — click anywhere here to expand / collapse */}
            <div
              className="min-w-0 flex-1 overflow-hidden py-1.5 cursor-pointer"
              onClick={() => setCollapsed(!isCollapsed)}
            >
              {header}
            </div>

            {/* Chevron — secondary collapse toggle */}
            <button
              type="button"
              className="shrink-0 px-2 py-1.5 text-foreground/70 hover:text-foreground"
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
            <div className="border-t">
              {children}
            </div>
          )}

        </div>
      </div>,
      document.body,
    );
  }
);
