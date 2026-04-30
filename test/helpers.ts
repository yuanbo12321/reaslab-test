import { type Locator, type Page, expect } from "@playwright/test";

import { absUrl } from "../common/global-setup";
import {
  readModelingContestTemplateProjectUuidArtifact,
  writeModelingContestTemplateProjectUuidArtifact,
} from "./data/e2e-modeling-contest-template-project-artifact";
import {
  readModelingProjectUuidArtifact,
  writeModelingProjectUuidArtifact,
} from "./data/e2e-modeling-project-artifact";
import {
  readOptimizationTemplateProjectUuidArtifact,
  writeOptimizationTemplateProjectUuidArtifact,
} from "./data/e2e-optimization-template-project-artifact";
import { readTheoremProjectUuidArtifact, writeTheoremProjectUuidArtifact } from "./data/e2e-theorem-project-artifact";

/** 与前端 `Hotkey.OPEN_FILE_EXPLORER` / `OPEN_PROJECT_SEARCH`（`mod+shift+e` / `mod+shift+f`）一致；无头 Linux 用 Ctrl。 */
const FILE_EXPLORER_HOTKEY = "Control+Shift+E";
const PROJECT_SEARCH_HOTKEY = "Control+Shift+F";

export async function navigateToHomeProjects(page: Page): Promise<void> {
  await page.goto(absUrl("/"));
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible({ timeout: 30_000 });
}

/** 与 `reaslab-iipe` Import Git 页 `ImportForm` 示例 URL 一致。 */
export const E2E_DEFAULT_IMPORT_GIT_URL =
  "https://github.com/leanprover-community/flt-regular.git" as const;

const IMPORT_GIT_IDE_NAV_TIMEOUT_MS = 600_000; // 10 min：服务端 clone + 重定向
const IMPORT_GIT_IDE_SHELL_TIMEOUT_MS = 600_000; // 10 min：toolchain / lake / 缓存

/**
 * 工作台 **`/?nav=import-git`** → **Manual Import**：填写仓库 URL 与项目名 → **Import Project**，
 * 等待进入 **`/projects/:uuid`** 且 **Create New File** 与文件树就绪（定理类仓库含长时间环境准备，与 MIL 模板同级）。
 *
 * 表单默认 **Theorem Proving**；Lean 仓库勿选 **Modeling**。
 */
export async function manualImportGitAndEnterIde(
  page: Page,
  sourceUrl: string,
  projectName: string,
): Promise<boolean> {
  try {
    await page.goto(absUrl("/?nav=import-git"), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Import from Git/i })).toBeVisible({
      timeout: 60_000,
    });

    const urlInput = page.locator("#sourceUrl");
    await expect(urlInput).toBeVisible({ timeout: 30_000 });
    await urlInput.fill(sourceUrl);

    const nameInput = page.locator("#projectName");
    await expect(nameInput).toBeVisible({ timeout: 15_000 });
    await nameInput.fill(projectName);

    const importBtn = page.getByRole("button", { name: "Import Project", exact: true });
    await expect(importBtn).toBeVisible({ timeout: 15_000 });
    await importBtn.click();

    await page.waitForURL(/\/projects\/[^/]+\/?$/i, { timeout: IMPORT_GIT_IDE_NAV_TIMEOUT_MS });
    await page
      .getByTitle("Create New File")
      .waitFor({ state: "visible", timeout: IMPORT_GIT_IDE_SHELL_TIMEOUT_MS });
    await waitForFileTree(page);
    return true;
  } catch {
    return false;
  }
}

/**
 * 工作台 Projects 下指定标签对应的面板。
 * 使用 **`role="tabpanel"` + 名称** 定位，避免多个 `[data-slot="tabs-content"]` 在 Radix Tabs 下仍被 `filter({ visible: true })` 同时命中，导致 `getByPlaceholder` strict mode 冲突。
 */
export function projectsTabPanel(page: Page, tabName: string) {
  return page.getByRole("tabpanel", { name: tabName, exact: true });
}

/**
 * **`ProjectsBatchToolbar`**（reaslab-iipe `projects-batch-toolbar.tsx`）：在搜索框与表格之间，
 * 出现 **「Selected N」** 时右侧才有 **Archive**（非 Archived）或 **Restore / Delete**（Archived）。
 * 须用本定位器再点按钮，**勿**用裸 `page.getByRole("button", { name: "Archive" })`，否则会命中表格行内的 **Archive**（`ArchiveProjectButton`），不会打开批量确认框。
 */
