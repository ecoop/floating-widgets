// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * avoid — keep widgets clear of arbitrary screen regions.
 *
 * Generalizes what used to be `settingsOpen` / `settingsPanelWidth` (Pitchcraft
 * #270): "slide left out of the Settings sheet's way" was one consumer's
 * vocabulary for "don't overlap this rect", with the rect's geometry hardcoded
 * as a width measured from the right edge.
 *
 * The general form matters more than the tidy-up, because the same mechanism
 * covers cases the specific one couldn't express:
 *
 *   - a side sheet or drawer (the original case),
 *   - the iOS software keyboard, which is a bottom rect and needs an UPWARD
 *     escape — impossible to say in terms of a right-edge panel width,
 *   - a toast stack, a floating action button, a video call PiP.
 *
 * Minimum-translation escape
 * --------------------------
 * For each overlapping rect we take the smallest displacement that clears it,
 * preferring a direction that keeps the widget on-screen. Direction falls out of
 * the geometry rather than being configured: a full-height side sheet can only
 * be escaped horizontally (a vertical escape would have to leave the viewport),
 * and a full-width keyboard only vertically. So the original Settings behavior
 * is reproduced by the general rule rather than special-cased inside it.
 *
 * Axis restriction
 * ----------------
 * Floating widgets may move on both axes — the user owns their position and
 * nothing is derived from it. SNAPPED widgets are restricted to x, because the
 * coordinator owns their y: shifting one vertically would slide it into its
 * siblings without the coordinator reflowing them. That restriction is the
 * existing model (LayoutContext derives `top` for snapped widgets), not a
 * special case for this feature.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * A region to keep clear, in viewport coordinates. Structurally satisfied by
 * `DOMRect`, so `element.getBoundingClientRect()` can be passed straight in.
 */
export interface AvoidRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The widget's current box, in viewport coordinates. */
export interface AvoidBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Which axes a widget is allowed to be displaced along. */
export type AvoidAxes = "x" | "xy";

/** Breathing room (px) left between a widget and a rect it is avoiding. */
export const AVOID_GAP = 16;

/** Passes over the rect list, so escaping rect A can't leave a widget in B. */
const MAX_PASSES = 3;

interface Candidate {
  axis: "x" | "y";
  d: number;
}

/**
 * The minimal offset that clears every rect, or `{x:0,y:0}` if the widget
 * already does. Pure — takes the viewport explicitly so it is testable and
 * SSR-inert.
 */
export function avoidOffset(
  box: AvoidBox,
  rects: readonly AvoidRect[],
  axes: AvoidAxes,
  viewport: { width: number; height: number },
  gap: number = AVOID_GAP,
): { x: number; y: number } {
  if (rects.length === 0) return { x: 0, y: 0 };

  let dx = 0;
  let dy = 0;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false;

    for (const r of rects) {
      if (r.right <= r.left || r.bottom <= r.top) continue; // empty rect

      const left = box.left + dx;
      const top = box.top + dy;
      const right = left + box.width;
      const bottom = top + box.height;

      // Overlap of the widget INFLATED by `gap` against the rect — so clearing
      // it leaves the gap rather than merely touching.
      const overlapX = Math.min(right + gap, r.right) - Math.max(left - gap, r.left);
      const overlapY = Math.min(bottom + gap, r.bottom) - Math.max(top - gap, r.top);
      if (overlapX <= 0 || overlapY <= 0) continue; // already clear

      const candidates: Candidate[] = [
        { axis: "x", d: r.left - gap - right },  // move left
        { axis: "x", d: r.right + gap - left },  // move right
      ];
      if (axes === "xy") {
        candidates.push(
          { axis: "y", d: r.top - gap - bottom }, // move up
          { axis: "y", d: r.bottom + gap - top }, // move down
        );
      }

      // Only escapes that keep the widget on-screen are allowed.
      //
      // When none does, the widget stays put. That case is real — a SNAPPED
      // widget is restricted to x, so a full-width rect (the keyboard) offers
      // it no viable escape at all. Taking the least-bad off-screen candidate
      // would shove it past the viewport edge, where it is unreachable AND
      // still not helping; staying put at least leaves it visible and
      // draggable. An unavoidable rect is the consumer's layout problem, and
      // silently hiding the widget would obscure it rather than surface it.
      const viable = candidates.filter((c) =>
        c.axis === "x"
          ? left + c.d >= 0 && left + c.d + box.width <= viewport.width
          : top + c.d >= 0 && top + c.d + box.height <= viewport.height,
      );
      if (viable.length === 0) continue;

      let best = viable[0];
      for (const c of viable) {
        if (Math.abs(c.d) < Math.abs(best.d)) best = c;
      }

      if (best.axis === "x") dx += best.d;
      else dy += best.d;
      moved = true;
    }

    if (!moved) break;
  }

  return { x: dx, y: dy };
}

