import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: [],
    css: false,
    include: ["tests/**/*.test.ts"],
  },
});