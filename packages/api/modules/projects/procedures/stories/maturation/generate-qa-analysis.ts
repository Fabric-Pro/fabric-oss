import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import {
	db,
	getFeatureMaturationState,
	hasProjectAccess,
	type MaturationTenantFilter,
	parseQaAnalysis,
	type QaAnalysisContent,
	setQaAnalysis,
} from "@repo/database";
import { combineCleanSpec } from "@repo/utils/clean-spec-content";
import { isTestCasesEnabled } from "@repo/utils/feature-flag";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { runInBackground } from "../../../../weave/lib/run-in-background";
import {
	shouldDraftAfterFeatureReview,
	startAutoDraft,
} from "../../../lib/auto-draft-test-cases";
import { generateQaAnalysis } from "../../../lib/generate-qa-analysis";
import { assertTestCasesFeatureEnabled } from "../../../lib/test-cases-feature";
import { QaAnalysisContentSchema } from "./schemas";

/**
 * `maturation.generateQaAnalysis` — produce and persist the QA
 * tab's analysis sections for a feature: under-specification warnings,
 * integration-test implications, and E2E scenario outlines. Explicitly
 * button-triggered — this is a billable one-shot model call, so nothing fires
 * it on tab open. Test-case drafting is NOT this procedure — the tab starts
 * that through the existing durable `testCases.aiDraft` pipeline.
 *
 * Depth comes from the project's `qaStrategyLevel` (LIGHT → warnings only).
 * The stored payload stamps the Clean Spec hash so the tab can flag staleness
 * when the spec later changes.
 *
 * PM-sync isolation (§7.7): writes only `qaAnalysis`, never the Clean Spec.
 */
/** Sibling feature titles fed to the model as cross-feature grounding. */
const SIBLING_FEATURE_LIMIT = 25;

