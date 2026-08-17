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
  useEffect,
  useLayoutEffect,
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
 * Measure live elements as `AvoidRect`s — the ergonomic path for "keep out of
 * this sheet's way", replacing a hardcoded width with the element's real box.
 * Absent (null) refs contribute nothing, so a sheet that isn't mounted simply
 * stops being avoided.
 *
 * Measures after EVERY commit, the same approach StackOriginReporter uses and
 * for the same reason: the host re-renders precisely when the things that move
 * these elements change. The equality check means it cannot loop, and it also
 * makes the hook safe with an inline `[ref]` array — no memoization required of
 * the caller.
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
