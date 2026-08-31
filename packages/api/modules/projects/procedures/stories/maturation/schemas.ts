import { z } from "zod";

/**
 * Shared Zod schemas + types for the `projects.stories.maturation` procedures
 * (Feature Maturation V2, spec 2026-06-09 §12). Output DTOs only — these
 * procedures never return raw Prisma models (`api.md`).
 *
 * Enum string-literal unions are kept in lock-step with the Prisma enums in
 * `packages/database/prisma/schema.prisma` (§5.2/§5.3). They are duplicated as
 * Zod literals (rather than importing the generated enum) so the API package
 * validates output without a deep-import into the generated client.
 */

export const MaturationApprovalModeSchema = z.enum(["AUTO_ACCEPT", "MANUAL"]);

export const DecisionStatusSchema = z.enum([
	"OPEN",
	"RESOLVED",
	"REJECTED",
	"FORMATTING_ONLY",
	"POSSIBLY_RESOLVED",
]);

const DecisionAuthorTypeSchema = z.enum(["USER", "AGENT"]);
export const DecisionSourceSchema = z.enum(["HUMAN", "AI_CONFIRMED"]);

/** How a PO produced an answer relative to the AI recommendation (#7). Mirrors the
 * Prisma `AnswerSource` enum. */
export const AnswerSourceSchema = z.enum([
	"AI_SUGGESTED",
	"AI_EDITED",
	"MANUAL",
]);

/** Effective approval mode per tab (the resolved §5.3 fall-through result). */
export const EffectiveApprovalModesSchema = z.object({
	cleanSpec: MaturationApprovalModeSchema,
	decisionLog: MaturationApprovalModeSchema,
	summaryQuestions: MaturationApprovalModeSchema,
});
export type ApprovalModeMap = z.infer<typeof EffectiveApprovalModesSchema>;

const DecisionLogReplySchema = z.object({
	id: z.string(),
	status: DecisionStatusSchema,
	summary: z.string().nullable(),
	content: z.string().nullable(),
	authorType: DecisionAuthorTypeSchema,
	source: DecisionSourceSchema,
	authorName: z.string().nullable(),
	sourceProvenance: z.string().nullable(),
	createdAt: z.date(),
	// Amendment pointer (#1910): set on an answer turn that replaces an earlier
	// one. The superseded turn stays in the thread so the Decisions tab can show
	// it as history; AI surfaces exclude it via `excludeSuperseded`.
	supersedesId: z.string().nullable(),
});

const CleanSpecPropagationStatusSchema = z.enum([
	"applied",
	"pending",
	"refused",
	"noop",
	"skipped",
	"error",
]);

/**
 * The Clean-Spec propagation outcome a decision produced (§7.5), summarized for
 * the editor: the status, the one-line applied summaries (for the Decision Log
 * "what changed"), and how many patches are still PENDING (drives the Clean Spec
 * MANUAL review banner + an accept affordance). `null` when a decision never ran
 * propagation (e.g. an OPEN question).
 */
const CleanSpecPropagationSummarySchema = z
	.object({
		status: CleanSpecPropagationStatusSchema,
		appliedSummaries: z.array(z.string()),
		pendingPatchCount: z.number().int(),
	})
	.nullable();
export type CleanSpecPropagationSummary = z.infer<
	typeof CleanSpecPropagationSummarySchema
>;

const DecisionLogRootSchema = DecisionLogReplySchema.extend({
	impactedSection: z.string().nullable(),
	topic: z.string().nullable(),
	questionId: z.string().nullable(),
	decidedBy: z.string().nullable(),
	cleanSpecPropagation: CleanSpecPropagationSummarySchema,
	// AI answer recommendations for an OPEN question (#7), derived from
	// `metadata.answerRecommendation`. 0–4 candidate answers, each with a required
	// justification (FR-2); empty array = no recommendation (renders as a plain
	// question).
	suggestedOptions: z.array(
		z.object({ text: z.string(), justification: z.string() }),
	),
});

/** A Decision Log thread: a root turn plus its chronological replies (§5.2). */
export const DecisionLogThreadSchema = z.object({
	root: DecisionLogRootSchema,
	replies: z.array(DecisionLogReplySchema),
});

/**
 * The QA tab's persisted analysis — mirrors `QaAnalysisContent` in
 * `queries/feature-maturation.ts`. Test cases are NOT part of this DTO; they
 * are real TestCase rows the client lists via `testCases.list`.
 */
export const QaAnalysisContentSchema = z.object({
	warnings: z.array(
		z.object({
			criterionRef: z.string(),
			warning: z.string(),
			// Set when writing the cases is what exposed the gap — the
			// test-first ordering's own claim, surfaced so it can be seen.
			fromDraftedCases: z.boolean().optional(),
		}),
	),
	integrationNotes: z.string(),
	e2eScenarios: z.string(),
	depth: z.enum(["LIGHT", "STANDARD", "STRICT"]),
	specHash: z.string(),
	generatedAt: z.string(),
	// Absent on analyses stored before this was recorded, and on standard-flow
	// projects where the review reads no cases by design.
	reviewedAgainstCaseCount: z.number().optional(),
});

export const AiReadinessResultSchema = z.object({
	aiReadinessScore: z.number().min(0).max(100),
	tierLabel: z.string(),
	rationale: z.string(),
	strengths: z.array(z.string()),
	gaps: z.array(z.string()),
});
