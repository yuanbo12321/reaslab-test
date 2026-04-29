import { expect, test } from "@playwright/test";

import { absUrl } from "../common/global-setup";
import {
  bulkArchiveAndPermanentlyDeleteAllMyProjectsOnProjectsPage,
  navigateToHomeProjects,
  projectsListBatchToolbar,
  projectsTabPanel,
  projectsTableDataRowsInTabPanel,
  waitForFileTree,
} from "./helpers";

/**
 * **用户场景 §10**：查看项目列表并管理项目（见 `docs/用户场景.md`）。
 * 覆盖：工作台 Projects 四标签、按名称搜索、点击项目名进入 IDE、行内 Setup/Settings/Download/Copy/Rename/Archive、多选批量栏。
 * **10.1** 不对单条项目确认归档/删除；**10.2** 固定执行：对 **My Projects** 下当前账号 **全部自有项目** **全选 → 归档 → 在「Archived」中永久删除**（不按名称关键字筛选；见 `bulkArchiveAndPermanentlyDeleteAllMyProjectsOnProjectsPage`），并断言 **My Projects** 表格数据行为 0。
 *
 * 有界面调试：Playwright 使用 **`--headed`**（没有 `--head`）。例如：
 * `pnpm run test:10:headed`，或
 * `npx playwright test --config common/playwright.config.ts test/10-project-list.test.ts --headed`。
 */
const U10_SKIP_MSG =
  "无法创建项目（如工具链加载失败），跳过 §10 项目列表用例。";

test.describe("10. 查看项目列表并管理项目", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

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

  test("10.1 四标签、新建 Modeling、搜索与行内操作", async ({ page }) => {
    await test.step("工作台 Projects：四标签与搜索框", async () => {
      await navigateToHomeProjects(page);
      await expect(page.getByRole("tab", { name: "All Projects" })).toBeVisible();
      await expect(page.getByRole("tab", { name: "My Projects" })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Shared with Me" })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Archived Projects" })).toBeVisible();

      const panelAll = projectsTabPanel(page, "All Projects");
      await expect(panelAll.getByPlaceholder("Search projects...")).toBeVisible();
      await expect(panelAll.getByRole("columnheader", { name: "Project", exact: true })).toBeVisible();

      await page.getByRole("tab", { name: "Shared with Me" }).click();
      await expect(projectsTabPanel(page, "Shared with Me").getByPlaceholder("Search projects...")).toBeVisible();

      await page.getByRole("tab", { name: "Archived Projects" }).click();
      await expect(projectsTabPanel(page, "Archived Projects").getByPlaceholder("Search projects...")).toBeVisible();

      await page.getByRole("tab", { name: "All Projects" }).click();
    });

    const projectName = `e2e_p1_u10_${Date.now()}`;

    await test.step("新建 Modeling 项目（供列表检索）", async () => {
      await navigateToHomeProjects(page);
      await page.getByRole("button", { name: "New Project" }).first().click();
      await expect(page.getByRole("heading", { name: "New Project" })).toBeVisible({
        timeout: 120_000,
      });

      const toolchainErr = page.getByText(/Could not load toolchain versions/i);
      if ((await toolchainErr.count()) > 0 && (await toolchainErr.isVisible().catch(() => false))) {
        test.skip(true, U10_SKIP_MSG);
      }

      const modelingBtn = page.getByRole("button", { name: "Modeling", exact: true });
      if ((await modelingBtn.count()) > 0) {
        const m = modelingBtn.first();
        const pressed = await m.getAttribute("aria-pressed");
        const dataState = await m.getAttribute("data-state");
        const on = pressed === "true" || dataState === "on";
        if (!on) {
          await m.click();
        }
      }

      const nameInput = page.locator("input#project-name, input#projectName").first();
      await expect(nameInput).toBeVisible({ timeout: 60_000 });
      await nameInput.fill(projectName);

      const createBtn = page.getByRole("button", { name: "Create Project" });
      await expect(createBtn).toBeEnabled({ timeout: 90_000 });
      await createBtn.click();

      await page.waitForURL(/\/projects\/[^/]+\/?$/i, { timeout: 120_000 });
      await page.getByTitle("Create New File").waitFor({ state: "visible", timeout: 120_000 });
      await waitForFileTree(page);
    });

    await test.step("返回列表：我的项目 + 名称搜索 + 行内操作可见", async () => {
      await page.goto(absUrl("/"), { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("tab", { name: "My Projects" }).click();

      const panel = projectsTabPanel(page, "My Projects");
      const search = panel.getByPlaceholder("Search projects...");
      await search.fill(projectName);

      const row = page.getByRole("row").filter({ hasText: projectName }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });

      await expect(row.getByRole("link", { name: "Setup", exact: true })).toBeVisible();
      await expect(row.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "Download", exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "Rename", exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
    });

    await test.step("Rename 对话框打开后取消", async () => {
      const row = page.getByRole("row").filter({ hasText: projectName }).first();
      await row.getByRole("button", { name: "Rename", exact: true }).click();
      await expect(page.getByRole("dialog").getByText("Rename project")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });
    });

    await test.step("多选后出现批量栏（不确认归档）", async () => {
      const row = page.getByRole("row").filter({ hasText: projectName }).first();
      await row.getByRole("checkbox", { name: `Select project ${projectName}` }).click();
      await expect(page.getByText("Selected 1", { exact: true })).toBeVisible({ timeout: 10_000 });
      const myPanel = projectsTabPanel(page, "My Projects");
      await expect(
        projectsListBatchToolbar(myPanel).getByRole("button", { name: "Archive", exact: true }),
      ).toBeEnabled();

      await row.getByRole("checkbox", { name: `Select project ${projectName}` }).click();
      await expect(page.getByText("Selected 1", { exact: true })).toBeHidden({ timeout: 10_000 });
    });

    await test.step("点击项目名进入 IDE", async () => {
      const row = page.getByRole("row").filter({ hasText: projectName }).first();
      await row.getByRole("link", { name: projectName, exact: true }).click();
      await page.waitForURL(/\/projects\/[^/]+\/?$/i, { timeout: 60_000 });
      await expect(page.getByTitle("Create New File")).toBeVisible({ timeout: 30_000 });
    });

    await test.step("行内 Settings 进入设置页", async () => {
      await page.goto(absUrl("/"), { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("tab", { name: "My Projects" }).click();
      const panel = projectsTabPanel(page, "My Projects");
      await panel.getByPlaceholder("Search projects...").fill(projectName);
      const row = page.getByRole("row").filter({ hasText: projectName }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.getByRole("link", { name: "Settings", exact: true }).click();
      await expect(page).toHaveURL(/\/projects\/[^/]+\/settings/i, { timeout: 30_000 });
    });
  });

  test("10.2 清理：全选并归档 My Projects 全部自有项目，再在「Archived」中永久删除", async ({ page }) => {
    await test.step("My Projects：清空搜索 → 全选 → Archive → 确认（若有）→ Archived：全选 → Delete → 确认", async () => {
      await bulkArchiveAndPermanentlyDeleteAllMyProjectsOnProjectsPage(page);
    });

    await test.step("My Projects：列表无数据行（不通过关键字筛选）", async () => {
      await navigateToHomeProjects(page);
      await page.getByRole("tab", { name: "My Projects" }).click();
      const panel = projectsTabPanel(page, "My Projects");
      await panel.getByPlaceholder("Search projects...").fill("");
      await expect(projectsTableDataRowsInTabPanel(panel)).toHaveCount(0, { timeout: 30_000 });
    });
  });
});
