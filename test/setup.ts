// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
/**
 * jsdom has no layout engine: every getBoundingClientRect() is zeros, and
 * ResizeObserver doesn't exist. Both matter here — `rectOf` treats a 0x0 box as
 * "not laid out" and returns null, which would make every avoid test trivially
 * pass by measuring nothing.
 *
 * So we give the sheet a real box. Anything tagged data-slot="sheet-content"
 * reports a 448px right-hand panel in a 1280x800 viewport; everything else
 * keeps a small non-zero box so it isn't mistaken for un-laid-out.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Without `globals: true`, RTL never registers its auto-cleanup, so DOM from
// one test leaks into the next test's `screen` queries.
afterEach(cleanup);

const VIEWPORT = { width: 1280, height: 800 };
export const SHEET_RECT = {
  left: 832, top: 0, right: 1280, bottom: 800, width: 448, height: 800,
};

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= StubResizeObserver as unknown as typeof ResizeObserver;

Object.defineProperty(window, "innerWidth", { value: VIEWPORT.width, writable: true });
Object.defineProperty(window, "innerHeight", { value: VIEWPORT.height, writable: true });

Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
  const box =
    this instanceof HTMLElement && this.dataset.slot === "sheet-content"
      ? SHEET_RECT
      : { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 };
  return { ...box, x: box.left, y: box.top, toJSON: () => box } as DOMRect;
};
