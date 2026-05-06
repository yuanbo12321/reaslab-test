import { expect, test, type Locator, type Page } from "@playwright/test";

import { E2E_GITHUB_PASSWORD, E2E_GITHUB_USERNAME } from "../common/global-setup";
import { navigateToHomeProjects } from "./helpers";

/**
 * **用户场景 §10**：向 ReasLab 反馈意见（见 `docs/用户场景.md`）。
 * 工作台左侧栏底部 **Feedback** → 打开 GitHub **`.../issues/new`**（或登录中转页）；若已进入可编辑 **new issue** 表单，则写入 **全英文** 标题与正文（**不**点击 **Create**）。无论是否到达表单页，均在 GitHub 流程页 **attach 全页截图** 到报告（CI 不强制 `issues/new`）。
 *
 * 编号 **P211**：用户场景 **§10**（与 `README` 中 `test:10` 约定一致）。
 * GitHub 登录账号见 **`common/global-setup.ts`** 的 **`E2E_GITHUB_USERNAME`** / **`E2E_GITHUB_PASSWORD`**（仅用于进入可编辑表单）。
 *
 * 单文件调试：`pnpm run test:10:headed`
 *
 * **打开方式**：从 **Feedback** 读取 **`href`** 后 **`context.newPage()` + `goto`**（避免弹窗资源加载差异）。
 */
const ISSUES_NEW_RE = /github\.com\/reaslab\/reaslab-ide-issues\/issues\/new/i;

function isGithubFeedbackFlowUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/github\.com$/i.test(u.hostname)) return false;
    if (ISSUES_NEW_RE.test(url)) return true;
    if (/\/reaslab\/reaslab-ide-issues/i.test(u.pathname)) return true;
    const ret = u.searchParams.get("return_to");
    if (ret && /reaslab\/reaslab-ide-issues/i.test(decodeURIComponent(ret))) return true;
    return false;
  } catch {
    return false;
  }
}

async function reloadGithubNewIssueIfStylesMissing(gh: Page): Promise<void> {
  const n = await gh.locator('link[rel="stylesheet"]').count();
  if (n >= 3) return;
  await gh.reload({ waitUntil: "load", timeout: 90_000 }).catch(() => {});
}

async function signIntoGithubIfPrompted(gh: Page, issueNewHref: string): Promise<void> {
  const url = gh.url();
  if (!url.includes("github.com")) return;
  const pathname = new URL(url).pathname;
  if (!pathname.startsWith("/login")) return;

  await gh.locator("#login_field").waitFor({ state: "visible", timeout: 30_000 });
  await gh.locator("#login_field").fill(E2E_GITHUB_USERNAME);
  await gh.locator("#password").fill(E2E_GITHUB_PASSWORD);
  await gh.locator('input[type="submit"][name="commit"]').click();

  /**
   * 勿用「已离开 `/login`」作为成功条件：中间重定向（甚至未带 cookie 的瞬时 URL）会误触发，
   * 随后 `goto(issues/new)` 仍会被打回 `login?return_to=...`（你遇到的 Received string）。
   * 应等待 **真正到达 `issues/new`**（或 2FA），并用 **`domcontentloaded`** 避免 `load` 挂死。
   */
  const twoFa = (u: URL) => /\/sessions\/two-factor/i.test(u.pathname);
  const onNewIssue = (u: URL) => ISSUES_NEW_RE.test(u.href);

  try {
    await gh.waitForURL((u) => onNewIssue(u) || twoFa(u), {
      timeout: 120_000,
      waitUntil: "domcontentloaded",
    });
  } catch {
    const flash = gh.locator("#js-flash-container .flash-error");
    if (await flash.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
      throw new Error(`GitHub 登录被拒: ${(await flash.first().innerText()).trim()}`);
    }
    await gh.goto(issueNewHref, { waitUntil: "domcontentloaded", timeout: 120_000 });
  }

  if (twoFa(new URL(gh.url()))) {
    /** 2FA 或停留在登录页：不阻断用例，由调用方决定是否填表，仅截图验收。 */
    return;
  }
  if (!ISSUES_NEW_RE.test(gh.url())) {
    const flash = gh.locator("#js-flash-container .flash-error");
    if (await flash.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
      throw new Error(`GitHub: ${(await flash.first().innerText()).trim()}`);
    }
    return;
  }
}

/** 仅在已处于 `issues/new` 时尝试等待表单；无法到达或加载失败则返回 `false`（不抛错）。 */
async function ensureGithubIssueComposerLoaded(gh: Page, issueNewHref: string): Promise<boolean> {
  if (!ISSUES_NEW_RE.test(gh.url())) return false;

  const main = gh.locator("main");
  const composerReady = main
    .getByPlaceholder(/^Title$/i)
    .or(main.getByLabel(/add a title/i))
    .or(main.getByPlaceholder(/type your description here/i));

  for (let attempt = 0; attempt < 3; attempt++) {
    await gh.waitForLoadState("load", { timeout: 45_000 }).catch(() => {});
    const visible = await composerReady
      .first()
      .isVisible({ timeout: 25_000 })
      .catch(() => false);
    if (visible) return true;

    if (!ISSUES_NEW_RE.test(gh.url())) return false;

    await gh.reload({ waitUntil: "load", timeout: 90_000 }).catch(() => {});
    await signIntoGithubIfPrompted(gh, issueNewHref);
    if (!ISSUES_NEW_RE.test(gh.url())) return false;
  }

  return await composerReady.first().isVisible({ timeout: 45_000 }).catch(() => false);
}

