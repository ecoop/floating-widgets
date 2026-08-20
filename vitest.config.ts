// Copyright (c) 2026 Eric Cooper. Licensed under the MIT License; see LICENSE.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.tsx"],
  },
});
