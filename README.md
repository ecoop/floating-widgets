<!-- Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE. -->

# @nobadeer/floating-widgets

_Last updated: 2026-08-16_

A draggable, snappable stack of corner-docked panels — **"floating widgets"** —
for React 19, which presents as a single docked surface on narrow viewports.
Extracted from Pitchcraft's sidebar HUD (Usage / Diagnostics / Telemetry / Demo).

Each widget is either **snapped** (placed by a shared coordinator that stacks
widgets below your header and reflows them as they collapse/expand) or
**floating** (the user grabbed it and dragged it somewhere; its position
persists to `localStorage`). Drag a snapped widget out of its slot and it takes
ownership; drop it back near the dock and it re-joins the stack.

Floating assumes there is room *beside* your content. Below a breakpoint you
choose there usually isn't, so the stack switches to a **dock**: one collapsible
surface pinned to an edge, holding every widget as an accordion. See
[Responsive dock](#responsive-dock).

The package ships the **mechanism** — chrome, coordinator, persistence — and is
agnostic about what goes *in* the panels. You supply the panel contents.

---

## Runtime contract

Two things this package **cannot** enforce through `package.json` or types. Get
them wrong and it fails quietly (unstyled panels, or widgets that don't track
the header), so they're stated up front.

### 1. Peer dependencies — React **19+**

```
react >= 19, react-dom >= 19, lucide-react >= 0.400
```

React 19 is a hard floor, not a preference. The code relies on two React-19-only
features:

- **`ref` as an ordinary prop** (`FloatingWidgetStack` takes `ref` directly, no
  `forwardRef`). On React 18 the ref never arrives.
- **`<Context value>`** as the provider element form. On React 18 this silently
  fails to provide context, and `useLayout()` throws.

`lucide-react` supplies the grip and chevron icons and is a peer so you share
one copy with the host app.

### 2. Styling — shadcn tokens by default, overridable everywhere

This package imports **no CSS** and ships **no styles**; it borrows the host's.
By default it borrows shadcn's tokens:

```
bg-card   text-card-foreground   border   shadow-lg
text-muted-foreground   text-foreground
```

If your app is already shadcn + Tailwind, they resolve and you need do nothing.
If they don't resolve, the panels render structurally correct but unstyled — a
silent failure, which is why this is stated as a contract rather than a detail.

You are not stuck with them. See [Styling](#styling): every element carries a
`data-fw-part` attribute you can target from your own stylesheet with no prop at
all, `classNames` appends per part, and `unstyled` drops the defaults entirely
for an app with no shadcn tokens.

### 3. Placement: one `<LayoutProvider>` around header + stack

The coordinator needs to know where your header ends (the "stack origin") and
who the snapped widgets are. So three things must live inside **one**
`<LayoutProvider>`:

- `<StackOriginReporter headerRef={...} />` — measures the header bottom,
- the **header element** referenced by `headerRef`,
- `<FloatingWidgetStack ... />`.

The stack deliberately does **not** render its own provider: the provider has to
also enclose the header, and that boundary belongs to you, not to the stack.

---

## Usage

```tsx
import { useMemo, useRef } from "react";
import {
  LayoutProvider,
  StackOriginReporter,
  FloatingWidgetStack,
  type FloatingWidgetStackHandle,
  type WidgetDef,
} from "@nobadeer/floating-widgets";

// 1. Your app's "context" — the bundle of already-computed live state the
//    widgets read. A plain object (view-model), NOT a place to call hooks.
type Ctx = {
  usage: UsageLog;
  error: string | null;
  demoMode: boolean;
};

// 2. The registry. Stable identity (useMemo([])) — the functions read
//    everything from `ctx` at call time, so the array never needs to change.
//    Array ORDER is the stack order (top to bottom).
const WIDGETS: WidgetDef<Ctx>[] = [
  {
    id: "usage",
    header: (c) => <UsageSummaryLine usage={c.usage} />,
    render: (c) => <UsageTable usage={c.usage} />,
  },
  {
    id: "diagnostics",
    defaultCollapsed: true,
    header: () => <span className="text-[11px] font-medium">Diagnostics</span>,
    render: (c) => <DiagnosticsPanel error={c.error} />,
  },
  {
    id: "demo",
    mountWhen: (c) => c.demoMode, // optional widgets gate on live state
    header: () => <span>Demo</span>,
    render: () => <DemoBody />,
  },
];

function AppShell() {
  const headerRef = useRef<HTMLElement>(null);
  const stackRef = useRef<FloatingWidgetStackHandle>(null);

  // Rebuilt each render; threaded into every def function by the stack.
  const ctx: Ctx = { usage, error, demoMode };

  // Stable — the registry never closes over live state directly.
  const widgets = useMemo(() => WIDGETS, []);

  return (
    {/* dockBelow: below this width the stack presents as one docked surface.
        Omit it for always-floating (the 0.1.0 behavior). */}
    <LayoutProvider dockBelow={1024}>
      <StackOriginReporter headerRef={headerRef} />
      <header ref={headerRef}>{/* your app header / banners */}</header>

      {/* ...page... */}

      <FloatingWidgetStack<Ctx>
        ref={stackRef}
        ctx={ctx}
        widgets={widgets}
      />

      {/* Imperatively re-dock everything (e.g. a "reset layout" button): */}
      <button onClick={() => stackRef.current?.snapAll()}>Snap all</button>
    </LayoutProvider>
  );
}
```

### Why `ctx` is a plain object and not per-widget hooks

The stack maps the registry and calls `header(ctx)` / `render(ctx)` — never a
hook — from inside that map. So your app calls all of *its* hooks normally, at
the top of your component, and packs the results into `ctx`. This keeps the
Rules of Hooks trivially satisfied even as widgets mount and unmount via
`mountWhen`. (An alternative design gives each `WidgetDef` its own `useModel()`
hook; it's more decoupled but calls hooks in a loop, which is fragile. Not used
here.)

---

## Responsive dock

Pass `dockBelow` and the stack switches presentation on its own:

```tsx
<LayoutProvider dockBelow={1024}>
```

Below that width every widget leaves the page and joins one docked surface — an
accordion pinned to the bottom edge (`dockEdge="right"` for a side drawer),
closed by default. Above it, nothing changes: the same drag, snap and reflow as
before. **`dockBelow` defaults to `false`**, so a consumer that doesn't opt in
gets the pre-0.2.0 behavior exactly.

Pick the same breakpoint your layout uses to reserve a gutter beside the
content, since that gutter is what makes floating viable in the first place.

### Driving it from your own chrome

`useDock()` is the reactive read. An app that wants its own toggle owns **no
state of its own** — which is the point, since two owners of "is the HUD
visible" is how these get out of sync:

```tsx
import { useDock } from "@nobadeer/floating-widgets";

function HudToggle() {           // anywhere inside <LayoutProvider>
  const { isDock, open, toggle } = useDock();
  if (!isDock) return null;      // desktop: the widgets speak for themselves
  return (
    <button onClick={toggle} aria-pressed={open}>
      {open ? <EyeOff /> : <Eye />}
    </button>
  );
}
```

Pass `renderDockTrigger={() => null}` to the stack so it doesn't also render its
own affordance. If you'd rather hold the state yourself, `dockOpen` +
`onDockOpenChange` on the provider make it controlled.

The imperative handle also has `openDock()` / `closeDock()` / `toggleDock()` /
`isDockOpen()`. Use those to *act*, not to *reflect*: a ref read can't re-render
the component holding it, so an icon derived from `isDockOpen()` goes stale.

### Crossing the breakpoint

Presentation is global chrome state, not per-widget state. While docked, widgets
don't register with the coordinator and never write a position — their stored
`mode` and `position` are untouched. So a widget you dragged to the middle of a
1440px desktop is still exactly there after a phone visit, and crossing back and
forth costs nothing. Collapse state *is* shared, deliberately: it belongs to the
widget, not to the layout.

Switching presentation remounts each widget. Everything persistent is in
`localStorage` and re-read on mount, so this is invisible.

### Accessibility

The dock is a persistent HUD, not a modal: `role="region"` with an accessible
name (`dockLabel`), focus moved into the panel on open and returned to whatever
opened it on close, and `Escape` to close. Focus is **not** trapped — trapping it
in an always-present HUD would strand keyboard users on the rest of the page.
Pass `dockModal` if you genuinely want modal behavior; that adds a scrim,
`aria-modal`, a Tab cycle and close-on-scrim-click.

The closed dock is pointer-transparent, so it never swallows clicks meant for
the page behind it.

---

## Staying out of the way — `avoidRects`

Widgets float over the page, so other UI can land underneath them: a side sheet,
a toast stack, the iOS software keyboard. Hand the stack the regions to keep
clear and each widget slides by *only* as much as it needs to escape them.

```tsx
const sheetRef = useRef<HTMLDivElement>(null);
const avoidRects = useAvoidRects([sheetRef]);   // measured, live

<FloatingWidgetStack avoidRects={avoidRects} … />
```

`useAvoidRects` measures on every commit and via `ResizeObserver`, so an
animating sheet is tracked as it opens and an unmounted one simply stops being
avoided. It's safe with an inline `[ref]` array — no memoization needed.

`AvoidRect` is `{ left, top, right, bottom }` in viewport coordinates, which
`DOMRect` satisfies structurally, so you can also pass
`element.getBoundingClientRect()` results or synthesize a rect yourself. For the
iOS keyboard, `visualViewport` gives you one:

```tsx
// The strip the keyboard covers: below the visual viewport, above the layout one.
const vv = window.visualViewport!;
const keyboard = {
  left: 0, right: innerWidth,
  top: vv.height + vv.offsetTop, bottom: innerHeight,
};
```

### How it decides which way to move

The smallest displacement that clears each rect, preferring a direction that
keeps the widget on-screen. Direction falls out of the geometry rather than
being configured — a full-height side sheet can only be escaped sideways, a
full-width keyboard only upward. **Snapped widgets move on x only**, because the
coordinator owns their y: shifting one vertically would slide it into siblings
that don't know to reflow.

The shift is a CSS transform, so stored positions are untouched and removing the
rect springs each widget back to exactly where it was. If the user *drags* a
widget while it's shifted, the offset is baked into its position and it stays
put — they meant to move it. Ignored entirely while docked.

> Replaces 0.1.0's `settingsOpen` / `settingsPanelWidth`, which said the same
> thing in one consumer's vocabulary with the rect hardcoded as a width measured
> from the right edge — a shape that couldn't express a keyboard.

---

## Styling

Three layers, so you can go as far as you need and no further.

**1. `data-fw-part`** — every element carries one, and you can style any of them
from your own stylesheet with no prop at all. Also the escape hatch: if a part
isn't reachable through `classNames`, it's still reachable here.

```css
[data-fw-part="grip"] { cursor: move; }
[data-fw-part="dock"][data-state="open"] [data-fw-part="dockPanel"] { … }
```

| Part | Element |
| --- | --- |
| `root` | Positioned wrapper (fixed + coordinator-placed when floating). |
| `card` | The bordered panel surface. |
| `header` | Header row: grip + title + toggle. |
| `grip` | Drag affordance. Float only. |
| `title` | Holds your `header(ctx)` output. |
| `toggle` | Chevron button — the accessible expand/collapse control. |
| `body` | Holds your `render(ctx)`. Absent while collapsed. |
| `dock` | Fixed container pinned to the dock edge. |
| `dockPanel` | The open dock surface. |
| `dockList` | Accordion list inside the panel. |
| `dockTrigger` | Closed-state affordance. |
| `dockBackdrop` | Scrim; only when `dockModal`. |

State comes as data attributes too: `data-state` (`open`/`closed`,
`expanded`/`collapsed`), `data-presentation`, `data-mode`, `data-edge`,
`data-fw-id`.

**2. `classNames`** — a bag keyed by the same part names, on the stack (all
widgets) or on a `WidgetDef` (one widget). Your classes are **appended** to the
defaults, not merged token-by-token: this package has no `tailwind-merge`
dependency, so a real merge isn't on offer and pretending otherwise would be the
unpredictable option. Append adds; `unstyled` subtracts.

```tsx
<FloatingWidgetStack classNames={{ dockPanel: "rounded-t-2xl", body: "p-3" }} … />
```

**3. `unstyled`** — drop every default class. Structure, data attributes and
geometry remain. This is the path for an app with no shadcn tokens.

### What the library keeps

Geometry, applied inline and not overridable: position, edge offsets, drag
transform, transition, the float↔dock reflow. Two values that are really style
decisions are emitted as CSS custom properties instead, so you can change them
without a prop:

| Property | Default | What |
| --- | --- | --- |
| `--fw-widget-width` | `17rem` | Floating panel width. Drag, clamp and snap math measure the element, so an override stays consistent. |
| `--fw-dock-z` | `50` | Dock stacking order. |
| `--fw-dock-max-h` | `60dvh` | Dock accordion height before it scrolls. |

Also inline, and deliberately not reachable by `unstyled`, because they are
correctness rather than taste: `touch-action: none` / `user-select: none` on the
grip (without them a touch drag scrolls the page instead of moving the widget),
`env(safe-area-inset-*)` padding on the dock (an iPhone bottom dock otherwise
renders under the home indicator), and the dock's scroll containment.

---

## API

### Composition surface (the 90% path)

| Export | What |
| --- | --- |
| `LayoutProvider` | Context provider; wrap header + reporter + stack. Owns the responsive presentation and dock open state. |
| `StackOriginReporter` | Measures `headerRef` bottom → stack origin. Renders nothing. |
| `FloatingWidgetStack<Ctx>` | Renders the registry in either presentation; exposes the handle via `ref`. |
| `useDock()` | Reactive `{ presentation, isDock, dockEdge, open, setOpen, toggle }`. How your own chrome reflects and drives the dock. |
| `useAvoidRects(refs)` | Measures live elements into `AvoidRect[]` for the stack's `avoidRects`. |
| `WidgetDef<Ctx>` (type) | One widget: `id`, `header`, `render`, optional `mountWhen` / `dockWhen` / `peek` / `defaultCollapsed` / `classNames`. |
| `FloatingWidgetStackHandle` (type) | `{ snapAll(); resetAll(); openDock(); closeDock(); toggleDock(); isDockOpen(); }`. |

**`LayoutProvider` props:** `dockBelow?` (default `false`), `dockEdge?` (default
`"bottom"`), `defaultDockOpen?` (default `false`), `dockOpen?`,
`onDockOpenChange?`.

**`FloatingWidgetStack` props:** `widgets`, `ctx`, `avoidRects?`,
`storagePrefix?`, `classNames?`, `unstyled?`, `dockLabel?`,
`renderDockTrigger?`, `dockModal?`, `ref?`. Pass `storagePrefix` if two apps
share an origin, so their `widget:<id>` localStorage keys don't collide.

### Primitives (escape hatch — custom layouts)

`FloatingWidget`, `FloatingWidgetHandle`, `useLayout`, `LayoutContextValue`,
`useBelowWidth`, `useWidgetLayout`, `clampPosition`, `WIDGET_W`,
`WIDGET_MARGIN`, and the `WidgetState` / `WidgetMode` / `WidgetPosition` /
`WidgetPart` / `PartClassNames` / `Presentation` / `DockEdge` types. Use these
only if you're building a layout other than the stack.

---

## Upgrading from 0.1.0

Additive — the defaults reproduce 0.1.0's behavior and visual output. Two things
to know:

- **Markup gained attributes.** Every element now carries `data-fw-part` (plus
  `data-state`, `data-presentation`, `data-mode`). Classes are unchanged. Only
  a test asserting on exact DOM attributes would notice.
- **`settingsOpen` / `settingsPanelWidth` are replaced by `avoidRects`** — the
  one genuinely breaking change, and a compile error rather than a silent one.
  Instead of a boolean plus a hardcoded panel width, pass the region to avoid;
  `useAvoidRects([sheetRef])` measures it from the live element, so the widths
  can't drift apart. See [above](#staying-out-of-the-way--avoidrects).
- **A stored position is no longer rewritten to fit the viewport.** Through
  0.1.0 a resize clamped each floating widget's position *and saved the clamp*,
  so merely opening the page narrow permanently moved a widget: one stored at
  x=900 became x≈100 and stayed stranded when the window widened again.
  Clamping now happens where the position is read, so the stored value stays the
  user's intent. If you were relying on the old behavior to rescue off-screen
  widgets, `resetAll()` is the deliberate version of that.

---

## Terminology

- **Floating widget** — one draggable, snappable panel (the mechanism).
- **HUD** — the *cluster* of them in a given app (in Pitchcraft: Usage,
  Diagnostics, Telemetry, Demo). The package is the mechanism; "the HUD" is what
  a host app assembles from it.

---

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit, mirrors Pitchcraft's strictness
npm run build       # tsup → dist/index.js (ESM) + dist/index.d.ts
```

Licensed under the MIT License; see `LICENSE`.