export function projectsListBatchToolbar(panel: Locator): Locator {
  return panel.getByText(/^Selected \d+/).locator("..");
}

/**
 * **`projects-table`** 的 tbody 数据行（`data-slot="table-row"`），**不按名称过滤**。
 * 用于「我的项目」全量清理与空表断言；勿用裸 **`getByRole("row")`** 以免混入表头等非数据行。
 */
export function projectsTableDataRowsInTabPanel(panel: Locator): Locator {
  return panel.locator('[data-slot="table-body"] [data-slot="table-row"]');
}

/**
 * 在工作台 **`/`** Projects：**My Projects** 下对当前列表中的 **全部自有项目** 循环执行：
 * **全选 → Archive → 确认**，再在 **Archived Projects** 中对 **全部已归档行** **全选 → Delete → 确认**（永久删除）。
 *
 * 各标签页会先 **`fill("")` 清空搜索框**：这不是「按关键字搜索」，而是**去掉残留筛选**，避免 `count()` 读到 0 行却误判已空、或 Archived 里筛掉行而跳过永久删除。
 *
 * 与前端 **`projects-table`**（表头 `aria-label="Select all projects"`）、**`projects-batch-toolbar`**、
 * **`projects-page`** 批量确认文案一致；多轮执行直至「我的项目」与「已归档」列表均无数据行，或达到轮数上限。
 */
export async function bulkArchiveAndPermanentlyDeleteAllMyProjectsOnProjectsPage(page: Page): Promise<void> {
  const maxPasses = 8;
  for (let pass = 0; pass < maxPasses; pass++) {
    await navigateToHomeProjects(page);

    await page.getByRole("tab", { name: "My Projects" }).click();
    const myPanel = projectsTabPanel(page, "My Projects");
    await expect(myPanel.locator('[data-slot="table-body"]')).toBeVisible({ timeout: 30_000 });
    await myPanel.getByPlaceholder("Search projects...").fill("");
    const nMyStart = await projectsTableDataRowsInTabPanel(myPanel).count();

    if (nMyStart > 0) {
      await myPanel.getByRole("checkbox", { name: "Select all projects" }).click();
      await expect(myPanel.getByText(/^Selected \d+/)).toBeVisible({ timeout: 10_000 });
      await projectsListBatchToolbar(myPanel).getByRole("button", { name: "Archive", exact: true }).click();

      const confirmArchive = page
        .locator('[data-slot="alert-dialog-content"]')
        .filter({ hasText: "Archive selected projects?" });
      await expect(confirmArchive).toBeVisible({ timeout: 20_000 });
      await confirmArchive.getByRole("button", { name: "Archive", exact: true }).click();
      await expect(confirmArchive).toBeHidden({ timeout: 180_000 });
    }

    await page.getByRole("tab", { name: "Archived Projects" }).click();
    const archivedPanel = projectsTabPanel(page, "Archived Projects");
    await expect(archivedPanel.locator('[data-slot="table-body"]')).toBeVisible({ timeout: 30_000 });
    await archivedPanel.getByPlaceholder("Search projects...").fill("");

    if (nMyStart > 0) {
      await expect
        .poll(async () => await projectsTableDataRowsInTabPanel(archivedPanel).count(), { timeout: 120_000 })
        .toBeGreaterThan(0);
    }

    const nArch = await projectsTableDataRowsInTabPanel(archivedPanel).count();

    if (nArch > 0) {
      await archivedPanel.getByRole("checkbox", { name: "Select all projects" }).click();
      await expect(archivedPanel.getByText(/^Selected \d+/)).toBeVisible({ timeout: 10_000 });
      await projectsListBatchToolbar(archivedPanel).getByRole("button", { name: "Delete", exact: true }).click();

      const confirmDelete = page
        .locator('[data-slot="alert-dialog-content"]')
        .filter({ hasText: "Permanently delete selected projects?" });
      await expect(confirmDelete).toBeVisible({ timeout: 20_000 });
      await confirmDelete.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(confirmDelete).toBeHidden({ timeout: 180_000 });
    }

    // 用回合结束时的真实行数判断「是否已清空」，勿用本轮开头的 nMyStart（首帧 0 行会误判并提前 return）
    await page.getByRole("tab", { name: "My Projects" }).click();
    const myPanelEnd = projectsTabPanel(page, "My Projects");
    await myPanelEnd.getByPlaceholder("Search projects...").fill("");
    const nMyEnd = await projectsTableDataRowsInTabPanel(myPanelEnd).count();
    await page.getByRole("tab", { name: "Archived Projects" }).click();
    const archivedPanelEnd = projectsTabPanel(page, "Archived Projects");
    await archivedPanelEnd.getByPlaceholder("Search projects...").fill("");
    const nArchEnd = await projectsTableDataRowsInTabPanel(archivedPanelEnd).count();
    if (nMyEnd === 0 && nArchEnd === 0) {
      return;
    }
  }

  await navigateToHomeProjects(page);
  await page.getByRole("tab", { name: "My Projects" }).click();
  const left = await projectsTableDataRowsInTabPanel(projectsTabPanel(page, "My Projects")).count();
  if (left > 0) {
    throw new Error(
      `bulkArchiveAndPermanentlyDeleteAllMyProjectsOnProjectsPage: 经过 ${maxPasses} 轮后 My Projects 仍有 ${left} 行；请检查归档/删除确认框或列表筛选状态。`,
    );
  }
}

