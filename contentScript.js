(function () {
  const WIKI_NODE_PATH = /^\/i\/nodes\//;
  const WIKI_IFRAME_SELECTOR = "iframe#wiki-doc-iframe, iframe[src*='/note/preview']";
  const ARTICLE_SELECTOR = "article[data-cangjie-content='true'], article.body-editor-content";
  const VIRTUAL_PLACEHOLDER_SELECTOR = [
    "[data-cangjie-virualize-placeholder]",
    "[data-cangjie-virtualize-placeholder]"
  ].join(",");

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "DINGTALK_MARKDOWN_CHECK") {
      handleCheck().then(sendResponse);
      return true;
    }

    if (message?.type === "DINGTALK_MARKDOWN_EXPORT") {
      handleExport().then(sendResponse);
      return true;
    }

    if (message?.type === "DINGTALK_BATCH_DISCOVER") {
      handleBatchDiscover(message).then(sendResponse);
      return true;
    }

    if (message?.type === "DINGTALK_BATCH_LINKS") {
      handleBatchLinks().then(sendResponse);
      return true;
    }

    return false;
  });

  async function handleCheck() {
    const target = await findTargetDocument();
    if (!target) {
      return { ok: false, error: "没有找到钉钉知识库文档正文。" };
    }

    return {
      ok: true,
      title: getDocumentTitle(target.document)
    };
  }

  async function handleExport() {
    const target = await findTargetDocument();
    if (!target) {
      return { ok: false, error: "没有找到钉钉知识库文档正文。" };
    }

    try {
      const title = getDocumentTitle(target.document);
      const htmlDocument = await buildReadableDocument(target.document, title);
      const markdown = htmlToMarkdown(htmlDocument.body.innerHTML, title, target.sourceUrl);

      return {
        ok: true,
        filename: `${safeFilename(title || "dingding-wiki-doc")}.md`,
        markdown
      };
    } catch (error) {
      return { ok: false, error: `导出失败：${error.message}` };
    }
  }

  async function handleBatchDiscover(message) {
    if (!isDingTalkDocsPage()) {
      return { ok: false, error: "当前不是钉钉知识库页面。" };
    }

    const scope = message?.scope || "sidebarAndPage";
    const resolveClicks = Boolean(message?.resolveClicks);
    const items = [];

    if (scope === "sidebar" || scope === "sidebarAndPage") {
      items.push(...await discoverSidebarItems({ resolveClicks }));
    }

    if (scope === "page" || scope === "sidebarAndPage") {
      items.push(...await discoverPageItems({ resolveClicks }));
    }

    const uniqueItems = uniqueBatchItems(items);
    return {
      ok: true,
      items: uniqueItems,
      mode: uniqueItems.some((item) => item.resolvedByClick) ? "click" : "direct"
    };
  }

  async function handleBatchLinks() {
    const target = await findTargetDocument();
    if (!target) {
      return { ok: true, items: [] };
    }

    const article = target.document.querySelector(ARTICLE_SELECTOR);
    return {
      ok: true,
      items: uniqueBatchItems(collectNodeLinks(article, {
        source: "linked",
        requireMainArea: false,
        baseDocument: target.document
      }))
    };
  }

  async function findTargetDocument() {
    if (!isDingTalkDocsPage()) {
      return null;
    }

    if (document.querySelector(ARTICLE_SELECTOR)) {
      return { document, sourceUrl: location.href };
    }

    const iframe = document.querySelector(WIKI_IFRAME_SELECTOR);
    if (!iframe) {
      return null;
    }

    await waitForIframeLoad(iframe);

    try {
      const iframeDocument = iframe.contentDocument;
      if (iframeDocument?.querySelector(ARTICLE_SELECTOR)) {
        return { document: iframeDocument, sourceUrl: location.href };
      }
    } catch (_error) {
      return null;
    }

    return null;
  }

  function isDingTalkDocsPage() {
    if (!["docs.dingtalk.com", "alidocs.dingtalk.com"].includes(location.hostname)) {
      return false;
    }

    return WIKI_NODE_PATH.test(location.pathname)
      || location.pathname === "/note/preview"
      || Boolean(document.querySelector(WIKI_IFRAME_SELECTOR))
      || Boolean(document.querySelector(ARTICLE_SELECTOR));
  }

  function waitForIframeLoad(iframe) {
    if (iframe.contentDocument?.readyState === "complete") {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timeout = window.setTimeout(resolve, 3000);
      iframe.addEventListener("load", () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  }

  async function buildReadableDocument(sourceDocument, title) {
    const article = sourceDocument.querySelector(ARTICLE_SELECTOR);
    if (!article) {
      throw new Error("正文区域不存在");
    }

    const cleanArticle = await cloneCompleteArticle(sourceDocument, article);
    cleanArticle.querySelector("#doc-title-area")?.remove();
    normalizeCodeBlocks(sourceDocument, cleanArticle);
    cleanArticle.querySelectorAll([
      "script",
      "style",
      "svg",
      "[data-annotations-bubbles-wrapper]",
      "[data-cangjie-selection-layer]",
      VIRTUAL_PLACEHOLDER_SELECTOR,
      "[contenteditable='false']",
      "[aria-hidden='true']"
    ].join(",")).forEach((node) => node.remove());

    cleanArticle.querySelectorAll("span").forEach((node) => {
      if (node.textContent === "\uFEFF") {
        node.remove();
      }
    });

    const html = sourceDocument.implementation.createHTMLDocument(title);
    html.body.innerHTML = `<article><h1>${escapeHtml(title)}</h1>${cleanArticle.innerHTML}</article>`;
    html.querySelectorAll("[style], [class], [data-spm-anchor-id], [data-spm-act-id]").forEach((node) => {
      node.removeAttribute("style");
      node.removeAttribute("class");
      node.removeAttribute("data-spm-anchor-id");
      node.removeAttribute("data-spm-act-id");
    });

    return html;
  }

  function normalizeCodeBlocks(sourceDocument, root) {
    root.querySelectorAll(".cm-editor").forEach((editor) => {
      const code = getCodeMirrorText(editor);
      if (!code.trim()) {
        return;
      }

      const pre = sourceDocument.createElement("pre");
      const codeNode = sourceDocument.createElement("code");
      codeNode.textContent = code;
      pre.appendChild(codeNode);

      const block = editor.closest("[data-block-uuid]") || editor;
      block.replaceWith(pre);
    });
  }

  function getCodeMirrorText(editor) {
    const lines = Array.from(editor.querySelectorAll(".cm-content .cm-line"));
    if (lines.length > 0) {
      return lines.map((line) => line.textContent.replace(/\uFEFF/g, "")).join("\n");
    }

    const content = editor.querySelector(".cm-content");
    if (content) {
      return content.textContent.replace(/\uFEFF/g, "");
    }

    return editor.textContent
      .replace(/^\s*(?:\d+\s*)+/g, "")
      .replace(/\uFEFF/g, "");
  }

  async function cloneCompleteArticle(sourceDocument, article) {
    if (!article.querySelector(VIRTUAL_PLACEHOLDER_SELECTOR)) {
      return article.cloneNode(true);
    }

    const scrollTarget = findScrollTarget(sourceDocument, article);
    const initialScrollTop = getScrollTop(scrollTarget);
    const collectedBlocks = new Map();

    const maxScrollTop = getMaxScrollTop(scrollTarget);
    const viewportHeight = getViewportHeight(scrollTarget);
    const step = Math.max(500, Math.floor(viewportHeight * 0.75));

    for (let scrollTop = 0; scrollTop <= maxScrollTop; scrollTop += step) {
      setScrollTop(scrollTarget, scrollTop);
      await waitForRender();
      await collectMountedBlocks(article, collectedBlocks);
    }

    setScrollTop(scrollTarget, maxScrollTop);
    await waitForRender();
    await collectMountedBlocks(article, collectedBlocks);
    setScrollTop(scrollTarget, initialScrollTop);

    if (collectedBlocks.size === 0) {
      return article.cloneNode(true);
    }

    const mergedArticle = article.cloneNode(false);
    const titleArea = article.querySelector("#doc-title-area");
    if (titleArea) {
      mergedArticle.appendChild(titleArea.cloneNode(true));
    }

    const content = sourceDocument.createElement("div");
    collectedBlocks.forEach((block) => content.appendChild(block));
    mergedArticle.appendChild(content);

    return mergedArticle;
  }

  async function collectMountedBlocks(article, collectedBlocks) {
    getTopLevelContentBlocks(article).forEach((block) => {
      const key = block.getAttribute("data-block-uuid");
      if (!key || collectedBlocks.has(key) || block.closest("#doc-title-area")) {
        return;
      }
      collectedBlocks.set(key, block.cloneNode(true));
    });
  }

  function getTopLevelContentBlocks(article) {
    return Array.from(article.querySelectorAll("[data-block-uuid]")).filter((block) => {
      const parentBlock = block.parentElement?.closest("[data-block-uuid]");
      return !parentBlock || !article.contains(parentBlock);
    });
  }

  function findScrollTarget(sourceDocument, article) {
    const scrollingElement = sourceDocument.scrollingElement || sourceDocument.documentElement;
    const candidates = [
      scrollingElement,
      sourceDocument.body,
      ...Array.from(sourceDocument.querySelectorAll("*"))
    ].filter((node) => {
      return node
        && node.contains(article)
        && node.scrollHeight > node.clientHeight + 100;
    });

    return candidates.sort((a, b) => {
      return getScrollRange(b) - getScrollRange(a);
    })[0] || scrollingElement;
  }

  function getScrollRange(node) {
    return Math.max(0, node.scrollHeight - node.clientHeight);
  }

  function getMaxScrollTop(scrollTarget) {
    return getScrollRange(scrollTarget);
  }

  function getViewportHeight(scrollTarget) {
    return scrollTarget.clientHeight
      || scrollTarget.ownerDocument?.defaultView?.innerHeight
      || 800;
  }

  function getScrollTop(scrollTarget) {
    if (scrollTarget === scrollTarget.ownerDocument?.scrollingElement) {
      return scrollTarget.ownerDocument.defaultView.scrollY;
    }
    return scrollTarget.scrollTop;
  }

  function setScrollTop(scrollTarget, scrollTop) {
    if (scrollTarget === scrollTarget.ownerDocument?.scrollingElement) {
      scrollTarget.ownerDocument.defaultView.scrollTo(0, scrollTop);
      return;
    }
    scrollTarget.scrollTop = scrollTop;
  }

  function waitForRender() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => window.setTimeout(resolve, 120));
    });
  }

  function htmlToMarkdown(html, title, sourceUrl) {
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-"
    });
    turndown.use(turndownPluginGfm.gfm);
    addDingTalkTableRule(turndown);

    turndown.addRule("dingTalkBlank", {
      filter: (node) => node.nodeType === Node.ELEMENT_NODE
        && ["P", "DIV"].includes(node.nodeName)
        && node.textContent.trim() === "",
      replacement: () => ""
    });

    const body = convertDingTalkListMarkers(removeDuplicateTitle(turndown.turndown(html), title))
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return [
      `# ${title || "钉钉知识库文档"}`,
      "",
      body,
      "",
      `> Source: ${sourceUrl}`,
      ""
    ].join("\n").replace(/\n{3,}/g, "\n\n");
  }

  function addDingTalkTableRule(turndown) {
    turndown.addRule("dingTalkTable", {
      filter: (node) => node.nodeName === "TABLE" && node.rows.length > 0,
      replacement: (_content, table) => {
        const rows = Array.from(table.rows).map((row) => {
          return Array.from(row.cells).flatMap((cell) => {
            const colspan = Number(cell.getAttribute("colspan") || 1);
            return [tableCellText(cell), ...Array(Math.max(colspan - 1, 0)).fill("")];
          });
        });
        const columnCount = Math.max(...rows.map((row) => row.length));
        const normalizedRows = rows.map((row) => {
          return [...row, ...Array(columnCount - row.length).fill("")];
        });
        const [header, ...body] = normalizedRows;

        return [
          "",
          markdownTableRow(header),
          markdownTableRow(Array(columnCount).fill("---")),
          ...body.map(markdownTableRow),
          ""
        ].join("\n");
      }
    });
  }

  function tableCellText(cell) {
    return cell.textContent
      .replace(/\uFEFF/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function markdownTableRow(cells) {
    return `| ${cells.map(escapeMarkdownTableCell).join(" | ")} |`;
  }

  function escapeMarkdownTableCell(value) {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, "<br>");
  }

  function convertDingTalkListMarkers(markdown) {
    const lines = markdown.split("\n");
    const result = [];
    const markerIndentMap = new Map([
      ["●", ""],
      ["○", "  "],
      ["■", "    "]
    ]);

    for (let index = 0; index < lines.length; index += 1) {
      const marker = lines[index].trim();
      if (!markerIndentMap.has(marker)) {
        result.push(lines[index]);
        continue;
      }

      let textIndex = index + 1;
      while (textIndex < lines.length && lines[textIndex].trim() === "") {
        textIndex += 1;
      }

      if (textIndex >= lines.length) {
        result.push(lines[index]);
        continue;
      }

      result.push(`${markerIndentMap.get(marker)}- ${lines[textIndex].trim()}`);

      let nextMarkerIndex = textIndex + 1;
      while (nextMarkerIndex < lines.length && lines[nextMarkerIndex].trim() === "") {
        nextMarkerIndex += 1;
      }

      if (markerIndentMap.has(lines[nextMarkerIndex]?.trim())) {
        index = nextMarkerIndex - 1;
      } else {
        index = textIndex;
      }
    }

    return result.join("\n");
  }

  async function discoverSidebarItems(options = {}) {
    let root = findSidebarRoot(document);
    if (!root) {
      return [];
    }

    const initialScrollTop = root.scrollTop;
    const seen = new Map();
    const probed = new Set();
    const stack = [];
    const originalUrl = location.href;
    const originalTitle = getVisiblePageTitle();

    root.scrollTop = 0;
    await sleep(120);

    for (let pass = 0; pass < 120; pass += 1) {
      root = findSidebarRoot(document) || root;
      const expanders = Array.from(root.querySelectorAll("[aria-expanded='false']"))
        .filter(isVisible)
        .slice(0, 40);

      for (const expander of expanders) {
        expander.click();
        await sleep(60);
      }

      const visibleItems = collectSidebarCandidates(root)
        .sort((a, b) => a.rect.top - b.rect.top);

      for (const item of visibleItems) {
        stack[item.level] = item.title;
        stack.length = item.level + 1;

        let url = item.url;
        let resolvedByClick = false;
        const probeKey = stack.join(" / ");

        if (!url && options.resolveClicks && !probed.has(probeKey)) {
          probed.add(probeKey);
          url = await resolveCandidateUrl(item, originalUrl, originalTitle, root.scrollTop);
          resolvedByClick = Boolean(url);
        }

        const key = nodeUrlKey(url);
        if (!key || seen.has(key)) {
          continue;
        }
        seen.set(key, {
          url,
          title: item.title,
          pathParts: stack.slice(),
          source: "sidebar",
          resolvedByClick
        });
      }

      root = findSidebarRoot(document) || root;
      const previousScrollTop = root.scrollTop;
      if (root.scrollHeight > root.clientHeight) {
        root.scrollTop = Math.min(
          root.scrollTop + Math.max(160, Math.floor(root.clientHeight * 0.45)),
          root.scrollHeight
        );
      }
      await sleep(160);

      if (expanders.length === 0 && root.scrollTop === previousScrollTop) {
        break;
      }
    }

    root = findSidebarRoot(document) || root;
    root.scrollTop = initialScrollTop;
    return Array.from(seen.values());
  }

  async function discoverPageItems(options = {}) {
    let root = findMainRoot(document);
    if (!root) {
      return [];
    }

    const scrollTarget = findScrollTarget(document, root);
    const initialScrollTop = getScrollTop(scrollTarget);
    const seen = new Map();
    const probed = new Set();
    const originalUrl = location.href;
    const originalTitle = getVisiblePageTitle();
    const maxScrollTop = getMaxScrollTop(scrollTarget);
    const step = Math.max(160, Math.floor(getViewportHeight(scrollTarget) * 0.45));

    for (let scrollTop = 0; scrollTop <= maxScrollTop; scrollTop += step) {
      setScrollTop(scrollTarget, scrollTop);
      await waitForRender();
      root = findMainRoot(document) || root;
      await collectPageItemsAtCurrentScroll(root, {
        seen,
        probed,
        resolveClicks: options.resolveClicks,
        originalUrl,
        originalTitle,
        scrollTop
      });
    }

    setScrollTop(scrollTarget, maxScrollTop);
    await waitForRender();
    root = findMainRoot(document) || root;
    await collectPageItemsAtCurrentScroll(root, {
      seen,
      probed,
      resolveClicks: options.resolveClicks,
      originalUrl,
      originalTitle,
      scrollTop: maxScrollTop
    });

    setScrollTop(scrollTarget, initialScrollTop);
    return Array.from(seen.values());
  }

  function collectSidebarCandidates(root) {
    const rootRect = root.getBoundingClientRect();
    const selectors = [
      "[role='treeitem']",
      "li",
      "[data-node-id]",
      "[data-node-uuid]",
      "[data-id]",
      "[data-url]",
      "[data-href]",
      "[class*='tree']",
      "[class*='catalog']",
      "[class*='item']",
      "[class*='node']",
      "[class*='file']"
    ];
    const seen = new Set();

    return Array.from(root.querySelectorAll(selectors.join(","))).flatMap((node) => {
      if (!isVisible(node)) {
        return [];
      }

      const rect = node.getBoundingClientRect();
      if (!rectIntersects(rect, rootRect)) {
        return [];
      }
      if (rect.left > 430 || rect.width < 70 || rect.height < 16 || rect.height > 86) {
        return [];
      }

      const title = getItemTitle(node);
      if (!title || shouldSkipBatchTitle(title)) {
        return [];
      }

      const level = getSidebarLevel(node, rootRect);
      const key = `${level}:${Math.round(rect.top)}:${title}`;
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);

      return [{
        node,
        title,
        source: "sidebar",
        level,
        url: extractNodeUrl(node, document),
        rect,
        x: Math.round(rect.left + Math.min(Math.max(rect.width * 0.25, 24), 140)),
        y: Math.round(rect.top + rect.height / 2)
      }];
    });
  }

  async function collectPageItemsAtCurrentScroll(root, context) {
    const directItems = [
      ...collectNodeLinks(root, {
        source: "page",
        requireMainArea: true,
        baseDocument: document
      }),
      ...collectNodeRows(root, document)
    ];

    directItems.forEach((item) => {
      addDiscoveredItem(context.seen, {
        url: item.url,
        title: item.title,
        pathParts: [item.title].filter(Boolean),
        source: "page",
        resolvedByClick: false
      });
    });

    if (!context.resolveClicks) {
      return;
    }

    const candidates = collectClickCandidates(root, "page");
    for (const candidate of candidates) {
      const directUrl = candidate.url;
      if (directUrl) {
        addDiscoveredItem(context.seen, {
          url: directUrl,
          title: candidate.title,
          pathParts: candidate.pathParts,
          source: "page",
          resolvedByClick: false
        });
        continue;
      }

      const probeKey = candidate.pathParts.join(" / ");
      if (context.probed.has(probeKey)) {
        continue;
      }
      context.probed.add(probeKey);

      const url = await resolveCandidateUrl(candidate, context.originalUrl, context.originalTitle, context.scrollTop);
      addDiscoveredItem(context.seen, {
        url,
        title: candidate.title,
        pathParts: candidate.pathParts,
        source: "page",
        resolvedByClick: Boolean(url)
      });
    }
  }

  function addDiscoveredItem(seen, item) {
    const key = nodeUrlKey(item.url);
    if (!key || seen.has(key)) {
      return false;
    }

    seen.set(key, item);
    return true;
  }

  async function resolveCandidateUrl(candidate, originalUrl, originalTitle, scrollTop) {
    const beforeUrl = location.href;
    const clicked = clickCandidateAtPoint(candidate);
    if (!clicked) {
      return null;
    }

    const changed = await waitForUrlChange(beforeUrl, 3500);
    const resolvedUrl = normalizeNodeUrl(location.href, originalUrl);
    if (changed) {
      await restoreOriginalLocation(originalUrl, originalTitle);
      restoreScanScroll(candidate.source, scrollTop);
      await sleep(250);
    }

    if (changed && resolvedUrl && nodeUrlKey(resolvedUrl) !== nodeUrlKey(originalUrl)) {
      return resolvedUrl;
    }

    return null;
  }

  function restoreScanScroll(source, scrollTop) {
    const root = source === "sidebar" ? findSidebarRoot(document) : findMainRoot(document);
    if (!root) {
      return;
    }

    const scrollTarget = source === "sidebar" ? root : findScrollTarget(document, root);
    setScrollTop(scrollTarget, scrollTop);
  }

  async function discoverClickNavigationItems(scope) {
    const originalUrl = location.href;
    const originalTitle = getVisiblePageTitle();
    const items = [];

    const candidates = [
      ...((scope === "sidebar" || scope === "sidebarAndPage") ? collectClickCandidates(findSidebarRoot(document), "sidebar") : []),
      ...((scope === "page" || scope === "sidebarAndPage") ? collectClickCandidates(findMainRoot(document), "page") : [])
    ].slice(0, 80);

    for (const candidate of candidates) {
      const beforeUrl = location.href;
      const clicked = clickCandidateAtPoint(candidate);
      if (!clicked) {
        continue;
      }

      const changed = await waitForUrlChange(beforeUrl, 3500);
      const resolvedUrl = normalizeNodeUrl(location.href, originalUrl);
      if (changed && resolvedUrl && nodeUrlKey(resolvedUrl) !== nodeUrlKey(originalUrl)) {
        items.push({
          url: resolvedUrl,
          title: candidate.title,
          pathParts: candidate.pathParts,
          source: candidate.source
        });
        await restoreOriginalLocation(originalUrl, originalTitle);
      }

      await sleep(180);
    }

    return items;
  }

  function collectClickCandidates(root, source) {
    if (!root) {
      return [];
    }

    const selectors = source === "sidebar"
      ? [
        "[role='treeitem']",
        "li",
        "[class*='tree']",
        "[class*='catalog']",
        "[class*='item']",
        "[class*='node']",
        "[class*='file']"
      ]
      : [
        "[role='row']",
        "tr",
        "[class*='row']",
        "[class*='item']",
        "[class*='file']",
        "[data-node-id]",
        "[data-id]"
      ];

    const rootRect = root.getBoundingClientRect();
    const seen = new Set();
    const stack = [];

    return Array.from(root.querySelectorAll(selectors.join(","))).flatMap((node) => {
      if (!isVisible(node)) {
        return [];
      }

      const rect = node.getBoundingClientRect();
      if (!rectIntersects(rect, rootRect)) {
        return [];
      }
      if (source === "sidebar") {
        if (rect.left > 430 || rect.width < 80 || rect.height < 18 || rect.height > 72) {
          return [];
        }
      } else if (rect.left < 240 || rect.top < 90 || rect.width < 160 || rect.height < 22 || rect.height > 120) {
        return [];
      }

      const title = getItemTitle(node);
      if (!title || shouldSkipBatchTitle(title)) {
        return [];
      }

      const key = `${source}:${Math.round(rect.left)}:${Math.round(rect.top)}:${title}`;
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);

      const level = source === "sidebar" ? getSidebarLevel(node, rootRect) : 0;

      if (source === "sidebar") {
        stack[level] = title;
        stack.length = level + 1;
      }

      return [{
        node,
        title,
        source,
        pathParts: source === "sidebar" ? stack.slice() : [title],
        url: extractNodeUrl(node, document),
        rect,
        x: Math.round(rect.left + Math.min(Math.max(rect.width * 0.25, 24), 140)),
        y: Math.round(rect.top + rect.height / 2)
      }];
    });
  }

  function getSidebarLevel(node, rootRect) {
    const rect = node.getBoundingClientRect();
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const marginLeft = Number.parseFloat(style.marginLeft) || 0;
    const indent = rect.left - rootRect.left + paddingLeft + marginLeft;
    return Math.max(0, Math.round((indent - 12) / 18));
  }

  function rectIntersects(rect, containerRect) {
    return rect.bottom > containerRect.top
      && rect.top < containerRect.bottom
      && rect.right > containerRect.left
      && rect.left < containerRect.right;
  }

  function clickCandidateAtPoint(candidate) {
    const node = candidate.node && isVisible(candidate.node)
      ? candidate.node
      : document.elementFromPoint(candidate.x, candidate.y);
    const clickable = node?.closest?.("a, button, [role='treeitem'], [role='row'], li, tr, [class*='item'], [class*='row'], [class*='file']")
      || node;
    if (!clickable) {
      return false;
    }

    clickable.dispatchEvent(new MouseEvent("mouseover", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: candidate.x,
      clientY: candidate.y
    }));
    clickable.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: candidate.x,
      clientY: candidate.y
    }));
    clickable.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: candidate.x,
      clientY: candidate.y
    }));
    clickable.click?.();
    return true;
  }

  function waitForUrlChange(previousUrl, timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = window.setInterval(() => {
        if (location.href !== previousUrl) {
          window.clearInterval(timer);
          resolve(true);
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          window.clearInterval(timer);
          resolve(false);
        }
      }, 120);
    });
  }

  async function restoreOriginalLocation(originalUrl, originalTitle) {
    if (location.href === originalUrl) {
      return;
    }

    history.back();
    const restored = await waitForUrlChange(location.href, 2500);
    if (!restored || location.href !== originalUrl) {
      location.href = originalUrl;
    }

    await waitForRender();
    await sleep(originalTitle ? 300 : 600);
  }

  function waitForPageTitle(title, timeoutMs) {
    if (!title) {
      return sleep(800);
    }

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = window.setInterval(() => {
        if (getVisiblePageTitle() === title || Date.now() - startedAt > timeoutMs) {
          window.clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  }

  function getVisiblePageTitle() {
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
      const text = cleanBatchText(node?.textContent);
      if (text && !shouldSkipBatchTitle(text)) {
        return text;
      }
    }

    return cleanBatchText(document.title);
  }

  function collectNodeLinks(root, options) {
    const baseDocument = options?.baseDocument || document;
    const nodes = Array.from(root.querySelectorAll("a, [href], [data-url], [data-href], [data-node-id], [data-node-uuid], [data-id]"));
    const items = [];

    nodes.forEach((node) => {
      if (!isVisible(node)) {
        return;
      }

      const rect = node.getBoundingClientRect();
      if (options?.requireMainArea && (rect.left < 240 || rect.top < 90)) {
        return;
      }

      const url = extractNodeUrl(node, baseDocument);
      if (!url) {
        return;
      }

      const row = closestItemRow(node, root);
      const title = getItemTitle(row || node);
      if (!title || shouldSkipBatchTitle(title)) {
        return;
      }

      items.push({
        url,
        title,
        source: options?.source || "page",
        rect: row ? row.getBoundingClientRect() : rect
      });
    });

    return items;
  }

  function collectNodeRows(root, baseDocument) {
    const selectors = [
      "[role='row']",
      "tr",
      "[data-node-id]",
      "[data-node-uuid]",
      "[data-id]",
      "[data-url]",
      "[data-href]",
      "[class*='row']",
      "[class*='item']",
      "[class*='file']"
    ];

    return Array.from(root.querySelectorAll(selectors.join(","))).flatMap((row) => {
      if (!isVisible(row)) {
        return [];
      }

      const rect = row.getBoundingClientRect();
      if (rect.left < 240 || rect.top < 90 || rect.height < 22 || rect.height > 120 || rect.width < 160) {
        return [];
      }

      const url = extractNodeUrl(row, baseDocument);
      if (!url) {
        return [];
      }

      const title = getItemTitle(row);
      if (!title || shouldSkipBatchTitle(title)) {
        return [];
      }

      return [{
        url,
        title,
        pathParts: [title],
        source: "page",
        rect
      }];
    });
  }

  function extractNodeUrl(node, baseDocument) {
    const baseLocation = baseDocument.defaultView?.location || location;
    const rawCandidates = [
      node.href,
      node.getAttribute?.("href"),
      node.getAttribute?.("data-url"),
      node.getAttribute?.("data-href")
    ].filter(Boolean);

    for (const raw of rawCandidates) {
      const url = normalizeNodeUrl(raw, baseLocation.href);
      if (url) {
        return url;
      }
    }

    if (node.attributes) {
      for (const attribute of Array.from(node.attributes)) {
        const value = attribute.value || "";
        const urlMatch = value.match(/https?:\/\/(?:docs|alidocs)\.dingtalk\.com\/i\/nodes\/[^"' <>)]+|\/i\/nodes\/[^"' <>)]+/);
        if (urlMatch) {
          const url = normalizeNodeUrl(urlMatch[0], baseLocation.href);
          if (url) {
            return url;
          }
        }
      }
    }

    const idAttributes = [
      "data-node-id",
      "data-node-uuid",
      "data-id",
      "data-resource-id",
      "data-file-id",
      "data-entry-id"
    ];

    for (const name of idAttributes) {
      const value = node.getAttribute?.(name);
      if (looksLikeNodeId(value)) {
        return `${baseLocation.origin}/i/nodes/${value}`;
      }
    }

    return null;
  }

  function normalizeNodeUrl(raw, baseUrl) {
    try {
      const url = new URL(raw, baseUrl);
      if (!["docs.dingtalk.com", "alidocs.dingtalk.com"].includes(url.hostname)) {
        return null;
      }
      if (!WIKI_NODE_PATH.test(url.pathname)) {
        return null;
      }
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  function looksLikeNodeId(value) {
    return typeof value === "string"
      && /^[A-Za-z0-9_-]{8,}$/.test(value)
      && !/^mpwd/i.test(value);
  }

  function closestItemRow(node, root) {
    const row = node.closest?.("[role='treeitem'], [role='row'], li, tr, [class*='tree'], [class*='item'], [class*='row'], [class*='file']");
    return row && root.contains(row) ? row : node;
  }

  function getItemTitle(node) {
    const titleAttr = cleanBatchText(node.getAttribute?.("title") || node.getAttribute?.("aria-label"));
    if (titleAttr && !shouldSkipBatchTitle(titleAttr)) {
      return titleAttr;
    }

    const textCandidates = Array.from(node.querySelectorAll?.("a, span, div, p") || [])
      .map((child) => cleanBatchText(child.getAttribute("title") || child.textContent))
      .filter(Boolean)
      .filter((text) => text.length <= 180)
      .filter((text) => !shouldSkipBatchTitle(text));

    if (textCandidates.length > 0) {
      return textCandidates.sort((a, b) => b.length - a.length)[0];
    }

    const text = cleanBatchText(node.textContent);
    if (!text || shouldSkipBatchTitle(text)) {
      return "";
    }
    return text.slice(0, 160);
  }

  function shouldSkipBatchTitle(text) {
    return /^(File name|Creator|Update time|Last edited|New|Upload|Share|Home|Catalog|Wiki)$/i.test(text)
      || /^\d+\s+document\(s\)/i.test(text)
      || text.length < 2;
  }

  function findSidebarRoot(baseDocument) {
    const candidates = Array.from(baseDocument.querySelectorAll([
      "aside",
      "nav",
      "[role='tree']",
      "[class*='sidebar']",
      "[class*='sider']",
      "[class*='catalog']",
      "[class*='tree']"
    ].join(","))).filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left < 380 && rect.width >= 120 && rect.height >= 180;
    });

    return candidates.sort((a, b) => {
      return b.getBoundingClientRect().height - a.getBoundingClientRect().height;
    })[0] || Array.from(baseDocument.body.children).find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left < 340
        && rect.width >= 180
        && rect.width <= 460
        && rect.height > baseDocument.defaultView.innerHeight * 0.45;
    });
  }

  function findMainRoot(baseDocument) {
    const candidates = Array.from(baseDocument.querySelectorAll("main, [role='main'], section, article, body > div"))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left > 180 && rect.width > baseDocument.defaultView.innerWidth * 0.45 && rect.height > 180;
      });

    return candidates.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return (bRect.width * bRect.height) - (aRect.width * aRect.height);
    })[0] || baseDocument.body;
  }

  function uniqueBatchItems(items) {
    const seen = new Set();
    const result = [];

    items.forEach((item) => {
      const key = nodeUrlKey(item.url);
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      result.push({
        url: item.url,
        title: cleanBatchText(item.title) || "未命名文档",
        pathParts: Array.isArray(item.pathParts) ? item.pathParts.map(cleanBatchText).filter(Boolean) : [],
        source: item.source || "page",
        resolvedByClick: Boolean(item.resolvedByClick)
      });
    });

    return result;
  }

  function nodeUrlKey(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/^\/i\/nodes\/([^/?#]+)/);
      return match ? `${url.hostname}/i/nodes/${match[1]}` : "";
    } catch (_error) {
      return "";
    }
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    const style = node.ownerDocument.defaultView.getComputedStyle(node);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== "hidden"
      && style.display !== "none";
  }

  function cleanBatchText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function getDocumentTitle(targetDocument) {
    const titleNode = targetDocument.querySelector("#doc-title-name")
      || targetDocument.querySelector("#doc-title")
      || targetDocument.querySelector("h1");
    const title = titleNode?.textContent?.trim() || targetDocument.title.trim();
    return title || "钉钉知识库文档";
  }

  function removeDuplicateTitle(markdown, title) {
    const lines = markdown.split("\n");
    const firstContentLine = lines.findIndex((line) => line.trim() !== "");
    if (firstContentLine === -1) {
      return "";
    }

    if (lines[firstContentLine].trim() === `# ${title}`) {
      lines.splice(firstContentLine, 1);
    }

    return lines.join("\n");
  }

  function safeFilename(value) {
    return value
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
