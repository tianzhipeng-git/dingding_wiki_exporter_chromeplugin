const params = new URLSearchParams(location.search);
const sourceTabId = Number(params.get("tabId"));

const sourceText = document.getElementById("sourceText");
const reloadButton = document.getElementById("reloadButton");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const selectAllButton = document.getElementById("selectAllButton");
const selectNoneButton = document.getElementById("selectNoneButton");
const itemSummary = document.getElementById("itemSummary");
const itemList = document.getElementById("itemList");
const rootDirInput = document.getElementById("rootDirInput");
const maxInput = document.getElementById("maxInput");
const includeLinkedInput = document.getElementById("includeLinkedInput");
const closeTabInput = document.getElementById("closeTabInput");
const progressBar = document.getElementById("progressBar");
const runStatus = document.getElementById("runStatus");
const logOutput = document.getElementById("logOutput");

let items = [];
let running = false;
let stopRequested = false;
let workerTabId = null;

init();

async function init() {
  bindEvents();

  if (!sourceTabId) {
    setStatus("没有找到来源标签页，请从插件弹窗重新打开。");
    return;
  }

  try {
    const tab = await chromeApi(chrome.tabs.get, sourceTabId);
    sourceText.textContent = tab.url || "当前钉钉页面";
    await reloadItems();
  } catch (error) {
    setStatus(`读取来源标签页失败：${error.message}`);
  }
}

function bindEvents() {
  reloadButton.addEventListener("click", reloadItems);
  startButton.addEventListener("click", startExport);
  stopButton.addEventListener("click", () => {
    stopRequested = true;
    stopButton.disabled = true;
    setStatus("正在停止，当前文档完成后会退出。");
  });
  selectAllButton.addEventListener("click", () => setAllChecked(true));
  selectNoneButton.addEventListener("click", () => setAllChecked(false));
}

async function reloadItems() {
  if (running) {
    return;
  }

  setStatus("正在扫描左侧目录和当前目录...");
  setControls({ loading: true });
  itemList.innerHTML = "<div class=\"empty\">扫描中...</div>";

  try {
    const response = await sendToTab(sourceTabId, {
      type: "DINGTALK_BATCH_DISCOVER",
      scope: "sidebarAndPage",
      resolveClicks: true
    });

    if (!response?.ok) {
      throw new Error(response?.error || "扫描失败");
    }

    items = uniqueItems(response.items || []);
    renderItems();
    setStatus(`扫描完成：${items.length} 个可选条目。`);
    appendLog(`扫描完成：${items.length} 个可选条目，模式：${response.mode === "click" ? "点击探测" : "直接读取"}`);
  } catch (error) {
    items = [];
    renderItems();
    setStatus(`扫描失败：${error.message}`);
    appendLog(`扫描失败：${error.message}`);
  } finally {
    setControls({ loading: false });
  }
}

function renderItems() {
  itemSummary.textContent = `${items.length} 个条目，已选择 ${selectedItems().length} 个`;
  startButton.disabled = running || selectedItems().length === 0;

  if (items.length === 0) {
    itemList.innerHTML = "<div class=\"empty\">没有识别到可导出的目录项。请确认来源标签页停留在钉钉知识库目录或文档页，左侧目录已加载完成，然后重新扫描。</div>";
    return;
  }

  itemList.innerHTML = "";
  items.forEach((item, index) => {
    const row = document.createElement("label");
    row.className = "item-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.checked !== false;
    checkbox.addEventListener("change", () => {
      item.checked = checkbox.checked;
      renderSummary();
    });

    const text = document.createElement("div");
    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = item.title || "未命名文档";
    const path = document.createElement("div");
    path.className = "item-path";
    path.textContent = item.pathParts?.length ? item.pathParts.join(" / ") : item.url;
    text.append(title, path);

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = item.source === "page" ? "目录" : "左侧";

    row.append(checkbox, text, badge);
    row.dataset.index = String(index);
    itemList.append(row);
  });

  renderSummary();
}

function renderSummary() {
  const selected = selectedItems().length;
  itemSummary.textContent = `${items.length} 个条目，已选择 ${selected} 个`;
  startButton.disabled = running || selected === 0;
}

function setAllChecked(checked) {
  items.forEach((item) => {
    item.checked = checked;
  });
  renderItems();
}

