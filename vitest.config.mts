import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 暂无测试文件时不报错；开工后随功能补充测试。
    passWithNoTests: true,
    projects: ["web"].map((app) => ({
      plugins: [react()],
      resolve: {
        alias: {
          "@": fileURLToPath(new URL(`./apps/${app}/src`, import.meta.url)),
        },
      },
      test: {
        name: app,
        root: fileURLToPath(new URL(`./apps/${app}`, import.meta.url)),
        environment: "jsdom",
        include: ["src/**/*.{test,spec}.{ts,tsx}"],
        setupFiles: [fileURLToPath(new URL("./tests/setup.ts", import.meta.url))],
        clearMocks: true,
        restoreMocks: true,
      },
    })),
  },
});
