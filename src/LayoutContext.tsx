// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * LayoutContext — coordinator for the stack of "snapped" floating widgets
 * (#257), and owner of the responsive presentation mode (0.2.0).
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
 * Presentation (float vs dock)
 * ----------------------------
 * `presentation` is GLOBAL CHROME STATE, not per-widget state — which is the
 * whole reason crossing the breakpoint is safe. While docked, widgets do not
 * register with the coordinator, do not derive a top, and never write a
 * position to localStorage; their stored `mode`/`position` are left untouched.
 * So float↔dock is lossless by construction rather than by reconciliation, and
 * there is no path by which a widget gets stranded off-screen or picks up a
 * stale position from the other presentation.
 *
 * Dock open/closed lives here rather than on the stack so that an app's own
 * chrome (a header toggle, typically rendered as a sibling of the stack) can
 * read AND drive it through `useDock()` without prop drilling and without
 * keeping a shadow copy — the failure mode where app and library both believe
 * they own visibility. It supports the usual controlled/uncontrolled pair.
 *
 * Update frequency is low (banner toggle, collapse/expand, mount/unmount,
 * breakpoint crossings) and dragging happens on a *floating* widget that isn't
 * in the registry, so a plain Context (re-render all consumers on change) is
 * the right tool here — no external store needed.
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

import { useBelowWidth } from "./useBelowWidth";
import type { Presentation } from "./parts";

/** Gap (px) above the first snapped widget and between stacked widgets. */
const GAP = 8;
/** Height assumed for a snapped widget before it reports a measured value. */
const FALLBACK_H = 40;
/** Fallback stack origin before the header has been measured. */
const DEFAULT_ORIGIN = 80;

/** Which viewport edge the dock is pinned to. */
export type DockEdge = "bottom" | "right";

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

/** Responsive presentation + dock open state. See `useDock()`. */
export interface DockContextValue {
  /** "float" (draggable panels) or "dock" (one docked surface). */
  presentation: Presentation;
  /** Convenience: `presentation === "dock"`. */
  isDock: boolean;
  /** Which viewport edge the dock is pinned to. */
  dockEdge: DockEdge;
  /** Whether the docked surface is open. Meaningless while floating. */
  open: boolean;
  /** Open/close the docked surface. */
  setOpen: (open: boolean) => void;
  /** Flip the docked surface open/closed. */
  toggle: () => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);
const DockContext = createContext<DockContextValue | null>(null);

export interface LayoutProviderProps {
  children: ReactNode;
  /**
   * Viewport width (px) below which the stack presents as a single docked
   * surface instead of scattered floating panels. `false` (the default) keeps
   * the 0.1.0 behavior exactly — always floating, no media query, no dock.
   * Pass the same breakpoint your layout uses to reserve a gutter beside the
   * content, since that gutter is what makes floating viable.
   */
  dockBelow?: number | false;
  /** Which viewport edge the dock pins to. Default "bottom". */
  dockEdge?: DockEdge;
  /** Initial open state for the UNCONTROLLED case. Default false. */
  defaultDockOpen?: boolean;
  /** Controlled open state. Pass with `onDockOpenChange`. */
  dockOpen?: boolean;
  /** Notified on every open/close request, controlled or not. */
  onDockOpenChange?: (open: boolean) => void;
}

export function LayoutProvider({
  children,
  dockBelow = false,
  dockEdge = "bottom",
  defaultDockOpen = false,
  dockOpen,
  onDockOpenChange,
}: LayoutProviderProps) {
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

  // ── Presentation + dock open ───────────────────────────────────────────────
  const isDock = useBelowWidth(dockBelow);

  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultDockOpen);
  const controlled = dockOpen !== undefined;
  const open = controlled ? dockOpen : uncontrolledOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      // An uncontrolled provider owns the state; a controlled one only reports,
      // so the consumer stays the single source of truth either way.
      if (!controlled) setUncontrolledOpen(next);
      onDockOpenChange?.(next);
    },
    [controlled, onDockOpenChange],
  );

  const toggle = useCallback(() => setOpen(!open), [setOpen, open]);

  const dockValue = useMemo<DockContextValue>(
    () => ({
      presentation: isDock ? "dock" : "float",
      isDock,
      dockEdge,
      open,
      setOpen,
      toggle,
    }),
    [isDock, dockEdge, open, setOpen, toggle],
  );

  return (
    <LayoutContext value={value}>
      <DockContext value={dockValue}>{children}</DockContext>
    </LayoutContext>
  );
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

/**
 * Read and drive the responsive presentation + dock open state.
 *
 * This — not the imperative handle — is how an app's own chrome should reflect
 * dock state. A ref mutation does not re-render the component holding it, so a
 * header icon driven off `FloatingWidgetStackHandle.isDockOpen()` would go
 * stale; the handle's dock methods are for fire-and-forget actions only.
 *
 *   const { isDock, open, toggle } = useDock();
 *   return isDock ? (
 *     <button onClick={toggle} aria-pressed={open}>…</button>
 *   ) : null;
 *
 * Throws if used outside a LayoutProvider.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useDock(): DockContextValue {
  const ctx = useContext(DockContext);
  if (!ctx) {
    throw new Error("useDock must be used within a <LayoutProvider>");
  }
  return ctx;
}
