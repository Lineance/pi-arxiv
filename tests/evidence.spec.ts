import { describe, expect, it } from "vitest";
import { makeEvidenceLocation, mapSectionToPdfPages } from "../extensions/paper/evidence.ts";

describe("paper evidence locations", () => {
	it("creates a stable content-addressed reference for a line range", () => {
		const first = makeEvidenceLocation("2609.35319", "v2", 12, 18, "retrieval improves answer quality");
		const same = makeEvidenceLocation("2609.35319", "v2", 12, 18, "retrieval improves answer quality");
		const changed = makeEvidenceLocation("2609.35319", "v2", 12, 18, "retrieval changes answer quality");

		expect(first).toEqual(same);
		expect(first.id).toContain("2609.35319@v2:L12-18:");
		expect(changed.id).not.toBe(first.id);
	});

	it("maps a section to approximate PDF pages by text overlap", () => {
		const section = "Retrieval augmented generation uses sparse embeddings for factual evidence and reranking improves answer grounding.";
		const pdfText = [
			"Introduction and motivation with unrelated experimental context.",
			"Retrieval augmented generation uses sparse embeddings. Factual evidence is selected, and reranking improves answer grounding.",
			"Conclusion and future work discuss limitations and broader deployment.",
		].join("\f");

		expect(mapSectionToPdfPages(section, pdfText)).toEqual({ start: 2, end: 2, confidence: "approximate" });
	});

	it("omits page references when lexical evidence is too weak", () => {
		expect(mapSectionToPdfPages("Short text.", "Page one has unrelated words and no corresponding passage.")).toBeUndefined();
	});
});
