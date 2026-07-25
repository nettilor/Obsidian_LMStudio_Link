# LM Studio Notes

Read, search, summarize, and chat with your Obsidian notes using a **local** model served by [LM Studio](https://lmstudio.ai) — everything stays on your machine.

This plugin runs inside Obsidian and talks to LM Studio's built-in OpenAI-compatible server. Your note contents never leave your computer.

## How it works

LM Studio is an MCP **host/client** and a local **OpenAI-compatible server** — it does not expose an MCP server for other apps to connect into. So instead of "connecting to an MCP server in LM Studio", this plugin acts as a client of LM Studio's local API (`http://localhost:1234/v1`). The plugin reads the note in your active pane, sends it to your local model, and writes the result back into the vault.

On desktop, chat responses **stream** token-by-token (over a direct local HTTP connection), so you see the answer as it is generated and can **stop** it at any point. On platforms without that transport the plugin falls back to Obsidian's `requestUrl` (buffered, no streaming).

## Features

**Connect & summarize**

- **Connect** to LM Studio's local server, with a model picker and a connection test.
- **Summarize current note** / **Summarize selection** — command + ribbon icon (scroll icon).
- Configurable summary prompt, insertion location (top / bottom / cursor), and callout formatting.

**Chat with your vault**

- A **chat side-pane** (speech-bubble ribbon icon, or the **Open chat** command) where you talk to your local model. Responses **stream in live**, with a **Stop** button and a tokens/sec readout. It's automatically aware of your notes — choose **None**, **Active note**, **All open notes**, **Current note + links**, or **Relevant notes** as context under Settings → Chat → **Note context**. "Current note + links" pulls in the note's forward/back links and tag-related notes, ranked by relevance (rare shared tags weigh most, then links). **"Relevant notes" is full auto-RAG**: every message you send is used as a retrieval query (hybrid keyword + semantic), and the best-matching excerpts from across the vault are injected automatically — no tool calls needed, which makes it the most reliable mode for smaller models.
- **Reasoning models are first-class** — chain-of-thought from thinking models (Qwen3, DeepSeek-R1 distills, gpt-oss) is split out into a collapsible **Thinking** fold (streamed live, folded when done) and kept out of the conversation history so it never eats your context window.
- **Vault context** (Settings → Vault context): a free-text **Vault notes** field for conventions the model should always know (folder layout, naming formats, templates), plus an automatic **current date & ISO week** line so "this week" / "last week" resolve to e.g. `2026-W26`. This is what makes tasks like *"move incomplete tasks from last week's note into this week's"* work.
- The model can call **tools** to read and edit your vault:
  - Read: `get_active_note`, `read_note` (whole note, one heading's section, or paged with `offset`), `list_vault_notes` (folder + sort options)
  - Search: `search_notes` — ONE hybrid search tool that fuses ranked keyword matching with semantic (meaning-based) search over the local embedding index, so the model never has to choose between search styles
  - Graph: `get_note_links` (backlinks/outgoing), `find_related_notes`, `get_note_outline`, `find_notes_by_tag`, `find_notes_by_property`, `get_recent_notes`
  - Edit: `replace_selection`, `insert_into_active_note`, `append_to_note`, `replace_in_note` (find/replace or delete content in any note by path), `update_frontmatter`, `create_note`, `move_note` (rename/move with link updates), `delete_note` (to trash, recoverable)
- **Tool control** — a tools dropdown (in the chat header and under Settings → Tools) lets you enable/disable groups of tools (Reading / Search / Graph / Editing). Disable the read tools when you already inject note content as context, or disable editing for a read-only session.
- **Edits are gated for safety** — every write asks for confirmation by default (toggle in settings).
- **Tunable for your hardware** (Settings → Performance): context size (how much note content + history to send, matched to your model's context window), max tool steps per message, and a max-response-token cap.

## Choosing a model (Apple Silicon)

Rules of thumb for a Mac with unified memory (tuned for a 64 GB M1 Max; scale to taste):

- **Prefer MoE (mixture-of-experts) models.** They activate only a few billion parameters per token, so they generate fast on Apple Silicon without pegging the GPU the way an equally-capable dense model would.
- **Daily driver: `qwen3-30b-a3b-instruct-2507`** (MLX 4-bit, ~18 GB). Excellent native tool calling, long context, and fast (only ~3B active params) — the best all-rounder for vault chat + editing as of mid-2026. The `qwen3-coder-30b-a3b` variant is a good swap for heavily structured edit work.
- **Fast/light alternative: `gpt-oss-20b`** (MXFP4, ~12 GB). Very quick, good tool use; its "harmony" tool-call format is handled by recent LM Studio versions (and this plugin recovers leaked calls when it isn't).
- **Small utility model: `qwen3-4b`** (~3 GB) for summaries and quick lookups when you want near-zero footprint.
- **Embeddings: `nomic-embed-text-v1.5`** (~0.3 GB) or `qwen3-embedding-0.6b` for the semantic index — tiny, keep one loaded alongside the chat model.
- **Avoid on 64 GB:** dense 70B models (~40 GB at 4-bit, <10 tok/s, machine maxed) and `gpt-oss-120b` (doesn't fit comfortably). They cost far more than they give for note work.

In LM Studio, set the model's **context length to 16k–32k** and enable **KV-cache quantization (8-bit)** to keep memory in check at long contexts; then pick the matching **Context size** (Large or Max) in Settings → Performance. **Important:** allow LM Studio to keep multiple models loaded at once (disable JIT auto-evict / raise the loaded-model limit in the server settings) — the chat model and the embedding model must be resident together, otherwise loading one evicts the other mid-conversation and requests fail. The plugin also serializes its own background embedding work so it never talks to the server while a chat response is being generated. A 30B-A3B chat model + embedding model + Obsidian comfortably stays around ~25 GB, leaving plenty of headroom.

## Setup

### 1. Start LM Studio's server

1. Open LM Studio and download/load a model (any chat model works; instruction-tuned models summarize best).
2. Go to the **Developer** tab and **Start Server** (default `http://localhost:1234`). Leave LM Studio running.

### 2. Install the plugin

For local development from this repo:

```bash
npm install
npm run build      # or: npm run dev  (rebuilds on change)
```

Then copy `main.js`, `manifest.json`, and `styles.css` into your vault:

```
<YourVault>/.obsidian/plugins/lmstudio-notes/
```

(Tip: during development you can symlink this folder there instead of copying.)

Reload Obsidian, then enable **LM Studio Notes** under **Settings → Community plugins**.

### 3. Configure

Open **Settings → LM Studio Notes**:

1. Confirm the **server URL** (default is correct for a standard LM Studio install).
2. Click **Test** to verify the connection.
3. Click the **refresh** button next to **Model** and pick a loaded model.

## Usage

**Summarize**

- Open a note, then run **Summarize current note** from the Command Palette (`Cmd/Ctrl+P`) or click the scroll ribbon icon.
- Select text and run **Summarize selection** to summarize just that part.
- The summary is inserted as a `> [!summary]` callout (configurable) at the top of the note by default. Edits to the open editor are undoable with `Cmd/Ctrl+Z`.

**Chat**

- Click the speech-bubble ribbon icon (or run **Open chat**) to open the chat pane.
- Ask about the current note ("summarize the key points of this note", "what are the open questions here?") or ask the model to edit ("add a `status: draft` property", "append a TODO section", "tighten the selected paragraph").
- Responses stream in as they generate; press **Stop** (the send button while busy) to cut a generation short — the partial answer is kept. Thinking models show their reasoning in a collapsible fold above the answer.
- When the model wants to write to the vault, a confirmation dialog shows a **git-style diff** (lines added/removed) of the exact change — approve or cancel. Use **New chat** (the + button) to start a fresh conversation.
- **Select and copy** any chat text, or use the hover **copy** button on a message to grab its raw markdown for pasting into a note.
- **Edit & re-run**: hover a message you sent and click the **pencil** to edit it; saving re-runs the conversation from that point so you can fine-tune the prompt (Cmd/Ctrl+Enter to submit, Esc to cancel).
- **Tool activity is folded**: the model's tool calls collapse into a single expandable row (closed by default) so the conversation stays readable — expand it to see exactly what it did.

## Semantic search (optional, recommended)

Lets the plugin find notes by *meaning*, not just keywords — fully local, using LM Studio's embeddings.

1. In LM Studio, load an **embedding model** (e.g. `nomic-embed-text`) alongside your chat model.
2. In **Settings → LM Studio Notes → Semantic search**, refresh and pick that model under **Embedding model**.
3. Click **Build / rebuild** to index your vault. The index lives in the plugin folder (`semantic-index.json`, vectors packed compactly) and updates automatically as you edit notes.

The index keeps itself current without LM Studio needing to be always on: besides live updates on edit, a **reconciliation sweep** (at startup, every 30 minutes, and after each successful chat) diffs file modification times against the index and re-embeds only what changed. Notes edited while Obsidian was closed, synced in from another device, or skipped because LM Studio was off are queued and caught up the next time the server is reachable — nothing is ever silently dropped.

Once built, the embedding index powers two things:

- the `search_notes` tool goes hybrid — keyword and semantic rankings are fused (Reciprocal Rank Fusion), so both "find the note mentioning PME-CCC" and "find notes about spaced repetition" work with the same tool;
- the **Relevant notes** context mode retrieves the best-matching excerpts for every message automatically.

Both degrade gracefully to keyword-only when no index is built. Rebuild from settings or the **Rebuild semantic index** command if you switch embedding models.

## Privacy & safety

This plugin only communicates with the LM Studio server URL you configure (a local address by default). No telemetry, no cloud calls — note contents are sent only to your local model.

Because the chat can modify your vault, edits require confirmation by default. You can turn that off, or disable editing tools entirely, under **Settings → LM Studio Notes → Chat**. Writes go to exact note paths only, and tool actions are surfaced in the chat so you can see what happened.

## Development

- `npm run dev` — build in watch mode.
- `npm run build` — type-check and produce a production `main.js`.
- `npm run lint` — ESLint with Obsidian-specific rules.

Source layout:

```
src/
  main.ts           # plugin lifecycle, view registration
  settings.ts       # settings interface + settings tab
  lmstudio.ts       # LM Studio client: streaming + buffered chat, tool-calling, embeddings
  reasoning.ts      # <think>-tag splitting for reasoning models (streaming + whole-text)
  note-context.ts   # read the active note + safe write-back helpers
  summarize.ts      # the summarize feature
  commands.ts       # command + ribbon registration
  chat-view.ts      # the chat side-pane (ItemView), streaming render + stop
  chat-session.ts   # the read→call-tools→answer conversation loop + context modes
  retrieval.ts      # hybrid keyword+semantic retrieval (RRF fusion), used by tools & auto-RAG
  tools.ts          # vault read / search / graph / edit tools the model can call
  semantic-index.ts # local embedding index (build, search, incremental updates)
  confirm-modal.ts  # confirmation dialog for model-requested edits
```

## License

0BSD (inherited from the Obsidian sample plugin template).