/** One element's viewport box, or null if it isn't laid out (hidden/detached). */
function rectOf(el: Element): AvoidRect | null {
  const b = el.getBoundingClientRect();
  if (b.width === 0 && b.height === 0) return null;
  return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
}

function sameRects(a: readonly AvoidRect[], b: readonly AvoidRect[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (r, i) =>
      r.left === b[i].left &&
      r.top === b[i].top &&
      r.right === b[i].right &&
      r.bottom === b[i].bottom,
  );
}

/**
 * Measure live elements as `AvoidRect`s, for DOM the host renders itself.
 *
 * ONLY use this when the avoided element is mounted in the same commit as the
 * component calling this hook — a sidebar or panel you render inline. For
 * anything portaled, animated, or mounted from its own effect, use
 * `useAvoidElement` instead.
 *
 * Why the limit is structural, not a bug to patch: a `RefObject` cannot notify.
 * `ref.current` is mutated invisibly to React, so the only re-measure trigger
 * available here is a commit of the CALLING component. When a Radix portal
 * mounts it does so via state inside a descendant (`Portal` renders null until
 * its own layout effect sets `mounted`), which never re-renders the host — so
 * this hook measures once against `ref.current === null`, and nothing ever
 * tells it to look again. `useAvoidElement` takes a callback ref, which React
 * invokes whenever it attaches the element, however late that is.
 *
 * @deprecated Prefer `useAvoidElement`, which is correct for portaled and
 * animated content as well as inline DOM. Retained for host-owned DOM and for
 * measuring several elements through one hook.
 */
