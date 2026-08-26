import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import {
	db,
	effectiveApprovalMode,
	getApprovalPreference,
	getFeatureMaturationState,
	getLatestRunChangeSummary,
	hasProjectAccess,
	isAiAnswerRecommendationsEnabled,
	listDecisionLogThreads,
	type MaturationTab,
	type MaturationTenantFilter,
	parseQaAnalysis,
	type UserApprovalPreferenceModes,
} from "@repo/database";
import { combineCleanSpec } from "@repo/utils/clean-spec-content";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { countPendingDecisions } from "../../../lib/record-answer-in-spec";
import {
	type ApprovalModeMap,
	DecisionLogThreadSchema,
	EffectiveApprovalModesSchema,
	QaAnalysisContentSchema,
} from "./schemas";
import { serializeDecisionLogThread } from "./serializers";

/**
 * `maturation.getEditorState` (§12, AC-2.1) — hydrate the three-tab editor for a
 * feature in a single round-trip: the Summary digest, the open questions/gaps
 * (OPEN-status Decision Log thread roots), the full threaded Decision Log,
 * the effective approval mode per tab (§5.3), and the Clean Spec (`description`
 * + `acceptanceCriteria`, §4.1 — there is no parallel `cleanSpecContent`).
 *
 * Read-only: this never writes, so it does not touch PM sync. Returns a
 * Zod-validated DTO, never raw Prisma models (`api.md`).
 */
