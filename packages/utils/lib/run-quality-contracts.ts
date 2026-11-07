import { z } from "zod";
import {
	RESULT_QUALITY_SCORER_VERSION,
	resultQualityChecksSchema,
	resultQualityGradeSchema,
} from "./result-quality";

const id = z.string().trim().min(1).max(200);
export const runQualityTargetSchema = z.strictObject({
	targetType: z.enum(["WORKFLOW", "AGENT"]),
	targetId: id,
});
export const runQualityRuleSchema = z.strictObject({
	id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
	name: z.string().trim().min(1).max(120),
	nodeId: id.optional(),
	pointer: z
		.string()
		.max(1_000)
		.regex(/^(?:|\/(?:[^~]|~[01])*)$/)
		.optional(),
	required: z.boolean().default(true),
	checks: resultQualityChecksSchema,
});
export const runQualityRulesSchema = z
	.array(runQualityRuleSchema)
	.min(1)
	.max(20)
	.refine(
		(rules) => new Set(rules.map((r) => r.id)).size === rules.length,
		"Check IDs must be unique.",
	)
	.refine(
		(rules) => rules.some((rule) => rule.required),
		"Keep at least one required check.",
	);
export const configureSchema = runQualityTargetSchema.extend({
	expectedRevision: z.number().int().min(0),
	enabled: z.boolean(),
	rules: runQualityRulesSchema,
});
export const listSchema = runQualityTargetSchema.extend({
	limit: z.number().int().min(1).max(50).default(20),
	offset: z.number().int().min(0).max(100_000).default(0),
});
export const identitySchema = runQualityTargetSchema.extend({
	assessmentId: id,
});
export const compareSchema = runQualityTargetSchema.extend({
	leftId: id,
	rightId: id,
});
export type RunQualityTarget = z.infer<typeof runQualityTargetSchema>;
export type RunQualityRule = z.infer<typeof runQualityRuleSchema>;
export type RunQualityActor = { userId: string; organizationId: string };
export class RunQualityError extends Error {
	constructor(
		public readonly code:
			| "BAD_REQUEST"
			| "FORBIDDEN"
			| "NOT_FOUND"
			| "CONFLICT"
			| "UNAVAILABLE",
		message: string,
	) {
		super(message);
		this.name = "RunQualityError";
	}
}

/** Fixed codes only: retained reports never carry provider messages or recorded output. */
export const runQualityReasonSchema = z.enum([
	"EXECUTION_FAILED",
	"EXECUTION_CANCELLED",
	"NO_OUTPUT",
	"OUTPUT_TOO_LARGE",
	"OUTPUT_SELECTION_INVALID",
	"EVIDENCE_UNAVAILABLE",
	"ASSESSMENT_UNAVAILABLE",
	"SOURCE_ACCESS_REVOKED",
	"POLICY_CHANGED",
	"NATIVE_IDENTITY_INVALID",
	"CHECK_BUDGET_EXCEEDED",
	"ASSESSMENT_CANCELLED",
]);
export const runQualityRuleResultSchema = z
	.strictObject({
		id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
		name: z.string().min(1).max(120),
		required: z.boolean(),
		outputHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		status: z.enum(["PASSED", "FAILED", "NOT_ASSESSED", "UNAVAILABLE"]),
		grade: resultQualityGradeSchema.optional(),
		reason: runQualityReasonSchema.optional(),
	})
	.refine(
		(rule) =>
			rule.grade
				? rule.status === rule.grade.status
				: rule.status === "UNAVAILABLE",
		"Available rules must contain a matching deterministic grade.",
	);
export const runQualityReportSchema = z
	.strictObject({
		version: z.literal(1),
		scorerVersion: z.literal(RESULT_QUALITY_SCORER_VERSION),
		rules: z.array(runQualityRuleResultSchema).min(1).max(20),
		coverage: z.strictObject({
			passed: z.number().int().min(0).max(20),
			failed: z.number().int().min(0).max(20),
			unavailable: z.number().int().min(0).max(20),
			total: z.number().int().min(1).max(20),
		}),
	})
	.refine(
		(report) =>
			new Set(report.rules.map((rule) => rule.id)).size ===
				report.rules.length &&
			report.coverage.total === report.rules.length &&
			report.coverage.passed ===
				report.rules.filter((rule) => rule.status === "PASSED")
					.length &&
			report.coverage.failed ===
				report.rules.filter((rule) => rule.status === "FAILED")
					.length &&
			report.coverage.unavailable ===
				report.rules.filter(
					(rule) =>
						rule.status === "UNAVAILABLE" ||
						rule.status === "NOT_ASSESSED",
				).length,
		"Report coverage must match its unique recorded rule results.",
	);
export const runQualityPolicyDtoSchema = z.strictObject({
	id,
	revision: z.number().int().positive(),
	enabled: z.boolean(),
	rules: runQualityRulesSchema,
	updatedAt: z.iso.datetime(),
});
export const runQualityPolicyResultSchema = runQualityTargetSchema.extend({
	policy: runQualityPolicyDtoSchema.nullable(),
	canConfigure: z.boolean(),
});
export const runQualityAssessmentSchema = runQualityTargetSchema
	.extend({
		id,
		executionId: id,
		policyRevision: z.number().int().positive(),
		sourceVersion: z.number().int().positive(),
		status: z.enum(["PENDING", "CHECKING", "COMPLETED", "CANCELLED"]),
		verdict: z
			.enum(["PASSED", "NEEDS_ATTENTION", "UNAVAILABLE", "INCONCLUSIVE"])
			.nullable(),
		report: runQualityReportSchema.nullable(),
		errorCode: runQualityReasonSchema.nullable(),
		createdAt: z.iso.datetime(),
		completedAt: z.iso.datetime().nullable(),
	})
	.refine(
		(row) =>
			row.status === "PENDING" || row.status === "CHECKING"
				? row.verdict === null &&
					row.report === null &&
					row.completedAt === null
				: row.verdict !== null && row.completedAt !== null,
		"Assessment state and verdict must agree.",
	)
	.refine(
		(row) =>
			row.verdict !== "PASSED" ||
			(!!row.report &&
				row.report.rules.some((rule) => rule.required) &&
				row.report.rules
					.filter((rule) => rule.required)
					.every((rule) => rule.status === "PASSED")),
		"A passing verdict needs assessed required checks.",
	);
export const runQualityAssessmentListSchema = z.strictObject({
	assessments: z.array(runQualityAssessmentSchema).max(50),
	hasMore: z.boolean(),
	unavailableCount: z.number().int().min(0).max(50).default(0),
});
export const runQualityComparisonResultSchema = z.strictObject({
	left: runQualityAssessmentSchema,
	right: runQualityAssessmentSchema,
	changes: z.strictObject({
		sameChecks: z.literal(true),
		sourceVersionChanged: z.boolean(),
		verdictChanged: z.boolean(),
		sourceScopeChanged: z.boolean().optional(),
	}),
});
export type RunQualityPolicyDTO = z.infer<typeof runQualityPolicyDtoSchema>;
export type RunQualityPolicyResult = z.infer<
	typeof runQualityPolicyResultSchema
>;
export type RunQualityAssessmentDTO = z.infer<
	typeof runQualityAssessmentSchema
>;
export type RunQualityReport = z.infer<typeof runQualityReportSchema>;
