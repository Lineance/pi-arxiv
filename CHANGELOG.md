# Changelog

## 0.1.0

Initial release.

- `arxiv_lookup` — id / URL / title → metadata via the Atom API (serialized, ≥3 s apart).
- `arxiv_pull` — PDF + LaTeX e-print + `abs.md` + `manifest.json`, then optional conversion.
- `paper_markdown` — convert any local LaTeX source directory to clean Markdown.
- `paper_toolchain` — report pandoc / pdftoppm / pdftotext availability.
- `/arxiv` command with `--force`, `--no-convert`, `--no-figures`, `--dir=`, `--version=`.
- Rule pipeline that repairs what pandoc gets wrong:
  - LaTeX counter replay → correct `\ref` numbers (`Equation 13`, `Appendix D.2`).
  - Rebuilds `\multirow`/`\multicolumn` tables from the `tabular` source.
  - Merges two-level table headers into GFM-compatible headers.
  - Restores captions pandoc dropped (`wrapfigure`) and classifies
    `\captionsetup{type=table}` inside figure floats as tables.
  - Restores abstracts dropped by custom document classes.
  - Numbers headings from the LaTeX section outline.
  - Rewrites `equation`/`align`/`gather` into KaTeX-compatible `$$` blocks.
  - Expands project macros (`\metricpm`, `\metricbest`, …) inside table cells.
- In-tree tar/gzip extraction with path-traversal refusal; no runtime npm dependencies.
- Shared HTTP layer: per-attempt timeout, bounded retry with backoff for transient
  failures (connect timeouts, resets, DNS, 408/429/5xx); fast-fail on other 4xx.
- `papers_index` — corpus inventory and health report (missing artifacts, stale
  Markdown, corrupt manifest, pre-`<id>/` layout). Read-only.

### Tooling

- Tests run on vitest, with coverage thresholds pinned to the floor CI reaches.
- `knip` gates dead exports and unused dependencies.
- `.githooks/pre-commit` runs `verify`; `.githooks/commit-msg` enforces
  Conventional Commits.
- `.github/workflows/ci.yml` verifies on Node 22 and 24, plus Windows, and tries
  to fetch a full-size fixture through this package's own pipeline.
- Deployment notes: the command flag is `--papers-dir` (corpus root) and the
  `arxiv_pull` parameter is `destDir` (one paper's directory); these were
  previously both called `dir` with different meanings.
