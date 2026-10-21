/**
 * Atom response parsing, with `fetch` stubbed at the global level.
 *
 * The parser is where an upstream format change would bite, and its branches
 * (entities, multiple authors, a missing version, a malformed document) are
 * cheaper to cover here than over the network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupById, parseArxivId, searchByTitle } from "../extensions/arxiv/api.ts";

/**
 * The request queue is process-global and serializes with a polite 3s gap, so a
 * request can outlive the test that issued it and pick up the next test's
 * stubbed `fetch`. Disabling the gap keeps each request inside its own test —
 * and turns a 38s suite into a sub-second one.
 */
const FAST = { minIntervalMs: 0 } as const;

/** A trimmed but structurally faithful Atom entry. */
const ATOM_ENTRY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2609.35319v1</id>
    <updated>2026-09-28T14:49:13Z</updated>
    <published>2026-09-28T14:49:13Z</published>
    <title>Teacher--Student Gaps Are Not Enough:
  Outcome-Guided On-Policy Distillation</title>
    <summary>  On-policy distillation (OPD) trains a student on
  its own trajectories with dense teacher supervision.  </summary>
    <author><name>Tong Zhang</name></author>
    <author><name>Zhou Liu</name></author>
    <author><name>Yihao Liu</name></author>
    <arxiv:comment xmlns:arxiv="http://arxiv.org/schemas/atom">22 pages, 5 figures</arxiv:comment>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.48550/arXiv.2609.35319</arxiv:doi>
    <link href="http://arxiv.org/abs/2609.35319v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2609.35319v1" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

/** An entry that omits every optional field. */
const MINIMAL_ENTRY = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2609.99999v2</id>
    <title>A title with &amp; an ampersand &lt;and&gt; entities</title>
    <summary>Abstract text.</summary>
    <author><name>Someone</name></author>
    <category term="cs.CL"/>
  </entry>
</feed>`;

function stubAtom(body: string, status = 200): { fetch: typeof fetch; urls: string[] } {
	const urls: string[] = [];
	const impl: typeof fetch = async (input) => {
		urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
		if (status !== 200) return new Response("err", { status });
		return new Response(body, { status: 200, headers: { "content-type": "application/atom+xml" } });
	};
	return { fetch: impl, urls };
}

/** The `search_query` operand of a request URL, form-decoded. */
function searchQueryOf(url: string): string {
	return new URL(url).searchParams.get("search_query") ?? "";
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("lookupById", () => {
	it("parses a full entry", async () => {
		vi.stubGlobal("fetch", stubAtom(ATOM_ENTRY).fetch);

		const meta = await lookupById("2609.35319", FAST);

		expect(meta.id).toBe("2609.35319");
		expect(meta.version).toBe("v1");
		expect(meta.title).toBe("Teacher--Student Gaps Are Not Enough: Outcome-Guided On-Policy Distillation");
		expect(meta.authors).toEqual(["Tong Zhang", "Zhou Liu", "Yihao Liu"]);
		expect(meta.abstract).toBe("On-policy distillation (OPD) trains a student on its own trajectories with dense teacher supervision.");
		expect(meta.categories).toEqual(["cs.LG", "cs.AI"]);
		expect(meta.primaryCategory).toBe("cs.LG");
		expect(meta.updated).toBe("2026-09-28T14:49:13Z");
		expect(meta.comment).toBe("22 pages, 5 figures");
		expect(meta.doi).toBe("10.48550/arXiv.2609.35319");
	});

	it("resolves prefixed Atom and arXiv namespaces and decodes numeric entities", async () => {
		const prefixed = `<?xml version="1.0"?>
<a:feed xmlns:a="http://www.w3.org/2005/Atom" xmlns:x="http://arxiv.org/schemas/atom">
  <a:entry>
    <a:id>https://arxiv.org/abs/2609.00001v3</a:id>
    <a:title>XML &#x3BB; parser &amp; entities</a:title>
    <a:summary>Prefix-safe metadata.</a:summary>
    <a:author><a:name>Author</a:name></a:author>
    <x:doi>10.0000/example</x:doi>
    <x:primary_category term="cs.XML"/>
    <a:category term="cs.XML"/>
    <a:link title="pdf" href="https://arxiv.org/pdf/2609.00001v3"/>
  </a:entry>
