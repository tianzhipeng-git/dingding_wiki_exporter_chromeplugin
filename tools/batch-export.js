#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");

let playwright;
try {
  playwright = require("playwright");
} catch (_error) {
  console.error("Playwright is not installed. Run `npm install` in this project first.");
  process.exit(1);
}

const PROJECT_ROOT = path.resolve(__dirname, "..");
const TURNDOWN_PATH = path.join(PROJECT_ROOT, "vendor", "turndown.js");
const GFM_PATH = path.join(PROJECT_ROOT, "vendor", "turndown-plugin-gfm.js");
const CONTENT_SCRIPT_PATH = path.join(PROJECT_ROOT, "contentScript.js");
const DEFAULT_PROFILE_DIR = path.join(PROJECT_ROOT, ".dingtalk-playwright-profile");
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, "exports", `dingtalk-wiki-${timestampForPath()}`);
const DING_HOSTS = new Set(["docs.dingtalk.com", "alidocs.dingtalk.com"]);
const NODE_PATH_RE = /\/i\/nodes\/([^/?#]+)/;

main().catch((error) => {
  console.error(`Error: ${error.message || String(error)}`);
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.url) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  options.out = path.resolve(options.out || DEFAULT_OUT_DIR);
  options.profile = path.resolve(options.profile || DEFAULT_PROFILE_DIR);
  options.delay = Number(options.delay || 1200);
  options.max = options.max ? Number(options.max) : Infinity;
  options.timeout = Number(options.timeout || 30000);

  validateStartUrl(options.url);
  await fsp.mkdir(options.out, { recursive: true });
  await fsp.mkdir(options.profile, { recursive: true });

  const scripts = await loadExporterScripts();
  const context = await launchContext(options);
  context.setDefaultTimeout(options.timeout);

  const page = context.pages()[0] || await context.newPage();
  await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: options.timeout });
  await settle(page);

  if (!options.yes) {
    console.log("");
    console.log("A browser window has opened.");
    console.log("Log in to DingTalk if needed, open the wiki/folder you want to export, then press Enter here.");
    const rl = readline.createInterface({ input, output });
    await rl.question("Press Enter to start crawling...");
    rl.close();
  }

  const startUrl = page.url() || options.url;
  const queue = new Map();
  const visited = new Set();
  const saved = [];
  const failed = [];

  enqueue(queue, {
    url: startUrl,
    title: await getPageTitle(page),
    pathParts: []
  });

  if (!options.noSidebar) {
    const sidebarItems = await discoverSidebarItems(page);
    for (const item of sidebarItems) {
      enqueue(queue, item);
    }
    if (sidebarItems.length > 0) {
      console.log(`Seeded ${sidebarItems.length} visible sidebar item(s).`);
    }
  }

  while (queue.size > 0 && saved.length < options.max) {
    const [key, item] = queue.entries().next().value;
    queue.delete(key);
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);

    console.log(`\n[${saved.length + failed.length + 1}] ${item.title || item.url}`);
    console.log(`    ${item.url}`);

    try {
      await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: options.timeout });
      await settle(page);

      const exportResult = await exportCurrentDocument(page, scripts);
      if (exportResult.ok) {
        const title = exportResult.title || firstMarkdownHeading(exportResult.markdown) || item.title || "dingding-wiki-doc";
        const parentPath = parentPathForDocument(item.pathParts, title);
        const filename = safePathPart(title, "dingding-wiki-doc") + ".md";
        const filePath = await uniqueFilePath(path.join(options.out, ...parentPath, filename));

        if (!options.dryRun) {
          await fsp.mkdir(path.dirname(filePath), { recursive: true });
          await fsp.writeFile(filePath, exportResult.markdown, "utf8");
        }

        saved.push({
          title,
          url: page.url(),
          file: path.relative(options.out, filePath)
        });
        console.log(`    saved: ${path.relative(options.out, filePath)}`);

        if (!options.noLinked) {
          const linked = await collectArticleLinks(page, scripts);
          const linkedPath = [...parentPath, `${safePathPart(title, "document")} - linked`];
          for (const link of linked) {
            enqueue(queue, {
              ...link,
              pathParts: linkedPath
            });
          }
          if (linked.length > 0) {
            console.log(`    queued ${linked.length} linked document(s).`);
          }
        }
      } else {
        const folderTitle = await getPageTitle(page);
        const folderPath = folderPathForItem(item.pathParts, folderTitle);
        const entries = await discoverFolderEntries(page, options);
        for (const entry of entries) {
          enqueue(queue, {
            ...entry,
            pathParts: [...folderPath, entry.title].filter(Boolean)
          });
        }

        if (entries.length > 0) {
          console.log(`    folder/list page: queued ${entries.length} child item(s).`);
        } else {
          failed.push({
            title: item.title,
            url: item.url,
            error: exportResult.error || "No article body or folder entries found"
          });
          console.log(`    skipped: ${exportResult.error || "no article body or folder entries found"}`);
        }
      }

      await delayWithJitter(options.delay);
    } catch (error) {
      failed.push({
        title: item.title,
        url: item.url,
        error: error.message || String(error)
      });
      console.log(`    failed: ${error.message || error}`);

      if (options.debug) {
        await saveDebugSnapshot(page, options.out, key);
      }
    }
  }

  const log = {
    startedFrom: startUrl,
    finishedAt: new Date().toISOString(),
    savedCount: saved.length,
    failedCount: failed.length,
    saved,
    failed
  };
  await fsp.writeFile(path.join(options.out, "export-log.json"), JSON.stringify(log, null, 2), "utf8");
  await writeIndex(options.out, saved);

  console.log("");
  console.log(`Done. Saved ${saved.length} Markdown file(s). Failed/skipped ${failed.length}.`);
  console.log(`Output: ${options.out}`);
  await context.close();
}

