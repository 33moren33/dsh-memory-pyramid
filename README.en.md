<div align="center">

  <h1>dsh-memory-pyramid</h1>

  <p>
    <img src="https://img.shields.io/badge/INFINITE%20MEMORY-ff6b35?style=for-the-badge" alt="Infinite memory" height="90" />
    <img src="https://img.shields.io/badge/FIXED%20TOKENS-2ea44f?style=for-the-badge" alt="Fixed tokens" height="90" />
    <img src="https://img.shields.io/badge/DSH%20NATIVE-3178c6?style=for-the-badge" alt="dsh native" height="90" />
  </p>

  <p><strong>Timeline memory</strong> for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness (dsh)</a>: an append-only log of facts, plus a summary pyramid the agent maintains by itself.<br/><strong>Ten thousand memories wake as 96 lines (≈7.3k tokens); any single memory is one seek away.</strong> Zero dependencies, plug and play.</p>

  <p>
    <a href="#quick-install"><strong>Quick Install</strong></a>
    ·
    <a href="#why-pyramid"><strong>Why "Pyramid"</strong></a>
    ·
    <a href="#roadmap"><strong>Roadmap</strong></a>
  </p>

  <p>
    <img src="https://img.shields.io/static/v1?label=License&message=MIT&color=blue&style=flat-square" alt="License: MIT" />
    <img src="https://img.shields.io/static/v1?label=Node&message=%E2%89%A519&color=green&style=flat-square" alt="Node >= 19" />
    <img src="https://img.shields.io/static/v1?label=Dependencies&message=0&color=brightgreen&style=flat-square" alt="Zero dependencies" />
  </p>

  <p><sub>Built with Fable 5</sub></p>

  <p><a href="README.md">中文</a> | English</p>

</div>

---

Once installed, every session wakes up with the pyramid memory injected; as memories accumulate, the view compresses into pyramid shape:

```
### Memory view (40 facts)

#0-31   Summary: spent this stretch getting plugin loading to work; conclusion: third-party plugins install via CLI only
#32-35  Summary: moved injection to the dynamic runtime-context channel; cache hit rate recovered from 40% to 91%
#36-37  Summary: data directory now lives in the workspace, keeping runtime data out of the home directory
#38     2026-08-15 summary tree stored per block size; the to-do list is derived from file length, no queue to drift
#39     2026-08-15 fixed-width records carry no sequence number: position is identity, concurrent appends are naturally safe
```

The closer to now, the more verbatim; the older, the coarser — but **not a single original line is ever lost**, and you can drill back down at any time.

## Why "Pyramid"

Every time two facts fill up, the agent writes one line that stands for them; when two of *those* lines pair up, it writes one coarser line. Each layer holds half as many blocks as the one below — the shape is a tower:

```
                  [ #0-127 ]                      ← 1 line · covering all 128 facts
            [ #0-63 ]    [ #64-127 ]              ← each line covers 64
      [#0-31] [#32-63] [#64-95] [#96-127]         ← each line covers 32
   ········································
  #0 #1 #2 #3 ··················· #126 #127       ← the base: 128 verbatim facts
```

The wake-up view walks a **diagonal staircase down the tower**: last year is one line at the peak, last month sits behind a mid-layer brick, yesterday you read verbatim at the base. The base never moves — coarse bricks are only the map, and `memory_zoom` takes you down to the originals in two lines. So memory can grow tenfold and the view doesn't gain a line.

The shape takes its cue from Victor Taelin's [OptMem](https://github.com/VictorTaelin/OptMem). **The shape is the reference; everything else we worked out ourselves inside dsh** — see the features below.

## The slot it fills

| | Axis | What it remembers |
|---|---|---|
| `agent-instructions` (AGENTS.md chain) | Space | Which rules apply in which directory |
| Retrieval memory (RAG family) | Relevance | Things similar to the current question |
| **dsh-memory-pyramid** | **Time** | **What happened, in what order, and why it was decided that way** |

The three axes are orthogonal and stack cleanly. Officially only the space axis is occupied — **the time axis is entirely empty**. That's where this plugin lands.

The serial edition works today and runs **nothing in the background**. On the roadmap are two things you won't find elsewhere: **parallel background settlement** (memory-writing handed to a dedicated clone, costing your main thread zero attention) and a **memory dashboard** (humans get to see their own memory too — click a fact, jump back to the conversation that produced it).

## Features

**The pyramid mechanism**

