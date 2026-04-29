#!/usr/bin/env node
/** 飞书自定义机器人 https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 * Webhook：默认自 **`common/global-setup.ts`** 中的 **`FEISHU_WEBHOOK_URL_DEFAULT`**（脚本启动时解析）；可用环境变量 **`FEISHU_WEBHOOK_URL`** 覆盖。**不支持签名校验**。
 * 报告链接：可选 `node send-results/send-feishu.mjs <报告URL>`（用于卡片底部「打开报告」链接，**不**再写入正文「报告/产物」行）。
 * 摘要 JSON：固定 `test-results/e2e-results.json`。
 * **被测网站**正文行：环境变量 **`E2E_BASE_URL`**；未设置时从 **`common/global-setup.ts`** 的 **`E2E_BASE_URL_DEFAULT`** 解析。测 `localhost:3000` 时请先 `export E2E_BASE_URL=http://localhost:3000` 再跑 `run.mjs`（子进程会继承）。
 * **章节范围**：`run.mjs` 使用 **`--scope-file`** 时注入 **`E2E_SCOPE_FILE`**。摘要首行：**程序汇总**（**`（共N个）`**）。**失败程序**以 **Markdown 管道表** 展示（`post` 富文本无原生表格，表格语法便于宽屏扫读；单元格内 `|` 会替换为 `｜`）。程序标题取首个顶层 `describe`（若无则 `NN（短名）`）。程序失败 = 该文件下至少一条用例为 failed/timedOut/interrupted。
 * **飞书 `code=11232` 频率限制**：自动退避重试（默认最多 **6** 次发送，可用 **`FEISHU_WEBHOOK_MAX_ATTEMPTS`** 覆盖，上限 12）。 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

/** 由仓库根目录 `run.mjs` 传入线上报告 URL；单独跑 `pnpm run report:feishu` 时可省略。 */
const CLI_REPORT_URL = (process.argv[2] ?? "").trim();

const MAX_BODY_BYTES = 18_000;

/**
 * 从 `common/global-setup.ts` 解析单行默认值（须保持 `const *_DEFAULT = "…";` 格式）。
 * @returns {{ feishuWebhook: string, e2eBaseUrl: string }}
 */
function readDefaultsFromGlobalSetupTs() {
  const p = path.join(REPO_ROOT, "common", "global-setup.ts");
  if (!fs.existsSync(p)) {
    return { feishuWebhook: "", e2eBaseUrl: "" };
  }
  const text = fs.readFileSync(p, "utf8");
  // 必须匹配「整行源码」：若用全局 .match，会误命中 JSDoc 反引号里的示例 `const … = "https://...";`，得到 `https://…` 进而 DNS 解析主机名 `...`（ENOTFOUND）。
  const feishuWebhook =
    text
      .match(/^\s*const\s+FEISHU_WEBHOOK_URL_DEFAULT\s*=\s*"(https:\/\/[^"]+)"\s*;\s*$/m)?.[1]
      ?.trim() ?? "";
  const e2eBaseUrl =
    text
      .match(/^\s*const\s+E2E_BASE_URL_DEFAULT\s*=\s*"(https?:\/\/[^"]+)"\s*;\s*$/m)?.[1]
      ?.trim() ?? "";
  return { feishuWebhook, e2eBaseUrl };
}

const _gs = readDefaultsFromGlobalSetupTs();

const FEISHU_WEBHOOK_URL = (process.env.FEISHU_WEBHOOK_URL ?? "").trim() || _gs.feishuWebhook;
if (!FEISHU_WEBHOOK_URL) {
  console.error(
    "未配置飞书 Webhook：请设置环境变量 FEISHU_WEBHOOK_URL，或确认 common/global-setup.ts 中存在单行 `const FEISHU_WEBHOOK_URL_DEFAULT = \"https://...\";`。",
  );
  process.exit(1);
}
const PLAYWRIGHT_JSON = path.join(REPO_ROOT, "test-results", "e2e-results.json");
const POST_TITLE = "Reaslab test";

/** Playwright JSON 中标识「一个测试文件」的 suite.title（相对仓库根的 `test/NN-*.test.ts`）。 */
const TEST_FILE_TITLE_RE = /^test\/\d{2}-.+\.(test|spec)\.[cm]?[jt]sx?$/i;

/** 每个失败程序下列出的失败功能点标题条数上限。 */
const MAX_FAILED_TITLES_PER_PROGRAM = 8;

