import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	enforceAiRateLimit,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { startTestCaseDraft } from "../../lib/start-test-case-draft";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

/**
 * How many features one drafting run may cover.
 *
 * This is a spend limit, not a UI preference: each feature is a separate LLM
 * generation, so the cap is the per-click ceiling on what a user can bill. The
 * dialog states it and stops the selection there — a silent truncation would
 * bill for some features and quietly drop the rest.
 */
export const MAX_FEATURES_PER_DRAFT_JOB = 5;

/**
 * Start a durable background run that drafts test cases from one or more
 * features.
 *
 * Drafting used to happen inline here, which meant a multi-minute chain of LLM
 * calls held the request open and died with the tab. It now starts a Temporal
 * workflow and returns immediately: the dialog closes, the UI is free, and the
 * run survives a reload, a tab close, and a logout. The job row is the durable
 * source of truth — the client rediscovers an in-flight run by querying the
 * project (`draftJobs.list`), never by remembering the workflow id.
 *
 * The drafting itself (and its per-feature error handling) lives in
 * `draftTestCasesForFeature`, the activity this workflow calls.
 */
export const aiDraftTestCasesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_CREATE))
	// Each call can start a billed generation, and the claim's advisory lock only
	// serializes concurrent runs over ONE project — it does not stop a caller
	// firing repeatedly, or fanning out across several projects they own. The AI
	// preset (20/min per user per path) is far above any real use of a button a
	// person presses.
	.use(async ({ context, next, path }) => {
		await enforceAiRateLimit(context.user.id, path);
		return await next();
	})
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/ai-draft",
		tags: ["Projects", "Test Cases"],
		summary: "Start a background AI test-case drafting run",
	})
	.input(
		z.object({
			projectId: z.string(),
			/**
			 * The features to draft from. Capped — see
			 * {@link MAX_FEATURES_PER_DRAFT_JOB}; the cap is enforced here rather
			 * than trimmed, so an over-long request is a visible rejection.
			 */
			storyIds: z
				.array(z.string())
				.min(1)
				.max(MAX_FEATURES_PER_DRAFT_JOB),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_CREATE) gates project
		// access — drafting creates cases, so create rights apply.
		const user = context.user;

		// Duplicate ids would bill the same feature twice for identical output.
		const storyIds = [...new Set(input.storyIds)];

		// The project-level "Generate manual test cases"
		// switch is a HARD gate. When it is off, no drafting run may start —
		// this is the single entry point for both the QA-tab "Draft cases"
		// button and the QA page dialog, so gating here delivers the AC
		// "OFF → no test cases generated (no credits spent)": we reject before
		// `claimTestCaseDraftJob` writes a job row or a workflow is dispatched,
		// so nothing is billed.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			// `organizationId` comes from the RECORD, never from the request.
			// This procedure's guard authorizes `projectId` alone, and the
			// drafting run resolves AI credentials and bills credits against
			// whatever org it is handed — so a caller-supplied org would spend
			// another tenant's credits on a project they do not belong to.
			select: { generateManualTestCases: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}
		if (!project.generateManualTestCases) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Manual test-case generation is turned off for this project. A project admin can turn it on in Settings → Testing.",
			});
		}

		// Resolve every requested feature inside this project, so a cross-project
		// id is rejected here rather than reaching the worker. `identifier` is
		// only for naming overlap-blocked features in the CONFLICT message.
		const stories = await db.userStory.findMany({
			where: { id: { in: storyIds }, projectId: input.projectId },
			select: { id: true, identifier: true, acceptanceCriteria: true },
		});
		if (stories.length !== storyIds.length) {
			throw new ORPCError("NOT_FOUND", {
				message: "Feature not found in this project",
			});
		}

		// Acceptance criteria ARE the drafting contract — every case must name the
		// criterion it validates. Refuse only when NOT ONE requested feature has
		// them: that job provably cannot draft anything, so starting it would just
		// bill nothing and report failure. A mixed batch still runs; the features
		// without criteria are recorded as skipped rather than blocking the rest.
		if (!stories.some((story) => story.acceptanceCriteria?.trim())) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This feature has no acceptance criteria. Add acceptance criteria to the feature, then draft test cases from them.",
			});
		}

		// A run covering any of these features is already in flight — starting a
		// second would bill duplicate generations AND append duplicate cases (the
		// drafter has no existing-case dedupe). The overlap check and the create
		// are ONE transaction inside `claimTestCaseDraftJob`, serialized per
		// project by an advisory lock — a truly concurrent pair of clicks can no
		// longer both slip through. Staleness cutoff and cross-requester scope
		// are documented on the claim itself.
		// Claim and dispatch, shared with the test-first auto-draft that fires when
		// a feature reaches Ready for Dev. The claim's overlap check and insert are
		// ONE transaction serialized per project by an advisory lock: the drafter
		// has no existing-case dedupe before it bills, so two concurrent runs over
		// one feature would pay for duplicate generations AND append duplicate
		// cases.
		const started = await startTestCaseDraft({
			projectId: input.projectId,
			organizationId: project.organizationId,
			userId: user.id,
			requestedById: user.id,
			storyIds,
		});

		if (!started.started && started.reason === "blocked") {
			// Name the blockers: against a multi-feature selection, an unnamed
			// "this feature" leaves the user deselecting at random.
			const blockedIds = new Set(started.blockedStoryIds);
			const blocked = stories.filter((story) => blockedIds.has(story.id));
			const names = blocked
				.map((story) => story.identifier ?? story.id)
				.join(", ");
			throw new ORPCError("CONFLICT", {
				message: `Test cases for ${names} are already being drafted. Wait for the current run to finish, or deselect ${blocked.length > 1 ? "these features" : "this feature"}.`,
			});
		}
		if (!started.started) {
			// The job row is already marked FAILED by the helper, so the client
			// shows a dismissible error rather than polling a PENDING row forever.
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Could not start drafting. Please try again.",
			});
		}

		return {
			jobId: started.jobId,
			status: started.status,
			totalFeatures: storyIds.length,
		};
	});