function parseArgs(argv) {
  const options = {
    noLinked: false,
    noSidebar: false,
    dryRun: false,
    debug: false,
    yes: false,
    headless: false,
    channel: "chrome"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];

    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-u" || arg === "--url") options.url = next();
    else if (arg.startsWith("--url=")) options.url = arg.slice("--url=".length);
    else if (arg === "-o" || arg === "--out") options.out = next();
    else if (arg.startsWith("--out=")) options.out = arg.slice("--out=".length);
    else if (arg === "--profile") options.profile = next();
    else if (arg.startsWith("--profile=")) options.profile = arg.slice("--profile=".length);
    else if (arg === "--max") options.max = next();
    else if (arg.startsWith("--max=")) options.max = arg.slice("--max=".length);
    else if (arg === "--delay") options.delay = next();
    else if (arg.startsWith("--delay=")) options.delay = arg.slice("--delay=".length);
    else if (arg === "--timeout") options.timeout = next();
    else if (arg.startsWith("--timeout=")) options.timeout = arg.slice("--timeout=".length);
    else if (arg === "--channel") options.channel = next();
    else if (arg.startsWith("--channel=")) options.channel = arg.slice("--channel=".length);
    else if (arg === "--headless") options.headless = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--no-linked") options.noLinked = true;
    else if (arg === "--no-sidebar") options.noSidebar = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--debug") options.debug = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printUsage() {
  console.log(`
Usage:
  npm run batch -- --url "https://alidocs.dingtalk.com/i/nodes/..." --out ./exports/wiki

Options:
  -u, --url <url>        Start DingTalk wiki folder/document URL. Required.
  -o, --out <dir>        Output directory. Default: ./exports/dingtalk-wiki-<timestamp>
      --profile <dir>    Persistent browser profile. Default: ./.dingtalk-playwright-profile
      --max <n>          Stop after saving n Markdown files.
      --delay <ms>       Delay between pages. Default: 1200.
      --timeout <ms>     Per-action timeout. Default: 30000.
      --channel <name>   Browser channel. Default: chrome. Use "chromium" to use Playwright's browser.
      --headless         Run without a visible browser window.
      --yes              Do not pause for login/confirmation.
      --no-linked        Do not queue document links found inside exported articles.
      --no-sidebar       Do not seed from visible sidebar links.
      --dry-run          Crawl without writing Markdown files.
      --debug            Save screenshots/HTML when a page fails.
`);
}

function validateStartUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new Error(`Invalid --url: ${value}`);
  }

  if (!DING_HOSTS.has(url.hostname) || !NODE_PATH_RE.test(url.pathname)) {
    throw new Error("The start URL must be a DingTalk wiki URL under /i/nodes/.");
  }
}

async function launchContext(options) {
  const launchOptions = {
    headless: options.headless,
    viewport: { width: 1440, height: 980 },
    acceptDownloads: true,
    bypassCSP: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage"
    ]
  };

  if (options.channel && options.channel !== "chromium") {
    launchOptions.channel = options.channel;
  }

  try {
    return await playwright.chromium.launchPersistentContext(options.profile, launchOptions);
  } catch (error) {
    if (!launchOptions.channel) {
      throw error;
    }
    console.warn(`Could not launch channel "${launchOptions.channel}". Falling back to Playwright Chromium.`);
    delete launchOptions.channel;
    return playwright.chromium.launchPersistentContext(options.profile, launchOptions);
  }
}

async function loadExporterScripts() {
  const [turndown, gfm, contentScript] = await Promise.all([
    fsp.readFile(TURNDOWN_PATH, "utf8"),
    fsp.readFile(GFM_PATH, "utf8"),
    fsp.readFile(CONTENT_SCRIPT_PATH, "utf8")
  ]);
  return { turndown, gfm, contentScript };
}

