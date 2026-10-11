# pi-arxiv

A [pi](https://pi.dev) package that fetches arXiv papers as **PDF + LaTeX e-print source** and converts them into **clean, KaTeX-safe Markdown** — the format a coding agent can actually read.

> arXiv does not publish Markdown. The official formats are PDF, HTML, and the LaTeX e-print; this package uses the e-print as the source of truth, because it is lossless and machine-parseable.

## What it gives you

```
papers/2609.35319/
├── 2609.35319.pdf            # the PDF, unchanged
├── 2609.35319-src.tar.gz     # the raw e-print (provenance)
├── abs.md                    # title/authors/abstract as Markdown
├── manifest.json             # URLs, sha256, toolchain versions, outputs, warnings
└── source/
    ├── main.tex              # extracted LaTeX source
    ├── figures/…             # original figure PDFs
    ├── 2609.35319.md         # ← the converted Markdown
    └── figures/png/…         # figures rasterized for preview
```

## Why convert from LaTeX instead of the PDF

A naïve `pdftotext` loses every equation and table. `pandoc` preserves them but produces output that is wrong in ways that are easy to miss — and wrong in ways that matter when you are reading a paper for its numbers:

| Problem | What pandoc does | What this package does |
|---|---|---|
| `\multirow` / `\multicolumn` tables | emits a GFM table with lost cells, or raw HTML | detects the broken block and **rebuilds it from the LaTeX `tabular`** |
| Two-level table headers | produces inconsistent column counts | merges group labels into the sub-headers (`**ALFWorld** Seen SR`) |
| `wrapfigure` captions | **silently drops them** | restores the caption from `\caption{}` |
| `\captionsetup{type=table}` in a figure float | labels a table as a figure | counts it as a table, like LaTeX |
| `\ref{...}` | numbers references with its own counter, which drifts | **replays LaTeX counters** — `Equation 13`, `Appendix D.2`, `Section 3.1` |
| Heading numbers | gfm writer ignores `--number-sections` | numbers headings from the section outline |
| `\begin{equation}` | emits envs KaTeX cannot render | rewrites to `$$…$$` + `aligned` |
| `\begin{abstract}` in custom classes | drops the abstract | restores it from the source |
| `\metricpm{a}{b}` style macros | leaves the macro in the table cell | expands project macros (`26.7 ± 3.0`) |

Everything it had to repair is reported back, so you know which parts of the Markdown were machine-fixed.

## Requirements

| Tool | Needed for | Missing → |
|---|---|---|
| [pandoc](https://pandoc.org) | LaTeX → Markdown | conversion fails with a clear message |
| `pdftoppm` (poppler) | rasterizing figure PDFs | Markdown keeps `.pdf` image links |
| `pdftotext` (poppler) | optional plain-text extract | skipped |

Run `paper_toolchain` (or ask the agent to check) to see what is available.
There are **no runtime npm dependencies** — even tar/gzip extraction is in-tree — so a local install needs no `npm install`.

## Install

```bash
pi install ./pi-arxiv          # from a local checkout
pi install npm:pi-arxiv        # once published
pi --extension ./pi-arxiv/extensions/index.ts   # try without installing
```

A **project** install (`-l`, written to `.pi/settings.json`) loads only after the
project is trusted — that is pi's default for project-local code, and it applies
to this package because it is an extension. Approve once with `pi -a`, or run
`/trust` inside a session; after that the tools are present normally.

## Use

In the agent:

```
arxiv_pull  { query: "2609.35319" }                       # download + convert
arxiv_pull  { query: "https://arxiv.org/abs/2609.35319", figures: false }
arxiv_pull  { query: "Outcome-Guided On-Policy Distillation..." }   # by title
arxiv_lookup    { query: "2609.35319" }                   # metadata only, no download
arxiv_diff      { id: "2609.35319", from: "v1", to: "v2" } # compare revisions, including table values
papers_index    {}                                        # what is on disk, what is missing
paper_markdown  { sourceDir: "./my-paper" }               # any local LaTeX directory
paper_markdown  { sourceDir: "./my-paper", force: true }   # ignore the conversion cache
paper_toolchain {}                                        # pandoc / pdftoppm / pdftotext
```

Or as a command:

```
/arxiv 2609.35319
/arxiv https://arxiv.org/abs/2609.35319 --force --no-figures
/arxiv 2609.35319 --papers-dir=D:/papers --version=v2
```

`--papers-dir` overrides the corpus root, so the paper keeps its `<id>/` layout;
the `arxiv_pull` tool's `destDir` names one paper's own directory.

## Configuration

Settings (in `settings.json`, project or personal):

```json
{
  "arxiv": {
    "papersDir": "D:/Code/Research/papers",
    "figures": true,
    "figureDpi": 150,
    "tableMode": "gfm",
    "timeoutMs": 120000
  }
}
```

CLI flags for one invocation: `--arxiv-dir=<path>`, `--arxiv-no-figures`, `--arxiv-table-mode=html`.

## Behaviour and guarantees

- **Idempotent.** Re-running reuses the PDF/source by file size, and skips the conversion when nothing that affects it changed (source digest, pandoc version, and the relevant options). `force: true` re-downloads and reconverts; `cache: false` disables reuse; deleting `<paper>.md.cache.json` forces a rebuild.
- **Resilient downloads.** Every request has a per-attempt timeout and bounded retry with backoff (connection timeouts, resets, DNS failures, 408/429/5xx). 4xx other than 429 fails fast. Failures name the URL and the cause.
- **Safe by construction.** The e-print archive is unpacked by an in-tree reader that refuses absolute paths, drive letters, `..`, and symlinks; LaTeX is never compiled, so `\write18` cannot execute anything.
- **Polite to arXiv.** Metadata requests are serialized with a ≥3 s gap and a descriptive User-Agent (the API's stated requirement).
- **Auditable.** `manifest.json` records the source URLs, SHA-256 of every artifact, the toolchain versions used, and every warning the conversion produced.
- **Non-destructive.** Only files inside the destination directory are written; nothing is ever deleted.

## Development

```bash
npm install && npm run dev:link && npm run hooks:install   # once per clone
npm run verify          # lint + typecheck + knip + tests with coverage
npm run test:watch      # TDD loop
npm run test:network    # additionally exercise the live arXiv API
npm run lint:fix        # format and apply safe fixes
```

`dev:link` links pi's host-provided packages into `node_modules` rather than
depending on them: a committed copy risks duplicate module instances inside pi.
`hooks:install` wires the pre-commit (verify) and commit-msg (Conventional
Commits) hooks.

| Suite | Covers |
|---|---|
| `cache` | conversion reuse: what invalidates it, and that it does not invalidate itself by writing its own output |
| `unit` | arXiv id parsing, LaTeX counter replay, label numbering, brace/tabular parsing, macro expansion, caption labelling, archive path-traversal refusal |
| `api` | Atom parsing with a stubbed `fetch`: entities, optional fields, malformed feeds, HTTP failures |
| `http` | retry policy, timeout wiring, status handling, cancellation, error text |
| `pull` | download → extract → manifest against a stubbed `fetch` (first run, reuse, force, part filtering, HTTP failure, single-`.tex` e-print) |
| `index-papers` | corpus classification: missing artifacts, corrupt manifest, staleness, legacy layout |
| `tools` | config precedence and every tool, through a faked `pi` |
| `compare` / `lines` | version file, LaTeX table-cell and bounded unified-diff behavior |
| `extension` | the `/arxiv` command end to end |
| `integration` | pi's own extension loader: tools, command and flags register cleanly |
| `fixture` | conversion invariants, against a checked-in mini paper plus an optional full-size one |
| `network` | live arXiv lookup, search, download, convert, re-pull (opt-in) |

The fixture suite asserts the invariants above (no leftover `\ref` anchors, no
raw float HTML, tables rebuilt, captions restored, reference numbers matching the
PDF). `tests/fixtures/mini-paper/` is checked in so this runs in CI;
`PI_ARXIV_FIXTURE_SOURCE=/path/to/paper` adds a full-size paper locally.

Coverage thresholds in `vitest.config.ts` are a ratchet pinned to the floor CI
reaches, so the gate is meaningful on every machine rather than only where the
optional fixture exists.

### Layout

```
extensions/
├── index.ts                 # extension factory: tools, command, flags
├── cfg.ts                   # settings/flags → ArxivConfig
├── tools.ts                 # model-facing tools, including arxiv_diff
├── compare/                 # bounded version diffs and table-cell comparisons
├── arxiv/api.ts             # Atom API: lookup by id, search by title
├── arxiv/pull.ts            # download + manifest
├── corpus/index-papers.ts   # corpus inventory and health report
├── convert/latex.ts         # LaTeX analysis: counters, labels, outline, tabulars
├── convert/pandoc.ts        # pandoc invocation
├── convert/convert.ts       # driver
├── convert/rules/           # one file per repair, each reporting what it changed
│   ├── figures.ts  math.ts  tables.ts  captions.ts  headings.ts  refs.ts  text.ts  structure.ts
└── util/
    ├── http.ts              # timeout + retry, shared by every request
    ├── tar.ts               # in-tree ustar/gzip reader with traversal refusal
    ├── toolchain.ts         # pandoc / pdftoppm / pdftotext detection
    └── fsx.ts               # queued writes, hashing, directory scanning
tests/
├── *.spec.ts                # one suite per thing that can break
├── fixtures/mini-paper/     # checked-in LaTeX paper for the end-to-end path
└── helpers/fixtures.ts      # tar and fetch builders
```

Gated on every commit by `.githooks/pre-commit`, and in CI by
`.github/workflows/ci.yml` (node 22 and 24, Linux plus one Windows job).

Adding a repair means adding one `Rule` with an `id` and a `description`; the
driver runs them in order and aggregates their warnings into the report.

## License

MIT
