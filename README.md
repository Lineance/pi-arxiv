# pi-arxiv

A [pi](https://pi.dev) package that fetches arXiv papers as **PDF + LaTeX e-print source** and converts them into **clean, KaTeX-safe Markdown** — the format a coding agent can actually read.

> arXiv does not publish Markdown. The official formats are PDF, HTML, and the LaTeX e-print; this package uses the e-print as the source of truth, because it is lossless and machine-parseable.

## What it gives you

```
papers/2609.35319/
├── 2609.35319.pdf            # the PDF, unchanged
├── 2609.35319.md             # generated separately for quick discovery
├── 2609.35319-src.tar.gz     # the raw e-print (provenance)
├── abs.md                    # title/authors/abstract as Markdown
├── manifest.json             # URLs, sha256, toolchain versions, outputs, warnings
├── figures/png/…             # figures rasterized for preview
└── source/
    ├── main.tex              # extracted LaTeX source
    └── figures/…             # original figure PDFs
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
| `parse5` | HTML section reading | installed automatically with the package |
| `sax` | namespace-aware Atom XML parsing | installed automatically with the package |
| [pandoc](https://pandoc.org) | LaTeX → Markdown | conversion fails with a clear message |
| `pdftoppm` (poppler) | PDF page images and figure rasterization | image mode unavailable; figure PDFs stay linked |
| `pdftotext` (poppler) | PDF page text and approximate section-to-page mapping | PDF text reads and page mapping unavailable |

Run `paper_toolchain` (or ask the agent to check) to see what is available.

`parse5` parses arXiv HTML sections; `sax` handles the Atom API feed as strict namespace-aware XML. Both runtime packages are installed automatically. LaTeX-to-Markdown additionally requires pandoc; Poppler provides optional PDF page extraction, page rendering, and figure rasterization.

## Install

```bash
pi install ./pi-arxiv          # from a local checkout
pi install npm:@laboon85/pi-arxiv
pi --extension ./pi-arxiv/extensions/index.ts   # try without installing
```

A **project** install (`-l`, written to `.pi/settings.json`) loads only after the
project is trusted — that is pi's default for project-local code, and it applies
to this package because it is an extension. Approve once with `pi -a`, or run
`/trust` inside a session; after that the tools are present normally.

## Use

In the agent:

```
arxiv_pull   { query: "2609.35319" }                                  # download PDF + LaTeX + metadata, no conversion
arxiv_markdown { id: "2609.35319" }                                   # queue a separate background conversion
arxiv_status { id: "<job-id>" }                                       # poll current-session job status
arxiv_read   { id: "2609.35319", section: "3.2" }                    # HTML first, local Markdown fallback
arxiv_read   { id: "2609.35319", pageStart: 4, pageEnd: 5 }            # PDF text by default
arxiv_read   { id: "2609.35319", pageStart: 4, format: "image" }      # render a PDF page
arxiv_lookup { query: "2609.35319" }                                  # metadata only, no download
arxiv_diff   { id: "2609.35319", from: "v1", to: "v2" }             # compare revisions; Markdown diff if both exist
paper_search { query: "retrieval augmented generation" }               # search the local paper library
paper_section { id: "2609.35319", section: "3.2" }                    # read converted Markdown with evidence locator
paper_repair { id: "2609.35319" }                                      # preview before explicit apply=true
papers_index {}                                                        # inventory the local library
paper_markdown { sourceDir: "./my-paper" }                             # synchronously convert a local LaTeX directory
paper_toolchain {}                                                      # pandoc / pdftoppm / pdftotext
```

Or as a command:

```
/arxiv search retrieval augmented generation
/arxiv pull 2609.35319
/arxiv read 2609.35319 --section=3.2
/arxiv read 2609.35319 --pages=4-5 --format=image
/arxiv markdown 2609.35319
/arxiv status
/arxiv diff 2609.35319 --from=v1 --to=v2
```

`pull` downloads only. Markdown conversion is a separate background task; `status` reports jobs from the current Pi session. Section reads prefer arXiv HTML, then existing local Markdown. If neither is available, request PDF pages explicitly. PDF page reads require a prior pull and support text (default) or rendered images.

`--papers-dir` overrides the corpus root. Downloaded sources stay in `<papersDir>/<id>/source/`; generated Markdown is stored at `<papersDir>/<id>/<id>.md`, next to the PDF and manifest. The `arxiv_pull` tool's `destDir` names one paper's own directory.

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

- **Idempotent.** Re-running a download reuses verified PDF/source files; Markdown conversion skips when source digest, pandoc version, and conversion options are unchanged. `force: true` on `arxiv_pull` re-downloads; `force: true` on `arxiv_markdown` rebuilds the conversion; `cache: false` disables conversion reuse.
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

## Release

`.github/workflows/release.yml` publishes on a `vX.Y.Z` tag after reusing the
full CI workflow. It verifies that the tag matches `package.json` and that the
version is not already on npm, then publishes with GitHub OIDC provenance. No
long-lived npm token is stored in GitHub secrets.

Before the first automated release, configure a Trusted Publisher in the npm
settings for `@laboon85/pi-arxiv`: provider **GitHub Actions**, owner `Lineance`,
repository `pi-arxiv`, workflow `release.yml`. Enable direct `npm publish` for
the trusted publisher. The account must have 2FA enabled. The already published
`0.1.0` predates this workflow; future releases require a version bump, a
matching `vX.Y.Z` tag, and pushing that tag.

| Suite | Covers |
|---|---|
| `cache` | conversion reuse: what invalidates it, and that it does not invalidate itself by writing its own output |
| `unit` | arXiv id parsing, LaTeX counter replay, label numbering, brace/tabular parsing, macro expansion, caption labelling, archive path-traversal refusal |
| `api` | Atom parsing with a stubbed `fetch`: entities, optional fields, malformed feeds, HTTP failures |
| `http` | retry policy, timeout wiring, status handling, cancellation, error text |
| `pull` | download → extract → manifest against a stubbed `fetch` (first run, reuse, force, part filtering, HTTP failure, single-`.tex` e-print) |
| `index-papers` | corpus classification: missing artifacts, corrupt manifest, staleness, legacy layout |
| `tools` | config precedence and every tool, through a faked `pi` |
| `compare` / `lines` | version file, label/caption/structure-aligned table diffs and bounded unified-diff behavior |
| `paper-search` | local abstract/full-text search, ranking, section and line locations |
| `evidence` | stable section evidence ids, Markdown line ranges and approximate PDF page mapping |
| `maintenance` | dry-run repair plans and explicitly applied Markdown reconversions |
| `extension` | the `/arxiv` command end to end |
| `integration` | pi's own extension loader: tools, command and flags register cleanly |
| `fixture` | conversion invariants, against a checked-in synthetic mini-paper and an optional externally supplied full-size source |
| `network` | live arXiv lookup, search, download, convert, re-pull (opt-in) |

The fixture suite asserts the invariants above (no leftover `\ref` anchors, no
raw float HTML, tables rebuilt, captions restored, reference numbers matching the
PDF). `tests/fixtures/mini-paper/` is checked in so this runs in CI;
`PI_ARXIV_FIXTURE_SOURCE=/path/to/paper` adds an external full-size source for optional stress coverage.

Coverage thresholds in `vitest.config.ts` are a ratchet pinned to the floor CI
reaches, so the gate is meaningful on every machine rather than only where the
optional fixture exists.

### Layout

```
extensions/
├── index.ts                 # extension factory: tools, command, flags
├── cfg.ts                   # settings/flags → ArxivConfig
├── tools.ts                 # model-facing tools, including arxiv_diff and paper_search
├── compare/                 # bounded version diffs and table-cell comparisons
├── paper/                   # section extraction and local paper search
├── arxiv/api.ts             # Atom API: lookup by id, search by title
├── arxiv/pull.ts            # download + manifest
├── corpus/                   # corpus inventory and dry-run repair planning
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