/** 与 `common/global-setup.ts` 中 `E2E_BASE_URL` / `E2E_BASE_URL_DEFAULT` 对齐；仅用于飞书文案。 */
const E2E_BASE_URL_DISPLAY = (
  (process.env.E2E_BASE_URL ?? "").trim() || _gs.e2eBaseUrl
).replace(/\/+$/, "");
if (!E2E_BASE_URL_DISPLAY) {
  console.error(
    "未解析被测网站 URL：请设置环境变量 E2E_BASE_URL，或确认 common/global-setup.ts 中存在单行 `const E2E_BASE_URL_DEFAULT = \"https://...\";`。",
  );
  process.exit(1);
}

function loadPlaywrightReportObject() {
  const jsonPath = PLAYWRIGHT_JSON;
  if (!fs.existsSync(jsonPath)) {
    return { path: jsonPath, data: null };
  }
  try {
    return { path: jsonPath, data: JSON.parse(fs.readFileSync(jsonPath, "utf8")) };
  } catch {
    return { path: jsonPath, data: null, broken: true };
  }
}

/** 与 `run.mjs` 中 `parseScopeChapterIds` 一致（scope 文件：注释 `#`、空行；支持同行多号）。 */
function parseScopeChapterIds(raw) {
  const ids = [];
  for (const line of raw.split(/\r?\n/)) {
    const cut = line.replace(/#.*$/, "").trim();
    if (!cut) {
      continue;
    }
    for (const token of cut.split(/\s+/)) {
      if (!/^\d{1,2}$/.test(token)) {
        continue;
      }
      const n = Number.parseInt(token, 10);
      if (n < 1 || n > 99) {
        continue;
      }
      ids.push(String(n).padStart(2, "0"));
    }
  }
  return [...new Set(ids)];
}

/** 仅当 `run.mjs` 注入 **`E2E_SCOPE_FILE`** 时读取 scope 文件，返回去重后的章节号（如 `01`…`12`）。 */
function loadScopeChapterIdsForChapterLabel() {
  const fromEnv = (process.env.E2E_SCOPE_FILE ?? "").trim();
  if (!fromEnv) {
    return [];
  }
  const tryPath = path.isAbsolute(fromEnv) ? fromEnv : path.join(REPO_ROOT, fromEnv);
  if (!fs.existsSync(tryPath)) {
    return [];
  }
  try {
    return parseScopeChapterIds(fs.readFileSync(tryPath, "utf8"));
  } catch {
    return [];
  }
}

/** Playwright JSON 根 suite 的 title 多为相对路径如 `test/01-playground.test.ts`，飞书摘要里省略该段。 */
function stripLeadingTestFileFromTitle(full) {
  const sep = " › ";
  const i = full.indexOf(sep);
  if (i === -1) {
    return full;
  }
  const first = full.slice(0, i).trim();
  if (!/\.(test|spec)\.[cm]?[jt]sx?$/i.test(first)) {
    return full;
  }
  const rest = full.slice(i + sep.length).trim();
  return rest || full;
}

function normalizeSuiteTitle(t) {
  return String(t ?? "")
    .trim()
    .replace(/\\/g, "/");
}

/** 从 `test/01-x.test.ts › …` 前缀链取所属测试文件路径。 */
function programKeyFromWalkName(fullName) {
  if (!fullName) {
    return null;
  }
  const sep = " › ";
  const i = fullName.indexOf(sep);
  const first = (i === -1 ? fullName : fullName.slice(0, i)).trim();
  return TEST_FILE_TITLE_RE.test(first) ? first : null;
}

/** `test/10-project-list.test.ts` → `10-project-list`（飞书概要括号内短名）。 */
function shortSlugFromTestPath(fileKey) {
  const base = path.basename(fileKey).replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, "");
  return base || fileKey;
}

function chaptersFromProgramMap(perProg) {
  const ids = [];
  for (const k of perProg.keys()) {
    const m = /^test\/(\d{2})-/i.exec(k);
    if (m) {
      ids.push(m[1]);
    }
  }
  return [...new Set(ids)].sort();
}

function findProgramFileKeyForChapter(chapterId, perProg) {
  const prefix = `test/${chapterId}-`;
  for (const k of perProg.keys()) {
    if (k.startsWith(prefix)) {
      return k;
    }
  }
  return null;
}

/**
 * 按 `test/NN-*.test.ts` 聚合功能点结果（与 JSON suite 树一致）。
 * @returns {Map<string, { passed: number, skipped: number, failed: number, flaky: number, failedTitles: string[], programHeading: string | null }>}
 */
