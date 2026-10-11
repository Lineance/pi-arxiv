import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchPapers } from "../extensions/paper/search.ts";

let papersDir: string;

async function addPaper(id: string, markdown: string, title: string): Promise<void> {
	const paperDir = join(papersDir, id);
	const sourceDir = join(paperDir, "source");
	await mkdir(sourceDir, { recursive: true });
	await writeFile(join(sourceDir, `${id}.md`), markdown);
	await writeFile(join(paperDir, "manifest.json"), JSON.stringify({ id, title, version: "v2", outputs: { markdown: `source/${id}.md` } }));
}

beforeEach(async () => {
	papersDir = await mkdtemp(join(tmpdir(), "pi-arxiv-search-"));
});

afterEach(async () => {
	await rm(papersDir, { recursive: true, force: true });
});

describe("searchPapers", () => {
	it("returns the best passage with paper, section and line metadata", async () => {
		await addPaper(
			"2609.00001",
			"# 1 Introduction\n\nWe study a different problem.\n\n# 2 Method\n\nOur retrieval augmented generation system uses a sparse index and reranker.\n",
			"Retrieval for Agents",
		);

		const hits = await searchPapers(papersDir, "retrieval augmented generation");

		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({
			id: "2609.00001",
			title: "Retrieval for Agents",
			version: "v2",
			section: "2 Method",
			sectionNumber: "2",
			lineStart: 7,
			lineEnd: 7,
			matchedTerms: ["retrieval", "augmented", "generation"],
		});
		expect(hits[0]?.snippet).toContain("sparse index and reranker");
	});

	it("ranks stronger matches first and restricts by paper id", async () => {
		await addPaper("2609.00001", "# Results\n\nSearch works.\n", "Search Paper");
		await addPaper("2609.00002", "# Results\n\nSearch ranking works well.\n", "Ranking Paper");

		const hits = await searchPapers(papersDir, "search ranking");
		const filtered = await searchPapers(papersDir, "search", { id: "2609.00001", limit: 1 });

		expect(hits.map((hit) => hit.id)).toEqual(["2609.00002", "2609.00001"]);
		expect(filtered.map((hit) => hit.id)).toEqual(["2609.00001"]);
	});

	it("returns no matches for blank queries or empty libraries", async () => {
		expect(await searchPapers(papersDir, "  !!! ")).toEqual([]);
		expect(await searchPapers(papersDir, "missing phrase")).toEqual([]);
	});
});
