// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * useBelowWidth — "is the viewport narrower than `width`?", as an external
 * store rather than an effect.
 *
 * useSyncExternalStore (not useState + useEffect) because the answer must be
 * right on the FIRST paint: an effect-based read renders the float
 * presentation, commits, then corrects to dock — a visible flash of floating
 * widgets over the page on every phone load. Subscribing to the MediaQueryList
 * also means rotation and resize are handled by the platform rather than by a
 * debounced resize handler.
 *
 * The 0.02px shaved off the max-width is the standard guard against the
 * fractional-device-pixel gap where neither `(max-width: N)` nor
 * `(min-width: N)` matches.
 *
 * SSR: the server snapshot is `false` (float). The viewport is unknowable on
 * the server, and this package is client-only in practice anyway — it portals
 * to `document.body` during render and reads localStorage in a state
 * initializer. "SSR-safe" here means "does not throw while server-rendering",
 * not "renders the right presentation server-side".
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

const SUBPIXEL_GUARD = 0.02;

function serverSnapshot(): boolean {
  return false;
}

export function useBelowWidth(width: number | false): boolean {
  const query =
    width === false ? null : `(max-width: ${width - SUBPIXEL_GUARD}px)`;

  const mql = useMemo(() => {
    if (query === null) return null;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return null;
    }
    return window.matchMedia(query);
  }, [query]);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!mql) return () => {};
      // Both signals, deliberately. The MediaQueryList `change` event is the
      // right one and fires in every real browser — but it is a single point of
      // failure for the whole responsive feature, and there are embedded /
      // emulated environments (CDP device-metrics overrides, some in-app
      // webviews) where `matches` updates correctly while `change` never
      // fires at all, stranding the stack in the wrong presentation with no
      // way back. `window.resize` closes that gap.
      //
      // The redundancy is free: useSyncExternalStore compares snapshots with
      // Object.is, so a resize that doesn't cross the breakpoint notifies and
      // re-renders nothing.
      mql.addEventListener("change", onChange);
      window.addEventListener("resize", onChange);
      return () => {
        mql.removeEventListener("change", onChange);
        window.removeEventListener("resize", onChange);
      };
    },
    [mql],
  );

  const getSnapshot = useCallback(() => mql?.matches ?? false, [mql]);

  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}