function aggregateStatsByProgramFile(data) {
  /** @type {Map<string, { passed: number, skipped: number, failed: number, flaky: number, failedTitles: string[], programHeading: string | null }>} */
  const map = new Map();
  function ensure(key) {
    if (!map.has(key)) {
      map.set(key, {
        passed: 0,
        skipped: 0,
        failed: 0,
        flaky: 0,
        failedTitles: [],
        programHeading: null,
      });
    }
    return map.get(key);
  }
  function walk(suite, prefix, fileKeyInherit) {
    const segment = normalizeSuiteTitle(suite.title);
    const name = [prefix, segment].filter(Boolean).join(" › ");
    let fileKey = fileKeyInherit;
    if (segment && TEST_FILE_TITLE_RE.test(segment)) {
      fileKey = segment;
      const bucket = ensure(fileKey);
      if (!bucket.programHeading && Array.isArray(suite.suites)) {
        for (const child of suite.suites) {
          const t = normalizeSuiteTitle(child.title);
          if (t && !TEST_FILE_TITLE_RE.test(t)) {
            bucket.programHeading = t;
            break;
          }
        }
      }
    } else if (!fileKey) {
      fileKey = programKeyFromWalkName(name);
    }
    for (const spec of suite.specs || []) {
      const specTitle = spec.title || "";
      for (const test of spec.tests || []) {
        const results = test.results || [];
        const last = results[results.length - 1];
        if (!last || !fileKey) {
          continue;
        }
        const bucket = ensure(fileKey);
        const status = last.status;
        if (status === "skipped") {
          bucket.skipped++;
        } else if (status === "failed" || status === "timedOut" || status === "interrupted") {
          bucket.failed++;
          const full = [name, specTitle].filter(Boolean).join(" › ");
          const label = stripLeadingTestFileFromTitle(full || specTitle || "(未命名用例)");
          bucket.failedTitles.push(label);
        } else if (status === "passed") {
          const flaky =
            results.length > 1 &&
            results.slice(0, -1).some((r) =>
              r.status === "failed" || r.status === "timedOut" || r.status === "interrupted",
            );
          if (flaky) {
            bucket.flaky++;
          } else {
            bucket.passed++;
          }
        }
      }
    }
    for (const child of suite.suites || []) {
      walk(child, name, fileKey);
    }
  }
  for (const root of data.suites || []) {
    walk(root, "", null);
  }
  return map;
}

/** 失败用例行已含顶层 describe 时，去掉与程序标题重复的前缀 `标题 › `。 */
function stripLeadingProgramHeadingFromCaseTitle(title, programHeading) {
  const t = String(title ?? "").trim();
  const h = String(programHeading ?? "").trim();
  if (!t || !h) {
    return t;
  }
  const prefix = `${h} › `;
  if (t.startsWith(prefix)) {
    return t.slice(prefix.length).trim() || t;
  }
  return t;
}

/** 避免 Markdown 管道表列被内容中的 `|` 拆乱；换行压成空格。 */
function sanitizeMarkdownTableCell(s, maxLen) {
  let x = String(s ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "｜")
    .replace(/[ \t\f\v]+/g, " ")
    .trim();
  if (maxLen > 0 && x.length > maxLen) {
    x = `${x.slice(0, Math.max(0, maxLen - 1))}…`;
  }
  return x || "—";
}

