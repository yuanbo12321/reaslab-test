import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { E2E_SHARE_INVITE_EMAIL } from "../common/global-setup";
import { clearModelingProjectUuidArtifact } from "./data/e2e-modeling-project-artifact";
import {
  MODELING_CH5_SKIP_MSG,
  ensureReasLingoVisible,
  expandIdeFileTreeRowByLabel,
  reaslingoUploadFileForAiChat,
  tryEnterModelingProjectIde,
  waitForFileTree,
  waitForReasLingoAssistantReplyDone,
} from "./helpers";

const TEST_UPLOAD_PNG = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "test_upload.png");

/** §5.2：Add Context 引用图后，用**全英文**提问（避免非英文与 OCR 组合下乱码 / OCR Failed）；要求只输出数字答案（与 `test_upload.png` 图中「二加二」→ 4 一致）。 */
const CH5_FIXTURE_QUESTION_PROMPT =
  "Answer the question shown in the image. Reply with exactly one Arabic numeral and nothing else.";

test.describe("5. 创建空白 Modeling 项目并使用基础功能", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(900_000);

  test.beforeAll(() => {
    clearModelingProjectUuidArtifact();
  });

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

  test("5.1 创建空白 Modeling 项目", async ({ page }) => {
    test.skip(!(await tryEnterModelingProjectIde(page)), MODELING_CH5_SKIP_MSG);
    await expect(page).toHaveURL(/\/projects\/[^/]+\/?$/i);
    await expect(page.getByTitle("Create New File")).toBeVisible({ timeout: 30_000 });
    // 建模族项目侧栏含 Solver Settings（`side-tab-bar`），定理项目才有 Semantic Search。
    await expect(
      page.locator(".bg-sidebar button").filter({ has: page.locator("svg.lucide-sliders-horizontal") }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("5.2 使用 AI 智能体", async ({
    page,
  }) => {
    test.skip(!(await tryEnterModelingProjectIde(page)), MODELING_CH5_SKIP_MSG);
    await ensureReasLingoVisible(page);

    // 须同时含「ReasLingo」标题与 Switch Agent，否则可能匹配到其它 SidebarGroup；再 `.first()` 固定一条右栏。
    const reasLingoInputHost = page
      .locator('[data-sidebar="group"]')
      .filter({ has: page.getByText("ReasLingo", { exact: true }) })
      .filter({ has: page.locator('button[title="Switch Agent"]') })
      .first();
    // 上传芯片在 MessageInput 根节点（与 Add Context 同容器）。必须挂在 ReasLingo 分组下，否则 `page` 级 `.first()` 可能命中其它侧栏的同名结构。
    const messageInputStrip = reasLingoInputHost
      .locator("div.px-3.py-2")
      .filter({ has: page.getByTitle("Add Context") })
      .first();

    // (1) 上传 `test/data/test_upload.png`：与手动一致，走 Explore「Upload Files」→ 选中 `chat-uploads` 后注入文件（见 `reaslingoUploadFileForAiChat`）。
    await reaslingoUploadFileForAiChat(page, reasLingoInputHost, TEST_UPLOAD_PNG);

    // 产品路径为 `chat-uploads/test_upload.png`；树常默认折叠，先展开 `chat-uploads` 再与输入条芯片二选一断言。
    const fileTreePanel = page.locator(".ide-filetree").filter({ visible: true }).first();
    await expandIdeFileTreeRowByLabel(page, /chat-uploads/i);
    await expect(
      messageInputStrip
        .getByText(/test_upload\.png/i)
        .or(fileTreePanel.getByText("test_upload.png", { exact: true })),
    ).toBeVisible({ timeout: 180_000 });
    // 图片会走 OCR；未完成前发送按钮会禁用。若服务异常会出现「OCR Failed」，末尾对数字 4 的断言将失败。
    await expect(reasLingoInputHost.getByText("OCR Processing", { exact: true })).toBeHidden({
      timeout: 120_000,
    });
    const ocrUnavailable = await reasLingoInputHost
      .getByText("OCR Failed", { exact: true })
      .isVisible()
      .catch(() => false);

    await waitForFileTree(page);

    // (2) Paper Copilot Agent
    const trigger = reasLingoInputHost.locator('button[title="Switch Agent"]');
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.click();
    const agentMenuPanel = page.locator('[data-slot="dropdown-menu-content"][class*="w-56"]');
    await expect(agentMenuPanel).toBeVisible({ timeout: 10_000 });
    const paperCopilot = agentMenuPanel.locator('[data-slot="dropdown-menu-item"]').filter({
      hasText: /Paper Copilot/i,
    });
    await expect(
      paperCopilot.first(),
      [
        "§5.2：Switch Agent 菜单中未找到「Paper Copilot」项（须在正式环境提供）。",
        "若为菜单结构或展示名变更，请同步更新本用例的 locator / 文案匹配。",
      ].join(" "),
    ).toBeVisible({ timeout: 15_000 });
    await paperCopilot.first().click();
    await expect(agentMenuPanel).toBeHidden({ timeout: 5_000 });

    // (3) Add Context：把 `test_upload.png` 显式加入本条消息上下文（与上传芯片引用互补）
    // `waitForFileTree` 会点 body / 切 Explorer，侧栏 ReasLingo 可能滚出视口；须重新确保可见。
    await ensureReasLingoVisible(page);
    const addContext = reasLingoInputHost.getByTitle("Add Context").first();
    await expect(addContext).toBeVisible({ timeout: 20_000 });
    await addContext.scrollIntoViewIfNeeded();
    await addContext.click();
    const ctxSearch = page.getByPlaceholder("Add files, folders, docs...");
    await expect(ctxSearch).toBeVisible({ timeout: 10_000 });
    await ctxSearch.fill("test_upload");
    // Add Context 浮层常无标准 `listbox`/`option`（仅 div+cmdk），`getByRole('listbox')` 会一直找不到；勿用全页 `button`+正则，会命中文件树「Drag test_upload.png」拖拽钮。
    const addCtxPopper = page
      .locator("[data-radix-popper-content-wrapper]")
      .filter({ visible: true })
      .filter({ has: page.getByPlaceholder("Add files, folders, docs...") })
      .last();
    const resultInPopper = addCtxPopper.getByText("test_upload.png", { exact: true }).first();
    const listboxRow = page
      .getByRole("listbox")
      .filter({ visible: true })
      .filter({ hasNot: page.locator(".ide-filetree") })
      .first()
      .getByText("test_upload.png", { exact: true })
      .first();
    // 非 Radix 包名时可能没有 `data-radix-popper-content-wrapper`，用「同时含搜索框与结果」的可见 div 兜底。
    const looseResultRow = page
      .locator("div")
      .filter({ visible: true })
      .filter({ has: ctxSearch })
      .filter({ has: page.getByText("test_upload.png", { exact: true }) })
      .getByText("test_upload.png", { exact: true })
      .first();
    await expect(resultInPopper.or(listboxRow).or(looseResultRow).first()).toBeVisible({ timeout: 30_000 });
    // 焦点在搜索框时 ↓ / Enter 只作用于当前 Combobox，不会点到左侧树里的同名文件。
    await ctxSearch.focus();
    await ctxSearch.press("ArrowDown");
    await ctxSearch.press("Enter");
    await ctxSearch.waitFor({ state: "detached", timeout: 15_000 }).catch(() =>
      ctxSearch.waitFor({ state: "hidden", timeout: 15_000 }),
    );

    // Paper Copilot（paper-generation）在「非 Auto + 当前模型为 ReasChat」等组合下会拒绝发送（仅 toast），消息气泡永不出现。
    const modelBtn = reasLingoInputHost.getByTitle("Switch Model");
    await modelBtn.click();
    // 模型选择器首行含 Auto 的 Switch；与 Agent 菜单区分（后者无 switch）。
    const modelPanel = page.getByRole("menu").filter({ has: page.getByRole("switch") }).first();
    await expect(modelPanel).toBeVisible({ timeout: 10_000 });
    const autoSwitch = modelPanel.getByRole("switch");
    if (!(await autoSwitch.isChecked())) {
      await autoSwitch.click();
    }
    await page.keyboard.press("Escape");

    // (4) 会话框输入问题并等待 AI 回复
    const ta = reasLingoInputHost.locator("textarea").first();
    await expect(ta).toBeVisible({ timeout: 15_000 });
    await ta.click();
    await ta.fill(CH5_FIXTURE_QUESTION_PROMPT);
    const sendBtn = reasLingoInputHost.getByTitle("Send Message").first();
    // 图片入上下文可能触发 OCR，发送按钮会暂时禁用。
    await expect(sendBtn).toBeEnabled({ timeout: 180_000 });
    await sendBtn.click();
    await expect(async () => {
      await expect(page).toHaveURL(/\/projects\/[^/]+/i);
      await expect(reasLingoInputHost.getByText(CH5_FIXTURE_QUESTION_PROMPT).first()).toBeVisible();
    }).toPass({ timeout: 30_000 });
    await waitForReasLingoAssistantReplyDone(page);
    const ocrStillBad = await reasLingoInputHost
      .getByText("OCR Failed", { exact: true })
      .isVisible()
      .catch(() => false);
    // OCR 失败须记为失败（勿 test.skip），便于报告与 CI 明确暴露环境/功能问题。
    expect(
      !(ocrUnavailable || ocrStillBad),
      [
        "§5.2 ReasLingo 图片上下文：界面出现「OCR Failed」或上传后已判定 OCR 不可用。",
        "本条要求成功识别 test_upload.png 并回答图中数字，不得跳过或当作通过。",
        "请检查 OCR 服务、集群配置或该图片的可识别性。",
      ].join(" "),
    ).toBe(true);
    await expect(reasLingoInputHost.getByText(/\b4\b/).last()).toBeVisible({ timeout: 60_000 });
  });

  test("5.3 邀请他人一起编辑项目", async ({ page }) => {
    test.skip(!(await tryEnterModelingProjectIde(page)), MODELING_CH5_SKIP_MSG);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Sharing Project" })).toBeVisible({
      timeout: 15_000,
    });
    // `InviteMember`：`#emails-input`，Enter/逗号将当前输入收为 chip 后再点 Invite。
    const emailInput = dialog.locator("#emails-input");
    await expect(emailInput).toBeVisible({ timeout: 10_000 });
    await emailInput.fill(E2E_SHARE_INVITE_EMAIL);
    await emailInput.press("Enter");
    await expect(dialog.getByText(E2E_SHARE_INVITE_EMAIL, { exact: true }).first()).toBeVisible({
      timeout: 5_000,
    });
    await dialog.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(
      page.getByText(/user\(s\) has been successfully invited|already members of this project/i).first(),
    ).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });
  });

  test("5.4 查看项目的修改历史", async ({ page }) => {
    test.skip(!(await tryEnterModelingProjectIde(page)), MODELING_CH5_SKIP_MSG);
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/history/i, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Project History" })).toBeVisible();
    await expect(page.getByText("Changed Files").first()).toBeVisible();
    await expect(page.getByText("Diff").first()).toBeVisible();
    await expect(page.getByText("Snapshots").first()).toBeVisible();
  });

  test("5.5 项目内搜索关键字", async ({ page }) => {
    test.skip(!(await tryEnterModelingProjectIde(page)), MODELING_CH5_SKIP_MSG);
    await page.getByRole("button", { name: "Project Search" }).click();
    const searchInput = page.getByPlaceholder("Enter to search");
    await expect(searchInput).toBeVisible({ timeout: 15_000 });
    const projectSearchContent = page
      .locator('[data-sidebar="group"]')
      .filter({ has: searchInput })
      .locator("[data-sidebar='group-content']");
    await expect(projectSearchContent).toBeVisible({ timeout: 5_000 });
    await searchInput.fill("e");
    await searchInput.press("Enter");
    await expect(
      projectSearchContent.getByText(/[1-9]\d* results? in \d+ files?/i),
    ).toBeVisible({ timeout: 20_000 });

    const noHitToken = `CH5_NOHIT_${Date.now()}_zzzz`;
    await searchInput.fill(noHitToken);
    await searchInput.press("Enter");
    await expect
      .poll(
        async () => {
          const searching = await projectSearchContent.getByText("Searching...").isVisible();
          if (searching) {
            return "searching";
          }
          const hitSummary = await projectSearchContent.getByText(/[1-9]\d* results? in \d+ files?/i).count();
          return hitSummary > 0 ? "has_hits" : "empty";
        },
        { timeout: 60_000 },
      )
      .toBe("empty");

    await page.getByRole("button", { name: /Explorer/i }).first().click();
  });

  test("5.6 导出项目", async ({ page }) => {
    test.skip(!(await tryEnterModelingProjectIde(page)), MODELING_CH5_SKIP_MSG);
    await page.getByRole("button", { name: "Menu" }).click();
    const zipBtn = page.getByRole("button", { name: /Source \(ZIP\)/ });
    await expect(zipBtn).toBeVisible({ timeout: 15_000 });
    const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
    await zipBtn.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().toLowerCase().endsWith(".zip")).toBeTruthy();
  });
});