export const getEditorStateProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/maturation/editor-state",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Load three-tab maturation editor state",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			feature: z.object({
				id: z.string(),
				title: z.string(),
				maturationV2OptedIn: z.boolean(),
				// When the Clean Spec was last rebuilt by an AI/context path — drives
				// the staleness colour + tooltip on the refresh control (#2/#3).
				// `null` = never refreshed via context.
				lastContextUpdateAt: z.date().nullable(),
				// Per-feature auto-propose-answers toggle (#7). Default true; drives the
				// "Auto-propose answers" control in the Summary & Questions tab.
				autoProposeAnswers: z.boolean(),
			}),
			summaryDigest: z.string().nullable(),
			workingNotesContent: z.string().nullable(),
			cleanSpec: z.object({
				description: z.string().nullable(),
				acceptanceCriteria: z.string().nullable(),
			}),
			openQuestions: z.array(DecisionLogThreadSchema),
			// Soft-closed questions the latest refresh no longer lists (#5) — shown
			// collapsed, restorable; never deleted.
			possiblyResolvedQuestions: z.array(DecisionLogThreadSchema),
			decisionLog: z.array(DecisionLogThreadSchema),
			approvalModes: EffectiveApprovalModesSchema,
			// Count of answers recorded but not yet merged into the Clean Spec body
			// (the pending-decisions appendix) — drives the "X New Decisions" bar (#B).
			// Increments on answer, returns to 0 when a refresh dissolves the appendix.
			pendingDecisionCount: z.number().int(),
			// True when there are pending decisions — surfaces the "Refresh Clean
			// Spec" affordance (#4b). Derived from `pendingDecisionCount`.
			refreshNeeded: z.boolean(),
			// The most recent maturation run's change summary — drives the
			// "Changes from this run" review card. `null` until a run produces one.
			latestRun: z
				.object({
					version: z.number().int(),
					changeSummary: z.array(z.string()),
					createdAt: z.date(),
				})
				.nullable(),
			// QA tab: the persisted analysis sections, `null` until
			// generated. Test cases are fetched separately via `testCases.list`.
			qaAnalysis: QaAnalysisContentSchema.nullable(),
			// True when the Clean Spec changed since the analysis was generated —
			// drives the "spec has changed" staleness note on the QA tab.
			qaAnalysisStale: z.boolean(),
			// The project QA depth (`Project.qaStrategyLevel`) — the QA tab's
			// empty state and generate hint say what a run will produce.
			qaStrategyLevel: z.enum(["LIGHT", "STANDARD", "STRICT"]),
			// QA test-case generation settings. The QA tab
			// disables drafting when generation is off and shows the active flow
			// (standard vs TDD ordering) so the editor matches project policy.
			generateManualTestCases: z.boolean(),
			applyTddApproach: z.boolean(),
			/** Live test cases linked to this feature — drives the test-first warning. */
			linkedTestCaseCount: z.number(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const feature = await getFeatureMaturationState({
			userStoryId: input.storyId,
			projectId: input.projectId,
		});
		if (!feature) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		const tenantFilter: MaturationTenantFilter = {
			organizationId: organizationId ?? null,
			userId: context.user.id,
		};

		const [
			threads,
			preference,
			latestRun,
			recommendationsEnabled,
			project,
			linkedTestCaseCount,
		] = await Promise.all([
			listDecisionLogThreads({
				tenantFilter,
				userStoryId: input.storyId,
			}),
			getApprovalPreference({ tenantFilter }),
			getLatestRunChangeSummary(input.storyId),
			// #7/FR-15: gate the DISPLAY of AI answer options on the org dogfood
			// flag, so flipping it off hides already-persisted recommendations too.
			isAiAnswerRecommendationsEnabled(organizationId ?? null),
			// QA tab depth + QA generation settings —
			// one narrow column read.
			db.project.findUnique({
				where: { id: input.projectId },
				select: {
					qaStrategyLevel: true,
					generateManualTestCases: true,
					applyTddApproach: true,
				},
			}),
			// How many LIVE test cases this feature has, for the test-first
			// warning on the QA tab. A count rather than the rows: the tab needs
			// "any or none", and the panel below it fetches the cases properly
			// when it renders. Soft-deleted cases are excluded — a link outlives
			// the case it points at, and a deleted case is not coverage.
			db.testCaseWorkItemLink.count({
				where: {
					userStoryId: input.storyId,
					testCase: { deletedAt: null },
				},
			}),
		]);
		const serializeOpts = {
			includeRecommendations: recommendationsEnabled,
		};

		const userPref: UserApprovalPreferenceModes | null = preference
			? {
					cleanSpecMode: preference.cleanSpecMode,
					decisionLogMode: preference.decisionLogMode,
					summaryQuestionsMode: preference.summaryQuestionsMode,
				}
			: null;

		const tabs: MaturationTab[] = [
			"cleanSpec",
			"decisionLog",
			"summaryQuestions",
		];
		const approvalModes = tabs.reduce((acc, tab) => {
			acc[tab] = effectiveApprovalMode(feature, userPref, tab);
			return acc;
		}, {} as ApprovalModeMap);

		// Open questions/gaps are the OPEN-status thread roots — the subset of
		// the Decision Log the PO still has to work (AC-2.1). Answered threads
		// flip out of OPEN (see answer-question.ts) so they fall off this list,
		// which is what keeps a resolved question from resurfacing (AC-2.4).
		const openQuestions = threads.filter(
			(thread) => thread.root.status === "OPEN",
		);

		// Questions a Clean Spec refresh soft-closed (#5) — the spec no longer lists
		// them. Surfaced as a collapsed, restorable group rather than deleted.
		const possiblyResolvedQuestions = threads.filter(
			(thread) => thread.root.status === "POSSIBLY_RESOLVED",
		);

		// "X New Decisions" (#B) + "Refresh Clean Spec" affordance (#4b): count the
		// answers sitting in the pending-decisions appendix (recorded but not yet
		// merged). This increments on answer and returns to 0 when a refresh
		// dissolves the appendix — so it clears reliably regardless of which path
		// applied the rebuild (the chat agent doesn't stamp `lastContextUpdateAt`).
		const pendingDecisionCount = countPendingDecisions(feature.description);
		const refreshNeeded = pendingDecisionCount > 0;

		// QA tab: parse the stored analysis and compare its spec hash
		// with the current Clean Spec so the tab can flag a stale analysis.
		const qaAnalysis = parseQaAnalysis(feature.qaAnalysis);
		const qaAnalysisStale =
			qaAnalysis !== null &&
			createHash("sha256")
				.update(
					combineCleanSpec(
						feature.description,
						feature.acceptanceCriteria,
					),
				)
				.digest("hex") !== qaAnalysis.specHash;

		return {
			feature: {
				id: feature.id,
				title: feature.title,
				maturationV2OptedIn: feature.maturationV2OptedIn,
				lastContextUpdateAt: feature.lastContextUpdateAt,
				autoProposeAnswers: feature.autoProposeAnswers,
			},
			summaryDigest: feature.summaryDigest,
			workingNotesContent: feature.workingNotesContent,
			cleanSpec: {
				description: feature.description,
				acceptanceCriteria: feature.acceptanceCriteria,
			},
			openQuestions: openQuestions.map((t) =>
				serializeDecisionLogThread(t, serializeOpts),
			),
			possiblyResolvedQuestions: possiblyResolvedQuestions.map((t) =>
				serializeDecisionLogThread(t, serializeOpts),
			),
			decisionLog: threads.map((t) =>
				serializeDecisionLogThread(t, serializeOpts),
			),
			approvalModes,
			pendingDecisionCount,
			refreshNeeded,
			latestRun: latestRun
				? {
						version: latestRun.version,
						changeSummary: latestRun.changeSummary,
						createdAt: latestRun.createdAt,
					}
				: null,
			qaAnalysis,
			qaAnalysisStale,
			qaStrategyLevel: project?.qaStrategyLevel ?? "STANDARD",
			generateManualTestCases: project?.generateManualTestCases ?? true,
			applyTddApproach: project?.applyTddApproach ?? false,
			linkedTestCaseCount,
		};
	});
