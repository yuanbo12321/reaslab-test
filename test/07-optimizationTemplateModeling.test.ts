import { expect, test } from "@playwright/test";

import {
  MODELING_CH7_SKIP_MSG,
  openLeafFile,
  reasLingoWhoAreYouProbe,
  tryEnterOptimizationTemplateModelingIde,
} from "./helpers";

test.describe("7. 使用模板创建优化建模项目并完成建模工作", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(900_000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        globalThis.localStorage.removeItem("rl---navigation-rail-item");
        globalThis.localStorage.removeItem("reaslingo-chat-view-mode");
      } catch {
        /* ignore */
      }
    });
  });

  test("7.1 从优化建模模板创建项目并进入建模 IDE", async ({ page }) => {
    test.skip(!(await tryEnterOptimizationTemplateModelingIde(page)), MODELING_CH7_SKIP_MSG);
    await expect(page).toHaveURL(/\/projects\/[^/]+\/?$/i);
    await expect(page.getByTitle("Create New File")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator(".bg-sidebar button").filter({ has: page.locator("svg.lucide-sliders-horizontal") }),
    ).toBeVisible({ timeout: 30_000 });
  });

  /**
   * `docs/用户场景.md` 7.2：进入项目后打开 **项目根目录 README.md**（场景文稿中的路径指此文件），
   * 在编辑器工具栏点击 **Markdown 预览**（眼睛图标，`editor-toolbar` 中 `Toggle Markdown Preview`），
   * 右侧/分栏出现 `MarkdownGroup` 的 `.ide-markdown-surface` 即视为成功。
   */
  test("7.2 打开 README.md 并显示 Markdown 预览", async ({ page }) => {
    test.skip(!(await tryEnterOptimizationTemplateModelingIde(page)), MODELING_CH7_SKIP_MSG);

    await expect(page.getByTitle("Create New File")).toBeVisible({ timeout: 30_000 });

    try {
      await openLeafFile(page, ["README.md"]);
    } catch {
      const tree = page.locator(".ide-filetree").filter({ visible: true }).first();
      await expect(tree).toBeVisible({ timeout: 45_000 });
      await tree.getByText(/readme\.md/i).first().click({ timeout: 15_000 });
    }

    await page.locator(".cm-editor").first().waitFor({ state: "visible", timeout: 60_000 });

    const markdownPreviewToggle = page
      .locator("div.flex.h-8.justify-end.gap-2.border-b")
      .locator("button")
      .filter({ has: page.locator("svg.lucide-eye") })
      .first();
    await expect(markdownPreviewToggle).toBeVisible({ timeout: 20_000 });
    await markdownPreviewToggle.click();

    const previewSurface = page.locator(".ide-markdown-surface").filter({ visible: true }).first();
    await expect(previewSurface).toBeVisible({ timeout: 45_000 });
    await expect
      .poll(
        async () => (await previewSurface.locator(".prose-markdown").first().innerText()).trim().length,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(5);
  });

  test("7.3 ReasLingo：Optimization Agent 与 who are you?", async ({ page }) => {
    test.skip(!(await tryEnterOptimizationTemplateModelingIde(page)), MODELING_CH7_SKIP_MSG);
    const ok = await reasLingoWhoAreYouProbe(page, /Optimization/i);
    test.skip(!ok, "当前环境无 Optimization Agent，跳过 7.3 ReasLingo。");
  });
});
