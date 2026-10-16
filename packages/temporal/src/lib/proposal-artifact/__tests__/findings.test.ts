/**
 * The Internal Analysis's findings as stored (Fizzy #2801, #2946): stable
 * keys, section resolution, cited sources, folding and the caps, directly on
 * the pure helpers the analysis activity stores findings with.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run src/lib/proposal-artifact/__tests__/findings.test.ts
 */

import {
	buildSectionMap,
	DOCUMENT_SECTION_KEY,
} from "@repo/utils/proposal-artifact/section-hash";
import { describe, expect, it } from "vitest";
import {
	boundText,
	citableSourceNumbers,
	citedSources,
	FINDING_DETAIL_MAX_CHARS,
	FINDING_TITLE_MAX_CHARS,
	type FindingResolution,
	findingStableKey,
	foldByStableKey,
	foldedText,
	type KeyedFinding,
	listedSection,
	MAX_FINDINGS,
	MAX_FOLDED_TITLES,
	MAX_SOURCE_REFS,
	type ModelFinding,
	normalizeSubject,
	toStoredFindings,
} from "../findings";

const CONTENT = [
	"# Example Proposal",
	"",
	"Opening text.",
	"",
	"## Scope",
	"",
	"We deliver the onboarding portal for Example Org.",
	"",
	"## Commercials",
	"",
	"The fixed fee covers both phases.",
	"",
].join("\n");

const MAP = buildSectionMap(CONTENT);

function resolution(
	overrides: Partial<FindingResolution> = {},
): FindingResolution {
	return {
		sectionMap: MAP,
		listedSections: MAP.sections,
		citableSources: new Set([1, 2, 3]),
		...overrides,
	};
}

function modelFinding(overrides: Partial<ModelFinding> = {}): ModelFinding {
	return {
		severity: "Important",
		type: "Scope",
		title: "Single sign-on is missing",
		subject: "single sign-on",
		detail: "The proposal never mentions single sign-on.",
		recommendation: "Add single sign-on to the scope.",
		sectionIndex: null,
		sectionHeading: null,
		sourceRefs: null,
		...overrides,
	};
}

function keyed(overrides: Partial<KeyedFinding> = {}): KeyedFinding {
	return {
		severity: "IMPORTANT",
		type: "SCOPE",
		title: "Title",
		detail: "Detail.",
		recommendation: null,
		sectionHeading: null,
		stableKey: "k1:same",
		sectionKey: DOCUMENT_SECTION_KEY,
		sectionHash: MAP.documentProseHash,
		sourceRefs: [],
		foldedTitles: [],
		...overrides,
	};
}

describe("normalizeSubject", () => {
	it("reads case, punctuation, width and a leading article as one subject", () => {
		const expected = "single sign on";
		for (const subject of [
			"The Single Sign-On",
			"single sign on",
			"  A single—sign…on! ",
			"ｓｉｎｇｌｅ ｓｉｇｎ ｏｎ",
		]) {
			expect(normalizeSubject(subject)).toBe(expected);
		}
	});

	it("drops only a leading article, never one inside a word", () => {
		expect(normalizeSubject("Theory of change")).toBe("theory of change");
		expect(normalizeSubject("An answer")).toBe("answer");
	});

	it("is empty for a missing or blank subject", () => {
		expect(normalizeSubject(null)).toBe("");
		expect(normalizeSubject(undefined)).toBe("");
		expect(normalizeSubject("")).toBe("");
		expect(normalizeSubject(" -- ")).toBe("");
	});
});

describe("findingStableKey", () => {
	const base = {
		type: "SCOPE",
		sectionKey: "p1:abc",
		subject: "sso",
	} as const;

	it("is versioned and a fixed length, and the same for the same input", () => {
		const key = findingStableKey(base);

		expect(key).toMatch(/^k1:[0-9a-f]{32}$/);
		expect(findingStableKey({ ...base })).toBe(key);
	});

	it("differs by type, by section and by subject", () => {
		const key = findingStableKey(base);

		expect(findingStableKey({ ...base, type: "RISK" })).not.toBe(key);
		expect(findingStableKey({ ...base, sectionKey: "p1:def" })).not.toBe(
			key,
		);
		expect(findingStableKey({ ...base, subject: "mfa" })).not.toBe(key);
	});
});

