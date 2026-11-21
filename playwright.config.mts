import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "web", use: { baseURL: "http://127.0.0.1:3100" } }],
  // 先运行 bun run build。专用端口避免与日常开发服务混用。
  webServer: [
    {
      command: "bun run --cwd apps/web start --port 3100 --hostname 127.0.0.1",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
