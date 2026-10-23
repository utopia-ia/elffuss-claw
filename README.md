# ✳️ Elffuss Claw — an agentic OS that lives in your browser

**Apps don't exist here: they get created.** Elffuss Claw is a chat-first agentic
"operating system" — the chat *is* the interface, and when you need an app you just ask
for it. The agent generates it as self-contained HTML and it appears instantly in the
viewer. Nothing to install, no mandatory backend, and the model runs **inside your
browser** (WebGPU) — everything stays on your machine.

**[▶️ Live demo](https://claw.elffuss.com)** ·
**[🧑‍💻 Elffuss Code (sibling project)](https://github.com/utopia-ia/elffuss-code)** ·
**[🧬 Shared core](https://github.com/utopia-ia/elffuss)** ·
**License: Apache-2.0**

> Elffuss Claw now lives in the UtopiaIA organization on GitHub, at github.com/utopia-ia/elffuss-claw. It moved from github.com/KikoCis/elffuss-claw on 23 October 2026; the old address redirects.

<p align="center">
  <a href="https://claw.elffuss.com">
    <img src="https://utopiaia.com/demos/elffuss/elffuss-claw-demo.gif" alt="Elffuss Claw — ask for a notes app and it's generated and rendered on the spot" width="820">
  </a>
</p>

> In the demo above I ask for a notes app — the model (running **100% in the browser**)
> generates it as HTML and it renders live in the viewer on the right. No install, no
> server.

---

## Why it's different

- **The chat is the whole interface.** No menus, no dashboards — you talk, things happen.
- **Apps are generated on demand**, as self-contained HTML in a sandboxed iframe, and
  saved locally so you can reopen them.
- **The model runs on *your* machine** via WebGPU — it never reaches for an external API
  on its own.
- **It has memory, tasks and secrets** — persistent memory, scheduled reminders, and an
  encrypted vault, all in your browser.
- **Zero install, zero build.** Vanilla ES modules. Open the URL and you're in.

## What it does today

| Pillar | How |
|---|---|
| **Apps that get created** | The agent generates self-contained HTML → sandboxed iframe in the viewer. Saved to IndexedDB and reopened from the *Apps* tab. |
| **Local by default** | Brains that run in YOUR browser: **LiteRT-LM** (Gemma-4 E2B) and **ONNX/WebGPU** (transformers.js + Qwen2.5-0.5B `q4`), plus a **Basic** rule-based mode (zero download). It **never** pulls an external model on its own. |
| **External models (advanced)** | ⚙️ tab: connect **OpenAI**, **Anthropic (Claude)**, **local Ollama** — opt-in. Keys stay in your browser; calls go straight to the provider. |
| **Message queue** | Queue several messages; they're processed in order and **persist in IndexedDB** — a refresh mid-answer loses none of them. |
| **Memory + history** | Conversation history persists in IndexedDB (a refresh erases nothing; 🧹 = new conversation), and `memory.*` stores facts permanently — they enter the CONTEXT of every turn. |
| **ACE-lite context** | Relevance-based history eviction (BM25-lite + IDF) with a token budget + a live "CONTEXT NOW" system snapshot + the browser's language. |
| **Permissions** | Every scope (files, apps, vault, tasks, internet) asks the first time; revocable in the *Permissions* tab. |
| **Your folders** | File System Access API (Chrome/Edge): authorize a folder and Elffuss lists/reads/writes inside it (**.xlsx read for real**, via SheetJS). |
| **Data → charts** | "visualize sales.xlsx" → reads the Excel/CSV and generates a bar-chart app in the viewer (works even in Basic mode). |
| **Folder automation** | "watch the *inbox* folder and drop processed files in *outbox*" → you drop a file, Elffuss picks it up, processes it (Excel→CSV; else copy) and leaves it in the other folder, pinging you in chat. |
| **Vault** | Secrets encrypted with AES-256-GCM, key derived via PBKDF2 (310k iters) from your master password. Auto-locks after 5 min. Nothing leaves your machine. |
| **Scheduled tasks** | "Remind me in 20 minutes…" → the prompt auto-fires in the future (while the tab is open). |
| **Internet** | `web.fetch` with a direct fetch (CORS) and a `/proxy?url=` server fallback. `/proxy` is an open GET relay to public web pages: it cannot tell the app from any other client (there are no accounts, and anything the page sends a script can send too), so it is bounded instead: public `http`/`https` destinations on ports 80 and 443 only (never private, loopback or the server's own addresses), a size cap, a deadline, and per-client, global and concurrency limits. |

## Run locally

```bash
python3 server/serve.py        # → http://localhost:8642
```

Chrome/Edge recommended (WebGPU + File System Access). **Basic** mode works with no
download; models are fetched from the CDN/HF the first time and cached afterwards.

Try: *"make me a clock"*, *"authorize a folder"*, *"remind me in 1 minute to stretch"*,
*"save the secret gmail: hunter2"*, *"open https://example.com"*.

## Architecture

```
web/
  index.html            OS shell: chat (left) + viewer (right)
  js/kernel.js          boot, model switching, scheduler
  js/agent.js           agentic loop: model → tool-call JSON → result → model
  js/permissions.js     per-scope permissions (modal + localStorage)
  js/tools/             fs · apps · vault · tasks · web  ← the only things touching the world
  js/providers/         rules (no model) · onnx (transformers.js) · litert (LiteRT-LM)
server/serve.py         dev server, and in production the /proxy backend (see the Internet row)
```

No framework, no build step. The agent talks to the tools with
` ```tool {"tool":…,"args":…} ``` ` blocks — the same protocol across all providers.

## Known limits / roadmap

- Tasks only fire while the tab is open (future: Service Worker + Periodic Background Sync).
- Reading the user's email needs OAuth (Gmail API) or an IMAP proxy — the browser can't
  speak IMAP. First iteration: `web.fetch` + proxy.
- Basic mode is deterministic (regex); true free-form language kicks in once a model loads.

## License

[Apache-2.0](LICENSE).

## Gestión de contexto

El empaquetador de contexto (BM25 con IDF endógena contra la pregunta viva, sin heurísticas) está medido: recuerdo de hechos **15,1 % → 65,3 %** al mismo gasto de tokens, y **recuperar bien bate a no comprimir** (F1 28,09 contra 22,56 del contexto completo, con el 8 % de los tokens).

Tablas completas, ablaciones y referencias en el **[core compartido](https://github.com/utopia-ia/elffuss#cómo-se-mide-el-gestor-de-contexto)** · la historia con lo que salió mal en la **[bitácora](https://bitacora.utopiaia.com/posts/16-beaten-by-doing-nothing.html)**.