describe("listedSection", () => {
	it("resolves a 1-based index to the listed section", () => {
		expect(listedSection(MAP.sections, 1)).toBe(MAP.sections[0]);
		expect(listedSection(MAP.sections, MAP.sections.length)).toBe(
			MAP.sections.at(-1),
		);
	});

	it.each([
		["null", null],
		["undefined", undefined],
		["zero", 0],
		["a negative index", -1],
		["a fractional index", 1.5],
		["one past the list", MAP.sections.length + 1],
	])("is null for %s", (_label, index) => {
		expect(listedSection(MAP.sections, index)).toBeNull();
	});
});

describe("citedSources", () => {
	it("keeps whole, citable numbers once each, in order", () => {
		expect(
			citedSources([3, 1, 3, 2.5, 4, 0, -1], new Set([1, 2, 3])),
		).toEqual([1, 3]);
	});

	it("is empty for no refs", () => {
		expect(citedSources(null, new Set([1]))).toEqual([]);
		expect(citedSources(undefined, new Set([1]))).toEqual([]);
	});

	it(`keeps at most ${MAX_SOURCE_REFS}`, () => {
		const all = Array.from({ length: 30 }, (_, index) => index + 1);

		expect(citedSources(all, new Set(all))).toEqual(
			all.slice(0, MAX_SOURCE_REFS),
		);
	});
});

describe("citableSourceNumbers", () => {
	it("is exactly the manifest's sources when the run has a manifest", () => {
		const entry = {
			kind: "other" as const,
			id: null,
			contextType: null,
			title: null,
			sourceName: null,
			fingerprint: "fnv1a:0:0",
		};

		expect(
			citableSourceNumbers({
				sourceContext: "### Source 1\nOne\n\n### Source 9\nForged",
				sourceManifest: [
					{ ...entry, source: 2 },
					{ ...entry, source: 5 },
				],
				contextCount: 9,
			}),
		).toEqual(new Set([2, 5]));
	});

	it("reads the header lines within the context count when it has none", () => {
		expect(
			citableSourceNumbers({
				sourceContext: [
					"### Source 1",
					"One",
					"",
					"### Source 3",
					"Three, mentioning ### Source 2 inline",
					"",
					"### Source 7",
					"Past the count",
					"#### Source 2",
				].join("\n"),
				sourceManifest: null,
				contextCount: 4,
			}),
		).toEqual(new Set([1, 3]));
	});
});

describe("boundText", () => {
	it("trims, and is null for nothing", () => {
		expect(boundText("  text  ", 10)).toBe("text");
		expect(boundText("   ", 10)).toBeNull();
		expect(boundText(null, 10)).toBeNull();
		expect(boundText(undefined, 10)).toBeNull();
	});

	it("caps at the limit in code points, marking the cut", () => {
		const capped = boundText("😀".repeat(20), 10);

		expect(Array.from(capped ?? "")).toHaveLength(10);
		expect(capped?.endsWith("…")).toBe(true);
	});
});

describe("foldedText", () => {
	it("adds a new text as its own paragraph and remembers it", () => {
		const seen = new Set(["First."]);

		expect(foldedText("First.", "Second.", seen, 100)).toBe(
			"First.\n\nSecond.",
		);
		expect(seen.has("Second.")).toBe(true);
	});

	it("leaves the text alone for an empty or already held addition", () => {
		const seen = new Set(["First."]);

		expect(foldedText("First.", null, seen, 100)).toBe("First.");
		expect(foldedText("First.", "", seen, 100)).toBe("First.");
		expect(foldedText("First.", "First.", seen, 100)).toBe("First.");
	});

	it("takes the addition as it is when there was no text", () => {
		expect(foldedText(null, "Only.", new Set(), 100)).toBe("Only.");
	});

	it("caps the joined text", () => {
		expect(foldedText("aaaa", "bbbbbbbb", new Set(), 10)).toBe(
			"aaaa\n\nbbb…",
		);
	});
});

