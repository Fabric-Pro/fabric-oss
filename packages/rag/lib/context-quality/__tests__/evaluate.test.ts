import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
	CONTEXT_QUALITY_MAX_BYTES,
	CONTEXT_QUALITY_MAX_CASES,
	CONTEXT_QUALITY_SCORER_VERSION,
	type ContextQualityInput,
	contextQualityInputSchema,
	contextQualityResultSchema,
	contextQualitySourceRevision,
	evaluateContextQuality,
} from "..";

function source(id = "example-source", content = "Approved product context") {
	return { id, content, revision: contextQualitySourceRevision(content) };
}

function fixture(): ContextQualityInput {
	return {
		version: 1,
		sources: [source()],
		cases: [
			{
				id: "example-case",
				recordedAnswer: "Customers may cancel appointments online.",
				retrievedSourceIds: ["example-source"],
				citedSourceIds: ["example-source"],
				expectations: {
					expectedSourceIds: ["example-source"],
					requiredPhrases: ["cancel appointments online"],
					forbiddenPhrases: ["call the clinic"],
				},
			},
		],
	};
}

describe("recorded-output context quality", () => {
	it("scores complete authorized evidence with versioned pins and no raw content", () => {
		const input = fixture();
		const result = evaluateContextQuality(input);
		expect(result).toMatchObject({
			version: 1,
			mode: "recorded-output",
			scorerVersion: CONTEXT_QUALITY_SCORER_VERSION,
			status: "passed",
			counts: {
				cases: 1,
				passed: 1,
				failed: 0,
				integrityFailures: 0,
				qualityFailures: 0,
			},
			cases: [
				{
					status: "passed",
					retrieval: { recall: 1, precision: 1 },
					citations: { recall: 1, precision: 1 },
				},
			],
		});
		for (const pin of [
			result.datasetHash,
			result.configurationHash,
			result.snapshotHash,
		]) {
			expect(pin).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(contextQualityResultSchema.parse(result)).toEqual(result);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(input.sources[0].content);
		expect(serialized).not.toContain(input.cases[0].recordedAnswer);
		expect(serialized).not.toContain(
			input.cases[0].expectations.requiredPhrases[0],
		);
	});

	it("keeps every failed case in the denominator", () => {
		const input = fixture();
		input.cases.push({
			...input.cases[0],
			id: "missing-answer",
			recordedAnswer: "",
		});
		input.cases.push({
			...input.cases[0],
			id: "wrong-answer",
			recordedAnswer: "Please call the clinic.",
		});
		const result = evaluateContextQuality(input);
		expect(result.status).toBe("failed");
		expect(result.counts).toEqual({
			cases: 3,
			passed: 1,
			failed: 2,
			integrityFailures: 1,
			qualityFailures: 3,
		});
		expect(
			result.cases.find((entry) => entry.id === "missing-answer")?.checks,
		).toContainEqual({
			id: "recorded-answer-present",
			category: "integrity",
			status: "failed",
		});
	});

	it("fails missing expected retrieval and citations instead of scoring empty sets as perfect", () => {
		const input = fixture();
		input.cases[0].retrievedSourceIds = [];
		input.cases[0].citedSourceIds = [];
		const result = evaluateContextQuality(input);
		expect(result.status).toBe("failed");
		expect(result.cases[0].retrieval).toEqual({ recall: 0, precision: 0 });
		expect(result.cases[0].citations).toEqual({ recall: 0, precision: 0 });
		expect(result.counts.qualityFailures).toBe(3);
	});

	it("reports missing source snapshots as unavailable evidence even when IDs claim retrieval and citations", () => {
		const input = fixture();
		input.sources = [];
		const result = evaluateContextQuality(input);
		expect(result.status).toBe("failed");
		expect(result.counts.integrityFailures).toBe(3);
		expect(
			result.cases[0].checks
				.filter((check) => check.status === "failed")
				.map((check) => check.id),
		).toEqual([
			"retrieved-sources-available",
			"cited-sources-available",
			"expected-sources-available",
		]);
	});

	it("refuses citations to an available source that was not recorded as retrieved", () => {
		const input = fixture();
		input.cases[0].retrievedSourceIds = [];
		const result = evaluateContextQuality(input);
		expect(result.status).toBe("failed");
		expect(result.cases[0].checks).toContainEqual({
			id: "citations-retrieved",
			category: "integrity",
			status: "failed",
		});
	});

	it("computes partial retrieval and citation precision with exact source identifiers", () => {
		const input = fixture();
		input.sources.push(source("other-source", "Other approved context"));
		input.cases[0].retrievedSourceIds.push("other-source");
		input.cases[0].citedSourceIds.push("other-source");
		const result = evaluateContextQuality(input);
		expect(result.cases[0].retrieval).toEqual({
			precision: 0.5,
			recall: 1,
		});
		expect(result.cases[0].citations).toEqual({
			precision: 0.5,
			recall: 1,
		});
		expect(result.cases[0].checks).toContainEqual({
			id: "citation-precision",
			category: "quality",
			status: "failed",
		});
	});

	it("uses literal case-sensitive phrases without claiming semantic groundedness", () => {
		const input = fixture();
		input.cases[0].recordedAnswer = "CANCEL APPOINTMENTS ONLINE";
		const result = evaluateContextQuality(input);
		expect(result.status).toBe("failed");
		expect(result.cases[0].checks).toContainEqual({
			id: "required-phrases",
			category: "quality",
			status: "failed",
		});
		expect(JSON.stringify(result)).not.toContain("groundedness");
	});

	it("leaves irrelevant retrieval metrics unknown for answer-only expectations", () => {
		const input = fixture();
		input.sources = [];
		input.cases[0].expectations.expectedSourceIds = [];
		input.cases[0].retrievedSourceIds = [];
		input.cases[0].citedSourceIds = [];
		const result = evaluateContextQuality(input);
		expect(result.status).toBe("passed");
		expect(result.cases[0].retrieval).toEqual({
			precision: null,
			recall: null,
		});
		expect(result.cases[0].citations).toEqual({
			precision: null,
			recall: null,
		});
	});

	it("pins dataset and exact evidence independently of output changes", () => {
		const original = fixture();
		const baseline = evaluateContextQuality(original);
		const changedAnswer = structuredClone(original);
		changedAnswer.cases[0].recordedAnswer = "A different recorded answer";
		const answerResult = evaluateContextQuality(changedAnswer);
		expect(answerResult.datasetHash).toBe(baseline.datasetHash);
		expect(answerResult.configurationHash).toBe(baseline.configurationHash);
		expect(answerResult.snapshotHash).not.toBe(baseline.snapshotHash);
		const changedSource = structuredClone(original);
		changedSource.sources[0] = source("example-source", "Updated context");
		const sourceResult = evaluateContextQuality(changedSource);
		expect(sourceResult.datasetHash).not.toBe(baseline.datasetHash);
		expect(sourceResult.snapshotHash).not.toBe(baseline.snapshotHash);
		const changedExpectations = structuredClone(original);
		changedExpectations.cases[0].expectations.requiredPhrases = [
			"new criterion",
		];
		expect(
			evaluateContextQuality(changedExpectations).datasetHash,
		).not.toBe(baseline.datasetHash);
	});

	it("canonicalizes unordered records, fields and expectation sets", () => {
		const input = fixture();
		input.sources.push(source("second-source", "Second document"));
		input.cases.push({
			...structuredClone(input.cases[0]),
			id: "second-case",
		});
		input.cases[0].expectations.requiredPhrases.push("Customers");
		const reordered = {
			cases: structuredClone(input.cases).reverse(),
			sources: [...input.sources].reverse(),
			version: 1,
		};
		reordered.cases[1].expectations.requiredPhrases.reverse();
		expect(evaluateContextQuality(reordered)).toEqual(
			evaluateContextQuality(input),
		);
	});

	it("returns deeply frozen independent JSON without mutating inputs", () => {
		const input = fixture();
		const before = structuredClone(input);
		const result = evaluateContextQuality(input);
		expect(input).toEqual(before);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.cases[0].checks[0])).toBe(true);
		expect(Object.isFrozen(result.sources[0])).toBe(true);
		expect(() => result.cases.push(result.cases[0])).toThrow(TypeError);
		input.sources[0].revision = "0".repeat(64);
		expect(result.sources[0].revision).toBe(before.sources[0].revision);
		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
	});

	it("rejects stale or forged revision-content pairs", () => {
		const input = fixture();
		input.sources[0].content = "Updated without a new revision";
		expect(() => evaluateContextQuality(input)).toThrow(ZodError);
	});

	it.each([
		[
			"unknown version",
			(input: ContextQualityInput) => ({ ...input, version: 2 }),
		],
		[
			"NaN version",
			(input: ContextQualityInput) => ({ ...input, version: Number.NaN }),
		],
		[
			"unknown config",
			(input: ContextQualityInput) => ({ ...input, scorer: "judge" }),
		],
		[
			"empty dataset",
			(input: ContextQualityInput) => ({ ...input, cases: [] }),
		],
		[
			"empty criteria",
			(input: ContextQualityInput) => ({
				...input,
				cases: [
					{
						...input.cases[0],
						expectations: {
							expectedSourceIds: [],
							requiredPhrases: [],
							forbiddenPhrases: [],
						},
					},
				],
			}),
		],
		[
			"duplicate case",
			(input: ContextQualityInput) => ({
				...input,
				cases: [...input.cases, input.cases[0]],
			}),
		],
		[
			"duplicate source",
			(input: ContextQualityInput) => ({
				...input,
				sources: [...input.sources, input.sources[0]],
			}),
		],
		[
			"duplicate retrieved ID",
			(input: ContextQualityInput) => ({
				...input,
				cases: [
					{
						...input.cases[0],
						retrievedSourceIds: [
							"example-source",
							"example-source",
						],
					},
				],
			}),
		],
		[
			"duplicate cited ID",
			(input: ContextQualityInput) => ({
				...input,
				cases: [
					{
						...input.cases[0],
						citedSourceIds: ["example-source", "example-source"],
					},
				],
			}),
		],
		[
			"duplicate expected ID",
			(input: ContextQualityInput) => ({
				...input,
				cases: [
					{
						...input.cases[0],
						expectations: {
							...input.cases[0].expectations,
							expectedSourceIds: [
								"example-source",
								"example-source",
							],
						},
					},
				],
			}),
		],
		[
			"duplicate phrase",
			(input: ContextQualityInput) => ({
				...input,
				cases: [
					{
						...input.cases[0],
						expectations: {
							...input.cases[0].expectations,
							forbiddenPhrases: ["duplicate", "duplicate"],
						},
					},
				],
			}),
		],
		[
			"blank source content",
			(input: ContextQualityInput) => ({
				...input,
				sources: [source("example-source", "   ")],
			}),
		],
		[
			"empty source content",
			(input: ContextQualityInput) => ({
				...input,
				sources: [source("example-source", "")],
			}),
		],
		[
			"whitespace phrase",
			(input: ContextQualityInput) => ({
				...input,
				cases: [
					{
						...input.cases[0],
						expectations: {
							...input.cases[0].expectations,
							requiredPhrases: [" "],
						},
					},
				],
			}),
		],
		[
			"too many cases",
			(input: ContextQualityInput) => ({
				...input,
				cases: Array.from(
					{ length: CONTEXT_QUALITY_MAX_CASES + 1 },
					(_, index) => ({ ...input.cases[0], id: `case-${index}` }),
				),
			}),
		],
	])("rejects %s", (_label, mutate) => {
		expect(() => evaluateContextQuality(mutate(fixture()))).toThrow(
			ZodError,
		);
	});

	it("enforces the total serialized UTF-8 limit rather than UTF-16 character count", () => {
		const input = fixture();
		const content = "😀".repeat(16_384);
		input.sources = [
			source("example-source", content),
			source("second-source", content),
		];
		expect(JSON.stringify(input).length).toBeLessThan(
			CONTEXT_QUALITY_MAX_BYTES,
		);
		expect(
			Buffer.byteLength(JSON.stringify(input), "utf8"),
		).toBeGreaterThan(CONTEXT_QUALITY_MAX_BYTES);
		expect(contextQualityInputSchema.safeParse(input).success).toBe(false);
		expect(() => evaluateContextQuality(input)).toThrow(ZodError);
	});

	it("accepts all cases up to the bounded maximum without sampling", () => {
		const input = fixture();
		input.cases = Array.from(
			{ length: CONTEXT_QUALITY_MAX_CASES },
			(_, index) => ({ ...input.cases[0], id: `case-${index}` }),
		);
		const result = evaluateContextQuality(input);
		expect(result.counts).toMatchObject({
			cases: 50,
			passed: 50,
			failed: 0,
		});
		expect(result.cases).toHaveLength(50);
	});
});