function formatPlaywrightSummary(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const parts = [];
  const scopeChapterIds = loadScopeChapterIdsForChapterLabel();
  const perProg = aggregateStatsByProgramFile(data);
  const fromJson = chaptersFromProgramMap(perProg);
  const chaptersOrdered =
    scopeChapterIds.length > 0 ? [...scopeChapterIds].sort() : fromJson.length > 0 ? fromJson : [];
  const N = chaptersOrdered.length;

  if (N > 0) {
    /** @type {{ ch: string, key: string | null, st: { passed: number, skipped: number, failed: number, flaky: number, failedTitles: string[], programHeading: string | null } }[]} */
    const failedChapters = [];
    for (const ch of chaptersOrdered) {
      const key = findProgramFileKeyForChapter(ch, perProg);
      const st = key
        ? perProg.get(key)
        : {
            passed: 0,
            skipped: 0,
            failed: 0,
            flaky: 0,
            failedTitles: [],
            programHeading: null,
          };
      if (st && st.failed > 0) {
        failedChapters.push({ ch, key, st });
      }
    }
    const failedProg = failedChapters.length;
    const successProg = N - failedProg;
    parts.push(`程序汇总：成功 ${successProg} 个，失败 ${failedProg} 个（共${N}个）`);
    if (failedChapters.length === 0) {
      parts.push("失败程序：无（各程序均无失败类用例）。");
    } else {
      parts.push(
        `失败程序一览（Markdown 表｜节选列仅列首条失败用例；同程序多条失败见 HTML 报告）：`,
      );
      parts.push("| 场景（程序） | 失败 | 跳过 | 不稳 | 失败功能点（节选） |");
      parts.push("| --- | ---: | ---: | ---: | --- |");
      for (const { ch, key, st } of failedChapters) {
        const shortName = key ? shortSlugFromTestPath(key) : ch;
        const heading =
          (st.programHeading && String(st.programHeading).trim()) ||
          `${ch}（${shortName}）`;
        const rawTitles = st.failedTitles || [];
        const first =
          rawTitles.length > 0
            ? stripLeadingProgramHeadingFromCaseTitle(rawTitles[0], st.programHeading)
            : "—";
        const more =
          rawTitles.length > 1 ? `（另有 ${rawTitles.length - 1} 条）` : "";
        const featCol = sanitizeMarkdownTableCell(`${first}${more}`, 120);
        parts.push(
          `| ${sanitizeMarkdownTableCell(heading, 56)} | ${st.failed} | ${st.skipped} | ${st.flaky} | ${featCol} |`,
        );
      }
    }
  } else if (data.stats && typeof data.stats === "object") {
    const s = data.stats;
    const passed = Number(s.expected) || 0;
    const failed = Number(s.unexpected) || 0;
    const skipped = Number(s.skipped) || 0;
    const flaky = Number(s.flaky) || 0;
    const totalOutcomes = passed + failed + skipped + flaky;
    parts.push(
      `（未解析到按文件分组的程序列表）功能点（全 run）共 ${totalOutcomes} 条：通过 ${passed}，失败 ${failed}，跳过 ${skipped}，不稳定 ${flaky}`,
    );
  }

  if (data.stats && typeof data.stats === "object") {
    const s = data.stats;
    const durationMs = s.duration;
    const dur =
      typeof durationMs === "number" && Number.isFinite(durationMs)
        ? `${(durationMs / 1000).toFixed(1)}s`
        : "—";
    parts.push(`执行耗时: ${dur}`);
    if (s.startTime) {
      parts.push(`测试时间：${s.startTime}`);
    }
    const passed = Number(s.expected) || 0;
    const failed = Number(s.unexpected) || 0;
    const skipped = Number(s.skipped) || 0;
    if (skipped > 0 && passed === 0 && failed === 0) {
      parts.push("说明: 通过 0 且有跳过，多为项目列表无行，或主线用例中 test.skip（如新建项目不可用等）。");
    }
  }

  if (Array.isArray(data.errors) && data.errors.length > 0) {
    parts.push(`执行错误 ${data.errors.length} 条（节选）:`);
    for (const err of data.errors.slice(0, 5)) {
      const line = String(err.message ?? err.error ?? "")
        .split("\n")[0]
        .trim()
        .slice(0, 280);
      if (line) {
        parts.push(`  · ${line}`);
      }
    }
  }

  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n");
}

function buildPlainText() {
  let text = `被测网站: ${E2E_BASE_URL_DISPLAY}`;

  const { path: jsonPath, data, broken } = loadPlaywrightReportObject();
  const summary = data ? formatPlaywrightSummary(data) : null;
  text += "\n\n--- 报告摘要 ---\n";
  if (summary) {
    text += summary;
  } else if (broken) {
    text += `（无法解析 JSON：${jsonPath}）`;
  } else {
    text += `（未找到 ${jsonPath}；请先执行 Playwright 生成报告，例如 pnpm exec playwright test --config common/playwright.config.ts）`;
  }
  return text;
}

function truncateText(text, reserveBytes) {
  let s = text;
  while (Buffer.byteLength(s, "utf8") > reserveBytes && s.length > 1) {
    s = s.slice(0, Math.floor(s.length * 0.9));
  }
  return s;
}

function feishuPostTextRowsFromPlain(rawText, maxBytes) {
  let body =
    rawText
      .split(/\r?\n/)
      .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
      .filter(Boolean)
      .join("\n") || "测试已完成";
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    body = truncateText(body, maxBytes);
  }
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return [[{ tag: "text", text: "测试已完成" }]];
  }
  return lines.map((line) => [{ tag: "text", text: line }]);
}

function buildPayload() {
  const reportUrl = CLI_REPORT_URL;
  const msgType = reportUrl ? "post" : "text";
  const rawText = buildPlainText();

  if (msgType === "post" && reportUrl) {
    const summaryRows = feishuPostTextRowsFromPlain(rawText, 4500);
    return {
      msg_type: "post",
      content: {
        post: {
          zh_cn: {
            title: POST_TITLE,
            content: [
              ...summaryRows,
              [{ tag: "text", text: "链接：" }, { tag: "a", text: "打开报告", href: reportUrl }],
            ],
          },
        },
      },
    };
  }

  const truncated = truncateText(rawText, MAX_BODY_BYTES - 512);
  return {
    msg_type: "text",
    content: { text: truncated },
  };
}

