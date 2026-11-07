import {
	buildProjectReference,
	type OAuthProjectAudience,
} from "@repo/utils/oauth-project-resource";
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
export const triagePin = z.strictObject({
	observationId: id,
	watchId: id,
	grantId: id,
	grantRevision: z.number().int().positive(),
	evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const triageStartInput = z
	.strictObject({
		projectId: id,
		requestId: z.uuid(),
		goal: z
			.string()
			.trim()
			.min(1)
			.max(2000)
			.refine(
				(x) => new TextEncoder().encode(x).byteLength <= 2000,
				"Goal must fit in 2,000 UTF-8 bytes.",
			),
		evidenceIds: z.array(id).min(1).max(5),
	})
	.refine(
		(x) => new Set(x.evidenceIds).size === x.evidenceIds.length,
		"Choose distinct evidence items.",
	);
export const triageListInput = z.strictObject({
	projectId: id,
	before: z.string().max(2048).optional(),
});
export const triageRunInput = z.strictObject({ projectId: id, runId: id });
export const triageReviewInput = triageRunInput.extend({
	proposalId: z.string().regex(/^[a-f0-9]{64}$/),
	decision: z.enum(["KEEP", "DISMISS"]),
});
export const triageStatus = z.enum([
	"QUEUED",
	"RUNNING",
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"OUTCOME_UNKNOWN",
]);
export const triageRun = z.strictObject({
	id,
	status: triageStatus,
	createdAt: z.iso.datetime(),
	expiresAt: z.iso.datetime(),
	selectedCount: z.number().int().min(1).max(5),
	failureCode: z
		.enum([
			"FORBIDDEN",
			"EVIDENCE_UNAVAILABLE",
			"BUDGET_UNAVAILABLE",
			"MODEL_UNAVAILABLE",
			"INVALID_RESULT",
			"CANCELLED",
			"OUTCOME_UNKNOWN",
		])
		.nullable(),
});
export const triageList = z.strictObject({
	version: z.literal(1),
	availability: z.enum(["AVAILABLE", "NOT_ENABLED", "STORAGE_UNAVAILABLE"]),
	runs: z.array(triageRun).max(20),
	nextBefore: z.string().max(2048).nullable(),
});
export const triageResult = z.strictObject({
	version: z.literal(1),
	audience: z.literal("PRIVATE_OWNER"),
	coverage: z.literal("SELECTED_EVIDENCE_ONLY"),
	reviewedEvidence: z.array(triagePin).min(1).max(5),
	proposals: z
		.array(
			z.strictObject({
				id: z.string().regex(/^[a-f0-9]{64}$/),
				title: z.string().min(1).max(200),
				summary: z.string().min(1).max(2000),
				kind: z.enum(["BUG", "FEATURE", "QUESTION", "RISK"]),
				urgency: z.enum(["NOW", "SOON", "LATER"]),
				uncertainties: z.array(z.string().max(400)).max(5),
				citations: z.array(triagePin).min(1).max(5),
			}),
		)
		.max(3),
});
export const triageRunDetail = z.strictObject({
	version: z.literal(1),
	run: triageRun,
	result: triageResult.nullable(),
	reviews: z.record(z.string(), z.enum(["KEEP", "DISMISS"])),
});
export const TRIAGE_OPERATIONS = [
	"list",
	"start",
	"status",
	"result",
	"cancel",
	"review",
] as const;
export type TriageOperation = (typeof TRIAGE_OPERATIONS)[number];
export function triageRequiredScopes(operation: TriageOperation) {
	const write = ["start", "cancel", "review"].includes(operation);
	return [
		write ? "projects:write" : "projects:read",
		write ? "features:write" : "features:read",
		"integrations:read",
		...(operation === "start" ||
		operation === "result" ||
		operation === "review"
			? ["integrations:execute"]
			: []),
		...(operation === "start" ? ["ai:models:resolve"] : []),
	];
}
export const triageCredential = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("SESSION") }),
	z.strictObject({
		kind: z.enum(["USER_API_KEY", "ORGANIZATION_API_KEY"]),
		id,
		scopes: z.array(z.string()).max(100),
	}),
	z.strictObject({
		kind: z.literal("OAUTH_CLIENT"),
		id,
		scopes: z.array(z.string()).max(100),
		referenceId: z.string().min(1).max(300),
	}),
]);
export type TriageCredential = z.infer<typeof triageCredential>;

/** Trusted transport facts only; never call with fields parsed from product input. */
export function triageCredentialFromFacts(
	kind: "USER_API_KEY" | "ORGANIZATION_API_KEY" | "OAUTH_CLIENT",
	id: string,
	scopes: string[],
	organizationId: string | null | undefined,
	projectId: string | null | undefined,
	audience: OAuthProjectAudience,
): TriageCredential {
	return triageCredential.parse({
		kind,
		id,
		scopes: [...scopes],
		...(kind === "OAUTH_CLIENT"
			? {
					referenceId: projectId
						? buildProjectReference(audience, projectId)
						: organizationId,
				}
			: {}),
	});
}

export const triageModelPin = z.strictObject({
	provider: z.literal("OPENAI_DIRECT"),
	modelString: z.string().min(1).max(200),
	canonicalName: z.string().min(1).max(200),
	configId: z.string().min(1),
	configSource: z.enum(["user", "organization"]),
	routeHash: z.string().regex(/^[a-f0-9]{64}$/),
	maxOutputTokens: z.number().int().min(1).max(2048),
	contextWindow: z.number().int().positive(),
	inputRate: z.number().positive().finite(),
	outputRate: z.number().positive().finite(),
});
export type TriageModelPin = z.infer<typeof triageModelPin>;