async function settle(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

async function exportCurrentDocument(page, scripts) {
  const result = await runContentScriptMessageInFrames(page, scripts, { type: "DINGTALK_MARKDOWN_EXPORT" });

  if (result?.ok) {
    result.title = firstMarkdownHeading(result.markdown);
  }
  return result || { ok: false, error: "Empty exporter response." };
}

async function runContentScriptMessageInFrames(page, scripts, message) {
  const mainFrame = page.mainFrame();
  const frames = [
    mainFrame,
    ...page.frames().filter((frame) => frame !== mainFrame)
  ];
  const responses = [];

  for (const frame of frames) {
    responses.push(await runContentScriptMessageInFrame(frame, scripts, message));
    if (isUsefulExporterResponse(message, responses[responses.length - 1])) {
      return responses[responses.length - 1];
    }
  }

  return chooseBestExporterResponse(message, responses);
}

async function runContentScriptMessageInFrame(frame, scripts, message) {
  try {
    await frame.evaluate(({ turndown, gfm, contentScript }) => {
    window.__DINGTALK_BATCH_HANDLER = null;

    const runtime = {
      onMessage: {
        addListener(listener) {
          window.__DINGTALK_BATCH_HANDLER = (message) => new Promise((resolve) => {
            let responded = false;
            const sendResponse = (response) => {
              responded = true;
              resolve(response);
            };

            try {
              const keepAlive = listener(message, {}, sendResponse);
              if (!keepAlive && !responded) {
                resolve({ ok: false, error: "Exporter did not respond." });
              }
            } catch (error) {
              resolve({ ok: false, error: error.message || String(error) });
            }
          });
        }
      }
    };

    const chromeShim = window.chrome && typeof window.chrome === "object" ? window.chrome : {};
    chromeShim.runtime = runtime;
    try {
      Object.defineProperty(window, "chrome", {
        value: chromeShim,
        configurable: true
      });
    } catch (_error) {
      window.chrome = chromeShim;
    }

    if (!window.TurndownService) {
      (0, eval)(turndown);
    }
    if (!window.turndownPluginGfm) {
      (0, eval)(gfm);
    }
    (0, eval)(contentScript);
    }, scripts);

    return await frame.evaluate(async (payload) => {
      if (!window.__DINGTALK_BATCH_HANDLER) {
        return { ok: false, error: "Exporter handler was not installed." };
      }
      return window.__DINGTALK_BATCH_HANDLER(payload);
    }, message);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function chooseBestExporterResponse(message, responses) {
  const ranked = responses
    .filter(Boolean)
    .sort((a, b) => exporterResponseScore(message, b) - exporterResponseScore(message, a));
  return ranked[0] || { ok: false, error: "Exporter handler was not installed." };
}

function isUsefulExporterResponse(message, response) {
  return exporterResponseScore(message, response) >= 1000;
}

function exporterResponseScore(_message, response) {
  if (!response) {
    return -1;
  }
  if (!response.ok) {
    return 0;
  }
  if (typeof response.markdown === "string") {
    return 1000 + Math.min(response.markdown.length, 100000);
  }
  if (Array.isArray(response.items)) {
    return 1000 + response.items.length;
  }
  return 1000;
}

async function discoverFolderEntries(page, options) {
  const hrefEntries = await collectNodeLinks(page, "main");
  if (hrefEntries.length > 0) {
    return uniqueItems(hrefEntries);
  }

  const clickCandidates = await collectMainClickCandidates(page);
  if (clickCandidates.length === 0) {
    return [];
  }

  const sourceUrl = page.url();
  const sourceKey = nodeKey(sourceUrl);
  const entries = [];
  const context = page.context();

  for (const candidate of clickCandidates.slice(0, 200)) {
    if (entries.length >= options.max) {
      break;
    }

    const popupPromise = context.waitForEvent("page", { timeout: 2500 }).catch(() => null);
    await page.mouse.click(candidate.x, candidate.y).catch(() => {});
    const popup = await popupPromise;

    let targetUrl = null;
    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      targetUrl = popup.url();
      await popup.close().catch(() => {});
    } else {
      await page.waitForTimeout(1000);
      const nextUrl = page.url();
      if (nodeKey(nextUrl) !== sourceKey) {
        targetUrl = nextUrl;
      }
    }

    if (targetUrl && isDingNodeUrl(targetUrl)) {
      entries.push({
        url: targetUrl,
        title: candidate.title,
        pathParts: []
      });
    }

    if (nodeKey(page.url()) !== sourceKey) {
      await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: options.timeout });
      await settle(page);
    }
  }

  return uniqueItems(entries);
}

async function discoverSidebarItems(page) {
  await expandVisibleSidebar(page);
  const items = await page.evaluate(() => {
    const root = findSidebarRootInPage();
    if (!root) return [];

    const seen = new Set();
    const rows = [];
    const add = (element, url, title) => {
      if (!url || !title || seen.has(url)) return;
      const rect = element.getBoundingClientRect();
      if (!isVisibleInPage(element) || rect.left > 420) return;
      seen.add(url);
      rows.push({
        url,
        title: cleanTextInPage(title),
        left: rect.left,
        top: rect.top
      });
    };

    root.querySelectorAll("a[href*='/i/nodes/']").forEach((anchor) => {
      add(anchor, anchor.href, anchor.textContent);
    });

    root.querySelectorAll("[data-url], [data-href], [href]").forEach((node) => {
      const rawUrl = node.getAttribute("data-url") || node.getAttribute("data-href") || node.getAttribute("href");
      if (!rawUrl || !rawUrl.includes("/i/nodes/")) return;
      add(node, new URL(rawUrl, location.href).href, node.textContent);
    });

    rows.sort((a, b) => a.top - b.top);
    const minLeft = rows.reduce((min, row) => Math.min(min, row.left), Infinity);
    const stack = [];

    return rows.map((row) => {
      const level = Math.max(0, Math.round((row.left - minLeft) / 18));
      stack[level] = row.title;
      stack.length = level + 1;
      return {
        url: row.url,
        title: row.title,
        pathParts: stack.slice()
      };
    });

    function findSidebarRootInPage() {
      const candidates = Array.from(document.querySelectorAll("aside, nav, [role='tree'], [class*='sidebar'], [class*='sider'], [class*='catalog'], [class*='tree']"));
      return candidates
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left < 360 && rect.width >= 120 && rect.height >= 300;
        })
        .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
        || Array.from(document.body.children).find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left < 320 && rect.width >= 180 && rect.width <= 420 && rect.height > innerHeight * 0.6;
        });
    }

    function isVisibleInPage(node) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function cleanTextInPage(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
  });

  return uniqueItems(items.filter((item) => isDingNodeUrl(item.url)));
}

