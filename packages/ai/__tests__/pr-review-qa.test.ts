/**
 * `groundFindings` — the QA lens's false-positive control.
 *
 * This is the part of the QA review lens that decides whether the finding list is
 * worth reading, and it is deliberately code rather than prompt wording: a model
 * told "do not invent a file path" invents file paths anyway. So these tests are
 * the contract, not a smoke check.
 *
 * The rules being pinned, and why each is drop vs strip:
 *   - a path the diff does not contain DROPS the finding (the model asserted a
 *     location and got it wrong — it is not a good finding with a bad citation);
 *   - no path at all is KEPT (an observation about the change as a whole is
 *     legitimate);
 *   - an unknown feature identifier STRIPS the link and keeps the finding;
 *   - a criterion ref past the end of that feature's parsed criteria is STRIPPED,
 *     because it points at a matrix row that does not exist.
 */

import { describe, expect, it } from "vitest";

import {
	buildPrReviewContext,
	composePrReviewPrompt,
	diffAddedLines,
	diffFilePaths,
	groundFindings,
	numberDiffLines,
	PR_REVIEW_MAX_FINDINGS,
	PR_REVIEW_MODEL_DIFF_BYTES,
	type PrReviewFeature,
	prReviewMaxOutputTokens,
} from "../lib/prompts/pr-review-qa";

const DIFF = [
	"diff --git a/src/payments/capture.ts b/src/payments/capture.ts",
	"index 111..222 100644",
	"--- a/src/payments/capture.ts",
	"+++ b/src/payments/capture.ts",
	"@@ -1,3 +1,7 @@",
	"+export function retryCapture() {}",
	"diff --git a/src/legacy/old-tax.ts b/dev/null",
	"--- a/src/legacy/old-tax.ts",
	"+++ /dev/null",
].join("\n");

const FEATURES: PrReviewFeature[] = [
	{
		storyId: "story-1",
		identifier: "F-102",
		title: "Resilient checkout",
		acceptanceCriteria:
			"- Capture retries once\n- A retry never double-charges",
		linkedCaseTitles: ["Capture retries once on timeout"],
	},
	{
		storyId: "story-2",
		identifier: "B-14",
		title: "Refund rounding",
		acceptanceCriteria: null,
		linkedCaseTitles: [],
	},
];

function raw(
	over: Partial<Parameters<typeof groundFindings>[0]["raw"][number]>,
) {
	return {
		severity: "medium",
		title: "Retry path is untested",
		detail: "The new retry branch has no case asserting a single capture.",
		recommendation:
			"Add a case that retries a failed capture twice and asserts one charge.",
		filePath: "",
		line: "",
		storyIdentifier: "",
		criterionRef: "",
		...over,
	};
}

function ground(items: Array<ReturnType<typeof raw>>) {
	return groundFindings({ raw: items, diff: DIFF, features: FEATURES });
}

describe("diffFilePaths", () => {
	it("collects both sides so a deleted file is still citable", () => {
		const paths = diffFilePaths(DIFF);
		expect(paths.has("src/payments/capture.ts")).toBe(true);
		// The `a/` side of a deletion — citing it must not be treated as invented.
		expect(paths.has("src/legacy/old-tax.ts")).toBe(true);
	});

	it("finds nothing in a diff with no headers", () => {
		expect(diffFilePaths("just some prose").size).toBe(0);
	});
});

describe("composePrReviewPrompt", () => {
	// The depth clause was computed and then left out of the prompt, so an EASY
	// project got a HARD-shaped review and the tier only decided how many of the
	// findings survived the cap. A reviewer told nothing about scope reports
	// security and performance gaps a light project deliberately did not ask for.
	it("tells the model the project's depth tier", () => {
		const prompt = composePrReviewPrompt({
			body: "BODY",
			strategyDepth: "EASY",
			facts: "FACTS",
		});

		expect(prompt).toContain("QA depth for this project is EASY");
		expect(prompt).toContain("BODY");
		expect(prompt).toContain("FACTS");
	});

	it.each([["HARD"], ["AVERAGE"]])("carries the %s clause", (depth) => {
		expect(
			composePrReviewPrompt({
				body: "B",
				strategyDepth: depth,
				facts: "F",
			}),
		).toContain(`QA depth for this project is ${depth}`);
	});

	it("falls back to AVERAGE for an unset or unknown tier", () => {
		for (const depth of [null, undefined, "whatever"]) {
			expect(
				composePrReviewPrompt({
					body: "B",
					strategyDepth: depth,
					facts: "F",
				}),
			).toContain("QA depth for this project is AVERAGE");
		}
	});

	it("puts the instructions and the tier ahead of the facts", () => {
		const prompt = composePrReviewPrompt({
			body: "BODY",
			strategyDepth: "EASY",
			facts: "FACTS",
		});

		expect(prompt.indexOf("BODY")).toBeLessThan(prompt.indexOf("QA depth"));
		expect(prompt.indexOf("QA depth")).toBeLessThan(
			prompt.indexOf("FACTS"),
		);
	});
});