/** 顶栏 Menubar 中「展开左侧栏」：折叠时图标为 `PanelLeft`，展开时为 `PanelLeftClose`（见 `IdeMenubar`）。 */
async function expandLeftPanelViaMenubarIfCollapsed(page: Page): Promise<void> {
  const menubar = page.getByRole("menubar");
  const toggle = menubar
    .locator("button")
    .filter({ has: page.locator("svg[class*='lucide-panel-left']") })
    .first();
  if ((await toggle.count()) === 0) {
    return;
  }
  const cls = (await toggle.locator("svg").first().getAttribute("class")) ?? "";
  if (cls.includes("lucide-panel-left-close")) {
    return;
  }
  if (cls.includes("lucide-panel-left")) {
    await toggle.click();
  }
}

async function activateFilesExplorerTabViaSidebar(page: Page): Promise<void> {
  const explorer = page.getByRole("button", { name: /Explorer/i });
  if ((await explorer.count()) === 0) {
    return;
  }
  await explorer.first().click();
  await page.waitForTimeout(250);
}

export async function waitForFileTree(page: Page): Promise<Locator> {
  await page.locator("body").click({ position: { x: 400, y: 280 } });
  await page.waitForTimeout(150);

  const panel = page.locator(".ide-filetree").filter({ visible: true }).first();

  for (let round = 0; round < 5; round++) {
    await activateFilesExplorerTabViaSidebar(page);
    if (await panel.isVisible().catch(() => false)) {
      break;
    }
    await page.keyboard.press(FILE_EXPLORER_HOTKEY);
    await page.waitForTimeout(400);
    if (await panel.isVisible().catch(() => false)) {
      break;
    }
    if (round === 1) {
      await page.keyboard.press(PROJECT_SEARCH_HOTKEY);
      await page.waitForTimeout(250);
      await activateFilesExplorerTabViaSidebar(page);
      await page.keyboard.press(FILE_EXPLORER_HOTKEY);
      await page.waitForTimeout(400);
      if (await panel.isVisible().catch(() => false)) {
        break;
      }
    }
    await expandLeftPanelViaMenubarIfCollapsed(page);
    await page.waitForTimeout(350);
    await activateFilesExplorerTabViaSidebar(page);
    await page.keyboard.press(FILE_EXPLORER_HOTKEY);
    await page.waitForTimeout(400);
    if (await panel.isVisible().catch(() => false)) {
      break;
    }
  }

  await expect(panel).toBeVisible({ timeout: 45_000 });

  const treegrid = panel.getByRole("treegrid", { name: "File tree" });
  const hasTreegrid = (await treegrid.count()) > 0;
  const treegridShown = hasTreegrid && (await treegrid.isVisible().catch(() => false));
  const tree = treegridShown ? treegrid : panel;

  if (treegridShown) {
    const rows = treegrid.getByRole("row");
    if ((await rows.count()) > 0) {
      await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    }
  } else if (!hasTreegrid) {
    const rows = panel.getByRole("row");
    if ((await rows.count()) > 0) {
      await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    }
  }

  return tree;
}

export async function ensureReasLingoVisible(page: Page): Promise<void> {
  const header = page.getByText("ReasLingo", { exact: true }).first();
  for (let i = 0; i < 3; i++) {
    try {
      await expect(header).toBeVisible({ timeout: 2000 });
      return;
    } catch {
      await page.keyboard.press("Control+j");
    }
  }
  await expect(header).toBeVisible({ timeout: 20_000 });
}

