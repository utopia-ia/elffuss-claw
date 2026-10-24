<div align="center">

<img src="assets/logo.svg" alt="" width="72">

# Elffuss Claw

**Ask for an app. Your computer builds it.**

Claw is an assistant that thinks inside your browser tab. You describe the app in your own words
and it appears, ready to use. Free, no account, nothing to install.

[![License](https://img.shields.io/badge/license-Apache--2.0-1e6b52?style=flat-square)](LICENSE)
[![No build](https://img.shields.io/badge/build-none-5b6169?style=flat-square)](#architecture)
[![Runs in](https://img.shields.io/badge/runs%20in-your%20browser-1e6b52?style=flat-square)](https://claw.elffuss.com)

[Open Claw](https://claw.elffuss.com) · [Elffuss](https://elffuss.com) · [Code](https://github.com/utopia-ia/elffuss-code) · [Translator](https://github.com/utopia-ia/elffuss-translator) · [Copilot](https://github.com/utopia-ia/elffuss-copilot) · [Shared core](https://github.com/utopia-ia/elffuss)

<a href="https://claw.elffuss.com">
  <img src="https://utopiaia.com/demos/elffuss/elffuss-claw-demo.gif" alt="Claw: someone asks for a notes app in the chat and the app it built appears on the right" width="820">
</a>

</div>

> Elffuss Claw now lives in the UtopiaIA organization on GitHub, at github.com/utopia-ia/elffuss-claw. It moved from github.com/KikoCis/elffuss-claw on 23 October 2026; the old address redirects.

---

**In this repository:** [why it is different](#why-it-is-different) · [what it does](#what-it-does) · [run it](#run-it) · [architecture](#architecture) · [limits](#known-limits) · [context management](#context-management)

---

## Why it is different

- **The chat is the whole interface.** No menus, no dashboards: you talk and things happen. When you need an app, you ask for it.
- **Apps are generated on demand**, as self-contained HTML in a sandboxed iframe, and saved in your browser so you can reopen them.
- **The model runs on your computer.** By default it never reaches for an outside AI on its own; your conversations, apps and files stay in your browser.
- **It remembers, schedules and keeps secrets**: persistent memory, reminders and an encrypted vault, all local.
- **You hold every permission.** Folders, apps, the vault, tasks and the internet each ask the first time, and you can take any of them back.
- **Zero install, zero build.** Plain ES modules. Open the URL and you are in.

## What it does

| | |
|---|---|
| **Apps that get created** | The agent writes self-contained HTML that runs in a sandboxed iframe in the viewer. It is saved to IndexedDB and reopened from the *Apps* tab. |
| **Local by default** | On a computer with a GPU, Gemma 4 (E4B and E2B) through LiteRT-LM. On a phone, Qwen3.5 0.8B through transformers.js. A *Basic* rule-based mode needs no download at all. Advanced: the [Elffuss engine](https://github.com/utopia-ia/elffuss-engine), written for WebGPU, which loads GGUF models, up to a 27B. |
| **Outside models (opt-in)** | In *Settings* you can connect OpenAI, Anthropic or a local Ollama. Keys stay in your browser and calls go straight to the provider. |
| **Message queue** | Queue several messages. They are handled in order and survive a refresh. |
| **Memory and history** | The conversation persists, and `memory.*` keeps facts for good: they enter the context of every turn. |
| **Your folders** | Authorize a folder (File System Access API, Chrome and Edge) and Claw lists, reads and writes inside it. Excel files are read for real, through SheetJS. |
| **Data to charts** | "visualize sales.xlsx" reads the sheet and builds a chart app. It works even in Basic mode. |
| **Folder automation** | "Watch the *inbox* folder and drop processed files in *outbox*". |
| **Vault** | Secrets encrypted with AES-256-GCM, the key derived with PBKDF2 (310,000 iterations) from your master password. It locks itself after five minutes. |
| **Scheduled tasks** | "Remind me in 20 minutes". The prompt fires later, while the tab is open. |
| **Internet** | `web.fetch`, direct when the site allows it, and through a `/proxy?url=` relay when it blocks the browser. The relay is an open GET relay to public pages, so it is bounded: public `http` and `https` addresses on ports 80 and 443 only (never private, loopback or the server's own addresses), a size cap, a deadline, and per-client, global and concurrency limits. |

## Run it

```bash
python3 server/serve.py        # http://localhost:8642
```

Chrome or Edge on a desktop is the recommended browser (WebGPU and File System Access). Basic mode needs no download; models are
fetched the first time and cached for the next visit.

Things to try: *"make me a clock"*, *"authorize a folder"*, *"remind me in 1 minute to stretch"*, *"open https://example.com"*.

## Architecture

```
web/
  index.html            the shell: chat on the left, viewer on the right
  js/kernel.js          boot, model switching, scheduler
  js/agent.js           the loop: model, tool-call JSON, result, model
  js/permissions.js     per-scope permissions (modal + localStorage)
  js/tools/             fs, apps, vault, tasks, web: the only things that touch the world
  js/providers/         rules (no model), onnx (transformers.js), litert (LiteRT-LM)
server/serve.py         dev server and, in production, the /proxy backend
```

No framework and no build step. The agent talks to its tools with
` ```tool {"tool":…,"args":…} ``` ` blocks, the same protocol for every provider.

## Known limits

- Tasks only fire while the tab is open (a Service Worker with periodic sync is the way forward).
- Reading your email needs OAuth or an IMAP proxy; the browser cannot speak IMAP.
- Basic mode is deterministic (regular expressions); free-form language starts once a model is loaded.

## Context management

The context packer (BM25 with an endogenous IDF against the live question, with no heuristics) is measured: fact recall goes from
**15.1 % to 65.3 %** at the same token spend, and **retrieving well beats not compressing** (F1 28.09 against 22.56 for the full
context, with 8 % of the tokens). Full tables, ablations and references are in the
[shared core](https://github.com/utopia-ia/elffuss#what-was-measured-and-not-assumed); the story, with what went wrong, is in the
[dev log](https://bitacora.utopiaia.com/posts/16-beaten-by-doing-nothing.html).

## Licence

[Apache-2.0](LICENSE).