async function expandVisibleSidebar(page) {
  await page.evaluate(async () => {
    const root = findSidebarRootInPage();
    if (!root) return;

    for (let pass = 0; pass < 8; pass += 1) {
      const expanders = Array.from(root.querySelectorAll("[aria-expanded='false']"))
        .filter(isVisibleInPage)
        .slice(0, 80);

      for (const expander of expanders) {
        expander.click();
        await sleepInPage(80);
      }

      const previous = root.scrollTop;
      root.scrollTop = Math.min(root.scrollTop + Math.max(240, root.clientHeight * 0.75), root.scrollHeight);
      await sleepInPage(180);

      if (expanders.length === 0 && root.scrollTop === previous) {
        break;
      }
    }

    root.scrollTop = 0;

    function findSidebarRootInPage() {
      const candidates = Array.from(document.querySelectorAll("aside, nav, [role='tree'], [class*='sidebar'], [class*='sider'], [class*='catalog'], [class*='tree']"));
      return candidates
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left < 360 && rect.width >= 120 && rect.height >= 300;
        })
        .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]
        || Array.from(document.body.children).find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left < 320 && rect.width >= 180 && rect.width <= 420 && rect.height > innerHeight * 0.6;
        });
    }

    function isVisibleInPage(node) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function sleepInPage(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
  }).catch(() => {});
}

async function collectNodeLinks(page, area) {
  const items = await page.evaluate((targetArea) => {
    const root = targetArea === "article"
      ? findArticleRootInPage()
      : findMainRootInPage();
    if (!root) return [];

    const result = [];
    const seen = new Set();
    const add = (element, url, title) => {
      if (!url || !url.includes("/i/nodes/")) return;
      if (targetArea === "main") {
        const rect = element.getBoundingClientRect();
        if (rect.left < 240 || rect.top < 80) return;
      }
      const absolute = new URL(url, location.href).href;
      if (seen.has(absolute)) return;
      seen.add(absolute);
      result.push({
        url: absolute,
        title: cleanTextInPage(title) || "Untitled",
        pathParts: []
      });
    };

    root.querySelectorAll("a[href*='/i/nodes/']").forEach((anchor) => {
      if (!isVisibleInPage(anchor)) return;
      add(anchor, anchor.href, anchor.textContent || anchor.getAttribute("title"));
    });

    root.querySelectorAll("[data-url], [data-href], [href]").forEach((node) => {
      const rawUrl = node.getAttribute("data-url") || node.getAttribute("data-href") || node.getAttribute("href");
      if (!rawUrl || !rawUrl.includes("/i/nodes/")) return;
      if (!isVisibleInPage(node)) return;
      add(node, rawUrl, node.textContent || node.getAttribute("title"));
    });

    return result;

    function findArticleRootInPage() {
      return document.querySelector("article[data-cangjie-content='true'], article.body-editor-content, article")
        || findMainRootInPage();
    }

    function findMainRootInPage() {
      const candidates = Array.from(document.querySelectorAll("main, [role='main'], section, article, body > div"))
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left > 180 && rect.width > innerWidth * 0.45 && rect.height > 180;
        });
      return candidates
        .sort((a, b) => areaScore(b) - areaScore(a))[0]
        || document.body;
    }

    function areaScore(node) {
      const rect = node.getBoundingClientRect();
      return rect.width * rect.height;
    }

    function isVisibleInPage(node) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function cleanTextInPage(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
  }, area);

  const currentKey = nodeKey(page.url());
  return uniqueItems(items)
    .filter((item) => isDingNodeUrl(item.url))
    .filter((item) => nodeKey(item.url) !== currentKey);
}

