import { expect, it } from "vitest";
import { gradeResultQuality } from "../result-quality";
import {
	runQualityAssessmentSchema,
	runQualityPolicyResultSchema,
	runQualityReportSchema,
} from "../run-quality-contracts";

const grade = gradeResultQuality("Ready", { requiredPhrases: ["Ready"] });
const report = {
	version: 1,
	scorerVersion: "fabric-deterministic-v1",
	rules: [
		{
			id: "check",
			name: "Delivery",
			required: true,
			status: "PASSED",
			grade,
			outputHash: "a".repeat(64),
		},
	],
	coverage: { passed: 1, failed: 0, unavailable: 0, total: 1 },
};
const assessment = {
	id: "example-assessment",
	targetType: "AGENT",
	targetId: "example-agent",
	executionId: "example-execution",
	policyRevision: 1,
	sourceVersion: 2,
	status: "COMPLETED",
	verdict: "PASSED",
	report,
	errorCode: null,
	createdAt: "2026-01-01T00:00:00Z",
	completedAt: "2026-01-01T00:00:01Z",
};
it("accepts minimized versioned reports and separate completed quality verdicts", () => {
	expect(runQualityAssessmentSchema.parse(assessment)).toEqual(assessment);
	expect(
		runQualityAssessmentSchema.safeParse({
			...assessment,
			verdict: "NEEDS_ATTENTION",
		}).success,
	).toBe(true);
});
it("rejects raw answer and provider errors anywhere in retained reports", () => {
	expect(
		runQualityReportSchema.safeParse({ ...report, rawOutput: "private" })
			.success,
	).toBe(false);
	expect(
		runQualityReportSchema.safeParse({
			...report,
			rules: [{ ...report.rules[0], answer: "private" }],
		}).success,
	).toBe(false);
	expect(
		runQualityReportSchema.safeParse({
			...report,
			rules: [
				{
					id: "check",
					name: "Delivery",
					required: true,
					status: "UNAVAILABLE",
					reason: "Provider failed with secret",
				},
			],
			coverage: { passed: 0, failed: 0, unavailable: 1, total: 1 },
		}).success,
	).toBe(false);
	expect(
		runQualityAssessmentSchema.safeParse({
			...assessment,
			errorCode: "API key private failed",
		}).success,
	).toBe(false);
});
it("requires matching unique rule coverage and grade statuses", () => {
	expect(
		runQualityReportSchema.safeParse({
			...report,
			coverage: { ...report.coverage, passed: 0 },
		}).success,
	).toBe(false);
	expect(
		runQualityReportSchema.safeParse({
			...report,
			rules: [report.rules[0], report.rules[0]],
			coverage: { passed: 2, failed: 0, unavailable: 0, total: 2 },
		}).success,
	).toBe(false);
	expect(
		runQualityReportSchema.safeParse({
			...report,
			rules: [{ ...report.rules[0], status: "FAILED" }],
		}).success,
	).toBe(false);
});
it("keeps unavailable grading separate from a passed assessment", () => {
	const unavailable = {
		...report,
		rules: [
			{
				id: "check",
				name: "Grounding",
				required: true,
				status: "UNAVAILABLE",
				reason: "EVIDENCE_UNAVAILABLE",
			},
		],
		coverage: { passed: 0, failed: 0, unavailable: 1, total: 1 },
	};
	expect(
		runQualityAssessmentSchema.safeParse({
			...assessment,
			report: unavailable,
			verdict: "UNAVAILABLE",
		}).success,
	).toBe(true);
	expect(
		runQualityAssessmentSchema.safeParse({
			...assessment,
			report: unavailable,
		}).success,
	).toBe(false);
	expect(
		runQualityAssessmentSchema.safeParse({
			...assessment,
			status: "CHECKING",
		}).success,
	).toBe(false);
	expect(
		runQualityAssessmentSchema.safeParse({
			...assessment,
			status: "CHECKING",
			verdict: null,
			report: null,
			completedAt: null,
		}).success,
	).toBe(true);
});
it("checks stored policy definitions rather than returning arbitrary JSON", () => {
	expect(
		runQualityPolicyResultSchema.safeParse({
			targetType: "AGENT",
			targetId: "example-agent",
			canConfigure: true,
			policy: {
				id: "policy",
				revision: 1,
				enabled: true,
				rules: [
					{
						id: "check",
						name: "Delivery",
						required: true,
						checks: { requiredPhrases: ["Ready"] },
					},
				],
				updatedAt: "2026-01-01T00:00:00Z",
				secret: "private",
			},
		}).success,
	).toBe(false);
});

it("requires at least one required policy check and prevents a vacuous passing receipt", async () => {
	const { runQualityRulesSchema } = await import("../run-quality-contracts");
	expect(
		runQualityRulesSchema.safeParse([
			{
				id: "check",
				name: "Advisory",
				required: false,
				checks: { requiredPhrases: ["Ready"] },
			},
		]).success,
	).toBe(false);
	expect(
		runQualityAssessmentSchema.safeParse({
			...assessment,
			report: {
				...report,
				rules: [{ ...report.rules[0], required: false }],
			},
		}).success,
	).toBe(false);
});