</a:feed>`;
		vi.stubGlobal("fetch", stubAtom(prefixed).fetch);

		const meta = await lookupById("2609.00001", FAST);
		expect(meta.title).toBe("XML λ parser & entities");
		expect(meta.primaryCategory).toBe("cs.XML");
		expect(meta.doi).toBe("10.0000/example");
		expect(meta.pdfUrl).toBe("https://arxiv.org/pdf/2609.00001v3");
	});

	it("rejects malformed XML instead of partially parsing it", async () => {
		vi.stubGlobal("fetch", stubAtom("<feed><entry><id>2609.35319</entry></feed>").fetch);
		await expect(lookupById("2609.35319", FAST)).rejects.toThrow(/Malformed arXiv Atom feed/);
	});

	it("rejects DTDs in remote Atom feeds", async () => {
		const xml =
			'<!DOCTYPE feed [<!ENTITY x "expanded">]><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>2609.35319</id><title>&x;</title></entry></feed>';
		vi.stubGlobal("fetch", stubAtom(xml).fetch);
		await expect(lookupById("2609.35319", FAST)).rejects.toThrow(/DOCTYPE is not permitted/);
	});

	it("collapses whitespace inside a multi-line title", async () => {
		vi.stubGlobal("fetch", stubAtom(ATOM_ENTRY).fetch);
		expect((await lookupById("2609.35319", FAST)).title).not.toMatch(/\n|\s{2}/);
	});

	it("prefers the pdf link from the feed, otherwise derives a version-pinned one", async () => {
		vi.stubGlobal("fetch", stubAtom(ATOM_ENTRY).fetch);
		expect((await lookupById("2609.35319", FAST)).pdfUrl).toBe("http://arxiv.org/pdf/2609.35319v1");

		vi.stubGlobal("fetch", stubAtom(MINIMAL_ENTRY).fetch);
		// No pdf link in the feed: derive it, keeping the version so the URL cannot
		// silently drift to a revision newer than the metadata describes.
		expect((await lookupById("2609.99999", FAST)).pdfUrl).toBe("https://arxiv.org/pdf/2609.99999v2");
	});

	it("decodes XML entities", () => {
		vi.stubGlobal("fetch", stubAtom(MINIMAL_ENTRY).fetch);
		return expect(lookupById("2609.99999", FAST)).resolves.toMatchObject({
			title: "A title with & an ampersand <and> entities",
		});
	});

	it("leaves optional fields undefined when the entry omits them", async () => {
		vi.stubGlobal("fetch", stubAtom(MINIMAL_ENTRY).fetch);

		const meta = await lookupById("2609.99999", FAST);

		expect(meta.doi).toBeUndefined();
		expect(meta.comment).toBeUndefined();
		expect(meta.published).toBeUndefined();
		expect(meta.htmlUrl).toBe("https://arxiv.org/html/2609.99999v2");
	});

	it("rejects input that is not an arXiv id", async () => {
		await expect(lookupById("attention is all you need", FAST)).rejects.toThrow(/Not an arXiv id or URL/);
	});

	it("throws when the feed contains no entry", async () => {
		vi.stubGlobal("fetch", stubAtom(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`).fetch);
		await expect(lookupById("2609.35319", FAST)).rejects.toThrow(/no entry/);
	});

	it("surfaces an HTTP failure", async () => {
		vi.stubGlobal("fetch", stubAtom("", 503).fetch);
		await expect(lookupById("2609.35319", FAST)).rejects.toThrow(/503/);
	});

	it("asks the API for the id it was given", async () => {
		const stub = stubAtom(ATOM_ENTRY);
		vi.stubGlobal("fetch", stub.fetch);

		await lookupById("arxiv.org/abs/2609.35319v1", FAST);

		expect(stub.urls[0]).toContain("id_list=2609.35319");
		expect(stub.urls[0]).toContain("export.arxiv.org");
	});
});

describe("searchByTitle", () => {
	it("returns every entry in the feed", async () => {
		vi.stubGlobal("fetch", stubAtom(ATOM_ENTRY).fetch);
		const matches = await searchByTitle("anything", 3, FAST);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.id).toBe("2609.35319");
	});

	it("strips LaTeX and punctuation that would break the query", async () => {
		const stub = stubAtom(ATOM_ENTRY);
		vi.stubGlobal("fetch", stub.fetch);

		await searchByTitle("Some \\textbf{Title} with $math$ and_underscores", 3, FAST);

		// Read the operand the way the arXiv API will: form-decoded, so `+` is a
		// space. Asserting on the raw URL would also trip over `search_query` itself.
		expect(searchQueryOf(stub.urls[0] ?? "")).toBe('ti:"Some textbf Title with math and underscores"');
	});

	it("bounds the query length", async () => {
		const stub = stubAtom(ATOM_ENTRY);
		vi.stubGlobal("fetch", stub.fetch);

		await searchByTitle("x".repeat(500), 3, FAST);

		expect(searchQueryOf(stub.urls[0] ?? "").length).toBeLessThan(220);
	});

	it("returns an empty list when the feed has no entries", async () => {
		vi.stubGlobal("fetch", stubAtom(`<?xml version="1.0"?><feed></feed>`).fetch);
		expect(await searchByTitle("nothing", 3, FAST)).toEqual([]);
	});
});

describe("parseArxivId", () => {
	it("keeps a version suffix when present", () => {
		expect(parseArxivId("2609.35319v3")).toEqual({ id: "2609.35319", version: "v3" });
	});

	it("omits the version when absent", () => {
		expect(parseArxivId("2609.35319")).toEqual({ id: "2609.35319", version: undefined });
	});
});
