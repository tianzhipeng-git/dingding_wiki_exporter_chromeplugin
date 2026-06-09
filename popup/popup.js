const statusNode = document.getElementById("status");
const exportButton = document.getElementById("exportButton");
const batchButton = document.getElementById("batchButton");

let activeTabId = null;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  if (!activeTabId || !isDingTalkDocsUrl(tab.url)) {
    setStatus("当前不是钉钉文档页面。");
    return;
  }

  batchButton.disabled = false;

  const state = await sendMessage({ type: "DINGTALK_MARKDOWN_CHECK" });
  if (!state?.ok) {
    setStatus("可批量选择导出；当前页未识别为单篇文档。");
    return;
  }

  setStatus(`已识别：${state.title || "钉钉知识库文档"}`);
  exportButton.disabled = false;
}

exportButton.addEventListener("click", async () => {
  exportButton.disabled = true;
  setStatus("正在收集文档内容并生成 Markdown...");

  const result = await sendMessage({ type: "DINGTALK_MARKDOWN_EXPORT" });
  if (!result?.ok) {
    setStatus(result?.error || "导出失败。");
    exportButton.disabled = false;
    return;
  }

  const dataUrl = markdownToDataUrl(result.markdown);
  await chrome.downloads.download({
    url: dataUrl,
    filename: result.filename,
    saveAs: true
  });

  setStatus("已生成下载任务。");
  exportButton.disabled = false;
});

batchButton.addEventListener("click", async () => {
  if (!activeTabId) {
    return;
  }

  const url = chrome.runtime.getURL(`batch/batch.html?tabId=${encodeURIComponent(activeTabId)}`);
  await chrome.tabs.create({ url });
});

function isDingTalkDocsUrl(url) {
  return typeof url === "string"
    && /^https:\/\/(?:docs|alidocs)\.dingtalk\.com\/i\/nodes\//.test(url);
}

function sendMessage(message) {
  return sendToBestFrame(activeTabId, message);
}

async function sendToBestFrame(tabId, message) {
  const responses = [];
  const frame0Response = await sendMessageToFrame(tabId, message, 0);
  responses.push(frame0Response);

  if (isUsefulResponse(message, frame0Response)) {
    return frame0Response;
  }

  const frames = await getAllFrames(tabId);
  for (const frame of frames) {
    if (frame.frameId === 0) {
      continue;
    }
    responses.push(await sendMessageToFrame(tabId, message, frame.frameId));
  }

  return chooseBestResponse(message, responses);
}

function sendMessageToFrame(tabId, message, frameId) {
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
  return ranked[0] || { ok: false, error: "扩展脚本尚未注入当前页面，请刷新页面后重试。" };
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

function setStatus(text) {
  statusNode.textContent = text;
}

function markdownToDataUrl(markdown) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  return URL.createObjectURL(blob);
}
