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
 * coordinator reflows its siblings around its actual height. It is also
 * independent of PRESENTATION: a widget collapsed on the desktop is collapsed
 * in the dock, because collapse is the widget's own state rather than a layout
 * artifact.
 *
 * `mode` subsumes the old dormant `snapAnchor` field (#243 → Phase 3).
 *
 * Stored position is INTENT, not placement (0.2.0)
 * ------------------------------------------------
 * The stored position is where the user put the widget, and it is written by
 * exactly one thing: a committed drag. It is deliberately NOT rewritten to fit
 * the current viewport.
 *
 * Through 0.1.0 a resize handler clamped the position *and saved the clamp*, so
 * merely viewing the page at a narrow width permanently destroyed the desktop
 * placement: a widget stored at x=900 was rewritten to x≈100 on a phone and
 * stayed stranded mid-page when the viewport widened again. That made a clean
 * float↔dock crossing unachievable no matter how the dock itself behaved, since
 * every crossing passes through the narrow width.
 *
 * Clamping now happens where the position is READ (FloatingWidget's
 * currentLeft/currentTop, via `clampPosition` below), so a narrow viewport
 * constrains where the widget is drawn without touching what the user chose.
 */

import { useState } from "react";

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

// Default widget width, matching the `--fw-widget-width` fallback in
// FloatingWidget. Used only where the real element hasn't been measured yet;
// a consumer that overrides the CSS variable is respected because the drag,
// clamp and snap math read the node's actual offsetWidth.
export const WIDGET_W = 272; // 17rem at 16px root font size
// Inset from the right viewport edge for a widget's *default* (right-edge-
// anchored) position, so it isn't flush against the edge. The old magic 288
// was exactly WIDGET_W + this margin; shared with FloatingWidget.
export const WIDGET_MARGIN = 16;
const HEADER_H = 40;  // approximate collapsed widget height

function storageKey(id: string): string {
  return `widget:${id}`;
}

/**
 * Constrain a position to the current viewport. Called at READ time (never
 * before a save) so a narrow viewport can't overwrite the user's placement —
 * see the header note. `width` should be the widget's measured offsetWidth;
 * WIDGET_W is only the pre-measurement fallback.
 */
export function clampPosition(
  pos: WidgetPosition,
  width: number = WIDGET_W,
): WidgetPosition {
  if (typeof window === "undefined") return pos;
  return {
    x: Math.max(0, Math.min(pos.x, window.innerWidth  - width)),
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
          // Loaded unclamped — the stored value is the user's intent, and the
          // viewport at load time is not necessarily the one they chose it in.
          position: parsed.position,
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