async function startExport() {
  const selected = selectedItems();
  if (selected.length === 0 || running) {
    return;
  }

  running = true;
  stopRequested = false;
  logOutput.textContent = "";
  setControls({ running: true });

  const max = Math.max(0, Number(maxInput.value || 0));
  const includeLinked = includeLinkedInput.checked;
  const rootDir = safePathPart(rootDirInput.value || "dingding-wiki-export", "dingding-wiki-export");
  const queue = selected.map((item) => normalizeQueueItem(item));
  const queuedKeys = new Set(queue.map((item) => nodeKey(item.url)));
  const visited = new Set();
  const saved = [];
  const failed = [];

  try {
    workerTabId = await createWorkerTab();
    appendLog(`已创建后台导出标签页：${workerTabId}`);

    while (queue.length > 0 && !stopRequested) {
      if (max > 0 && saved.length >= max) {
        appendLog(`达到最多导出篇数 ${max}，停止。`);
        break;
      }

      const item = queue.shift();
      const key = nodeKey(item.url);
      if (!key || visited.has(key)) {
        continue;
      }
      visited.add(key);

      updateProgress(saved.length, Math.max(saved.length + queue.length + 1, selected.length));
      setStatus(`正在导出：${item.title || item.url}`);
      appendLog(`导出：${item.title || item.url}`);

      try {
        await navigateWorker(item.url);
        const exportResult = await sendToTab(workerTabId, { type: "DINGTALK_MARKDOWN_EXPORT" });

        if (exportResult?.ok) {
          const title = firstMarkdownHeading(exportResult.markdown) || item.title || "钉钉知识库文档";
          const parentPath = parentPathForDocument(item.pathParts || [], title);
          const filename = `${safePathPart(title, "dingding-wiki-doc")}.md`;
          const downloadPath = joinDownloadPath([rootDir, ...parentPath, filename]);
          await downloadMarkdown(downloadPath, exportResult.markdown);
          saved.push({ title, url: item.url, file: downloadPath });
          appendLog(`  保存：${downloadPath}`);

          if (includeLinked) {
            const linked = await sendToTab(workerTabId, { type: "DINGTALK_BATCH_LINKS" });
            if (linked?.ok && linked.items?.length) {
              const linkedParent = [...parentPath, `${safePathPart(title, "document")} - linked`];
              for (const link of linked.items) {
                enqueue(queue, queuedKeys, {
                  ...link,
                  pathParts: linkedParent
                });
              }
              appendLog(`  发现正文子文档：${linked.items.length} 个`);
            }
          }
        } else {
          const children = await discoverChildrenFromWorker(item);
          if (children.length > 0) {
            const folderPath = folderPathForItem(item.pathParts || [], item.title);
            children.forEach((child) => {
              enqueue(queue, queuedKeys, {
                ...child,
                pathParts: [...folderPath, child.title].filter(Boolean)
              });
            });
            appendLog(`  作为目录处理，加入子项：${children.length} 个`);
          } else {
            failed.push({
              title: item.title,
              url: item.url,
              error: exportResult?.error || "未找到正文或子项"
            });
            appendLog(`  跳过：${exportResult?.error || "未找到正文或子项"}`);
          }
        }

        await sleep(800);
      } catch (error) {
        failed.push({ title: item.title, url: item.url, error: error.message });
        appendLog(`  失败：${error.message}`);
      }
    }

    const indexMarkdown = buildIndexMarkdown(saved, failed);
    await downloadMarkdown(joinDownloadPath([rootDir, "_index.md"]), indexMarkdown);
    await downloadMarkdown(
      joinDownloadPath([rootDir, "export-log.json"]),
      JSON.stringify({ saved, failed, finishedAt: new Date().toISOString() }, null, 2),
      "application/json;charset=utf-8"
    );

    updateProgress(saved.length, saved.length);
    setStatus(`完成：成功 ${saved.length} 篇，失败/跳过 ${failed.length} 个。`);
    appendLog(`完成：成功 ${saved.length} 篇，失败/跳过 ${failed.length} 个。`);
  } finally {
    if (workerTabId && closeTabInput.checked) {
      await chromeApi(chrome.tabs.remove, workerTabId).catch(() => {});
    }
    workerTabId = null;
    running = false;
    setControls({ running: false });
    renderSummary();
  }
}

async function discoverChildrenFromWorker(item) {
  const response = await sendToTab(workerTabId, {
    type: "DINGTALK_BATCH_DISCOVER",
    scope: "page",
    resolveClicks: true
  });

  if (!response?.ok) {
    return [];
  }

  const currentKey = nodeKey(item.url);
  return uniqueItems(response.items || [])
    .filter((child) => nodeKey(child.url) !== currentKey);
}

async function createWorkerTab() {
  const tab = await chromeApi(chrome.tabs.create, {
    url: "about:blank",
    active: false
  });
  return tab.id;
}

async function navigateWorker(url) {
  await chromeApi(chrome.tabs.update, workerTabId, { url, active: false });
  await waitForTabComplete(workerTabId);
  await sleep(1300);
}

async function waitForTabComplete(tabId) {
  const tab = await chromeApi(chrome.tabs.get, tabId).catch(() => null);
  if (tab?.status === "complete") {
    return;
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("页面加载超时"));
    }, 45000);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        window.clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

const CONTENT_FRAME_MESSAGE_TYPES = new Set([
  "DINGTALK_MARKDOWN_CHECK",
  "DINGTALK_MARKDOWN_EXPORT",
  "DINGTALK_BATCH_LINKS"
]);

async function sendToTab(tabId, message) {
  if (CONTENT_FRAME_MESSAGE_TYPES.has(message?.type)) {
    return sendToBestFrame(tabId, message);
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
      if (chrome.runtime.lastError) {
        chrome.tabs.sendMessage(tabId, message, (fallbackResponse) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: "扩展脚本尚未注入页面，请刷新页面或重新加载插件。" });
            return;
          }
          resolve(fallbackResponse);
        });
        return;
      }
      resolve(response);
    });
  });
}

