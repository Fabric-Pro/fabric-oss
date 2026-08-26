/**
 * The fence-corruption audit's detector.
 *
 * The audit narrows a manual review set, so both directions cost real time: a
 * miss leaves corrupted content in a spec nobody re-reads, and a false positive
 * sends someone diffing version history for an edit a person made on purpose.
 * These pin the three shapes the defect actually produced against the ordinary
 * edits that look superficially similar.
 */
import { describe, expect, it } from "vitest";
import {
	concatenationSuspects,
	contextFor,
	doubledWords,
	fenceBodies,
	weldedLines,
} from "../scripts/find-fence-corrupted-stories";

describe("fenceBodies", () => {
	it("pulls the body out of each fence, ignoring prose between them", () => {
		const doc = [
			"Some prose.",
			"```ts",
			"const timeout = 30;",
			"```",
			"More prose with `inline code` that is not a fence.",
			"```gherkin",
			"Given the cart has 3 items",
			"```",
		].join("\n");

		expect(fenceBodies(doc)).toEqual([
			"const timeout = 30;\n",
			"Given the cart has 3 items\n",
		]);
	});

	it("returns nothing for a document with no fence, or no document", () => {
		expect(fenceBodies("just prose")).toEqual([]);
		expect(fenceBodies(null)).toEqual([]);
		expect(fenceBodies(undefined)).toEqual([]);
	});

	it("is not left stateful by a previous call", () => {
		// The regex is module-level and global; without a lastIndex reset the
		// second call would start mid-string and silently under-report.
		const doc = "```ts\na\n```";
		expect(fenceBodies(doc)).toEqual(["a\n"]);
		expect(fenceBodies(doc)).toEqual(["a\n"]);
	});
});

describe("concatenationSuspects", () => {
	it("catches the numeric case the defect produced", () => {
		expect(
			concatenationSuspects(
				"const timeout = 30;",
				"const timeout = 3090;",
			),
		).toEqual([{ from: "30;", to: "3090;" }]);
	});

	it("catches a single-digit growing, as in the gherkin case", () => {
		expect(
			concatenationSuspects(
				"Given the cart has 3 items",
				"Given the cart has 37 items",
			),
		).toEqual([{ from: "3", to: "37" }]);
	});

	it("catches a diagram label growing", () => {
		expect(concatenationSuspects("A --> B", "A --> BC")).toEqual([
			{ from: "B", to: "BC" },
		]);
	});

	it("stays quiet when a value was replaced properly", () => {
		// The fixed behaviour. If this flagged, every correctly-applied edit
		// would land in the review pile and the audit would be worthless.
		expect(
			concatenationSuspects("const timeout = 30;", "const timeout = 90;"),
		).toEqual([]);
	});

	it("stays quiet on an unchanged fence", () => {
		expect(concatenationSuspects("a b c", "a b c")).toEqual([]);
	});

	it("stays quiet when a whole line was rewritten", () => {
		// An ordinary human rewrite changes tokens wholesale rather than
		// extending them in place.
		expect(
			concatenationSuspects(
				"const timeout = 30;",
				"const retryLimit = 5;",
			),
		).toEqual([]);
	});
});

describe("weldedLines", () => {
	// Both positive cases are real rows found on staging, trimmed for width.
	// They are the damage this audit exists to find, so they are pinned exactly
	// rather than paraphrased.
	it("catches a mermaid diagram collapsed onto one line", () => {
		const line =
			"A[ViewUser Uploads Vehicle Photo] --> B[.NET API Gateway]    B --> C[Azure Service Bus Queue]    C --> D[AI/ML Ingestion Pod]";
		expect(weldedLines(line)).toEqual([line]);
	});

	it("catches a code block collapsed onto one line", () => {
		const line =
			"public ValueTask<KeysInfo> GetKeysInfo()    {        return ValueTask.FromResult(new KeysInfo        {            HasKeys = State.HasKeys,";
		expect(weldedLines(line)).toEqual([line]);
	});

	it("ignores an indented markdown list item", () => {
		// A wide-indented list item has the space run but no second statement.
		// Before this exclusion it was the audit's loudest false positive.
		expect(
			weldedLines(
				"-    GIVEN a proposal is displayed WHEN reviewed THEN shown",
			),
		).toEqual([]);
	});

	it("ignores aligned assignments", () => {
		// Alignment produces the space run legitimately; one statement per line
		// means no second boundary token, so it stays quiet.
		expect(weldedLines("const a    = 1;\nconst bbbb = 2;")).toEqual([]);
	});

	it("ignores ordinary single-statement lines", () => {
		expect(weldedLines("A --> B\nB --> C")).toEqual([]);
		expect(weldedLines("public ValueTask<KeysInfo> GetKeysInfo()")).toEqual(
			[],
		);
	});

	it("returns nothing for an empty fence", () => {
		expect(weldedLines("")).toEqual([]);
	});
});

describe("doubledWords", () => {
	// Every string here is a real production row, trimmed for width. They are the
	// damage the other two detectors could not see, so they are pinned verbatim.
	it("catches word-level doubling in prose", () => {
		expect(
			doubledWords(
				"the pipeline remains dormant until code-sharingswitchesswitches on GitLab",
			),
		).toEqual(["switchesswitches"]);
		expect(
			doubledWords("runs p/owasptrivytrivy image --severity HIGH"),
		).toEqual(["trivytrivy"]);
	});

	it("catches doubling where the replacement was capitalised", () => {
		// Real damage that a case-SENSITIVE matcher would miss: the inserted text
		// began a clause, so it arrived capitalised.
		expect(
			doubledWords("removed from the attachmentsAttachments list"),
		).toEqual(["attachmentsAttachments"]);
	});

	it("catches a token that compounded across several edits", () => {
		// The shortest repeating unit is `sopen` x3, so that is what gets
		// reported — the reader still sees the damage, just not on the word
		// boundary a human would pick.
		expect(doubledWords("System displaysopensopensopens the view")).toEqual(
			["sopensopensopen"],
		);
	});

	it("still reports an ordinary camelCase identifier — a known false positive", () => {
		// `firecrawl` + `Crawl` + `Activity`. This is NOT damage. It is pinned so
		// the limit is explicit: the detector cannot separate this from the
		// capitalised real damage above, which is why the caller reads context.
		expect(
			doubledWords("`firecrawlCrawlActivity` has a 120-minute timeout"),
		).toEqual(["crawlCrawl"]);
	});

	it("ignores placeholder runs and clean text", () => {
		expect(doubledWords("redacted as XXXXXXXX here")).toEqual([]);
		expect(doubledWords("the crawler indexes each page once")).toEqual([]);
		expect(doubledWords(null)).toEqual([]);
		expect(doubledWords(undefined)).toEqual([]);
	});
});

describe("contextFor", () => {
	it("returns the surrounding text so a reader can judge a hit", () => {
		const text =
			"Some lead-in prose.\n\n`firecrawlCrawlActivity` already has a timeout.";
		expect(contextFor(text, "crawlCrawl")).toContain(
			"firecrawlCrawlActivity",
		);
		expect(contextFor(text, "crawlCrawl")).not.toContain("\n");
	});

	it("returns empty when the hit is absent", () => {
		expect(contextFor("nothing here", "missing")).toBe("");
	});
});