- One fact per line, ≤280 bytes, append-only, never edited; summaries maintained by the agent as it writes — no background process, no timers
- Fixed reading budget: when everything fits, nothing is compressed; when it doesn't, older gets coarser — **never cut off**
- Bad summaries have a formal redraw channel (`memory_forget`), cascading to every coarser summary derived from them

**dsh-native adaptation (friction we solved ourselves)**

- Native dsh tools, not an external CLI — no shell permission needed
- **The injection channel was chosen on real API bills**: putting the view in the system prompt wrecks the prompt cache; moving it to the official dynamic runtime-context channel took whole-session hit rates from 40% to 91% (ledger below)
- **Session-range anchors**: every fact records which slice of conversation it was distilled from (`sessionId` + seq range) — dsh keeps a full event stream of every session, raw material that doesn't exist in OptMem's environment
- **Every integration channel was tested before we picked a seat**: the AGENTS.md channel (`agent-instructions`) ships root-flagged as disabled yet turns out alive in real sessions — but it's built for static, per-directory rules (cascading, never summarized); a memory view that changes on every write belongs in the official dynamic runtime-context channel
- Data-directory claiming / auto-migration / refusal to splice — better to not work than to write into someone else's directory

**Engineering properties**

- **Zero npm dependencies, zero native modules**; Node ≥ 19
- Windows / Linux / macOS / ARM64 (full green acceptance run on a postmarketOS phone)
- Multiple processes write the same memory **lock-free and correctly** — by removing a field, not adding a mutex
- Data lives in your workspace as plain text, diff-friendly; whether it goes into git is your choice

## Quick Install