async function sendToBestFrame(tabId, message) {
  const responses = [];
  const frame0Response = await sendToFrame(tabId, message, 0);
  responses.push(frame0Response);

  if (isUsefulResponse(message, frame0Response)) {
    return frame0Response;
  }

  const frames = await getAllFrames(tabId);
  for (const frame of frames) {
    if (frame.frameId === 0) {
      continue;
    }
    responses.push(await sendToFrame(tabId, message, frame.frameId));
  }

  return chooseBestResponse(message, responses);
}

function sendToFrame(tabId, message, frameId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

function getAllFrames(tabId) {
  return new Promise((resolve) => {
    if (!chrome.webNavigation?.getAllFrames) {
      resolve([]);
      return;
    }
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(frames || []);
    });
  });
}

function chooseBestResponse(message, responses) {
  const ranked = responses
    .filter(Boolean)
    .sort((a, b) => responseScore(message, b) - responseScore(message, a));
  return ranked[0] || { ok: false, error: "扩展脚本尚未注入页面，请刷新页面或重新加载插件。" };
}

function isUsefulResponse(message, response) {
  return responseScore(message, response) >= 1000;
}

function responseScore(_message, response) {
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

function downloadMarkdown(filename, content, mimeType = "text/markdown;charset=utf-8") {
  return new Promise((resolve, reject) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    }, (downloadId) => {
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

function selectedItems() {
  return items.filter((item) => item.checked !== false);
}

function normalizeQueueItem(item) {
  return {
    url: item.url,
    title: item.title || "未命名文档",
    pathParts: Array.isArray(item.pathParts) ? item.pathParts : []
  };
}

function enqueue(queue, queuedKeys, item) {
  const key = nodeKey(item.url);
  if (!key || queuedKeys.has(key)) {
    return false;
  }
  queuedKeys.add(key);
  queue.push(normalizeQueueItem(item));
  return true;
}

function uniqueItems(rawItems) {
  const seen = new Set();
  const result = [];
  rawItems.forEach((item) => {
    if (!item?.url) {
      return;
    }
    const key = nodeKey(item.url);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push({
      ...item,
      title: cleanText(item.title) || "未命名文档",
      pathParts: Array.isArray(item.pathParts) ? item.pathParts.filter(Boolean) : [],
      checked: item.checked !== false
    });
  });
  return result;
}

function nodeKey(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/i\/nodes\/([^/?#]+)/);
    if (!match) {
      return "";
    }
    return `${url.hostname}/i/nodes/${match[1]}`;
  } catch (_error) {
    return "";
  }
}

function parentPathForDocument(pathParts, title) {
  if (!pathParts.length) {
    return [];
  }
  const last = pathParts[pathParts.length - 1];
  if (titlesLookSame(last, title)) {
    return pathParts.slice(0, -1).map((part) => safePathPart(part, "folder"));
  }
  return pathParts.map((part) => safePathPart(part, "folder"));
}

function folderPathForItem(pathParts, title) {
  if (!title || (pathParts.length && titlesLookSame(pathParts[pathParts.length - 1], title))) {
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

function firstMarkdownHeading(markdown) {
  const match = String(markdown || "").match(/^#\s+(.+)$/m);
  return match ? cleanText(match[1]) : "";
}

function buildIndexMarkdown(saved, failed) {
  const lines = [
    "# DingTalk Wiki Export Index",
    "",
    "## Exported",
    ""
  ];

  if (saved.length === 0) {
    lines.push("No documents exported.", "");
  } else {
    saved.forEach((item) => {
      lines.push(`- [${escapeMarkdownText(item.title)}](${encodeURI(item.file).replace(/#/g, "%23")})`);
    });
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push("## Failed or Skipped", "");
    failed.forEach((item) => {
      lines.push(`- ${escapeMarkdownText(item.title || item.url)}：${escapeMarkdownText(item.error || "")}`);
    });
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function joinDownloadPath(parts) {
  return parts
    .filter(Boolean)
    .map((part) => safePathPart(part, "item"))
    .join("/");
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

function escapeMarkdownText(value) {
  return String(value || "").replace(/[[\]\\]/g, "\\$&");
}

function setStatus(text) {
  runStatus.textContent = text;
}

function setControls(state) {
  const isRunning = Boolean(state.running);
  const isLoading = Boolean(state.loading);

  reloadButton.disabled = isRunning || isLoading;
  startButton.disabled = isRunning || isLoading || selectedItems().length === 0;
  stopButton.disabled = !isRunning;
  selectAllButton.disabled = isRunning || isLoading || items.length === 0;
  selectNoneButton.disabled = isRunning || isLoading || items.length === 0;
}

function updateProgress(done, total) {
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  progressBar.style.width = `${Math.round(ratio * 100)}%`;
}

function appendLog(line) {
  const timestamp = new Date().toLocaleTimeString();
  logOutput.textContent += `[${timestamp}] ${line}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function chromeApi(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
