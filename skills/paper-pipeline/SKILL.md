---
name: paper-pipeline
description: Fetch arXiv papers and turn LaTeX sources into clean Markdown. Use when asked to read, summarise, compare, or extract numbers from a paper (arXiv id, arXiv URL, or a local LaTeX/PDF directory), or when a paper needs to be downloaded for offline reference.
---

# Paper pipeline

Two halves: **fetch** (arXiv → local files) and **convert** (LaTeX → clean Markdown).

## Fetching a paper

Use `arxiv_pull` — it downloads, extracts, converts, and records provenance in one call.

```
arxiv_pull { query: "2609.35319" }                 # id, URL, or title
arxiv_pull { query: "<title>", convert: false }    # just the files
arxiv_pull { query: "<id>", figures: false }       # skip figure rasterization
```

Default layout, `<papersDir>/<id>/`:

| Path | Contents |
|---|---|
| `<id>.pdf` | the original PDF |
| `source/` | extracted LaTeX (`main.tex`, `figures/`, `.bib`) |
| `source/<id>.md` | **the converted Markdown — read this, not the PDF** |
| `source/figures/png/` | figures rasterized for preview |
| `abs.md` | title / authors / abstract |
| `manifest.json` | URLs, SHA-256, toolchain versions, conversion warnings |

`papersDir` defaults to `<cwd>/papers`, overridable with the `arxiv` settings key or `--arxiv-dir`.

### Reading a paper

1. `arxiv_pull { query: "<id>" }`
2. `read` the returned `markdownPath`.
3. Prefer the Markdown over the PDF: equations, tables, and reference numbers are faithful, and it is searchable with `grep`.

If the paper is already downloaded, skip step 1 and read `source/<id>.md` directly.

### Choosing a tool

- `arxiv_lookup` — metadata only, no download. Cheap; use it to turn a fuzzy title into an id.
- `arxiv_pull` — the normal path.
- `paper_markdown` — convert a LaTeX directory that did **not** come from arXiv (a local checkout, an Overleaf export, a supplementary archive).
- `paper_toolchain` — when a conversion failed, check pandoc/poppler before assuming the source is bad.

## Trusting the output

The converter repairs a lot, and every repair is reported. Read the `warnings` in the tool result (and in `manifest.json`) before quoting numbers:

| Warning | What it means |
|---|---|
| `tables: table N rebuilt from LaTeX source` | the table came from the LaTeX `tabular`, so cell values are trustworthy, but merged cells were flattened |
| `captions: Figure N caption restored from LaTeX source` | pandoc dropped the caption; it was recovered by position, so verify it matches the figure |
| `captions: Table N caption inserted from LaTeX source` | same, for a table |
| `structure: abstract restored from LaTeX source` | the class hid the abstract from pandoc |
| `refs: N reference(s) had no matching LaTeX label` | that reference stayed as its raw text — check it in the PDF |
| `refs: no .bib file found` | citations are unresolved keys like `[chen2026futurebridge]`, not author-year |
| `lint: <problem>` | something looks like a conversion failure — open the PDF for that section |
| `figures: ... left as .pdf links` | `pdftoppm` is missing; the images are still correct, just not previewable |

Never present a rebuilt table's numbers as if they were verbatim from the paper without noting the rebuild when the numbers are load-bearing.

## Converting a local LaTeX directory

```
paper_markdown { sourceDir: "./my-paper" }
paper_markdown { sourceDir: "./my-paper", mainTex: "paper.tex", figures: false }
paper_markdown { sourceDir: "./my-paper", keepIntermediate: true }   # also keep raw pandoc output
```

Requirements: a `.tex` file with `\documentclass` (auto-detected, or pass `mainTex`), and `pandoc` on `PATH`. Figures resolve relative to `sourceDir`.

## Failure modes

- **`pandoc not found`** — install pandoc; there is no fallback, because PDF text extraction loses every equation.
- **No source available** (`source download failed`) — some papers have no e-print. Fall back to the PDF and say so; the Markdown will not exist.
- **Unrecognised e-print container** — kept as `source/source.bin`; report it rather than guessing.
- **Wrong `main.tex` picked** — pass `mainTex` explicitly.
- **Garbled math** — the source uses a macro package the expander does not know. Read the LaTeX in `source/` for that equation.