/**
 * 将本地文件上传到项目的 **`chat-uploads/`** 下，供 §5.2～§5.4 等 ReasLingo 用例使用。
 *
 * **与当前产品、手动成功路径一致**：左侧 Explore 工具栏 **`title="Upload Files"`**（`file-tree-toolbar`）
 * → 弹窗标题 **「Upload Files」**（`upload-dialog.tsx`）→ 对隐藏 file input 做 **`setInputFiles`**
 *（等效于点 **「Select Files」** 再选文件）。上传目标目录为选中行对应的父路径：此处先保证存在
 * **`chat-uploads`** 文件夹并选中该行，使文件落在 **`chat-uploads/<文件名>`**。
 *
 * 不再依赖 ReasLingo 输入条上的 **「Upload Files for AI Chat」** 及其「Upload & Reference」弹窗——
 * 与你在截图中的手动流程一致；`reasLingoInputHost` 仍保留在签名上以免改动各用例调用处。
 */
export async function reaslingoUploadFileForAiChat(
  page: Page,
  reasLingoInputHost: Locator,
  filePath: string,
): Promise<void> {
  void reasLingoInputHost;

  await waitForFileTree(page);
  const tree = page.locator(".ide-filetree").filter({ visible: true }).first();
  await expect(tree).toBeVisible({ timeout: 45_000 });

  await ensureChatUploadsFolderInIdeFileTree(page);
  await expandIdeFileTreeRowByLabel(page, /chat-uploads/i);

  const uploadBtn = page.locator('button[title="Upload Files"]').first();
  await uploadBtn.scrollIntoViewIfNeeded();
  await uploadBtn.click();

  const uploadDialog = page.getByRole("dialog").filter({
    has: page.getByRole("button", { name: "Select Files", exact: true }),
  });
  await expect(uploadDialog).toBeVisible({ timeout: 15_000 });

  const fileInput = uploadDialog.locator('input[type="file"]:not([webkitdirectory])').first();
  await expect(fileInput).toBeAttached({ timeout: 10_000 });
  await fileInput.setInputFiles(filePath);

  await expect(uploadDialog).toBeHidden({ timeout: 180_000 });
  await expect(
    page.locator("[data-sonner-toast]").filter({
      hasText: /Failed to upload|Upload failed:|Upload process failed/i,
    }),
  ).toHaveCount(0, { timeout: 15_000 });
}

/** 在 Explore 文件树中保证存在 `chat-uploads` 目录（无则在本机「Create new folder」下创建）。 */
async function ensureChatUploadsFolderInIdeFileTree(page: Page): Promise<void> {
  const tree = page.locator(".ide-filetree").filter({ visible: true }).first();
  if ((await tree.getByRole("row", { name: /chat-uploads/i }).count()) > 0) {
    return;
  }
  const readmeRow = tree.getByRole("row", { name: /readme\.md/i }).first();
  if ((await readmeRow.count()) > 0 && (await readmeRow.isVisible().catch(() => false))) {
    await readmeRow.click();
  } else {
    await tree.getByRole("row").first().click();
  }
  const createFolder = page.getByTitle("Create new folder");
  await expect(createFolder).toBeVisible({ timeout: 15_000 });
  await createFolder.click();
  const nameInput = page.getByPlaceholder("New Folder");
  await expect(nameInput).toBeVisible({ timeout: 15_000 });
  await nameInput.fill("chat-uploads");
  await nameInput.press("Enter");
  await expect(tree.getByRole("row", { name: /chat-uploads/i }).first()).toBeVisible({ timeout: 60_000 });
}

