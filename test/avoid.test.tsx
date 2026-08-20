// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * Regression tests for the useAvoid* hook family, against REAL Radix.
 *
 * Both shipped bugs in this family came from the same blind spot: the hooks
 * were only ever exercised against DOM the test itself mounted, never against
 * a portaled, ref-composing component like Radix's Dialog Content.
 *
 *   0.2.0  useAvoidRects returned [] forever for portaled content — a
 *          RefObject can't notify, so the layout effect ran once against null.
 *   0.2.1  useAvoidElement's callback ref setState'd on every invocation.
 *          Radix's useComposedRefs re-invokes callback refs (null, then el)
 *          whenever its identity changes, flipping state within one commit and
 *          driving an infinite render loop.
 *
 * One fixture — a callback ref attached to a Radix Content inside a Portal —
 * catches both. That fixture is this file.
 */

import { StrictMode, useState } from "react";
import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog as SheetPrimitive } from "radix-ui";

import { useAvoidElement } from "../src/avoid";
import { SHEET_RECT } from "./setup";

/** Mirrors shadcn/ui's Sheet: no explicit forwardRef, spreads props onto Content. */
function SheetContent(props: React.ComponentProps<typeof SheetPrimitive.Content>) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Content data-slot="sheet-content" {...props}>
        <SheetPrimitive.Title>Settings</SheetPrimitive.Title>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

function Harness({ onRender }: { onRender?: () => void }) {
  const [open, setOpen] = useState(false);
  const [rects, sheetRef] = useAvoidElement();
  onRender?.();
  return (
    <SheetPrimitive.Root open={open} onOpenChange={setOpen} modal={false}>
      <SheetPrimitive.Trigger onClick={() => setOpen(true)}>open</SheetPrimitive.Trigger>
      <SheetContent ref={sheetRef} />
      <output data-testid="rects">{JSON.stringify(rects)}</output>
    </SheetPrimitive.Root>
  );
}

const readRects = () => JSON.parse(screen.getByTestId("rects").textContent || "[]");

/**
 * A host that hands down a FRESH callback-ref identity on every render — which
 * is precisely what Radix's `useComposedRefs` does, and what React answers by
 * calling the old ref with null and the new one with the element on the same
 * commit.
 *
 * This is the deterministic form of the 0.2.1 crash. Testing the CONTRACT here
 * rather than Radix's internals matters: the same scenario inside a real Radix
 * dialog does not reproduce under jsdom (no layout, no animation, far less
 * re-rendering), so a Radix-only test passes against the broken hook and proves
 * nothing.
 */
function ChurningRefHarness({ onRender }: { onRender?: () => void }) {
  const [rects, ref] = useAvoidElement();
  onRender?.();
  const composed = (el: HTMLDivElement | null) => ref(el); // new identity/render
  return (
    <div>
      <div data-slot="sheet-content" ref={composed} />
      <output data-testid="rects">{JSON.stringify(rects)}</output>
    </div>
  );
}

describe("useAvoidElement under a churning callback ref", () => {
  it("does not loop when the ref identity changes every render", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let renders = 0;

    expect(() => render(<ChurningRefHarness onRender={() => { renders += 1; }} />))
      .not.toThrow();

    const messages = errors.mock.calls.map((c) => String(c[0])).join("\n");
    errors.mockRestore();

    expect(messages).not.toMatch(/Maximum update depth/i);
    expect(renders).toBeLessThan(25);
    expect(readRects()).toHaveLength(1); // and it still measured the element
  });
});

describe("useAvoidElement with a Radix-portaled sheet", () => {
  it("measures the element once the portal mounts", async () => {
    render(<Harness />);
    expect(readRects()).toEqual([]); // closed: nothing to avoid

    await act(async () => {
      screen.getByText("open").click();
    });

    // The 0.2.0 failure mode was [] here, forever.
    expect(readRects()).toEqual([
      {
        left: SHEET_RECT.left,
        top: SHEET_RECT.top,
        right: SHEET_RECT.right,
        bottom: SHEET_RECT.bottom,
      },
    ]);
  });

  it("does not loop when Radix re-composes its ref", async () => {
    // The 0.2.1 failure mode: React aborts with "Maximum update depth
    // exceeded" and unmounts the subtree. Assert on both the error and a
    // bounded render count, so a merely-excessive (not fatal) loop still fails.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let renders = 0;

    render(<Harness onRender={() => { renders += 1; }} />);
    const before = renders;

    await act(async () => {
      screen.getByText("open").click();
    });

    const messages = errors.mock.calls.map((c) => String(c[0])).join("\n");
    errors.mockRestore();

    expect(messages).not.toMatch(/Maximum update depth/i);
    expect(renders - before).toBeLessThan(25);
    expect(screen.getByText("Settings")).toBeTruthy(); // subtree survived
  });

  it("clears the rect when the sheet really unmounts", async () => {
    render(<Harness />);
    await act(async () => { screen.getByText("open").click(); });
    expect(readRects()).toHaveLength(1);

    await act(async () => { screen.getByText("open").click(); });
    // Deferred detach must still fire for a genuine unmount.
    await act(async () => { await Promise.resolve(); });
    expect(readRects()).toEqual([]);
  });

  it("survives StrictMode double-invocation", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<StrictMode><Harness /></StrictMode>);
    await act(async () => { screen.getByText("open").click(); });
    const messages = errors.mock.calls.map((c) => String(c[0])).join("\n");
    errors.mockRestore();

    expect(messages).not.toMatch(/Maximum update depth/i);
    expect(readRects()).toHaveLength(1);
  });
});