export const generateQaAnalysisProcedure = tenantProtectedProcedure
	// SOC2 ratchet: `resolveOrganizationId` returns the caller's org string
	// verbatim, and `requireProjectPermission` never reads the org — this
	// asserts membership of the org actually being written under.
	.use(requireInputOrgPermission(Permissions.STORY_UPDATE))
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/qa-analysis",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Generate the QA tab's analysis sections",
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
			qaAnalysis: QaAnalysisContentSchema,
			// True when the sub-minute idempotent replay served the STORED
			// analysis instead of generating — the client says so, because a
			// silently swallowed "Refresh" click reads as a broken button.
			replayed: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		// The QA tab rides on the QA feature — same gate as every
		// test-cases procedure, so the tab and its backend switch together.
		assertTestCasesFeatureEnabled();
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
		// FEATURE-only surface (the tab is scoped to the feature
		// maturation workflow; bugs keep the three-tab editor unchanged).
		if (feature.kind === "BUG") {
			throw new ORPCError("BAD_REQUEST", {
				message: "QA analysis is only available on features",
			});
		}

		const spec = combineCleanSpec(
			feature.description,
			feature.acceptanceCriteria,
		);
		if (!spec.trim()) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This feature has no specification yet. Add a description or acceptance criteria first.",
			});
		}

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				qaStrategyLevel: true,
				organizationId: true,
				applyTddApproach: true,
				// For the standard-flow auto-draft below.
				generateManualTestCases: true,
			},
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// Idempotent replay: a double-fire (second browser tab, a re-click racing
		// the response) on an unchanged spec at the same depth within a minute
		// returns the stored analysis instead of billing a second model call. A
		// spec edit or a depth change always regenerates.
		const specHash = createHash("sha256").update(spec).digest("hex");
		const stored = parseQaAnalysis(feature.qaAnalysis);
		if (
			stored &&
			stored.specHash === specHash &&
			stored.depth === project.qaStrategyLevel &&
			Date.now() - Date.parse(stored.generatedAt) < 60_000
		) {
			return { qaAnalysis: stored, replayed: true };
		}

		// Tenant for prompt/model resolution derives from the LOADED project
		// record, not the caller-supplied org (the ratchet's "derive the org from
		// the record" guidance): a member of org B must not have org B's prompt
		// override applied to — or org B's AI usage billed for — a project that
		// lives outside org B.
		const tenantFilter: MaturationTenantFilter = {
			organizationId: project.organizationId ?? null,
			userId: context.user.id,
		};

		// Sibling features (titles only) so cross-feature risks can be grounded
		// in what actually exists (AC-3) — with only its own spec the model
		// cannot know any other feature exists. Bounded and cheap.
		// KNOWN LIMITATION: this compound order is not the same ranking as
		// `lastEditedAt ?? createdAt` — it places every edited feature above
		// every never-edited one, so under the cap a feature created today can
		// lose its place to one last touched years ago. Correcting it needs the
		// partitioned read in `story-activity-ranking.ts`, which pulls a second
		// database collaborator into this procedure's test surface.
		const projectFeatures = await db.userStory.findMany({
			where: {
				projectId: input.projectId,
				kind: "FEATURE",
				id: { not: input.storyId },
				mergedIntoStoryId: null,
			},
			select: { identifier: true, title: true },
			orderBy: [
				{ lastEditedAt: { sort: "desc", nulls: "last" } },
				{ createdAt: "desc" },
			],
			take: SIBLING_FEATURE_LIMIT,
		});

		// Under TDD the cases are written BEFORE the
		// implementation, so the review grades the spec against them too. Loaded
		// only when the project runs TDD — otherwise these cases are drafted
		// after this review and feeding them back would grade the model's own
		// later output.
		const tddTestCases = project.applyTddApproach
			? (
					await db.testCase.findMany({
						where: {
							projectId: input.projectId,
							workItemLinks: {
								some: { userStoryId: input.storyId },
							},
						},
						select: { identifier: true, title: true },
						orderBy: { identifier: "asc" },
						take: 60,
					})
				).map((c) => ({ identifier: c.identifier, title: c.title }))
			: undefined;

		const generated = await generateQaAnalysis({
			feature,
			tenantFilter,
			depth: project.qaStrategyLevel,
			projectFeatures,
			tddTestCases,
		});
		if (!generated) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This feature has no specification yet. Add a description or acceptance criteria first.",
			});
		}

		const qaAnalysis: QaAnalysisContent = {
			...generated,
			depth: project.qaStrategyLevel,
			specHash,
			generatedAt: new Date().toISOString(),
			// Recorded so the tab can show that the cases were part of this
			// review. Only meaningful under test-first — the standard flow
			// reads none by design, and stamping 0 there would read as a
			// failure rather than as the intended ordering.
			...(tddTestCases
				? { reviewedAgainstCaseCount: tddTestCases.length }
				: {}),
		};

		const count = await setQaAnalysis({
			userStoryId: input.storyId,
			projectId: input.projectId,
			qaAnalysis,
			generatedByUserId: context.user.id,
		});
		if (count === 0) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		// Standard ordering (test-first OFF): this review IS the "Feature
		// Review" step, and the flow both switches describe puts test-case
		// drafting straight after it — "cases are drafted after the feature is
		// reviewed", as the settings page and the Testing tab have always said.
		// Nothing observed this completion before, so on the DEFAULT settings no
		// feature was ever drafted automatically at all.
		//
		// Placed after the persist and after the idempotent-replay return, so a
		// re-click that served the stored analysis does not re-trigger. Scheduled
		// with runInBackground rather than a bare `void`: on Vercel a floating
		// promise is not guaranteed to finish once the response is sent, and the
		// window lost here spans the ledger claim.
		// The three conditions already in hand are checked first so the query
		// below is not paid on every test-first analysis, where the answer is
		// always no. `shouldDraftAfterFeatureReview` still re-checks them — this
		// is a short-circuit, not a second source of truth.
		const eligibility =
			isTestCasesEnabled() &&
			project.generateManualTestCases &&
			!project.applyTddApproach
				? await db.userStory.findUnique({
						where: {
							id: input.storyId,
							projectId: input.projectId,
						},
						select: {
							kind: true,
							_count: { select: { testCaseLinks: true } },
						},
					})
				: null;
		if (
			eligibility &&
			shouldDraftAfterFeatureReview({
				kind: eligibility.kind,
				generateManualTestCases: project.generateManualTestCases,
				applyTddApproach: project.applyTddApproach,
				existingCaseCount: eligibility._count.testCaseLinks,
				testCasesEnabled: isTestCasesEnabled(),
			})
		) {
			runInBackground(
				startAutoDraft({
					projectId: input.projectId,
					organizationId: project.organizationId ?? null,
					userId: context.user.id,
					storyId: input.storyId,
					trigger: "feature-review",
				}),
			);
		}

		return { qaAnalysis, replayed: false };
	});