/** 在可见 `.ide-filetree` 中展开匹配 `rowLabel` 的文件夹行。无匹配则跳过。 */
export async function expandIdeFileTreeRowByLabel(page: Page, rowLabel: string | RegExp): Promise<void> {
  const shell = page.locator(".ide-filetree").filter({ visible: true }).first();

  const basenameMatches = (basename: string | null): boolean => {
    if (!basename) {
      return false;
    }
    return typeof rowLabel === "string" ? basename === rowLabel : rowLabel.test(basename);
  };

  /**
   * `@reaslab/file-tree`（iipe / beta）：`Tree` + `TreeItem` 渲染为 **treegrid**，展开控件为
   * **`<Button slot="chevron" data-tree-chevron>`**（Hugeicons，**无** `lucide-chevron-right`），且 **无** `data-filetree-node`。
   *
   * **幂等**：`aria-expanded="true"` 时不再点 chevron，避免「上传前已展开 → 上传后再 expand 实为收起」导致子文件从 DOM 消失。
   */
  let treeGrid = shell.getByRole("treegrid", { name: /file tree/i }).first();
  if ((await treeGrid.count()) === 0) {
    treeGrid = shell.getByRole("treegrid").first();
  }
  if ((await treeGrid.count()) > 0) {
    const row = treeGrid.getByRole("row", { name: rowLabel }).first();
    if ((await row.count()) > 0) {
      const expanded = await row.getAttribute("aria-expanded");
      if (expanded === "true") {
        return;
      }
      const racChevron = row.locator("[data-tree-chevron]").first();
      if ((await racChevron.count()) > 0) {
        await racChevron.scrollIntoViewIfNeeded();
        await racChevron.click({ force: true });
        return;
      }
      const expandBtn = row.getByRole("button", { name: /Expand/i }).first();
      if ((await expandBtn.count()) > 0) {
        await expandBtn.scrollIntoViewIfNeeded();
        await expandBtn.click({ force: true });
        return;
      }
      try {
        await row.focus({ timeout: 5_000 });
      } catch {
        /* ignore */
      }
      await page.keyboard.press("ArrowRight");
      return;
    }
  }

  /**
   * `reaslab-uni`：`DirNode` 根节点带 **`data-filetree-node` + `data-node-basename`**，展开为
   * **`svg.lucide-chevron-right`** 或整行 **`.ide-filetree-content`** 点击（`toggleDir`）。
   */
  const uniNodes = shell.locator("[data-filetree-node='true'][data-node-basename]");
  for (let i = 0; i < (await uniNodes.count()); i++) {
    const node = uniNodes.nth(i);
    const base = await node.getAttribute("data-node-basename");
    if (!basenameMatches(base)) {
      continue;
    }
    const lucideChevron = node
      .locator("svg.lucide-chevron-right, svg[class*='chevron-right']")
      .first();
    if ((await lucideChevron.count()) > 0) {
      await lucideChevron.scrollIntoViewIfNeeded();
      await lucideChevron.click({ force: true });
      return;
    }
    const content = node.locator(".ide-filetree-content").first();
    if ((await content.count()) > 0) {
      await content.scrollIntoViewIfNeeded();
      await content.click({ force: true });
      return;
    }
  }

  /** 兜底：仅在 shell 上找 row（无嵌套 treegrid 的旧布局）。 */
  const row = shell.getByRole("row", { name: rowLabel }).first();
  if ((await row.count()) === 0) {
    return;
  }
  const expandBtn = row.getByRole("button", { name: /Expand/i }).first();
  if ((await expandBtn.count()) > 0) {
    await expandBtn.scrollIntoViewIfNeeded();
    await expandBtn.click({ force: true });
    return;
  }
  await row.click();
}

const U1_ASSISTANT_WAIT_MS = 30_000;

export async function waitForReasLingoAssistantReplyDone(page: Page): Promise<void> {
  await page.waitForTimeout(U1_ASSISTANT_WAIT_MS);
}

/**
 * `docs/用户场景.md` §6～§9：侧栏 ReasLingo，发送 **`who are you?`**，并等待本轮助理输出结束（与 `waitForReasLingoAssistantReplyDone` 一致）。
 * `agentMenuLabel` 为 **`null`** 时不打开 Agent 菜单（保持默认 Agent）；否则在 **Agent / Switch Agent** 触发器菜单中选首条匹配项。
 *
 * @returns 若指定了 `agentMenuLabel` 但菜单中无匹配项，返回 **`false`**（调用方宜 `test.skip`）；否则返回 **`true`**。
 */
