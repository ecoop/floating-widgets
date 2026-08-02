// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * LayoutContext — coordinator for the stack of "snapped" floating widgets
 * (#257). The single source of truth for where snapped widgets sit.
 *
 * Model
 * -----
 *   - `stackOrigin` — the y (px) where the snapped stack begins. Whoever
 *     knows the chrome above the stack (in Pitchcraft: SessionFlow, which
 *     measures the page header below any banners) pushes it in via
 *     `setStackOrigin`. The coordinator itself knows nothing about headers
 *     or banners — only "the stack starts at y".
 *   - A registry of snapped widgets, each with an `order` (stack position)
 *     and a measured `height`. `topFor(id)` derives a widget's y as
 *     `stackOrigin + GAP + Σ(heights of snapped widgets ordered above it)`.
 *
 * Reflow falls out for free: when any snapped widget collapses/expands, it
 * reports a new height → the coordinator re-derives → every widget below it
 * moves down/up. A widget dragged out flips to "floating", unregisters, and
 * the gap closes.
 *
 * Portability
 * -----------
 * Deliberately Pitchcraft-agnostic — it knows about stacked panels, reserved
 * origin, ordering, and heights, nothing about Usage/Telemetry/Diagnostics.
 * Could be lifted into a standalone `useStackedFloatingLayout` package later.
 *
 * Update frequency is low (banner toggle, collapse/expand, mount/unmount) and
 * dragging happens on a *floating* widget that isn't in the registry, so a
 * plain Context (re-render all consumers on change) is the right tool here —
 * no external store needed.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Gap (px) above the first snapped widget and between stacked widgets. */
const GAP = 8;
/** Height assumed for a snapped widget before it reports a measured value. */
const FALLBACK_H = 40;
/** Fallback stack origin before the header has been measured. */
const DEFAULT_ORIGIN = 80;

interface SnappedItem {
  order: number;
  height: number;
}

export interface LayoutContextValue {
  /** y (px) where the snapped stack begins. */
  stackOrigin: number;
  /** Set by whoever measures the chrome above the stack (header bottom). */
  setStackOrigin: (y: number) => void;
  /** Add/refresh a snapped widget's stack order. Idempotent. */
  registerSnapped: (id: string, order: number) => void;
  /** Remove a widget from the snapped stack (it floated away or unmounted). */
  unregisterSnapped: (id: string) => void;
  /** Report a snapped widget's measured outer height (px). */
  setHeight: (id: string, height: number) => void;
  /** Derived top (px) for a snapped widget. */
  topFor: (id: string) => number;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [stackOrigin, setStackOriginState] = useState(DEFAULT_ORIGIN);

  // Registry lives in a ref for stable identity; a version counter forces a
  // re-render (and a fresh context value) whenever it mutates, so consumers
  // recompute their derived top.
  const itemsRef = useRef<Map<string, SnappedItem>>(new Map());
  const [version, bump] = useReducer((n: number) => n + 1, 0);

  const setStackOrigin = useCallback((y: number) => {
    setStackOriginState((prev) => (prev === y ? prev : y));
  }, []);

  const registerSnapped = useCallback((id: string, order: number) => {
    const cur = itemsRef.current.get(id);
    if (cur && cur.order === order) return; // no change
    itemsRef.current.set(id, { order, height: cur?.height ?? FALLBACK_H });
    bump();
  }, []);

  const unregisterSnapped = useCallback((id: string) => {
    if (itemsRef.current.delete(id)) bump();
  }, []);

  const setHeight = useCallback((id: string, height: number) => {
    const cur = itemsRef.current.get(id);
    if (!cur || cur.height === height) return; // unregistered or unchanged
    itemsRef.current.set(id, { ...cur, height });
    bump();
  }, []);

  const topFor = useCallback(
    (id: string): number => {
      const sorted = [...itemsRef.current.entries()].sort(
        (a, b) => a[1].order - b[1].order,
      );
      let y = stackOrigin + GAP;
      for (const [itemId, item] of sorted) {
        if (itemId === id) return y;
        y += item.height + GAP;
      }
      // Not (yet) registered — place it at the stack top as a sane default.
      return stackOrigin + GAP;
    },
    [stackOrigin],
  );

  // `version` in the deps forces a new value object whenever the registry
  // mutates, so context consumers re-render and re-read topFor().
  const value = useMemo<LayoutContextValue>(
    () => ({
      stackOrigin,
      setStackOrigin,
      registerSnapped,
      unregisterSnapped,
      setHeight,
      topFor,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stackOrigin, version, setStackOrigin, registerSnapped, unregisterSnapped, setHeight, topFor],
  );

  return <LayoutContext value={value}>{children}</LayoutContext>;
}

/** Access the layout coordinator. Throws if used outside a LayoutProvider.
 *  Colocated with the provider (idiomatic Context pattern); the disable below
 *  silences the Fast-Refresh "components-only export" lint for this one hook. */
// eslint-disable-next-line react-refresh/only-export-components
export function useLayout(): LayoutContextValue {
  const ctx = useContext(LayoutContext);
  if (!ctx) {
    throw new Error("useLayout must be used within a <LayoutProvider>");
  }
  return ctx;
}