function shrinkPayloadIfNeeded(body) {
  const ts = body.timestamp;
  const sg = body.sign;
  const withSign = (partial) =>
    ts !== undefined && sg !== undefined ? { timestamp: ts, sign: sg, ...partial } : partial;
  let b = { ...body };
  let encoded = JSON.stringify(b);
  for (let i = 0; i < 80 && Buffer.byteLength(encoded, "utf8") > MAX_BODY_BYTES; i++) {
    if (b.msg_type === "text" && b.content?.text) {
      const byteBudget = Math.max(256, Math.floor(Buffer.byteLength(b.content.text, "utf8") * 0.85));
      b = withSign({ msg_type: "text", content: { text: truncateText(b.content.text, byteBudget) } });
      encoded = JSON.stringify(b);
      continue;
    }
    if (b.msg_type === "post" && Array.isArray(b.content?.post?.zh_cn?.content)) {
      for (const row of b.content.post.zh_cn.content) {
        if (row?.some((c) => c.tag === "a")) {
          continue;
        }
        const cell = row?.[0];
        if (cell?.tag === "text" && cell.text) {
          const byteBudget = Math.max(128, Math.floor(Buffer.byteLength(cell.text, "utf8") * 0.85));
          cell.text = truncateText(cell.text, byteBudget);
        }
      }
      b = withSign({ msg_type: b.msg_type, content: b.content });
      encoded = JSON.stringify(b);
      continue;
    }
    break;
  }
  return b;
}

function explainFeishuError(body) {
  const c = body.code ?? body.StatusCode;
  const m = body.msg ?? body.StatusMessage ?? "";
  const hints = {
    19002: "请求体缺少 msg_type 或格式不对",
    19021: "签名校验失败（本脚本不发送签名；请在飞书机器人安全设置中关闭签名校验）",
    19022: "IP 不在白名单",
    19024: "未命中自定义关键词（请检查飞书机器人关键词设置与正文）",
    9499: "请求体 Bad Request，对照官方 msg_type 示例",
    11232: "触发频率限制，稍后再发",
  };
  const hint = hints[c] ? ` — ${hints[c]}` : "";
  return `code=${c} msg=${m}${hint}`;
}

function isFeishuOk(body) {
  return (
    Object.keys(body).length === 0 ||
    body.StatusCode === 0 ||
    body.code === 0 ||
    body.errcode === 0
  );
}

async function postToFeishu(payload) {
  const res = await fetch(FEISHU_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

const core = buildPayload();

async function sendOnce() {
  return postToFeishu(shrinkPayloadIfNeeded(core));
}

/** 自定义机器人偶发 `code=11232` frequency limited；HTTP 仍 200。退避重试以提高定时 job 送达率。 */
function isFeishuFrequencyLimited(body) {
  const c = body?.code ?? body?.StatusCode;
  return c === 11232;
}

async function sendWith11232Backoff() {
  const maxAttempts = Number.parseInt(process.env.FEISHU_WEBHOOK_MAX_ATTEMPTS ?? "6", 10);
  const safeMax = Number.isFinite(maxAttempts) && maxAttempts >= 1 ? Math.min(maxAttempts, 12) : 6;
  let last = await sendOnce();
  for (let attempt = 1; attempt < safeMax; attempt++) {
    if (last.res.ok && isFeishuOk(last.body)) {
      return last;
    }
    if (!isFeishuFrequencyLimited(last.body)) {
      return last;
    }
    const waitMs = Math.min(120_000, 30_000 * attempt);
    console.warn(
      `飞书 frequency limited (code=11232)，${waitMs / 1000}s 后重试 (${attempt}/${safeMax - 1})…`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
    last = await sendOnce();
  }
  return last;
}

const { res, body } = await sendWith11232Backoff();
const ok = res.ok && isFeishuOk(body);

if (!ok) {
  const extra =
    body.code === 19021
      ? "（请在飞书自定义机器人「安全设置」中关闭签名校验。）"
      : body.code === 11232
        ? "（多次重试后仍频率限制：请拉长定时间隔、换 Webhook 或联系飞书侧配额。）"
        : "";
  console.error("飞书返回异常:", res.status, explainFeishuError(body), extra, body);
  process.exit(1);
}

console.log("已发送到飞书:", body.msg ?? body.StatusMessage ?? "success");
