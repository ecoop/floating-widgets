// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * StackOriginReporter — measures the bottom edge of the host app's header and
 * feeds it to the LayoutContext coordinator as the stack origin (the y where
 * the snapped widget stack begins).
 *
 * Lives as its own component (renders nothing) so it can call useLayout()
 * INSIDE the provider — the host's layout body typically sits outside it.
 * Mount it as a sibling of <FloatingWidgetStack>, both within <LayoutProvider>.
 *
 * Lifted verbatim from Pitchcraft's SessionFlow (#257); the only app-specific
 * assumption is "there is one element whose bottom is the stack origin," passed
 * in as headerRef.
 */

import { useCallback, useEffect, useLayoutEffect } from "react";

import { useLayout } from "./LayoutContext";

export function StackOriginReporter({
  headerRef,
}: {
  /** Element whose bottom edge (below any banners) is the stack origin. */
  headerRef: React.RefObject<HTMLElement | null>;
}) {
  const { setStackOrigin } = useLayout();

  const measure = useCallback(() => {
    const el = headerRef.current;
    if (el) setStackOrigin(el.getBoundingClientRect().bottom);
  }, [headerRef, setStackOrigin]);

  // Re-measure after EVERY commit (no deps). The host re-renders precisely when
  // the things that move the header bottom change — content loading and growing
  // the header, banners mounting/unmounting, etc. Measuring on each render
  // catches all of them. setStackOrigin no-ops when the value is unchanged, so
  // this can't loop.
  useLayoutEffect(measure);

  // Belt-and-suspenders for layout changes that DON'T trigger a host re-render:
  // web-font load reflowing the header (ResizeObserver) and viewport resize
  // (window). The render-driven pass above handles everything React-state
  // driven; these cover the rest.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [headerRef, measure]);

  return null;
}
