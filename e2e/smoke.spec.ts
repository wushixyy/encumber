import { expect, test } from "@playwright/test";

test("首页正常响应且没有浏览器运行时错误", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("main")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("不存在的页面返回 404", async ({ request }) => {
  const response = await request.get("/__template_missing_page__");

  expect(response.status()).toBe(404);
});
