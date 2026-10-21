---
name: paper-pipeline
description: Search, fetch, read, compare, and maintain arXiv papers in the local pi library. Use for arXiv ids, titles, URLs, paper questions, section/page evidence, or LaTeX-to-Markdown conversion.
---

# Paper Pipeline

Use the smallest operation that satisfies the request. Downloading a paper does not generate Markdown. Markdown is an explicit background task.

## Find and pull

- Use `arxiv_lookup` or `/arxiv search <query>` to resolve a title or inspect metadata. Exact arXiv ids can be looked up directly.
- Use `arxiv_pull` or `/arxiv pull <id|url|title>` to download the PDF, LaTeX source, abstract, and provenance manifest. This does not convert the source.
- The default library layout is `<papersDir>/<id>/`: PDF, manifest, abstract, generated `<id>.md`, and extracted source under `source/`.
- A PDF page read requires the PDF to exist locally. Pull first if it is missing.

## Read a paper

Prefer section-based reading. Call `arxiv_read` with `id` and `section` (number or title). It reads arXiv HTML first, then an existing local Markdown file. If neither exists, ask for explicit PDF pages instead of guessing section boundaries.

PDF page reads use `pageStart` and optional inclusive `pageEnd`. `format` is `text` by default; choose `image` when equations, tables, figures, or layout are important. A single call is limited to five pages. Page numbering is 1-based.

For generated Markdown with stable local line evidence, use `paper_section`. Omit `section` to list headings, then request the relevant section. It reports Markdown line ranges and an approximate PDF page mapping when available. Use `paper_search` for lexical search across the local library.

## Generate Markdown

Run `arxiv_markdown { id }` or `/arxiv markdown <id>` only when a durable, searchable Markdown copy is useful. It queues conversion for a paper already pulled into the library and returns a current-session job id. Poll with `arxiv_status { id: "<job-id>" }` or `/arxiv status <job-id>`; a completed job reports its Markdown path. Jobs do not survive Pi session shutdown. Use `force: true` to rebuild an existing conversion.

Markdown is written to `<papersDir>/<id>/<id>.md`, beside the PDF and manifest. The extracted LaTeX remains under `source/`. Figure links are relative to the Markdown output. The manifest records the generated path, conversion statistics, and warnings.

`paper_markdown` remains the synchronous converter for an arbitrary local LaTeX directory. `paper_repair` previews stale or missing library Markdown; only pass `apply: true` after the user approves the rebuild.

## Compare and diagnose

- Use `arxiv_diff` or `/arxiv diff <id> --from=v1 --to=v2` for source and table changes. It does not generate Markdown; a Markdown diff is included only when both versions already have converted Markdown.
- Use `papers_index` for a read-only library inventory.
- Use `paper_toolchain` when a conversion or PDF page operation reports a missing system tool.

## Trust the output

Read warnings before relying on extracted values. Rebuilt tables are sourced from LaTeX and flattened merged cells; unresolved citation keys stay as keys; missing figure rasterization leaves PDF links. PDF text extraction is layout-dependent. Use `format: "image"` for pages where visual structure matters.