export function useAvoidRects(
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
): AvoidRect[] {
  const [rects, setRects] = useState<AvoidRect[]>([]);

  function measure() {
    const next: AvoidRect[] = [];
    for (const ref of refs) {
      const el = ref.current;
      if (!el) continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue; // hidden / unmounted
      next.push({ left: b.left, top: b.top, right: b.right, bottom: b.bottom });
    }
    setRects((prev) => (sameRects(prev, next) ? prev : next));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(measure);

  // Layout changes that don't trigger a host re-render: the element resizing
  // (an animating sheet) and viewport changes.
  useEffect(() => {
    const observers: ResizeObserver[] = [];
    for (const ref of refs) {
      const el = ref.current;
      if (!el) continue;
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      observers.push(ro);
    }
    window.addEventListener("resize", measure);
    return () => {
      for (const ro of observers) ro.disconnect();
      window.removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs.length]);

  return rects;
}

/**
 * Track one element as an `AvoidRect`, via a callback ref.
 *
 * The correct primitive for anything you do not mount yourself: Radix / shadcn
 * `Sheet`, `Dialog`, `Popover` and `DropdownMenu` portals, `Presence`-wrapped
 * animated content, or any component that mounts from its own effect. React
 * invokes a callback ref when it *attaches* the element — whenever that
 * happens, in the same commit or many commits later — so there is no window in
 * which the element exists and this hook hasn't seen it.
 *
 *   const [sheetRects, sheetRef] = useAvoidElement();
 *   <SheetContent ref={sheetRef}>…</SheetContent>
 *   <FloatingWidgetStack avoidRects={sheetRects} … />
 *
 * Returns an ARRAY (empty or one rect) so several avoided regions compose by
 * spreading, without the caller memoizing anything:
 *
 *   const [sheetRects, sheetRef] = useAvoidElement();
 *   const [toastRects, toastRef] = useAvoidElement();
 *   <FloatingWidgetStack avoidRects={[...sheetRects, ...toastRects]} … />
 *
 * Re-measures on: attach, the next animation frame, `ResizeObserver`,
 * `animationend`, `transitionend`, and window resize. The animation events
 * matter as much as the observer — a sheet that slides in with a transform
 * changes its box without changing its size, so `ResizeObserver` alone would
 * leave the rect at the off-screen position the animation started from.
 *
 * Not tracked: an avoided element that MOVES with scroll (i.e. is in normal
 * flow rather than fixed/absolute). Watching that means a
 * `getBoundingClientRect` per scroll frame, which is not worth the layout cost
 * for a HUD. Avoided regions are overlays in practice; if yours scrolls, build
 * the rect yourself and pass it to `avoidRects` directly.
 */
export function useAvoidElement(): [
  AvoidRect[],
  (el: HTMLElement | null) => void,
] {
  const [rects, setRects] = useState<AvoidRect[]>([]);
  // The element currently being observed, and the teardown for its listeners.
  const attachedRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  // Bumped on every attach and every detach request; a deferred detach only
  // runs if its generation is still current. This is what cancels a detach
  // that a re-attach has already superseded.
  const detachGenRef = useRef(0);

  const commit = useCallback((el: HTMLElement | null) => {
    const rect = el ? rectOf(el) : null;
    const next = rect ? [rect] : [];
    setRects((prev) => (sameRects(prev, next) ? prev : next));
  }, []);

  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (el === null) {
        // DEFERRED detach — the subtle part, and the cause of a real crash.
        //
        // When a composed ref's identity changes, React calls the OLD callback
        // with null and the NEW one with the SAME element, both inside one
        // commit. Radix's `useComposedRefs` produces a fresh identity on benign
        // re-renders, so this pair fires constantly for a Radix `Content`.
        //
        // Clearing state synchronously here makes the pair flip [] then
        // [{rect}] within that commit. The net value is unchanged but the array
        // is a NEW identity, so React re-renders, so Radix composes a new ref,
        // so the pair fires again: "Maximum update depth exceeded", and React
        // unmounts the subtree.
        //
        // Deferring one microtask lets the re-attach land first. If it does,
        // this detach is cancelled and NOTHING happens — no teardown, no
        // setState, no re-render, so the cycle never starts. A real unmount has
        // no re-attach, so the detach runs normally, one microtask late.
        //
        // Note an element-identity check alone (`if (el === last) return`) does
        // NOT fix this: null !== el and el !== null, so both calls still pass.
        const gen = ++detachGenRef.current;
        queueMicrotask(() => {
          if (detachGenRef.current !== gen) return; // superseded by a re-attach
          cleanupRef.current?.();
          cleanupRef.current = null;
          attachedRef.current = null;
          commit(null);
        });
        return;
      }

      // Any attach cancels a pending detach.
      detachGenRef.current++;

      // Re-attaching the element we are already observing: the listeners are
      // live and the rect is current, so there is nothing to do. Returning here
      // also keeps us from churning a ResizeObserver on every Radix re-render.
      if (el === attachedRef.current) return;

      cleanupRef.current?.();
      attachedRef.current = el;
      commit(el);

      const remeasure = () => commit(el);
      const ro = new ResizeObserver(remeasure);
      ro.observe(el);
      el.addEventListener("animationend", remeasure);
      el.addEventListener("transitionend", remeasure);
      window.addEventListener("resize", remeasure);
      // One frame later, for a final position applied after attach.
      const raf = requestAnimationFrame(remeasure);

      cleanupRef.current = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        el.removeEventListener("animationend", remeasure);
        el.removeEventListener("transitionend", remeasure);
        window.removeEventListener("resize", remeasure);
      };
    },
    [commit],
  );

  useEffect(
    () => () => {
      // Cancel any deferred detach so it can't fire after unmount.
      detachGenRef.current++;
      cleanupRef.current?.();
      cleanupRef.current = null;
      attachedRef.current = null;
    },
    [],
  );

  return [rects, ref];
}
