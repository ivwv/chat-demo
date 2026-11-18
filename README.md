# chat-demo

English | [简体中文](README.zh-CN.md)

A static chat demo with bring-your-own providers. No application backend is required: the browser connects directly to the API service you configure, and you can switch freely between OpenAI-compatible and Anthropic-compatible endpoints.

You can [try the app online](https://deepseek-ai.github.io/chat-demo/) or download the archive from [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases), extract it, and double-click `index.html` to use it locally without installation or a build. Add a provider and API key in Settings before your first chat.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Features

- Multiple providers and models: each provider holds any number of models, switched with a two-level picker in the composer and searchable by fuzzy match.
- Prompt presets: switch them next to the search toggle; the selected preset is sent as the system prompt.
- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Images and text files are sent inline with the message, so they work across providers; large pastes collapse into a placeholder card that can be restored or previewed.
- Every reply reports token usage and throughput, and the header shows the running total for the current branch.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Providers and models

Open Settings → Providers. Presets for common services are built in, and anything else can be configured by hand:

| Field      | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| Protocol   | `OpenAI Chat Completions` or `Anthropic Messages`; decides body format and auth |
| Base URL   | Up to `/v1`, e.g. `https://api.openai.com/v1`                                  |
| API key    | Stored in this browser only; local inference servers (localhost) may leave it empty |
| Models     | Add manually, or pull them from `GET /models` in one click                      |

Model capabilities (vision, thinking, search) are inferred from the model name and can be overridden per model. Provider-level feature flags map to vendor-specific extensions — **leave every flag off for plain OpenAI-compatible services**, otherwise those fields are sent as-is and the request fails with 400:

- Server-side web search / server-generated titles / server time reminder / safety check: DeepSeek extensions.
- File API upload: attachments go through `POST /files` and `file_id` (enabled on the DeepSeek preset today). When off, attachments are sent inline.
- Speech synthesis and recognition: `/v1/tools/asr` and `/v1/tools/tts`; when off, the voice entry points disappear.

## Attachments

- Images are inlined as base64 (OpenAI `image_url` data URL, Anthropic `source.type: base64`), up to 8 MB, PNG / JPG / GIF / WebP.
- Text-like files (`.txt`, `.md`, `.csv`, code…) are read as text and folded into the message; anything over 200k characters is truncated.
- PDF, Word, PowerPoint and Excel cannot be inlined. Only providers with file API upload enabled accept them; others reject the file with a clear reason.

## Prompts and usage

- The prompt picker next to the search toggle switches between 7 built-in presets; the selection is sent as the system prompt. Resolution order: preset → custom system prompt (Settings › General) → generated from the provider name.
- Pasting text over roughly 1200 tokens turns it into a text attachment with a token estimate; "Paste text into the box" restores it as editable content.
- Large content already sent stays collapsible too: "Show full text" expands it in place, or click the card to preview it in a dialog.
- Each reply shows input / output / cached / reasoning tokens and average throughput; hover for the full breakdown. The header shows the running total for the current branch. All numbers come from the provider's `usage`; nothing is estimated.

## Data and storage

Provider configurations (including API keys) and settings live in localStorage; conversations and original attachments live in IndexedDB. Local data is isolated by browser profile and site origin. API keys are stored in plain text — be careful on shared machines. Sending messages, uploading attachments, and using speech features sends the relevant content to the selected provider.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) no longer injects a fixed API origin — every provider is configured at runtime in Settings.

The request layer replaces only two things: request building and stream parsing. `services/api/dispatch.ts` routes by `provider.protocol` to `protocols/anthropic.ts` or `protocols/openai.ts`; both emit the same internal `MessageStreamEvent`, so conversations, branches, rendering, and import/export stay protocol-agnostic. Adding another protocol (Gemini native, say) means writing one more adapter.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, protocol adapters (anthropic / openai) and types
    chat/              Conversations, message branches, storage, and history import/export
    providers/         Provider and model configuration, presets, capability inference
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## Known limitations

- The app is fully static and talks to providers directly, so **availability depends on whether they allow browser cross-origin requests**. OpenAI's official API blocks them; when that happens the fix is an edge proxy (Cloudflare Pages Functions), not an application backend.
- DeepSeek ships two presets: `DeepSeek (Anthropic compatible)` keeps the original behaviour (`/anthropic/v1` plus the Files API), `DeepSeek (OpenAI compatible)` uses `deepseek-chat` / `deepseek-reasoner`. Both are kept so existing users see no change after upgrading.
- Web search is not self-hosted; it is only exposed when the provider declares the capability.
- Speech is currently DeepSeek-only.

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