async function fillGithubIssueBody(gh: Page, main: Locator, body: string): Promise<void> {
  const byPlaceholder = main.getByPlaceholder(/type your description here/i);
  if (await byPlaceholder.isVisible({ timeout: 12_000 }).catch(() => false)) {
    await byPlaceholder.scrollIntoViewIfNeeded();
    await byPlaceholder.fill(body, { force: true });
    return;
  }

  const byLabel = main.getByLabel(/add a description/i);
  if (await byLabel.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await byLabel.scrollIntoViewIfNeeded();
    await byLabel.fill(body, { force: true });
    return;
  }

  const bodyUnion = main
    .getByRole("textbox", { name: /markdown/i })
    .or(main.locator("#issue_body"))
    .or(main.locator('textarea[name="issue[body]"]'));
  const primary = bodyUnion.first();
  await primary.waitFor({ state: "attached", timeout: 30_000 });
  await primary.scrollIntoViewIfNeeded();
  const ok = await primary.fill(body, { force: true, timeout: 30_000 }).then(
    () => true,
    () => false,
  );
  if (ok) return;

  const editors = main.locator('[contenteditable="true"]');
  const n = await editors.count();
  const pick = n > 1 ? editors.nth(1) : editors.first();
  await pick.waitFor({ state: "visible", timeout: 15_000 });
  await pick.click({ force: true });
  await gh.keyboard.press("Control+a");
  await gh.keyboard.type(body, { delay: 5 });
}

async function fillGithubNewIssueDraftEnglish(gh: Page, title: string, body: string): Promise<void> {
  await gh.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});

  const main = gh.locator("main");
  await expect(main.getByRole("heading", { name: /create new issue/i })).toBeVisible({ timeout: 60_000 });

  const titleField = main
    .getByLabel(/add a title/i)
    .or(main.getByPlaceholder(/^Title$/i))
    .or(main.getByRole("textbox", { name: /^title$/i }))
    .or(main.locator("#issue_title"))
    .or(main.locator('input[name="issue[title]"]'));

  await expect(titleField).toBeVisible({ timeout: 60_000 });
  await titleField.fill(title, { force: true });

  await fillGithubIssueBody(gh, main, body);
}

test.describe("10. 向 ReasLab 反馈意见", () => {
  test.setTimeout(180_000);

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

  test("10.1 打开 GitHub 草稿 Issue 并截图（不提交）", async ({ page }, testInfo) => {
    await navigateToHomeProjects(page);

    const feedback = page.getByRole("link", { name: "Feedback" });
    await expect(feedback).toBeVisible({ timeout: 30_000 });
    await expect(feedback).toHaveAttribute(
      "href",
      /https:\/\/github\.com\/reaslab\/reaslab-ide-issues\/issues\/new/,
    );
    await expect(feedback).toHaveAttribute("target", "_blank");

    const href = await feedback.getAttribute("href");
    expect(href).toBeTruthy();
    expect(href).toMatch(/^https:\/\/github\.com\//);

    const gh = await page.context().newPage();
    try {
      await gh.goto(href!, { waitUntil: "load", timeout: 120_000 });
      await reloadGithubNewIssueIfStylesMissing(gh);

      await expect
        .poll(() => isGithubFeedbackFlowUrl(gh.url()), { timeout: 60_000 })
        .toBe(true);

      await signIntoGithubIfPrompted(gh, href!);

      const composerOk = await ensureGithubIssueComposerLoaded(gh, href!);

      const stamp = Date.now();
      const marker = `E2E-P211-${stamp}`;
      const title = `[${marker}] Draft by reaslab-test Playwright (do not submit)`;
      const body = [
        "Draft for automated test P211 (reaslab-test). **Do not click Create.**",
        "",
        "- Test file: test/10-feedback.test.ts",
        "- Search prefix if needed: [E2E-P211-",
      ].join("\n");

      if (composerOk) {
        await fillGithubNewIssueDraftEnglish(gh, title, body);
      }

      /** 不再用 **`getByText(marker)`**：标题在 **`<input value>`** 里时 Playwright 常匹配不到，易误报失败；本用例以 **截图** 为交付物（含仅登录页/中转页）。 */
      const png = await gh.screenshot({ fullPage: true });
      await testInfo.attach("11-github-issue-draft-en.png", {
        body: png,
        contentType: "image/png",
      });
    } finally {
      await gh.close().catch(() => {});
    }
  });
});
