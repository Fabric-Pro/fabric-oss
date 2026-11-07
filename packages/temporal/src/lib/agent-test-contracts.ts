import {
	resultQualityCheckFields,
	resultQualityGradeFields,
	validResultQualityChecks,
	validResultQualityGrade,
} from "@repo/utils/result-quality";
import { z } from "zod";

export const AGENT_TEST_WORKFLOW = "agentTestAssessmentWorkflow";
export const AGENT_TEST_MAX_BYTES = 128 * 1024;
const id = z.string().trim().min(1).max(200);
const phrase = z.string().trim().min(1).max(512);
export const agentTestChecksSchema = z
	.strictObject({
		...resultQualityCheckFields,
		requiredPhrases: z.array(phrase).max(20).default([]),
		forbiddenPhrases: z.array(phrase).max(20).default([]),
	})
	.refine(validResultQualityChecks, {
		message:
			"Add at least one check; JSON and grounding checks require version 2.",
	});
export const agentTestScopeSchema = z.strictObject({
	instanceId: id,
	configHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	projectId: id.optional(),
	workspaceIds: z.array(id).max(30).default([]),
	workspaceDocumentFilters: z
		.array(
			z.strictObject({
				workspaceId: id,
				documentIds: z.array(id).max(1000).default([]),
			}),
		)
		.max(30)
		.default([]),
	skillIds: z.array(id).max(100).default([]),
});
export const agentTestCaseCreateSchema = z.strictObject({
	instanceId: id,
	sourcePreview: z
		.strictObject({ workflowId: id, runId: z.uuid().optional() })
		.optional(),
	name: z.string().trim().min(1).max(120),
	input: z.string().trim().min(1).max(20_000),
	checks: agentTestChecksSchema,
});
export const agentTestCaseUpdateSchema = z.strictObject({
	caseId: id,
	revision: z.number().int().positive(),
	name: z.string().trim().min(1).max(120),
	input: z.string().trim().min(1).max(20_000),
	checks: agentTestChecksSchema,
});
export const agentTestCaseArchiveSchema = z.strictObject({
	caseId: id,
	revision: z.number().int().positive(),
});
export const agentTestCaseListSchema = z.strictObject({
	instanceId: id,
	limit: z.number().int().min(1).max(50).default(20),
	cursor: id.optional(),
});
export const agentTestRunStartSchema = z.strictObject({
	caseId: id,
	caseRevision: z.number().int().positive(),
	instanceId: id,
	idempotencyKey: z.uuid(),
});
export const agentTestRunIdentitySchema = z.strictObject({ testRunId: id });
export const agentTestRunListSchema = z.strictObject({
	caseId: id,
	limit: z.number().int().min(1).max(50).default(20),
	cursor: id.optional(),
});
export const agentTestCompareSchema = z
	.strictObject({ baselineRunId: id, candidateRunId: id })
	.refine((x) => x.baselineRunId !== x.candidateRunId, {
		message: "Choose two different test runs.",
	});
export interface AgentTestActor {
	userId: string;
	organizationId: string;
	external?: boolean;
}
export type AgentTestChecks = z.infer<typeof agentTestChecksSchema>;
export type AgentTestScope = z.infer<typeof agentTestScopeSchema>;
const agentTestLegacyReportSchema = z
	.strictObject({
		version: z.literal(1),
		method: z.literal("exact-text"),
		outputHash: z.string().regex(/^[a-f0-9]{64}$/),
		passed: z.number().int().min(0).max(40),
		total: z.number().int().min(1).max(40),
		results: z
			.array(
				z.strictObject({
					kind: z.enum(["required", "forbidden"]),
					index: z.number().int().min(0).max(19),
					passed: z.boolean(),
				}),
			)
			.max(40),
		durationMs: z.number().int().nonnegative().nullable(),
		inputTokens: z.number().int().nonnegative().nullable(),
		outputTokens: z.number().int().nonnegative().nullable(),
		totalCost: z
			.string()
			.max(40)
			.regex(/^[0-9]+(?:\.[0-9]+)?$/)
			.nullable(),
	})
	.refine(
		(x) =>
			x.total === x.results.length &&
			x.passed === x.results.filter((r) => r.passed).length,
		{ message: "The report counts must match its checks." },
	);
const agentTestDeterministicReportSchema = z
	.strictObject({
		...resultQualityGradeFields,
		outputHash: z.string().regex(/^[a-f0-9]{64}$/),
		durationMs: z.number().int().nonnegative().nullable(),
		inputTokens: z.number().int().nonnegative().nullable(),
		outputTokens: z.number().int().nonnegative().nullable(),
		totalCost: z
			.string()
			.max(40)
			.regex(/^[0-9]+(?:\.[0-9]+)?$/)
			.nullable(),
	})
	.refine(validResultQualityGrade, {
		message: "The report counts must match its checks.",
	});
export const agentTestReportSchema = z.union([
	agentTestLegacyReportSchema,
	agentTestDeterministicReportSchema,
]);
export type AgentTestReport = z.infer<typeof agentTestReportSchema>;
export interface AgentTestRunSummary {
	id: string;
	requestKey: string;
	caseId: string;
	instanceId: string;
	agentVersion: number;
	caseRevision: number;
	status: "ADMITTING" | "RUNNING" | "COMPLETED" | "CANCELLED" | "ERROR";
	verdict: "PASSED" | "FAILED" | null;
	executionId: string | null;
	errorCode: string | null;
	report: AgentTestReport | null;
	createdAt: string;
	completedAt: string | null;
}
export interface AgentTestCaseSummary {
	id: string;
	agentSId: string;
	originInstanceId: string;
	name: string;
	input: string;
	checks: AgentTestChecks;
	revision: number;
	createdAt: string;
	updatedAt: string;
	latestRun: AgentTestRunSummary | null;
}
export const agentTestErrorDataSchema = z.strictObject({
	admission: z.literal("NOT_STARTED"),
});
export class AgentTestError extends Error {
	constructor(
		readonly code:
			| "BAD_REQUEST"
			| "FORBIDDEN"
			| "NOT_FOUND"
			| "CONFLICT"
			| "SERVICE_UNAVAILABLE",
		message: string,
		readonly data?: z.infer<typeof agentTestErrorDataSchema>,
	) {
		super(message);
		this.name = "AgentTestError";
	}
}
