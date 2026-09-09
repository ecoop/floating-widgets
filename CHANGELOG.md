<!-- Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE. -->

# Changelog

_Last updated: 2026-09-08_

Versions follow semver's 0.x rules: a caret range allows patch bumps only, so
`^0.2.0` means `>=0.2.0 <0.3.0` and a caret-pinned consumer never crosses a
minor break on reinstall.

---

## 0.2.2 — 2026-08-20

**Fix:** `useAvoidElement` crashed with "Maximum update depth exceeded" when its
callback ref was attached to a Radix-composed component (shadcn `Sheet`,
`Dialog`, `Popover`), and React unmounted the whole subtree.

React answers a changed callback-ref identity by calling the old ref with `null`
and the new one with the same element, in one commit. Radix's `useComposedRefs`
produces a fresh identity on benign re-renders, so that pair fired constantly.
The hook `setState`d on every invocation, so the pair flipped `[]` → `[{rect}]`
inside the commit: same value, new array identity, hence a re-render, hence a
new composed ref, hence the pair again.

The detach is now deferred one microtask and cancelled if a re-attach lands
first — which it always does here, since both calls happen inside one
synchronous commit. A real unmount has no re-attach and proceeds normally.

Also added the project's first tests (`vitest`) and CI. Two consecutive releases
had shipped a broken `useAvoid*` hook with no test suite to catch either.

## 0.2.1 — 2026-08-18

**Added** `useAvoidElement()`, a callback-ref hook, and **deprecated**
`useAvoidRects()`.

`useAvoidRects` was inert for portaled content: a `RefObject` cannot notify, so
its only re-measure trigger was a commit of the calling component — which a
Radix portal mounting from a descendant's effect never causes. It measured once
against `null` and never looked again. A callback ref is invoked when React
*attaches* the element, however late that is.

`useAvoidRects` remains correct for DOM the host renders inline.

## 0.2.0 — 2026-08-17

Responsive dock, a library-wide styling seam, and `avoidRects`.

**Added**

- `dockBelow` on `LayoutProvider`: below that width the stack presents as one
  docked surface holding every widget as an accordion. Defaults to `false`,
  which is 0.1.0's behavior exactly.
- `useDock()` — reactive presentation + open/closed state, so an app's own
  chrome can drive the dock while holding no state of its own.
- Styling seam: `data-fw-part` on every element, a `classNames` bag, and
  `unstyled`.
- `WidgetDef.peek` and `WidgetDef.dockWhen`.
- CSS custom properties: `--fw-widget-width`, `--fw-dock-z`, `--fw-dock-max-h`.

**Breaking**

- `settingsOpen` / `settingsPanelWidth` → `avoidRects`. The old pair encoded "a
  panel of width W at the right edge", which cannot express a bottom rect such
  as the iOS software keyboard. A compile error, so TypeScript finds every call
  site. No export was removed, and the `localStorage` format is unchanged (same
  `widget:<id>` key and `{ position, collapsed, mode }` shape), so saved layouts
  survive.

**Fixed**

- A resize handler clamped each floating widget's position **and saved the
  clamp**, so merely viewing the page narrow permanently moved a widget — one
  stored at x=900 became x≈100 and stayed stranded when the window widened
  again. Clamping now happens where the position is read, so the stored value
  stays the user's intent. `resetAll()` is the deliberate way to rescue a
  layout.

**Behavior changes that don't fail to compile**

- The grip's `touch-none` class became inline `touch-action` / `user-select` —
  drag correctness has to survive `unstyled`. CSS or tests selecting the grip by
  that class now miss.
- Bring-to-front moved `onMouseDown` → `onPointerDown`, so touch can raise a
  widget. A test firing `mouseDown` silently stops exercising it.
- A *floating* widget may now escape a rect vertically; 0.1.0's shift was x-only
  for everything. Identical for a full-height sheet, visible if the rect isn't.
- The chevron gained `aria-expanded` / `aria-controls`, and the body a matching
  `id`.
- Markup gained `data-fw-part`, `data-state`, `data-presentation`, `data-mode`,
  `data-fw-id`. Class strings unchanged; expect DOM snapshot churn.

## 0.1.0 — 2026-08-03

Initial release. Draggable, snappable corner-docked panel stack extracted from
Pitchcraft's sidebar HUD.