describe("foldByStableKey", () => {
	it("folds same-key findings into the earliest, keeping what the others add", () => {
		const first = keyed({
			title: "First",
			detail: "First detail.",
			recommendation: "Do this.",
			sourceRefs: [3],
		});
		const findings = [
			first,
			keyed({ stableKey: "k1:other", title: "Other" }),
			keyed({
				severity: "BLOCKING",
				title: "Second",
				detail: "Second detail.",
				recommendation: "Do this.",
				sourceRefs: [1, 3],
			}),
			keyed({ title: "First", detail: "First detail.", sourceRefs: [2] }),
		];

		const { kept, folded } = foldByStableKey(findings);

		expect(folded).toBe(2);
		expect(kept.map((finding) => finding.title)).toEqual([
			"First",
			"Other",
		]);
		expect(kept[0]).toMatchObject({
			// The later Blocking finding's classification is not lost.
			severity: "BLOCKING",
			detail: "First detail.\n\nSecond detail.",
			recommendation: "Do this.",
			sourceRefs: [1, 2, 3],
			foldedTitles: ["Second"],
		});
		// The input finding is left as it was.
		expect(first.sourceRefs).toEqual([3]);
		expect(first.foldedTitles).toEqual([]);
	});

	// Fizzy #2946: folding never hides a blocking finding behind a milder
	// one, whichever comes first; the earliest still keeps its title and place.
	it.each([
		[
			"Informational then Blocking",
			"INFORMATIONAL",
			"BLOCKING",
			"BLOCKING",
		],
		[
			"Blocking then Informational",
			"BLOCKING",
			"INFORMATIONAL",
			"BLOCKING",
		],
		["Important then Blocking", "IMPORTANT", "BLOCKING", "BLOCKING"],
		[
			"Informational then Important",
			"INFORMATIONAL",
			"IMPORTANT",
			"IMPORTANT",
		],
	] as const)(
		"keeps the most severe classification when folding %s",
		(_order, earliest, later, expected) => {
			const { kept, folded } = foldByStableKey([
				keyed({ severity: earliest, title: "Earliest" }),
				keyed({ stableKey: "k1:other", title: "Other" }),
				keyed({ severity: later, title: "Later" }),
			]);

			expect(folded).toBe(1);
			expect(kept.map((finding) => finding.title)).toEqual([
				"Earliest",
				"Other",
			]);
			expect(kept[0]).toMatchObject({
				severity: expected,
				title: "Earliest",
				foldedTitles: ["Later"],
			});
			// The finding with another key keeps its own.
			expect(kept[1]?.severity).toBe("IMPORTANT");
		},
	);

	it("keeps Blocking when a milder finding folds into a Blocking one", () => {
		const { kept } = foldByStableKey([
			keyed({ severity: "BLOCKING", title: "Earliest" }),
			keyed({ severity: "INFORMATIONAL", title: "Later" }),
			keyed({ severity: "IMPORTANT", title: "Last" }),
		]);

		expect(kept).toHaveLength(1);
		expect(kept[0]?.severity).toBe("BLOCKING");
	});

	it(`keeps at most ${MAX_FOLDED_TITLES} folded titles`, () => {
		const findings = Array.from({ length: MAX_FOLDED_TITLES + 5 }, (_, i) =>
			keyed({ title: `Title ${i}` }),
		);

		const { kept } = foldByStableKey(findings);

		expect(kept).toHaveLength(1);
		expect(kept[0]?.foldedTitles).toHaveLength(MAX_FOLDED_TITLES);
	});
});