export async function reasLingoWhoAreYouProbe(
  page: Page,
  agentMenuLabel: RegExp | null,
): Promise<boolean> {
  await ensureReasLingoVisible(page);
  const host = page
    .locator('[data-sidebar="group"]')
    .filter({ has: page.getByText("ReasLingo", { exact: true }) })
    .filter({ has: page.getByTitle("Add Context") })
    .first();
  await expect(host).toBeVisible({ timeout: 20_000 });

  if (agentMenuLabel) {
    const trigger = host.getByRole("button", { name: /^Agent$/i }).or(host.locator('button[title="Switch Agent"]'));
    await expect(trigger.first()).toBeVisible({ timeout: 15_000 });
    await trigger.first().click();
    const panel = page.locator('[data-slot="dropdown-menu-content"][class*="w-56"]');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    const item = panel.locator('[data-slot="dropdown-menu-item"]').filter({ hasText: agentMenuLabel });
    if ((await item.count()) < 1) {
      await page.keyboard.press("Escape");
      return false;
    }
    await item.first().click();
    await expect(panel).toBeHidden({ timeout: 5_000 });
  }

  const ta = host.locator("textarea").first();
  await expect(ta).toBeVisible({ timeout: 15_000 });
  await ta.click();
  await ta.fill("who are you?");
  const sendBtn = host.getByTitle("Send Message").first();
  await expect(sendBtn).toBeEnabled({ timeout: 15_000 });
  await sendBtn.click();
  await expect(async () => {
    await expect(page).toHaveURL(/\/projects\/[^/]+/i);
    await expect(host.getByText(/^who are you\?$/i).first()).toBeVisible();
  }).toPass({ timeout: 30_000 });
  await waitForReasLingoAssistantReplyDone(page);
  return true;
}

/** MIL 入门路径（与 monorepo e2e `TEST_FILES.GETTING_STARTED` 对齐）。 */
export const MIL_GETTING_STARTED_SEGMENTS = ["MIL", "C01_Introduction", "S01_Getting_Started.lean"];

/** `docs/用户场景.md` §5：空白 Modeling 项目不可用时的跳过说明。 */
export const MODELING_CH5_SKIP_MSG =
  "无法进入数学建模 IDE：请确认已登录且 New Project 可创建 Modeling 项目，或 test/data/.e2e-artifacts/modeling-project-uuid.txt 仍有效。";

/** `docs/用户场景.md` §7「模板创建优化建模项目」：从「Optimization Modeling Templates」创建项目失败时的跳过说明。 */
export const MODELING_CH7_SKIP_MSG =
  "无法从优化建模模板进入数学建模 IDE：请确认已登录、模板服务可用，或 test/data/.e2e-artifacts/optimization-template-project-uuid.txt 仍有效。";

/** `docs/用户场景.md` §9「模板创建竞赛建模项目」：从「Math Modeling Contest Templates」创建项目失败时的跳过说明。 */
export const MODELING_CH9_SKIP_MSG =
  "无法从数学建模竞赛模板进入建模 IDE：请确认已登录、竞赛模板服务可用，或 test/data/.e2e-artifacts/modeling-contest-template-project-uuid.txt 仍有效。";

/** `docs/用户场景.md` §8「模板创建定理证明项目」：MIL 定理证明模板 IDE 不可用时的跳过说明（与 `tryEnterLeanProjectIde` / `theorem-project-uuid.txt` 一致）。 */
export const THEOREM_CH8_SKIP_MSG =
  "无法进入 MIL 定理证明 IDE：请确认已登录且 Theorem Proving Templates → Mathematics in Lean → Use Template 可用（首次 lake 可能极慢），或 test/data/.e2e-artifacts/theorem-project-uuid.txt 仍有效。";

const OPT_TEMPLATE_IDE_SHELL_TIMEOUT_MS = 180_000;

const MIL_IMPORT_NAV_TIMEOUT_MS = 600_000;
const MIL_IDE_SHELL_TIMEOUT_MS = 600_000;

