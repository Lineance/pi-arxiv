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
paper_markdown { sourceDir: "./my-paper" }                # convert any local LaTeX dir
paper_toolchain {}                                        # check pandoc/poppler
arxiv_lookup { query: "2609.35319" }                       # metadata only, no download
```

Or as a command:

```
/arxiv 2609.35319
/arxiv https://arxiv.org/abs/2609.35319 --force --no-figures
/arxiv 2609.35319 --dir=D:/papers --version=v2
```

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

- **Idempotent.** Re-running reuses the PDF/source by file size and only rewrites the Markdown; `force: true` re-downloads.
- **Resilient downloads.** Every request has a per-attempt timeout and bounded retry with backoff (connection timeouts, resets, DNS failures, 408/429/5xx). 4xx other than 429 fails fast. Failures name the URL and the cause.
- **Safe by construction.** The e-print archive is unpacked by an in-tree reader that refuses absolute paths, drive letters, `..`, and symlinks; LaTeX is never compiled, so `\write18` cannot execute anything.
- **Polite to arXiv.** Metadata requests are serialized with a ≥3 s gap and a descriptive User-Agent (the API's stated requirement).
- **Auditable.** `manifest.json` records the source URLs, SHA-256 of every artifact, the toolchain versions used, and every warning the conversion produced.
- **Non-destructive.** Only files inside the destination directory are written; nothing is ever deleted.

## Development

```bash
node --experimental-strip-types tests/run.ts            # all offline suites
node --experimental-strip-types tests/run.ts --unit     # unit + http + pull only
node --experimental-strip-types tests/run.ts --fixture  # end-to-end conversion only
node --experimental-strip-types tests/run.ts --integration  # extension loading only
node --experimental-strip-types tests/run.ts --network  # also exercise the real arXiv API
node --experimental-strip-types tests/run.ts --write     # refresh the golden Markdown
npx tsc --noEmit                                        # typecheck
```

| Suite | Covers |
|---|---|
| `unit` | arXiv id parsing, LaTeX counter replay, label numbering, brace/tabular parsing, macro expansion, caption labelling, archive path-traversal refusal |
| `http` | retry policy, timeout wiring, status handling, cancellation, error text |
| `pull` | full download → extract → manifest path against a stubbed `fetch` (first run, reuse, force, part filtering, HTTP failure, single-`.tex` e-print) |
| `fixture` | end-to-end conversion of a real paper |
| `integration` | pi's own extension loader: tools, command and flags register cleanly |
| `network` | live arXiv API lookup, search, download, convert, re-pull (opt-in) |

The end-to-end fixture converts a real paper and asserts the invariants above
(no leftover `\ref` anchors, no raw float HTML, tables rebuilt, captions restored,
`\ref` numbering matching the PDF). Set `PI_ARXIV_FIXTURE_SOURCE=/path/to/paper`
to point it at another LaTeX source directory.

### Layout

```
extensions/
├── index.ts                 # extension factory: tools, command, flags
├── cfg.ts                   # settings/flags → ArxivConfig
├── tools.ts                 # the four model-facing tools
├── arxiv/api.ts             # Atom API: lookup by id, search by title
├── arxiv/pull.ts            # download + manifest
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
├── run.ts                   # orchestrator
├── unit.ts http.ts pull.ts fixture.ts integration.ts network.ts
└── harness.ts               # assertions
```

Adding a repair means adding one `Rule` with an `id` and a `description`; the
driver runs them in order and aggregates their warnings into the report.

## License

MIT
