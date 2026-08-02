// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * useWidgetLayout — per-widget mode + position + collapse state, persisted
 * to localStorage (#156, coordinator in #257).
 *
 * A widget is in one of two modes:
 *   - "snapped"  → position is DERIVED by the LayoutContext coordinator
 *                  (stackOrigin + the measured heights of snapped widgets
 *                  above it). The stored `position` is ignored while snapped;
 *                  the widget follows the header and reflows around its
 *                  snapped siblings.
 *   - "floating" → user-owned absolute `{ x, y }`, persisted as before.
 *
 * Dragging a widget flips it to "floating" (the user takes ownership);
 * SnapTo flips it back to "snapped". New widgets default to "snapped" so
 * they sit below the header chrome and track it (fixes #255 symmetrically).
 *
 * Collapse/expand state is independent of mode and survives a snap — a
 * snapped widget keeps whatever expanded/collapsed state it had, and the
 * coordinator reflows its siblings around its actual height.
 *
 * `mode` subsumes the old dormant `snapAnchor` field (#243 → Phase 3).
 */

import { useEffect, useState } from "react";

export type WidgetPosition = { x: number; y: number };
export type WidgetMode = "snapped" | "floating";

export interface WidgetState {
  /** Absolute (x,y); authoritative ONLY when mode === "floating". */
  position: WidgetPosition;
  collapsed: boolean;
  mode: WidgetMode;
}

interface WidgetLayoutHook {
  state: WidgetState;
  /** User drag commit → takes ownership, flips to "floating". */
  setPosition: (position: WidgetPosition) => void;
  setCollapsed: (collapsed: boolean) => void;
  /** Snap back under the coordinator → "snapped". Preserves collapsed state;
   *  the coordinator reflows snapped siblings around this widget's height. */
  snap: () => void;
  reset: () => void;
}

// Widget width matches the `width: "17rem"` in FloatingWidget — used for
// clamping so the grip stays reachable even when dragged to the right edge.
export const WIDGET_W = 272; // 17rem at 16px root font size
// Inset from the right viewport edge for a widget's *default* (right-edge-
// anchored) position, so it isn't flush against the edge. The old magic 288
// was exactly WIDGET_W + this margin; shared with FloatingWidget.
export const WIDGET_MARGIN = 16;
const HEADER_H = 40;  // approximate collapsed widget height

function storageKey(id: string): string {
  return `widget:${id}`;
}

function clampPosition(pos: WidgetPosition): WidgetPosition {
  return {
    x: Math.max(0, Math.min(pos.x, window.innerWidth  - WIDGET_W)),
    y: Math.max(0, Math.min(pos.y, window.innerHeight - HEADER_H)),
  };
}

function isValidPosition(pos: unknown): pos is WidgetPosition {
  return (
    typeof (pos as WidgetPosition)?.x === "number" &&
    typeof (pos as WidgetPosition)?.y === "number" &&
    !isNaN((pos as WidgetPosition).x) &&
    !isNaN((pos as WidgetPosition).y)
  );
}

function loadState(
  id: string,
  defaultPosition: WidgetPosition,
  defaultCollapsed: boolean,
  defaultMode: WidgetMode,
): WidgetState {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WidgetState>;
      if (isValidPosition(parsed.position)) {
        // Migration: only an *explicit* "floating" stays floating (the user
        // dragged it and took ownership). Everything else — "snapped" or a
        // legacy entry written before `mode` existed — loads as "snapped" so
        // it joins the coordinator and tracks the header. This fixes #255 for
        // existing users automatically, with no manual SnapTo or localStorage
        // wipe; the stored position is kept but ignored while snapped (it
        // becomes the floating fallback if the user later drags the widget).
        const mode: WidgetMode = parsed.mode === "floating" ? "floating" : "snapped";
        return {
          position: clampPosition(parsed.position),
          collapsed: parsed.collapsed ?? defaultCollapsed,
          mode,
        };
      }
    }
  } catch {
    // Corrupt storage — fall through to defaults.
  }
  // No stored entry → brand-new widget starts in defaultMode ("snapped").
  return { position: defaultPosition, collapsed: defaultCollapsed, mode: defaultMode };
}

function saveState(id: string, state: WidgetState): void {
  try {
    localStorage.setItem(storageKey(id), JSON.stringify(state));
  } catch {
    // Storage full or unavailable — silently ignore.
  }
}

export function useWidgetLayout(
  id: string,
  defaultCollapsed: boolean,
  defaultPosition: WidgetPosition,
  defaultMode: WidgetMode = "snapped",
): WidgetLayoutHook {
  const [state, setState] = useState<WidgetState>(() =>
    loadState(id, defaultPosition, defaultCollapsed, defaultMode),
  );

  // Re-clamp whenever the viewport shrinks so floating widgets don't get
  // stranded off-screen. Snapped widgets are positioned by the coordinator
  // (which already tracks the viewport), so this is floating-only.
  useEffect(() => {
    function onResize() {
      setState((prev) => {
        if (prev.mode !== "floating") return prev;
        const clamped = clampPosition(prev.position);
        if (clamped.x === prev.position.x && clamped.y === prev.position.y) {
          return prev; // no change — skip re-render + save
        }
        const next = { ...prev, position: clamped };
        saveState(id, next);
        return next;
      });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [id]);

  function update(patch: Partial<WidgetState>): void {
    const next = { ...state, ...patch };
    setState(next);
    saveState(id, next);
  }

  return {
    state,
    // A drag means the user is taking ownership → become floating.
    setPosition: (position) => update({ position, mode: "floating" }),
    setCollapsed: (collapsed) => update({ collapsed }),
    // Single atomic update — no stale-closure double-setState. Collapsed
    // state is intentionally preserved (non-collapsing snap, #257).
    snap: () => update({ mode: "snapped" }),
    reset: () =>
      update({ position: defaultPosition, collapsed: defaultCollapsed, mode: defaultMode }),
  };
}