export async function createTheoremProvingProjectFromMilTemplate(page: Page): Promise<boolean> {
  try {
    await page.goto(absUrl("/?nav=theorem-proving-templates"), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Create Project Using Template" })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "Use Template" }).first().click();
    await page.waitForURL(/\/projects\/[^/]+\/?$/i, { timeout: MIL_IMPORT_NAV_TIMEOUT_MS });
    await page
      .getByTitle("Create New File")
      .waitFor({ state: "visible", timeout: MIL_IDE_SHELL_TIMEOUT_MS });
    await waitForFileTree(page);
    return true;
  } catch {
    return false;
  }
}

export async function createBlankModelingProjectAndEnterIde(page: Page): Promise<boolean> {
  try {
    await navigateToHomeProjects(page);
    await page.getByRole("button", { name: "New Project" }).first().click();
    await expect(page.getByRole("heading", { name: "New Project" })).toBeVisible({
      timeout: 120_000,
    });

    const toolchainErr = page.getByText(/Could not load toolchain versions/i);
    if ((await toolchainErr.count()) > 0 && (await toolchainErr.isVisible().catch(() => false))) {
      return false;
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

    const name = `e2e_u5_${Date.now()}`;
    const nameInput = page.locator("input#project-name, input#projectName").first();
    await expect(nameInput).toBeVisible({ timeout: 60_000 });
    await nameInput.fill(name);

    const createBtn = page.getByRole("button", { name: "Create Project" });
    await expect(createBtn).toBeEnabled({ timeout: 90_000 });
    await createBtn.click();

    await page.waitForURL(/\/projects\/[^/]+\/?$/i, { timeout: 120_000 });
    await page.getByTitle("Create New File").waitFor({ state: "visible", timeout: 120_000 });
    await waitForFileTree(page);
    return true;
  } catch {
    return false;
  }
}

export async function createModelingProjectFromFirstOptimizationTemplate(page: Page): Promise<boolean> {
  try {
    await page.goto(absUrl("/?nav=optimization-modeling-templates"), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Optimization Modeling Templates" })).toBeVisible({
      timeout: 120_000,
    });

    const failedHeading = page.getByRole("heading", { name: "Failed to load templates" });
    const emptyHeading = page.getByRole("heading", { name: "No templates available" });
    if ((await failedHeading.count()) > 0 && (await failedHeading.isVisible().catch(() => false))) {
      return false;
    }
    if ((await emptyHeading.count()) > 0 && (await emptyHeading.isVisible().catch(() => false))) {
      return false;
    }

    await expect(page.getByText(/\d+\s+templates?\s+in\s+total/i)).toBeVisible({ timeout: 120_000 });

    const firstCardToDetail = page
      .locator(
        "xpath=//div[contains(@class,'lg:grid-cols-3')]//button[@type='button'][.//img[@alt]]",
      )
      .first();
    await expect(firstCardToDetail).toBeVisible({ timeout: 60_000 });
    await firstCardToDetail.click();

    await page.waitForURL(/\/modeling-templates\/[^/]+/i, { timeout: 60_000 });

    const useTpl = page.getByRole("button", { name: "Use Template" });
    await expect(useTpl).toBeVisible({ timeout: 120_000 });
    await useTpl.click();

    await page.waitForURL(/\/projects\/[^/]+\/?$/i, { timeout: OPT_TEMPLATE_IDE_SHELL_TIMEOUT_MS });
    await page
      .getByTitle("Create New File")
      .waitFor({ state: "visible", timeout: OPT_TEMPLATE_IDE_SHELL_TIMEOUT_MS });
    await waitForFileTree(page);
    return true;
  } catch {
    return false;
  }
}

export async function tryEnterOptimizationTemplateModelingIde(page: Page): Promise<boolean> {
  const openByUuid = async (uuid: string): Promise<boolean> => {
    const res = await page.goto(absUrl(`/projects/${uuid}`), { waitUntil: "domcontentloaded" });
    if (!res?.ok() && res?.status() !== 304) {
      return false;
    }
    try {
      await waitForFileTree(page);
      return true;
    } catch {
      return false;
    }
  };

  const cached = readOptimizationTemplateProjectUuidArtifact();
  if (cached && (await openByUuid(cached))) {
    return true;
  }

  const ok = await createModelingProjectFromFirstOptimizationTemplate(page);
  if (!ok) {
    return false;
  }
  const m = page.url().match(/\/projects\/([^/]+)/i);
  if (m?.[1]) {
    writeOptimizationTemplateProjectUuidArtifact(m[1]);
  }
  return true;
}

export async function createModelingProjectFromFirstContestTemplate(page: Page): Promise<boolean> {
  try {
    await page.goto(absUrl("/?nav=math-modeling-contest-templates"), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Math Modeling Contest Templates" })).toBeVisible({
      timeout: 120_000,
    });

    const failedHeading = page.getByRole("heading", { name: "Failed to Load Templates" });
    const emptyHeading = page.getByRole("heading", {
      name: "No Competition Templates Available",
    });
    if ((await failedHeading.count()) > 0 && (await failedHeading.isVisible().catch(() => false))) {
      return false;
    }
    if ((await emptyHeading.count()) > 0 && (await emptyHeading.isVisible().catch(() => false))) {
      return false;
    }

    await expect(page.getByText(/\d+\s+templates?\s+in\s+total/i)).toBeVisible({ timeout: 120_000 });

    const firstCardToDetail = page
      .locator(
        "xpath=//div[contains(@class,'lg:grid-cols-3')]//button[@type='button'][.//img[@alt]]",
      )
      .first();
    await expect(firstCardToDetail).toBeVisible({ timeout: 60_000 });
    await firstCardToDetail.click();

    await page.waitForURL(/\/modeling-competition\/[^/]+/i, { timeout: 60_000 });

    const useTpl = page.getByRole("button", { name: "Use Template" });
    await expect(useTpl).toBeVisible({ timeout: 120_000 });
    await useTpl.click();

    await page.waitForURL(/\/projects\/[^/]+\/?$/i, { timeout: OPT_TEMPLATE_IDE_SHELL_TIMEOUT_MS });
    await page
      .getByTitle("Create New File")
      .waitFor({ state: "visible", timeout: OPT_TEMPLATE_IDE_SHELL_TIMEOUT_MS });
    await waitForFileTree(page);
    return true;
  } catch {
    return false;
  }
}

