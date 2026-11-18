# chat-demo

[English](README.md) | 简体中文

多服务商的静态聊天示例。无需应用后端，浏览器直接请求你配置的 API 服务，可在 OpenAI 兼容与 Anthropic 兼容接口之间自由切换。

点击 [在线体验](https://deepseek-ai.github.io/chat-demo/) 即可使用，也可以前往 [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases) 下载压缩包，解压后双击 `index.html` 在本地使用，无需安装或构建。首次使用时，请在设置中添加服务商并填写 API Key。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 功能

- 多服务商、多模型：每个服务商可挂多个模型，输入框里按「服务商 → 模型」两级切换，模型列表支持模糊搜索。
- 提示词预设：输入框底部一键切换，选中项作为系统提示词随请求发送。
- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 图片、文本附件随消息内联发送，跨服务商通用；大段粘贴自动转占位卡片，可还原、可预览。
- 每条回答显示 token 用量与吐字速度，会话标题栏显示当前分支的累计用量。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 服务商与模型

打开「设置 → 服务商」，内置一批常见服务商的预设，也可以自定义：

| 字段     | 说明                                                         |
| -------- | ------------------------------------------------------------ |
| 协议     | `OpenAI Chat Completions` 或 `Anthropic Messages`，决定请求格式与鉴权头 |
| 接口地址 | 填到 `/v1` 为止，例如 `https://api.openai.com/v1`            |
| API Key  | 只保存在本机浏览器；本地推理服务（localhost）可留空           |
| 模型列表 | 手动添加，或用「拉取模型」调用 `GET /models` 一次性导入       |

模型能力（图像、思考、联网）默认按模型名推断，也可以在编辑弹窗里覆盖；推断不准时以覆盖值为准。服务商级的能力位对应各家专有扩展，**普通 OpenAI 兼容服务请全部保持关闭**，否则这些字段会被原样下发并触发 400：

- 服务端联网搜索 / 服务端生成标题 / 服务端时间提醒 / 安全审核参数：DeepSeek 的专有扩展。
- 文件接口上传：附件改走 `POST /files` + `file_id`（目前只有 DeepSeek 的预设打开）。关闭时附件内联发送。
- 语音合成与识别：`/v1/tools/asr`、`/v1/tools/tts`，关闭后输入框与回答里的语音入口不再显示。

## 附件

- 图片读成 base64 随消息内联（OpenAI 用 `image_url` 的 data URL，Anthropic 用 `source.type: base64`），上限 8MB，支持 PNG / JPG / GIF / WebP。
- 文本类文件（`.txt`、`.md`、`.csv`、代码等）读成文本拼进消息，**不做任何截断**：卡片上会给出 token 估算，发多少由你按当前会话的用量自己决定。
- PDF、Word、PPT、Excel 等二进制文档无法内联，只有打开「文件接口上传」的服务商可以发送，其余会被拦下并提示原因。

## 提示词与用量

- 输入框底部的「提示词」在 7 个内置预设与自定义项之间切换，选中的内容作为系统提示词随每次请求发送；「设置 › 提示词」可新建、编辑、删除自定义提示词，内置项虽然只读，但可以「复制一份」再改。优先级为「预设 → 自定义系统提示词（设置 › 通用）→ 按服务商名称自动生成」。
- 粘贴超过约 1200 tokens 的文本时自动转成文本附件，卡片显示 token 估算，可「粘贴原文至输入框」还原成普通内容继续编辑。
- 发送后的超大内容同样以占位卡片呈现，可「展开原文」就地查看，或点开卡片在弹窗里预览全文。
- 每条回答下方显示输入 / 输出 / 缓存 / 思考 token 与平均吐字速度，悬停可看完整明细；会话标题右侧显示当前分支的累计用量。数值全部取自服务商返回的 `usage`，没有返回就不显示，不做估算。

## 数据

服务商配置（含 API Key）和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。API Key 为明文存储，公共设备上请谨慎使用。发送对话、上传附件和使用语音功能时，相应内容会提交给当前服务商。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 不再注入固定的 API 地址，所有服务商配置都在运行时由设置决定。

请求链路只替换「请求构造 + 流解析」两层：`services/api/dispatch.ts` 按 `provider.protocol` 分派到 `protocols/anthropic.ts` 或 `protocols/openai.ts`，两者都产出同一套内部事件 `MessageStreamEvent`，因此会话、分支、渲染、导入导出无需感知协议差异。新增协议（如 Gemini 原生）只需再写一个适配器。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE、协议适配（anthropic / openai）与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    providers/         服务商与模型配置、内置预设、能力推断
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 已知限制

- 纯静态直连各家 API，**是否可用取决于对方是否允许浏览器跨域**。OpenAI 官方等会拦截浏览器直连；被拦时需要在 Cloudflare Pages Functions 之类的边缘层补一层代理，而不是加回应用后端。
- DeepSeek 有两条预设：`DeepSeek（Anthropic 兼容）` 保留仓库原有行为（`/anthropic/v1` + 文件接口），`DeepSeek（OpenAI 兼容）` 走官方 `deepseek-chat` / `deepseek-reasoner`。老用户升级后行为不变。
- 联网搜索不自建，只在服务商声明了对应能力时开放。
- 语音能力目前只有 DeepSeek 提供。

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