async function collectArticleLinks(page, scripts) {
  const result = await runContentScriptMessageInFrames(page, scripts, { type: "DINGTALK_BATCH_LINKS" });
  if (result?.ok) {
    return uniqueItems(result.items || [])
      .filter((item) => isDingNodeUrl(item.url))
      .filter((item) => nodeKey(item.url) !== nodeKey(page.url()));
  }
  return collectNodeLinks(page, "article");
}

async function collectMainClickCandidates(page) {
  return page.evaluate(() => {
    const root = findMainRootInPage();
    if (!root) return [];

    const selectors = [
      "[role='row']",
      "tr",
      "[class*='row']",
      "[class*='item']",
      "[class*='file']",
      "[data-node-id]",
      "[data-file-id]",
      "[data-resource-id]"
    ];
    const result = [];
    const seenTitles = new Set();

    root.querySelectorAll(selectors.join(",")).forEach((node) => {
      if (!isVisibleInPage(node)) return;
      const rect = node.getBoundingClientRect();
      if (rect.left < 240 || rect.top < 110 || rect.height < 22 || rect.height > 96 || rect.width < 160) return;

      const title = rowTitleInPage(node);
      if (!title || seenTitles.has(title) || shouldSkipTitleInPage(title)) return;
      seenTitles.add(title);

      result.push({
        title,
        x: Math.round(rect.left + Math.min(96, Math.max(28, rect.width * 0.12))),
        y: Math.round(rect.top + rect.height / 2)
      });
    });

    return result.slice(0, 240);

    function findMainRootInPage() {
      const candidates = Array.from(document.querySelectorAll("main, [role='main'], section, body > div"))
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left > 180 && rect.width > innerWidth * 0.45 && rect.height > 200;
        });
      return candidates
        .sort((a, b) => areaScore(b) - areaScore(a))[0]
        || document.body;
    }

    function areaScore(node) {
      const rect = node.getBoundingClientRect();
      return rect.width * rect.height;
    }

    function isVisibleInPage(node) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function rowTitleInPage(node) {
      const candidates = Array.from(node.querySelectorAll("a, span, div, p"))
        .map((child) => cleanTextInPage(child.textContent))
        .filter(Boolean)
        .filter((text) => text.length <= 180)
        .filter((text) => !shouldSkipTitleInPage(text));

      return candidates[0] || cleanTextInPage(node.textContent).split(" Creator ")[0].slice(0, 160);
    }

    function shouldSkipTitleInPage(text) {
      return /^(File name|Creator|Update time|Last edited|New|Upload|Share|Home|Catalog)$/i.test(text)
        || /^\d+\s+document\(s\)/i.test(text)
        || text.length < 2;
    }

    function cleanTextInPage(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
  });
}

