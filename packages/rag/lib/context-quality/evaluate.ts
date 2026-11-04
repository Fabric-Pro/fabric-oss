import { createHash } from "node:crypto";
import { z } from "zod";
import {
	CONTEXT_QUALITY_SCORER_VERSION,
	type ContextQualityCase,
	type ContextQualityCheck,
	type ContextQualityInput,
	type ContextQualityResult,
	contextQualityInputSchema,
} from "./types";

/** Content identity, not proof of who produced or is allowed to read it. */
export function contextQualitySourceRevision(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function hash(value: unknown): string {
	return contextQualitySourceRevision(canonical(value));
}

function sorted(values: string[]): string[] {
	return [...values].sort();
}

function normalize(input: ContextQualityInput): ContextQualityInput {
	return {
		version: 1,
		sources: [...input.sources].sort((a, b) =>
			a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
		),
		cases: [...input.cases]
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
			.map((entry) => ({
				...entry,
				retrievedSourceIds: sorted(entry.retrievedSourceIds),
				citedSourceIds: sorted(entry.citedSourceIds),
				expectations: {
					expectedSourceIds: sorted(
						entry.expectations.expectedSourceIds,
					),
					requiredPhrases: sorted(entry.expectations.requiredPhrases),
					forbiddenPhrases: sorted(
						entry.expectations.forbiddenPhrases,
					),
				},
			})),
	};
}

function metrics(actual: string[], expected: string[]) {
	if (expected.length === 0) {
		return { precision: null, recall: null };
	}
	const relevant = new Set(expected);
	const matched = actual.filter((id) => relevant.has(id)).length;
	return {
		precision: actual.length === 0 ? 0 : matched / actual.length,
		recall: matched / expected.length,
	};
}

function evaluateCase(
	entry: ContextQualityCase,
	available: Set<string>,
): ContextQualityResult["cases"][number] {
	const checks: ContextQualityCheck[] = [];
	const check = (
		id: ContextQualityCheck["id"],
		category: ContextQualityCheck["category"],
		passed: boolean,
	) => {
		checks.push({ id, category, status: passed ? "passed" : "failed" });
	};
	const retrieved = new Set(entry.retrievedSourceIds);
	const cited = new Set(entry.citedSourceIds);
	const expected = entry.expectations.expectedSourceIds;
	check(
		"recorded-answer-present",
		"integrity",
		entry.recordedAnswer.trim().length > 0,
	);
	check(
		"retrieved-sources-available",
		"integrity",
		entry.retrievedSourceIds.every((id) => available.has(id)),
	);
	check(
		"cited-sources-available",
		"integrity",
		entry.citedSourceIds.every((id) => available.has(id)),
	);
	check(
		"citations-retrieved",
		"integrity",
		entry.citedSourceIds.every((id) => retrieved.has(id)),
	);
	if (expected.length > 0) {
		check(
			"expected-sources-available",
			"integrity",
			expected.every((id) => available.has(id)),
		);
		check(
			"expected-sources-retrieved",
			"quality",
			expected.every((id) => retrieved.has(id)),
		);
		check(
			"expected-sources-cited",
			"quality",
			expected.every((id) => cited.has(id)),
		);
		check(
			"citation-precision",
			"quality",
			metrics(entry.citedSourceIds, expected).precision === 1,
		);
	}
	if (entry.expectations.requiredPhrases.length > 0) {
		check(
			"required-phrases",
			"quality",
			entry.expectations.requiredPhrases.every((phrase) =>
				entry.recordedAnswer.includes(phrase),
			),
		);
	}
	if (entry.expectations.forbiddenPhrases.length > 0) {
		check(
			"forbidden-phrases",
			"quality",
			entry.expectations.forbiddenPhrases.every(
				(phrase) => !entry.recordedAnswer.includes(phrase),
			),
		);
	}
	return {
		id: entry.id,
		status: checks.every((item) => item.status === "passed")
			? "passed"
			: "failed",
		checks,
		retrieval: metrics(entry.retrievedSourceIds, expected),
		citations: metrics(entry.citedSourceIds, expected),
	};
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) {
			deepFreeze(child);
		}
		Object.freeze(value);
	}
	return value;
}

/**
 * Scores supplied recorded outputs, never invokes retrieval, a model or a tool.
 * Phrase checks are literal and case-sensitive, not semantic groundedness.
 * Callers authorize every snapshot before invoking this function. A passed
 * report is no source-permission, secret-detection or full-replay certificate.
 */
export function evaluateContextQuality(input: unknown): ContextQualityResult {
	const parsed = contextQualityInputSchema.parse(input);
	for (const [index, source] of parsed.sources.entries()) {
		if (contextQualitySourceRevision(source.content) !== source.revision) {
			throw new z.ZodError([
				{
					code: "custom",
					path: ["sources", index, "revision"],
					message: "Source revision does not match supplied content",
				},
			]);
		}
	}
	const snapshot = normalize(parsed);
	const sourceManifest = snapshot.sources.map(({ id, revision }) => ({
		id,
		revision,
	}));
	const cases = snapshot.cases.map((entry) =>
		evaluateCase(
			entry,
			new Set(snapshot.sources.map((source) => source.id)),
		),
	);
	const failed = cases.filter((entry) => entry.status === "failed").length;
	const failingChecks = cases
		.flatMap((entry) => entry.checks)
		.filter((check) => check.status === "failed");
	return deepFreeze({
		version: 1,
		mode: "recorded-output",
		scorerVersion: CONTEXT_QUALITY_SCORER_VERSION,
		datasetHash: hash({
			version: 1,
			sources: sourceManifest,
			cases: snapshot.cases.map(({ id, expectations }) => ({
				id,
				expectations,
			})),
		}),
		configurationHash: hash({
			scorerVersion: CONTEXT_QUALITY_SCORER_VERSION,
			phraseMatching: "literal-case-sensitive",
			expectedSourceMatching: "exact-identifiers",
			requiredSourceRecall: 1,
			requiredCitationPrecision: 1,
			unavailableEvidence: "fail",
		}),
		snapshotHash: hash(snapshot),
		status: failed === 0 ? "passed" : "failed",
		counts: {
			cases: cases.length,
			passed: cases.length - failed,
			failed,
			integrityFailures: failingChecks.filter(
				(check) => check.category === "integrity",
			).length,
			qualityFailures: failingChecks.filter(
				(check) => check.category === "quality",
			).length,
		},
		sources: sourceManifest,
		cases,
	});
}