describe("toStoredFindings", () => {
	const scope = MAP.sections.find(
		(section) => section.headingText === "Scope",
	);

	it("stores enum values, bounded text and the listed section's key and hash", () => {
		const scopeIndex = MAP.sections.indexOf(scope ?? MAP.sections[0]);
		const { findings, folded, droppedRefs } = toStoredFindings(
			[
				modelFinding({
					severity: "Blocking",
					type: "Source Validation",
					title: `  ${"t".repeat(FINDING_TITLE_MAX_CHARS + 10)}  `,
					sectionIndex: scopeIndex + 1,
					sectionHeading: "Scope",
					sourceRefs: [2, 9, 2],
				}),
			],
			resolution(),
		);

		expect(folded).toBe(0);
		expect(droppedRefs).toBe(2);
		expect(findings).toHaveLength(1);
		const [stored] = findings;
		expect(stored).toMatchObject({
			severity: "BLOCKING",
			type: "SOURCE_VALIDATION",
			sectionKey: scope?.key,
			sectionHash: scope?.proseHash,
			sectionHeading: "Scope",
			sourceRefs: [2],
			foldedTitles: [],
		});
		expect(Array.from(stored?.title ?? "")).toHaveLength(
			FINDING_TITLE_MAX_CHARS,
		);
		expect(stored?.stableKey).toBe(
			findingStableKey({
				type: "SOURCE_VALIDATION",
				sectionKey: scope?.key ?? "",
				subject: "single sign on",
			}),
		);
	});

	it("files a finding with no usable section under the whole document", () => {
		const { findings } = toStoredFindings(
			[modelFinding({ sectionIndex: 99 })],
			resolution(),
		);

		expect(findings[0]).toMatchObject({
			sectionKey: DOCUMENT_SECTION_KEY,
			sectionHash: MAP.documentProseHash,
		});
	});

	it("drops a finding with no title or no detail", () => {
		const { findings } = toStoredFindings(
			[
				modelFinding({ title: "  " }),
				modelFinding({ detail: "" }),
				modelFinding({ title: "Kept" }),
			],
			resolution(),
		);

		expect(findings.map((finding) => finding.title)).toEqual(["Kept"]);
	});

	it("keys a finding with no subject by its title", () => {
		const { findings } = toStoredFindings(
			[
				modelFinding({ subject: null, title: "The Payment Terms" }),
				modelFinding({ subject: "  ", title: "Payment terms!" }),
			],
			resolution(),
		);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.stableKey).toBe(
			findingStableKey({
				type: "SCOPE",
				sectionKey: DOCUMENT_SECTION_KEY,
				subject: "payment terms",
			}),
		);
	});

	it("folds same-key findings and counts them", () => {
		const { findings, folded } = toStoredFindings(
			[
				modelFinding({ title: "Single sign-on is missing" }),
				modelFinding({
					title: "No SSO",
					subject: "Single Sign-On",
					detail: "SSO is absent.",
				}),
			],
			resolution(),
		);

		expect(folded).toBe(1);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.foldedTitles).toEqual(["No SSO"]);
		expect(findings[0]?.detail).toBe(
			"The proposal never mentions single sign-on.\n\nSSO is absent.",
		);
	});

	it(`keeps at most ${MAX_FINDINGS}, in the model's order`, () => {
		const { findings } = toStoredFindings(
			Array.from({ length: MAX_FINDINGS + 5 }, (_, i) =>
				modelFinding({
					subject: `subject ${i}`,
					title: `Finding ${i}`,
				}),
			),
			resolution(),
		);

		expect(findings).toHaveLength(MAX_FINDINGS);
		expect(findings[0]?.title).toBe("Finding 0");
		expect(findings.at(-1)?.title).toBe(`Finding ${MAX_FINDINGS - 1}`);
	});

	it("caps a folded detail at the detail limit", () => {
		const long = "d".repeat(FINDING_DETAIL_MAX_CHARS - 5);
		const { findings } = toStoredFindings(
			[
				modelFinding({ detail: long }),
				modelFinding({ detail: "Another detail entirely." }),
			],
			resolution(),
		);

		expect(Array.from(findings[0]?.detail ?? "")).toHaveLength(
			FINDING_DETAIL_MAX_CHARS,
		);
	});
});