Prerequisites: pnpm on PATH — dsh uses it to manage plugins on every platform (`npm install -g pnpm`; if the global directory isn't writable, `npm install -g pnpm --prefix ~/.local` and put `~/.local/bin` on PATH). Installing from source additionally needs git; the plugin itself has zero dependencies, no build step, Node.js ≥ 19.

One command:

```bash
dsh plugin --profile web add dsh-memory-pyramid
```

Installed means activated — the package declares `dsh.bundle`, so dsh adds it to the profile's layer stack automatically. **Not a single config file to edit.** The next new session wakes up with the Memory view. (You can also just ask your dsh agent to run the install for you.)

Uninstalling is one command too: `dsh plugin --profile web remove dsh-memory-pyramid`.

<details><summary>Install from source (to track the latest code)</summary>

```bash
git clone https://github.com/33moren33/dsh-memory-pyramid.git
dsh plugin --profile web add "link:/absolute/path/dsh-memory-pyramid"
```

</details>

To change configuration (e.g. `wakeLines`), override the same id in your profile's `cordis.patch.yml` — hot-reloaded:

```yaml
- id: memory
  config:
    wakeLines: 192
```

**A real injection** (real session, zero tools — the model answers straight from the injected view):

<img src="assets/memory-view.png" alt="A real injection" width="640" />

## Configuration

| Key | Default | Description |
|---|---|---|
| `namespace` | none | A shared-area name. If set, data lands in `<workspace>/<name>/dsh_memory`. Single directory name only. |
| `dataDir` | none | Fully custom path (absolute, or relative to the workspace root). **Overrides** `namespace`. |
| `migrate` | `true` | When the location changes, automatically move the old memory found in the workspace. |
| `wakeLines` | `96` | Line budget of the memory view. **A reading budget, not a storage budget** — change it any time; nothing is recomputed. |
| `injectWake` | `true` | Whether to inject the memory view at session start. Turned off, the tools still work; the view just stops appearing on its own. |
| `liveView` | `false` | Whether the view updates live as memory changes mid-session. Off (default): the view is injected once at session start; facts written mid-session stay visible through tool receipts, and every new session opens with the full latest view. On: every memory change appends a fresh full view to the session (more injected tokens). Hot-reloaded — the current conversation follows the new setting from its next message. |

Data defaults to `<workspace>/dsh_memory` (never the home directory). `LOG.txt` is plain text, append-only — commit it and a team shares one lived history; `TREE/` is pure cache, deleting it loses no facts. If the directory already exists: a matching identity marker is claimed untouched; anything else is refused with an explanation. **Two memories are never spliced** (records are addressed by position; splicing would silently shift every summary reference) — multiple old copies found means refuse and let a human decide.

## Tools

| Tool | What it does |
|---|---|
| `memory_note` | Record one fact. One line, ≤280 bytes, append-only, never edited. |
| `memory_summarize` | Pay the pyramid's upkeep: when a block fills, write the one line that will represent it. |
| `memory_zoom` | Open any `#a-b` node into its two halves — the cheap way to drill down. |
| `memory_recall` | Scan all facts with a regular expression (`from`/`to` bound the scan), or read a range of originals. A shortened answer reports how many matches it held back. Every fact comes with its session anchor. |
| `memory_forget` | Discard a bad summary and queue a rewrite. **Redraws the map, never touches the territory.** |

## Why it never slows down

1. **Fixed-width records ⇒ position is identity.** Fact N lives at byte N×384, forever; reading one fact is one `pread`. Records store no sequence number — which also makes concurrent appends naturally correct.
2. **The summary tree is fixed-width too, one dense-prefix file per layer.** "How far has this layer gotten?" = file length ÷ 288, one `stat`. The to-do list is *derived* — there is no queue that can drift.
3. **Compression work is constant.** Small blocks (≤16 facts) compress from originals; larger blocks read only their two half-block summaries. Layer 10 costs the same as layer 1, and a written summary is never reworked.
4. **The reading budget is fixed, and nothing is truncated.** A binary search finds the coarsening rate that exactly fits; when everything fits, nothing is compressed. Changing the budget recomputes zero summaries.

### Why it never breaks the prompt cache

**The discipline text (static) lives in the system prompt; the memory view (changes on every write) lives in the dynamic context.** The dividing line is one question: *will this text change?* Measured on real API traffic (an 8-turn session writing 6 facts and paying 6 compression debts):

| | View in system prompt (the wrong way) | View in dynamic context (now) |
|---|---|---|
| Cacheable-prefix invalidations | 5 | **0** |
| Full-price input tokens | 95,362 | **11,618** |
| Whole-session cache hit rate | 40% | **91%** |

The cost is **independent of turn count — it only depends on how many times the memory actually changed**.

### Summaries will be wrong, and that's part of the design

The top of the pyramid is a multi-generation game of telephone; meaning drifts. So the originals are permanent (a broken map doesn't sink the territory), `memory_forget` is the formal redraw channel, and a missing summary makes the view split that block finer until it reaches originals — it never displays a summary that doesn't exist.

## Roadmap

- [x] v0.1 serial edition: five tools, session-range anchors, cache-safe injection, byte-level OptMem `TREE/` compatibility
- [x] v0.1.1 injection switch: by default the view is injected once at session start (`liveView` switches back to live updates, hot-reloaded)
- [ ] **Injection refinement**: incremental dynamic injection — track what each session has already seen and inject only what it hasn't
- [ ] **Memory dashboard**: today the Memory view is readable only by the model — **you can't see your own memory**. Planned: a timeline list and pyramid-layer view where clicking a memory jumps back to the conversation slice that produced it (the anchor fields are written correctly *now* so that day needs no data migration)
- [ ] **Pyramid tutorial**: flowcharts and screenshots explaining how the tower is built, read, broken, and repaired
- [ ] **Parallel settlement**: hand memory-writing to a dedicated clone so the main thread is never interrupted; an idle sweeper picks up unclaimed conversation ranges
- [ ] OptMem `LOG.txt` migration converter (`TREE/` can be moved as-is)

## Known Limits

- **Where the memory lands**: in `dsh_memory/` under the **dsh server process's startup directory**. Headless runs one process per task from the workspace, so it lands in the workspace; but the web GUI is one long-lived process serving multiple workspaces — switching a session's workspace in the UI does **not** switch the memory location, and all sessions share the copy under the startup directory. Practical rule: **start `dsh web` from inside your workspace directory.**
- The peer-dependency warning `@deepseek-ai/cordis missing` is harmless: cordis is only referenced in type annotations, never imported at runtime, and dsh ships its own. Removed as of v0.1.1; safe to ignore on older versions.
- Concurrent multi-process writing is supported and lock-free; but **sub-agents should not write memory** (they can't see what's already recorded). Currently enforced by prompt convention, not by code.
- Session anchors are faithfully stored and returned by `memory_recall`, but the tool that *opens* the original conversation from an anchor doesn't exist yet — that belongs to the parallel-settlement edition.
- Early version; the injection shape is still evolving (see the first Roadmap item). **Full reliability claims are left to real-world testing and issue reports** — if you hit something, please open an issue.

## License

This project is licensed under the [MIT License](./LICENSE).