describe("groundFindings", () => {
	it("keeps a finding citing a path the diff actually touches", () => {
		const { findings, dropped } = ground([
			raw({ filePath: "src/payments/capture.ts" }),
		]);

		expect(dropped).toBe(0);
		expect(findings).toHaveLength(1);
		expect(findings[0].filePath).toBe("src/payments/capture.ts");
	});

	it("DROPS a finding citing a path the diff never touched", () => {
		// The whole point of the filter: a model that names a file it did not see
		// has drifted, and the observation cannot be trusted either.
		const { findings, dropped } = ground([
			raw({ filePath: "src/billing/invoice.ts" }),
		]);

		expect(findings).toHaveLength(0);
		expect(dropped).toBe(1);
	});

	it("keeps a finding that cites no path at all", () => {
		const { findings, dropped } = ground([raw({ filePath: "" })]);

		expect(dropped).toBe(0);
		expect(findings[0].filePath).toBeNull();
	});

	it("resolves a known feature identifier to its story id", () => {
		const { findings } = ground([raw({ storyIdentifier: "F-102" })]);

		expect(findings[0].storyId).toBe("story-1");
	});

	it("matches a feature identifier case- and space-insensitively", () => {
		const { findings } = ground([raw({ storyIdentifier: "  f-102 " })]);

		expect(findings[0].storyId).toBe("story-1");
	});

	it("STRIPS an unknown feature link but keeps the finding", () => {
		// Unlike a bad path, an unattached observation about the diff still stands.
		const { findings, dropped } = ground([
			raw({ storyIdentifier: "F-999", criterionRef: "AC 1" }),
		]);

		expect(dropped).toBe(0);
		expect(findings).toHaveLength(1);
		expect(findings[0].storyId).toBeNull();
		// Without a feature there is nothing for the ref to resolve against.
		expect(findings[0].criterionRef).toBeNull();
	});

	it("keeps a criterion ref that resolves within the feature's criteria", () => {
		const { findings } = ground([
			raw({ storyIdentifier: "F-102", criterionRef: "AC 2" }),
		]);

		expect(findings[0].criterionRef).toBe("AC 2");
	});

	it("STRIPS a criterion ref past the end of the feature's criteria", () => {
		// F-102 has two criteria; "AC 7" points at a traceability row that does
		// not exist, which is exactly the wrong-row bug the shared parser fixed.
		const { findings } = ground([
			raw({ storyIdentifier: "F-102", criterionRef: "AC 7" }),
		]);

		expect(findings[0].storyId).toBe("story-1");
		expect(findings[0].criterionRef).toBeNull();
	});

	it("STRIPS any criterion ref on a feature with no criteria recorded", () => {
		const { findings } = ground([
			raw({ storyIdentifier: "B-14", criterionRef: "AC 1" }),
		]);

		expect(findings[0].storyId).toBe("story-2");
		expect(findings[0].criterionRef).toBeNull();
	});

	it("drops a finding with no title or no detail", () => {
		const { findings, dropped } = ground([
			raw({ title: "   " }),
			raw({ detail: "" }),
		]);

		expect(findings).toHaveLength(0);
		expect(dropped).toBe(2);
	});

	// The requirement is that every flag carries a remediation, and the only way
	// to keep that true is to refuse the ones that do not. A finding that
	// describes a gap and proposes nothing reads as complete and leaves the
	// reader exactly where they started.
	it("drops a finding that proposes no remediation", () => {
		const { findings, dropped } = ground([
			raw({ recommendation: "" }),
			raw({ recommendation: "   " }),
			raw({ recommendation: undefined }),
		]);

		expect(findings).toHaveLength(0);
		expect(dropped).toBe(3);
	});

	it("keeps the remediation apart from the diagnosis", () => {
		const { findings } = ground([
			raw({
				detail: "The retry branch has no case.",
				recommendation:
					"Add a case asserting one charge after two retries.",
			}),
		]);

		expect(findings[0].detail).toBe("The retry branch has no case.");
		expect(findings[0].recommendation).toBe(
			"Add a case asserting one charge after two retries.",
		);
	});

	it.each([
		["high", "HIGH"],
		["HIGH", "HIGH"],
		["Critical", "HIGH"],
		["low", "LOW"],
		["Minor", "LOW"],
		["medium", "MEDIUM"],
		["moderate", "MEDIUM"],
		["", "MEDIUM"],
		["whatever the model felt like saying", "MEDIUM"],
	])("normalizes severity %j to %s", (input, expected) => {
		const { findings } = ground([raw({ severity: input })]);

		expect(findings[0].severity).toBe(expected);
	});

	it("caps the list and sheds the least severe, not the last", () => {
		const items = [
			...Array.from({ length: PR_REVIEW_MAX_FINDINGS }, (_, i) =>
				raw({ severity: "low", title: `low ${i}` }),
			),
			raw({ severity: "high", title: "the one that matters" }),
		];

		const { findings } = ground(items);

		expect(findings).toHaveLength(PR_REVIEW_MAX_FINDINGS);
		expect(findings[0].title).toBe("the one that matters");
	});

	it("returns nothing for an empty model response", () => {
		const { findings, dropped } = ground([]);

		expect(findings).toEqual([]);
		expect(dropped).toBe(0);
	});
});

