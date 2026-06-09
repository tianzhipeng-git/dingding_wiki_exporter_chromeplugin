# DingTalk Wiki Markdown Exporter

钉钉知识库文档 Markdown 导出 Chrome 扩展。

## 功能说明

该扩展用于把钉钉知识库文档导出为 `.md` 文件，当前支持如下形式的钉钉知识库页面：

```text
https://docs.dingtalk.com/i/nodes/...
https://alidocs.dingtalk.com/i/nodes/...
```

扩展会在当前页面中查找钉钉知识库正文区域，清理编辑器相关的页面元素，并使用 Turndown 将 HTML 内容转换为 Markdown。导出的文件名会优先使用文档标题。

## 本地安装

1. 打开 Chrome 浏览器，进入 `chrome://extensions`。
2. 打开右上角的「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本项目目录。
5. 安装完成后，浏览器工具栏会出现扩展入口。

更新本地代码后，需要在 `chrome://extensions` 找到该扩展并点击「重新加载」，否则 Chrome 会继续运行旧版本脚本。

## 使用方法

### 单篇导出

1. 在 Chrome 中打开要导出的钉钉知识库文档。
2. 确认页面已经登录，并且文档内容已经完整加载。
3. 点击浏览器工具栏中的扩展图标。
4. 如果扩展识别到文档，会显示文档标题，并启用「导出 Markdown」按钮。
5. 点击「导出 Markdown」。
6. 在浏览器弹出的下载窗口中选择保存位置。

### 插件内批量选择导出

1. 在 Chrome 中打开知识库目录页或任意知识库文档页。
2. 点击浏览器工具栏中的扩展图标。
3. 点击「批量选择导出」。
4. 扩展会打开一个批量导出管理页，并扫描左侧目录和当前目录中的文档条目。
5. 勾选要导出的目录或文档。
6. 设置下载根目录、最多导出篇数，以及是否包含正文里链接到的子文档。
7. 点击「开始导出」。

批量导出会创建一个后台标签页逐篇打开文档，并把 Markdown 下载到 Chrome 默认下载目录下的子文件夹中。例如下载根目录为 `dingding-wiki-export` 时，文件会保存到：

```text
Downloads/dingding-wiki-export/...
```

如果 Chrome 设置里开启了「下载前询问每个文件的保存位置」，批量导出时会逐个弹出保存窗口；建议批量导出前临时关闭这个选项。

## 批量导出

项目内也提供了一个 Playwright 批量导出工具，可以从一个知识库目录或文档 URL 开始，递归收集子目录/子文档，逐篇导出 Markdown，并按目录路径保存。这个方式适合需要断点续跑、命令行日志或自定义输出目录的场景。

首次使用先安装依赖：

```bash
npm install
```

然后运行：

```bash
npm run batch -- --url "https://alidocs.dingtalk.com/i/nodes/你的节点ID" --out ./exports/wiki
```

运行后会打开一个真实 Chrome 窗口。如果页面要求登录，请先在打开的窗口里完成登录，并确认已经进入要导出的知识库目录，再回到终端按 Enter 开始。

常用参数：

```bash
# 最多导出 20 篇，适合先小范围试跑
npm run batch -- --url "https://alidocs.dingtalk.com/i/nodes/你的节点ID" --out ./exports/test --max 20

# 不抓正文里链接到的其它钉钉文档
npm run batch -- --url "https://alidocs.dingtalk.com/i/nodes/你的节点ID" --no-linked

# 不从左侧目录树预收集链接，只从当前目录页面往下递归
npm run batch -- --url "https://alidocs.dingtalk.com/i/nodes/你的节点ID" --no-sidebar
```

输出目录中会包含：

- `_index.md`：本次导出的索引。
- `export-log.json`：成功、失败、跳过记录。
- 各级目录下的 `.md` 文件。

## 注意事项

- 当前仅支持 `docs.dingtalk.com` 和 `alidocs.dingtalk.com` 下的知识库文档页面，不保证支持所有钉钉文档类型。
- 如果弹窗提示「扩展脚本尚未注入当前页面」，请刷新当前钉钉页面后重试。
- 如果弹窗提示没有找到正文，请确认当前页面是知识库文档页面，并等待文档加载完成后再试。
- 如果批量导出日志出现「没有找到钉钉知识库文档正文」，请先在 `chrome://extensions` 重新加载扩展；新版会在顶层页面和正文 iframe 中选择可导出的响应。
- 导出过程中扩展会读取当前页面已经渲染出来的文档内容，因此请先确认页面中能正常看到正文。
- 导出的 Markdown 末尾会包含原始文档地址，方便回溯来源。
- 批量导出只会读取当前账号已经有权限访问的页面；建议先用 `--max 20` 小范围试跑，确认目录结构和格式符合预期后再全量导出。

## 项目文件

- `manifest.json`：Chrome 扩展配置。
- `contentScript.js`：识别钉钉文档正文并转换 Markdown。
- `popup/`：扩展弹窗页面和交互逻辑。
- `batch/`：插件内批量选择导出管理页。
- `vendor/`：Markdown 转换依赖。
- `tools/batch-export.js`：批量导出脚本。