async function getPageTitle(page) {
  return page.evaluate(() => {
    const selectors = [
      "#doc-title-name",
      "#doc-title",
      "article h1",
      "main h1",
      "[role='main'] h1",
      "h1",
      "h2"
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = cleanTextInPage(node?.textContent);
      if (text && !shouldSkipTitleInPage(text)) {
        return text;
      }
    }

    const topCandidates = Array.from(document.querySelectorAll("main [class*='title'], [role='main'] [class*='title'], body [class*='title']"))
      .filter(isVisibleInPage)
      .map((node) => cleanTextInPage(node.textContent))
      .filter((text) => text && text.length <= 120 && !shouldSkipTitleInPage(text));

    return topCandidates[0] || cleanTextInPage(document.title) || "DingTalk wiki";

    function isVisibleInPage(node) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function shouldSkipTitleInPage(text) {
      return /^(File name|Creator|Update time|Last edited|New|Upload|Share|Home|Catalog)$/i.test(text)
        || /^\d+\s+document\(s\)/i.test(text);
    }

    function cleanTextInPage(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
  }).catch(() => "DingTalk wiki");
}

function enqueue(queue, item) {
  if (!item?.url || !isDingNodeUrl(item.url)) {
    return false;
  }

  const key = nodeKey(item.url);
  if (!key || queue.has(key)) {
    return false;
  }

  queue.set(key, {
    url: item.url,
    title: cleanText(item.title) || "Untitled",
    pathParts: Array.isArray(item.pathParts) ? item.pathParts.filter(Boolean) : []
  });
  return true;
}

function uniqueItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = nodeKey(item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function isDingNodeUrl(value) {
  try {
    const url = new URL(value);
    return DING_HOSTS.has(url.hostname) && NODE_PATH_RE.test(url.pathname);
  } catch (_error) {
    return false;
  }
}

function nodeKey(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(NODE_PATH_RE);
    if (match) {
      return `${url.hostname}/i/nodes/${match[1]}`;
    }
    return `${url.hostname}${url.pathname}`;
  } catch (_error) {
    return null;
  }
}

function parentPathForDocument(pathParts, title) {
  if (!pathParts.length) return [];
  const last = pathParts[pathParts.length - 1];
  if (titlesLookSame(last, title)) {
    return pathParts.slice(0, -1).map((part) => safePathPart(part, "folder"));
  }
  return pathParts.map((part) => safePathPart(part, "folder"));
}

function folderPathForItem(pathParts, title) {
  if (!title) return pathParts.map((part) => safePathPart(part, "folder"));
  if (pathParts.length && titlesLookSame(pathParts[pathParts.length - 1], title)) {
    return pathParts.map((part) => safePathPart(part, "folder"));
  }
  return [...pathParts, title].map((part) => safePathPart(part, "folder"));
}

function titlesLookSame(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  return left && right && (left === right || left.includes(right) || right.includes(left));
}

function normalizeTitle(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[\\/:*?"<>|#_\-\s.，,、。]+/g, "")
    .slice(0, 80);
}

function safePathPart(value, fallback) {
  const cleaned = cleanText(value)
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/^\.+$/, "")
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function uniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base} (${index})${ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not create a unique file path for ${filePath}`);
}

function firstMarkdownHeading(markdown) {
  const match = String(markdown || "").match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

async function writeIndex(outDir, saved) {
  const lines = [
    "# DingTalk Wiki Export Index",
    "",
    ...saved.map((item) => `- [${escapeMarkdownLinkText(item.title)}](${encodeURI(item.file).replace(/#/g, "%23")})`)
  ];
  await fsp.writeFile(path.join(outDir, "_index.md"), `${lines.join("\n")}\n`, "utf8");
}

function escapeMarkdownLinkText(value) {
  return String(value || "").replace(/[[\]\\]/g, "\\$&");
}

async function saveDebugSnapshot(page, outDir, key) {
  const debugDir = path.join(outDir, "_debug");
  await fsp.mkdir(debugDir, { recursive: true });
  const safeKey = safePathPart(key, "page");
  await page.screenshot({ path: path.join(debugDir, `${safeKey}.png`), fullPage: true }).catch(() => {});
  await fsp.writeFile(path.join(debugDir, `${safeKey}.html`), await page.content(), "utf8").catch(() => {});
}

async function delayWithJitter(ms) {
  const jitter = Math.round(Math.random() * Math.min(ms, 600));
  await new Promise((resolve) => setTimeout(resolve, ms + jitter));
}

function timestampForPath() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  ].join("-");
}