describe("buildPrReviewContext", () => {
	/**
	 * The two bounds are easy to invert by editing one and forgetting the other,
	 * and the failure is silent: the model would be handed more diff than Fabric
	 * ever stored, so it would reason over text no reader can go back and check.
	 * 400_000 is `PR_REVIEW_MAX_DIFF_BYTES` in the API package — duplicated as a
	 * literal here rather than imported, because @repo/ai must not depend on
	 * @repo/api.
	 */
	it("never shows the model more diff than Fabric stores", () => {
		expect(PR_REVIEW_MODEL_DIFF_BYTES).toBeLessThan(400_000);
	});

	it("tells the model when the STORED diff was already truncated", () => {
		const context = buildPrReviewContext({
			diff: "diff --git a/a.ts b/a.ts",
			diffTruncated: true,
			features: [],
		});

		// Without this the lens reports the half it cannot see as untested.
		expect(context).toContain("only PART of the change");
	});

	it("tells the model when IT is the one truncating", () => {
		const context = buildPrReviewContext({
			diff: "x".repeat(PR_REVIEW_MODEL_DIFF_BYTES + 1),
			diffTruncated: false,
			features: [],
		});

		expect(context).toContain("only PART of the change");
	});

	it("says the change is complete when neither bound bit", () => {
		const context = buildPrReviewContext({
			diff: "diff --git a/a.ts b/a.ts",
			diffTruncated: false,
			features: [],
		});

		expect(context).toContain("This is the complete change.");
		expect(context).not.toContain("only PART of the change");
	});

	it("numbers criteria the way the shared parser does, so a ref can resolve", () => {
		const context = buildPrReviewContext({
			diff: "diff --git a/a.ts b/a.ts",
			diffTruncated: false,
			features: [
				{
					storyId: "story-1",
					identifier: "F-102",
					title: "Resilient checkout",
					acceptanceCriteria:
						"- Capture retries once\n- Never double-charges",
					linkedCaseTitles: ["Capture retries once on timeout"],
				},
			],
		});

		expect(context).toContain("AC 1: Capture retries once");
		expect(context).toContain("AC 2: Never double-charges");
		// The case titles are the ONLY evidence of coverage the lens is given.
		expect(context).toContain("Capture retries once on timeout");
	});

	it("says so explicitly when a feature has no criteria or no cases", () => {
		const context = buildPrReviewContext({
			diff: "diff --git a/a.ts b/a.ts",
			diffTruncated: false,
			features: [
				{
					storyId: "story-2",
					identifier: "B-14",
					title: "Refund rounding",
					acceptanceCriteria: null,
					linkedCaseTitles: [],
				},
			],
		});

		// An absent list must read as absent, not as an empty section the model
		// fills in with an assumption.
		expect(context).toContain("no acceptance criteria recorded");
		expect(context).toContain("no test cases linked to this feature");
	});
});

describe("diffAddedLines", () => {
	it("maps each file to the NEW-side lines the change added", () => {
		const lines = diffAddedLines(DIFF);

		// The hunk header is @@ -1,3 +1,7 @@ and the single added line is the first
		// of the new side, so line 1 belongs to capture.ts.
		expect(lines.get("src/payments/capture.ts")?.has(1)).toBe(true);
	});

	it("advances the counter over context lines, not just added ones", () => {
		const diff = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -10,3 +10,4 @@",
			" const untouched = 1;",
			"-const removed = 2;",
			"+const added = 3;",
		].join("\n");

		const lines = diffAddedLines(diff);

		// Context line is new-line 10, the removed line advances nothing, so the
		// added line is 11. Getting this wrong is how a finding cites the line above.
		expect([...(lines.get("a.ts") ?? [])]).toEqual([11]);
	});
});

