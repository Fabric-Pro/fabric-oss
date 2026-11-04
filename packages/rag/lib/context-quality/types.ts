import { z } from "zod";

export const CONTEXT_QUALITY_MAX_CASES = 50;
export const CONTEXT_QUALITY_MAX_SOURCES = 50;
export const CONTEXT_QUALITY_MAX_BYTES = 128 * 1024;
export const CONTEXT_QUALITY_SCORER_VERSION = "fabric-deterministic-context-v1";

const identifier = z
	.string()
	.min(1)
	.max(128)
	.refine((value) => value.trim().length > 0);
const phrase = z
	.string()
	.min(1)
	.max(512)
	.refine((value) => value.trim().length > 0);
const sourceIds = z.array(identifier).max(CONTEXT_QUALITY_MAX_SOURCES);

function requireUnique(
	values: readonly string[],
	context: z.RefinementCtx,
	path: (string | number)[] = [],
) {
	if (new Set(values).size !== values.length) {
		context.addIssue({
			code: "custom",
			path,
			message: "Duplicate identifiers or expectations",
		});
	}
}

export const contextQualitySourceSchema = z.strictObject({
	id: identifier,
	revision: z.string().regex(/^[0-9a-f]{64}$/),
	content: z
		.string()
		.min(1)
		.max(96 * 1024)
		.refine((value) => value.trim().length > 0),
});

export const contextQualityCaseSchema = z
	.strictObject({
		id: identifier,
		recordedAnswer: z.string().max(16_384),
		retrievedSourceIds: sourceIds,
		citedSourceIds: sourceIds,
		expectations: z.strictObject({
			expectedSourceIds: sourceIds,
			requiredPhrases: z.array(phrase).max(20),
			forbiddenPhrases: z.array(phrase).max(20),
		}),
	})
	.superRefine((entry, context) => {
		requireUnique(entry.retrievedSourceIds, context, [
			"retrievedSourceIds",
		]);
		requireUnique(entry.citedSourceIds, context, ["citedSourceIds"]);
		for (const key of [
			"expectedSourceIds",
			"requiredPhrases",
			"forbiddenPhrases",
		] as const) {
			requireUnique(entry.expectations[key], context, [
				"expectations",
				key,
			]);
		}
		if (
			entry.expectations.expectedSourceIds.length === 0 &&
			entry.expectations.requiredPhrases.length === 0 &&
			entry.expectations.forbiddenPhrases.length === 0
		) {
			context.addIssue({
				code: "custom",
				path: ["expectations"],
				message: "At least one substantive expectation is required",
			});
		}
	});

/** Shared prevalidation, including when source content has not been loaded yet. */
export const contextQualityCasesSchema = z
	.array(contextQualityCaseSchema)
	.min(1)
	.max(CONTEXT_QUALITY_MAX_CASES)
	.superRefine((cases, context) =>
		requireUnique(
			cases.map((entry) => entry.id),
			context,
		),
	);

/**
 * Recorded evidence only. This schema does not establish source access, consent
 * or provenance: callers must supply snapshots from an authorized reader.
 */
export const contextQualityInputSchema = z
	.strictObject({
		version: z.literal(1),
		sources: z
			.array(contextQualitySourceSchema)
			.max(CONTEXT_QUALITY_MAX_SOURCES),
		cases: contextQualityCasesSchema,
	})
	.superRefine((value, context) => {
		if (
			new TextEncoder().encode(JSON.stringify(value)).byteLength >
			CONTEXT_QUALITY_MAX_BYTES
		) {
			context.addIssue({
				code: "custom",
				message: "Evaluation exceeds the UTF-8 byte limit",
			});
		}
		requireUnique(
			value.sources.map((source) => source.id),
			context,
			["sources"],
		);
	});

export const contextQualityCheckSchema = z.strictObject({
	id: z.enum([
		"recorded-answer-present",
		"retrieved-sources-available",
		"cited-sources-available",
		"citations-retrieved",
		"expected-sources-available",
		"expected-sources-retrieved",
		"expected-sources-cited",
		"citation-precision",
		"required-phrases",
		"forbidden-phrases",
	]),
	category: z.enum(["integrity", "quality"]),
	status: z.enum(["passed", "failed"]),
});

const metricsSchema = z.strictObject({
	precision: z.number().min(0).max(1).nullable(),
	recall: z.number().min(0).max(1).nullable(),
});

export const contextQualityResultSchema = z.strictObject({
	version: z.literal(1),
	mode: z.literal("recorded-output"),
	scorerVersion: z.literal(CONTEXT_QUALITY_SCORER_VERSION),
	datasetHash: z.string().regex(/^[0-9a-f]{64}$/),
	configurationHash: z.string().regex(/^[0-9a-f]{64}$/),
	snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
	status: z.enum(["passed", "failed"]),
	counts: z.strictObject({
		cases: z.number().int().min(1).max(CONTEXT_QUALITY_MAX_CASES),
		passed: z.number().int().min(0).max(CONTEXT_QUALITY_MAX_CASES),
		failed: z.number().int().min(0).max(CONTEXT_QUALITY_MAX_CASES),
		integrityFailures: z.number().int().min(0),
		qualityFailures: z.number().int().min(0),
	}),
	sources: z.array(
		z.strictObject({
			id: identifier,
			revision: z.string().regex(/^[0-9a-f]{64}$/),
		}),
	),
	cases: z.array(
		z.strictObject({
			id: identifier,
			status: z.enum(["passed", "failed"]),
			checks: z.array(contextQualityCheckSchema),
			retrieval: metricsSchema,
			citations: metricsSchema,
		}),
	),
});

export type ContextQualityInput = z.infer<typeof contextQualityInputSchema>;
export type ContextQualitySource = z.infer<typeof contextQualitySourceSchema>;
export type ContextQualityCase = z.infer<typeof contextQualityCaseSchema>;
export type ContextQualityCheck = z.infer<typeof contextQualityCheckSchema>;
export type ContextQualityResult = z.infer<typeof contextQualityResultSchema>;
