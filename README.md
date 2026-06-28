# LM Studio Notes

Read, summarize, and (soon) chat with your Obsidian notes using a **local** model served by [LM Studio](https://lmstudio.ai) — everything stays on your machine.

This plugin runs inside Obsidian and talks to LM Studio's built-in OpenAI-compatible server. Your note contents never leave your computer.

## How it works

LM Studio is an MCP **host/client** and a local **OpenAI-compatible server** — it does not expose an MCP server for other apps to connect into. So instead of "connecting to an MCP server in LM Studio", this plugin acts as a client of LM Studio's local API (`http://localhost:1234/v1`). The plugin reads the note in your active pane, sends it to your local model, and writes the result back into the vault. Requests go through Obsidian's `requestUrl`, which bypasses the browser CORS restriction that would otherwise block calls to `localhost`.

## Features

**Connect & summarize**

- **Connect** to LM Studio's local server, with a model picker and a connection test.
- **Summarize current note** / **Summarize selection** — command + ribbon icon (scroll icon).
- Configurable summary prompt, insertion location (top / bottom / cursor), and callout formatting.

**Chat with your vault**

- A **chat side-pane** (speech-bubble ribbon icon, or the **Open chat** command) where you talk to your local model. It's automatically aware of your notes — choose **None**, **Active note**, **All open notes**, or **Current note + links** as context under Settings → Chat → **Note context**. "Current note + links" pulls in the most relevant related notes — its forward/back links and tag-related notes, ranked by relevance (rare shared tags weigh most, then links), capped and tunable in settings. Lightweight RAG over your vault's own structure.
- **Vault context** (Settings → Vault context): a free-text **Vault notes** field for conventions the model should always know (folder layout, naming formats, templates), plus an automatic **current date & ISO week** line so "this week" / "last week" resolve to e.g. `2026-W26`. This is what makes tasks like *"move incomplete tasks from last week's note into this week's"* work.
- The model can call **tools** to read and edit your vault:
  - Read: `get_active_note`, `read_note`, `search_vault`, `list_vault_notes`
  - Graph: `get_note_links` (backlinks/outgoing), `find_related_notes`, `get_note_outline`, `find_notes_by_tag`, `find_notes_by_property`, `get_recent_notes`
  - Semantic: `semantic_search` (meaning-based search over a local embedding index)
  - Edit: `replace_selection`, `insert_into_active_note`, `append_to_note`, `replace_in_note` (find/replace or delete content in any note by path), `update_frontmatter`, `create_note`
- **Tool control** — a tools dropdown (in the chat header and under Settings → Tools) lets you enable/disable groups of tools (Reading / Search / Graph / Editing). Disable the read tools when you already inject note content as context, or disable editing for a read-only session.
- **Edits are gated for safety** — every write asks for confirmation by default (toggle in settings).

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
- When the model wants to write to the vault, a confirmation dialog shows a **git-style diff** (lines added/removed) of the exact change — approve or cancel. Use **New chat** (the + button) to start a fresh conversation.
- **Select and copy** any chat text, or use the hover **copy** button on a message to grab its raw markdown for pasting into a note.
- **Edit & re-run**: hover a message you sent and click the **pencil** to edit it; saving re-runs the conversation from that point so you can fine-tune the prompt (Cmd/Ctrl+Enter to submit, Esc to cancel).
- **Tool activity is folded**: the model's tool calls collapse into a single expandable row (closed by default) so the conversation stays readable — expand it to see exactly what it did.

## Semantic search (optional)

Lets the model find notes by *meaning*, not just keywords — fully local, using LM Studio's embeddings.

1. In LM Studio, load an **embedding model** (e.g. `nomic-embed-text`) alongside your chat model.
2. In **Settings → LM Studio Notes → Semantic search**, refresh and pick that model under **Embedding model**.
3. Click **Build / rebuild** to index your vault. The index lives in the plugin folder (`semantic-index.json`) and updates automatically as you edit notes.

Once built, the `semantic_search` tool becomes available to the chat (e.g. "find notes related to the idea of spaced repetition"). Rebuild from settings or the **Rebuild semantic index** command if you switch embedding models.

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
  lmstudio.ts       # LM Studio client: chat + tool-calling (via requestUrl)
  note-context.ts   # read the active note + safe write-back helpers
  summarize.ts      # the summarize feature
  commands.ts       # command + ribbon registration
  chat-view.ts      # the chat side-pane (ItemView)
  chat-session.ts   # the read→call-tools→answer conversation loop
  tools.ts          # vault read / graph / semantic / edit tools the model can call
  semantic-index.ts # local embedding index (build, search, incremental updates)
  confirm-modal.ts  # confirmation dialog for model-requested edits
```

## License

0BSD (inherited from the Obsidian sample plugin template).