describe("grounding a claimed line", () => {
	it("keeps a line the diff actually added", () => {
		const { findings } = ground([
			raw({ filePath: "src/payments/capture.ts", line: "1" }),
		]);

		expect(findings[0].line).toBe(1);
	});

	it("STRIPS a line the diff never added, keeping the finding", () => {
		// A line the model invented sends a reader to the wrong place and looks
		// authoritative doing it. The observation may still be right about the file.
		const { findings, dropped } = ground([
			raw({ filePath: "src/payments/capture.ts", line: "4096" }),
		]);

		expect(dropped).toBe(0);
		expect(findings[0].filePath).toBe("src/payments/capture.ts");
		expect(findings[0].line).toBeNull();
	});

	it("strips a line when no file was claimed to anchor it", () => {
		const { findings } = ground([raw({ filePath: "", line: "1" })]);

		expect(findings[0].line).toBeNull();
	});

	it.each(["", "  ", "not a number", "0"])(
		"treats %j as no line at all",
		(value) => {
			const { findings } = ground([
				raw({ filePath: "src/payments/capture.ts", line: value }),
			]);

			expect(findings[0].line).toBeNull();
		},
	);
});

/**
 * The output budget for the review call.
 *
 * This call ran with no budget at all until the repository's own CI review
 * flagged it. An unbounded structured generation does not fail as an error, it
 * fails as a hang, and the feature reads as broken rather than slow — the exact
 * class of failure this stack has already paid for elsewhere.
 */
describe("prReviewMaxOutputTokens", () => {
	it("leaves room for a full-size finding list", () => {
		// The prompt asks for up to PR_REVIEW_MAX_FINDINGS, so the budget has to
		// cover that many without truncating — a truncated structured response
		// surfaces as a schema error, not as a shorter list.
		const full = prReviewMaxOutputTokens(PR_REVIEW_MAX_FINDINGS);
		expect(full).toBeGreaterThanOrEqual(800 + PR_REVIEW_MAX_FINDINGS * 200);
	});

	it("grows with the number of findings asked for", () => {
		expect(prReviewMaxOutputTokens(12)).toBeGreaterThan(
			prReviewMaxOutputTokens(4),
		);
	});

	it("never returns a budget too small to hold the envelope", () => {
		// A caller passing 0 or a negative must still get a usable budget rather
		// than one that guarantees a truncated response.
		expect(prReviewMaxOutputTokens(0)).toBeGreaterThan(800);
		expect(prReviewMaxOutputTokens(-5)).toBeGreaterThan(800);
	});

	it("does not grow without bound when asked for more than the cap", () => {
		expect(prReviewMaxOutputTokens(1000)).toBe(
			prReviewMaxOutputTokens(PR_REVIEW_MAX_FINDINGS),
		);
	});
});

describe("numberDiffLines", () => {
	// A finding is meant to carry a file AND a line, and grounding keeps a line
	// only when the diff added it. The model was guessing because a unified diff
	// never states a line number — the hunk header gives an offset and the reader
	// counts. These numbers are the ones grounding will accept.
	const DIFF_WITH_HUNK = [
		"diff --git a/src/a.ts b/src/a.ts",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -10,3 +10,4 @@",
		" const before = 1;",
		"+const added = 2;",
		"-const removed = 3;",
		" const after = 4;",
	].join("\n");

	it("numbers added lines with their new-file line", () => {
		const numbered = numberDiffLines(DIFF_WITH_HUNK);

		expect(numbered).toContain("    11 +const added = 2;");
	});

	it("numbers context lines, because a gap often sits beside the change", () => {
		const numbered = numberDiffLines(DIFF_WITH_HUNK);

		expect(numbered).toContain("    10  const before = 1;");
		expect(numbered).toContain("    12  const after = 4;");
	});

	it("leaves a removed line unnumbered", () => {
		// It is not in the new file. A number here would invite a citation to a
		// line that no longer exists, which grounding would strip anyway.
		const line = numberDiffLines(DIFF_WITH_HUNK)
			.split("\n")
			.find((l) => l.includes("-const removed"));

		expect(line).toBe("       -const removed = 3;");
	});

	it("leaves the headers alone so the paths still parse", () => {
		const numbered = numberDiffLines(DIFF_WITH_HUNK);

		expect(numbered).toContain("diff --git a/src/a.ts b/src/a.ts");
		expect(numbered).toContain("+++ b/src/a.ts");
		// The path parser reads these lines, and a numeric prefix would break it.
		expect(diffFilePaths(numbered).has("src/a.ts")).toBe(true);
	});

	it("restarts the count at each hunk", () => {
		const twoHunks = [
			"+++ b/src/a.ts",
			"@@ -1,1 +1,1 @@",
			"+first",
			"@@ -90,1 +90,1 @@",
			"+ninetieth",
		].join("\n");

		const numbered = numberDiffLines(twoHunks);

		expect(numbered).toContain("     1 +first");
		expect(numbered).toContain("    90 +ninetieth");
	});
});