export async function tryEnterContestTemplateModelingIde(page: Page): Promise<boolean> {
  const openByUuid = async (uuid: string): Promise<boolean> => {
    const res = await page.goto(absUrl(`/projects/${uuid}`), { waitUntil: "domcontentloaded" });
    if (!res?.ok() && res?.status() !== 304) {
      return false;
    }
    try {
      await waitForFileTree(page);
      return true;
    } catch {
      return false;
    }
  };

  const cached = readModelingContestTemplateProjectUuidArtifact();
  if (cached && (await openByUuid(cached))) {
    return true;
  }

  const ok = await createModelingProjectFromFirstContestTemplate(page);
  if (!ok) {
    return false;
  }
  const m = page.url().match(/\/projects\/([^/]+)/i);
  if (m?.[1]) {
    writeModelingContestTemplateProjectUuidArtifact(m[1]);
  }
  return true;
}

export async function tryEnterModelingProjectIde(page: Page): Promise<boolean> {
  const openByUuid = async (uuid: string): Promise<boolean> => {
    const res = await page.goto(absUrl(`/projects/${uuid}`), { waitUntil: "domcontentloaded" });
    if (!res?.ok() && res?.status() !== 304) {
      return false;
    }
    try {
      await waitForFileTree(page);
      return true;
    } catch {
      return false;
    }
  };

  const cached = readModelingProjectUuidArtifact();
  if (cached && (await openByUuid(cached))) {
    return true;
  }

  const ok = await createBlankModelingProjectAndEnterIde(page);
  if (!ok) {
    return false;
  }
  const m = page.url().match(/\/projects\/([^/]+)/i);
  if (m?.[1]) {
    writeModelingProjectUuidArtifact(m[1]);
  }
  return true;
}

export async function tryEnterLeanProjectIde(page: Page): Promise<boolean> {
  const openByUuid = async (uuid: string): Promise<boolean> => {
    const res = await page.goto(absUrl(`/projects/${uuid}`), { waitUntil: "domcontentloaded" });
    if (!res?.ok() && res?.status() !== 304) {
      return false;
    }
    try {
      await waitForFileTree(page);
      return true;
    } catch {
      return false;
    }
  };

  const cached = readTheoremProjectUuidArtifact();
  if (cached && (await openByUuid(cached))) {
    return true;
  }

  await navigateToHomeProjects(page);
  const ok = await createTheoremProvingProjectFromMilTemplate(page);
  if (!ok) {
    return false;
  }
  const m = page.url().match(/\/projects\/([^/]+)/i);
  if (m?.[1]) {
    writeTheoremProjectUuidArtifact(m[1]);
  }
  return true;
}

export async function openLeafFile(page: Page, segments: readonly string[]): Promise<void> {
  const tree = await waitForFileTree(page);
  const dirs = segments.slice(0, -1);
  for (let i = 0; i < dirs.length; i += 1) {
    const nextName = segments[i + 1]!;
    const alreadyVisible = await tree
      .getByText(nextName, { exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    if (alreadyVisible) {
      continue;
    }
    const dirNode = tree.getByText(dirs[i]!, { exact: true }).first();
    await expect(dirNode).toBeVisible({ timeout: 20_000 });
    await dirNode.click();
    await expect(tree.getByText(nextName, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  }
  const fileName = segments[segments.length - 1]!;
  const fileNode = tree.getByText(fileName, { exact: true }).first();
  await expect(fileNode).toBeVisible({ timeout: 20_000 });
  await fileNode.click();
}
