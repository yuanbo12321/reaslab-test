import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import {
  MODELING_CH5_SKIP_MSG,
  tryEnterModelingProjectIde,
  waitForFileTree,
} from "./helpers";

const TEST_UPLOAD_TEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "test_upload.tex");

/** 在 Explore 中选根目录常见锚点（README）后，经 **Upload Files** 弹窗上传单文件（与 `reaslingoUploadFileForAiChat` 同源 UI）。 */
async function uploadSingleFileToSelectedTreeDir(page: Page, absoluteFilePath: string): Promise<void> {
  await waitForFileTree(page);
  const tree = page.locator(".ide-filetree").filter({ visible: true }).first();
  await expect(tree).toBeVisible({ timeout: 45_000 });

  const readmeRow = tree.getByRole("row", { name: /readme\.md/i }).first();
  if ((await readmeRow.count()) > 0 && (await readmeRow.isVisible().catch(() => false))) {
    await readmeRow.click();
  } else {
    await tree.getByRole("row").first().click();
  }

  const uploadBtn = page.locator('button[title="Upload Files"]').first();
  await expect(uploadBtn).toBeVisible({ timeout: 15_000 });
  await uploadBtn.scrollIntoViewIfNeeded();
  await uploadBtn.click();

  const uploadDialog = page.getByRole("dialog").filter({
    has: page.getByRole("button", { name: "Select Files", exact: true }),
  });
  await expect(uploadDialog).toBeVisible({ timeout: 15_000 });

  const fileInput = uploadDialog.locator('input[type="file"]:not([webkitdirectory])').first();
  await expect(fileInput).toBeAttached({ timeout: 10_000 });
  await fileInput.setInputFiles(absoluteFilePath);

  await expect(uploadDialog).toBeHidden({ timeout: 180_000 });
  await expect(
    page.locator("[data-sonner-toast]").filter({
      hasText: /Failed to upload|Upload failed:|Upload process failed/i,
    }),
  ).toHaveCount(0, { timeout: 15_000 });
}

/** 当前可见编辑区内的 CodeMirror 内容（避免 `.first()` 命中已隐藏的标签页里仍为 markdown 的 `.cm-content`）。 */
function visibleCmContent(page: Page) {
  return page.locator(".cm-content").filter({ visible: true }).first();
}

/**
 * 打开 **TeX / PDF** 侧栏（`texSplitPreviewOpenAtom`，见 `state/editor/split-preview.ts`）。
 *
 * **`TooltipIconButton`**（`components/tooltip-wrapper.tsx`）只把文案交给 Radix **Tooltip**，**不**设置原生 **`title`**，
 * 故 **勿用** `getByTitle("Toggle TeX Preview")`。与 `editor-toolbar.tsx` 一致：在
 * **`div.flex.h-8.justify-end.gap-2.border-b`** 内找带 **`lucide-eye`** 的按钮（与 `07-optimizationTemplateModeling` Markdown 预览同款 DOM 结构）。
 *
 * 若本地存过 `tex-split--<uuid>` 为 true，首次点击会关栏，则再点一次打开。
 */
async function openTexPreviewThenCompileButton(page: Page): Promise<void> {
  const editorToolbar = page
    .locator("div.flex.h-8.justify-end.gap-2.border-b")
    .filter({ visible: true })
    .first();
  await expect(editorToolbar).toBeVisible({ timeout: 30_000 });

  const eyeBtn = editorToolbar.locator("button").filter({
    has: page.locator("svg.lucide-eye, svg[class*='lucide-eye']"),
  }).first();
  await expect(eyeBtn).toBeVisible({ timeout: 30_000 });

  const compile = page.getByRole("button", { name: "Compile", exact: true });
  for (let i = 0; i < 3; i++) {
    if (await compile.isVisible().catch(() => false)) {
      return;
    }
    await eyeBtn.click();
    await page.waitForTimeout(800);
  }
  await expect(compile).toBeVisible({ timeout: 30_000 });
}

/**
 * **用户场景 §12**：使用 LaTeX 文件（见 `docs/用户场景.md`）。
 * 依赖数学建模类项目（与 §5 相同 **`tryEnterModelingProjectIde`**）；上传 **`test/data/test_upload.tex`** → 打开 → 工具栏 **眼睛**（`editor-toolbar.tsx` + `TooltipIconButton`，无 `title`）打开侧栏 → **Compile** → 断言 PDF 区出现 **canvas**（`pdf-preview.tsx` / `data-pdf-presentation`）。
 */
test.describe("12. 使用 LaTeX 文件", () => {
  test.setTimeout(600_000);

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

  test("12.1 上传本地 LaTeX 并编译预览", async ({ page }) => {
    test.skip(!(await tryEnterModelingProjectIde(page)), MODELING_CH5_SKIP_MSG);
    await expect(page.getByTitle("Create New File")).toBeVisible({ timeout: 30_000 });

    await test.step("Explore：上传 test_upload.tex 至项目根", async () => {
      await uploadSingleFileToSelectedTreeDir(page, TEST_UPLOAD_TEX);
    });

    await test.step("文件树打开 .tex 标签页", async () => {
      const tree = page.locator(".ide-filetree").filter({ visible: true }).first();
      const row = tree.getByRole("row", { name: /test_upload\.tex/i }).first();
      await expect(row).toBeVisible({ timeout: 180_000 });
      await row.click();
      await expect(visibleCmContent(page)).toBeVisible({ timeout: 60_000 });
      await expect(visibleCmContent(page)).toContainText(/\\documentclass/i, {
        timeout: 30_000,
      });
    });

    await test.step("侧栏 TeX 预览：眼睛打开预览窗 → Compile → PDF canvas 可见", async () => {
      await openTexPreviewThenCompileButton(page);
      const emptyHint = page.getByText("Click the compile button to preview PDF", { exact: true });
      if (await emptyHint.isVisible().catch(() => false)) {
        await expect(emptyHint).toBeVisible();
      }

      await page.getByRole("button", { name: "Compile", exact: true }).click();

      await expect(emptyHint).toBeHidden({ timeout: 300_000 });

      const pdfCanvas = page.locator("[data-pdf-presentation]").locator("canvas").first();
      await expect(pdfCanvas).toBeVisible({ timeout: 120_000 });
    });
  });
});
