<!-- Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE. -->

# @ecoop/floating-widgets

A draggable, snappable stack of corner-docked panels — **"floating widgets"** —
for React 19. Extracted from Pitchcraft's sidebar HUD (Usage / Diagnostics /
Telemetry / Demo).

Each widget is either **snapped** (placed by a shared coordinator that stacks
widgets below your header and reflows them as they collapse/expand) or
**floating** (the user grabbed it and dragged it somewhere; its position
persists to `localStorage`). Drag a snapped widget out of its slot and it takes
ownership; drop it back near the dock and it re-joins the stack.

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

### 2. A shadcn / Tailwind CSS-variable theme must be in scope

`FloatingWidget` styles itself with these design tokens (shadcn's defaults):

```
bg-card   text-card-foreground   border   shadow-lg
text-muted-foreground   text-foreground
```

They must resolve at runtime — i.e. the host app already uses Tailwind with the
shadcn CSS variables installed (`--card`, `--card-foreground`, `--border`,
`--muted-foreground`, `--foreground`). This package imports **no CSS** and ships
**no styles**; it borrows the host's. Without those tokens the panels render
structurally correct but unstyled.

> If you ever need a non-shadcn consumer, that's the seam to parametrize
> (className props or your own CSS vars). Not done here — both current consumers
> are shadcn apps.

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
} from "@ecoop/floating-widgets";

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
    <LayoutProvider>
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

## API

### Composition surface (the 90% path)

| Export | What |
| --- | --- |
| `LayoutProvider` | Context provider; wrap header + reporter + stack. |
| `StackOriginReporter` | Measures `headerRef` bottom → stack origin. Renders nothing. |
| `FloatingWidgetStack<Ctx>` | Renders the registry; exposes `snapAll` / `resetAll` via `ref`. |
| `WidgetDef<Ctx>` (type) | One widget's declaration: `id`, `header`, `render`, optional `mountWhen` / `defaultCollapsed`. |
| `FloatingWidgetStackHandle` (type) | `{ snapAll(); resetAll(); }`. |

**`FloatingWidgetStack` props:** `widgets`, `ctx`, `settingsOpen?`,
`settingsPanelWidth?`, `storagePrefix?`, `ref?`. Pass `storagePrefix` if two
apps share an origin, so their `widget:<id>` localStorage keys don't collide.

### Primitives (escape hatch — custom layouts)

`FloatingWidget`, `FloatingWidgetHandle`, `useLayout`, `LayoutContextValue`,
`useWidgetLayout`, `WIDGET_W`, `WIDGET_MARGIN`, and the `WidgetState` /
`WidgetMode` / `WidgetPosition` types. Use these only if you're building a layout
other than the stack.

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
