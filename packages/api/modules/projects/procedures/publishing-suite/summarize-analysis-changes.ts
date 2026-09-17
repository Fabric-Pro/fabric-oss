/**
 * `publishingSuite.summarizeAnalysisChanges` — turn a before→after pair of a
 * topic's Planning & Analysis prose into a short, section-tagged change summary
 * for the confirm-time review, so the author reads ~4 lines instead of scanning
 * the assistant's whole inline diff.
 *
 * The Publishing Suite half of the parity with
 * `stories.maturation.summarizeChanges`; the reasoning that is specific to a
 * planning analysis — above all, where the section vocabulary comes from —
 * lives in `lib/summarize-analysis-changes.ts`.
 *
 * NOT `saveAnalysisRevision`'s `changeSummary`. That one is a single ≤200-char
 * label an author types to name their own revision, and it is stored. This is
 * a list of bullets a model derives from a diff, and it is stored NOWHERE. The
 * output field is still called `changeSummary` on purpose, so the web layer can
 * reuse `ConfirmChangeSummaryCard` verbatim rather than fork it over a name.
 *
 * READ-ONLY. It writes no revision, mints no decision thread, records no
 * outcome event, and touches no topic row. That is what lets it run while the
 * author has unsaved text in the editor without racing their own Save — the
 * hazard `PlanningAnalysisEditor` is built around (Fizzy #1929).
 *
 * ADVISORY, NEVER BLOCKING. Every way this call can end — slow, empty, or
 * thrown — must leave Accept and Reject fully usable. It is deliberately NOT
 * fail-soft in the handler: a model failure throws rather than returning `[]`,
 * because "nothing substantive changed" and "the summary could not be produced"
 * are different facts and only the caller can decide what to say about each.
 * The card renders nothing for both, so the two look the same on screen — the
 * distinction is for logging and for a retry affordance, not for the diff bar,
 * which must never be gated on this call's state.
 */

import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";
import { requireEligibleProjectForTopic } from "../../lib/publishing-topic-project";

/**
 * Bound on each version handed in.
 *
 * `BODY_MAX` from `analysis-revision.ts` — 40,000 — and not maturation's
 * 200,000. A planning analysis is already bounded at 40k by the only path that
 * can persist one, so a summarize call that accepted five times that would be
 * accepting text this feature cannot produce. Two of them, so the prompt is
 * bounded at ~80k of document plus the section list.
 */
const VERSION_MAX = 40000;

export const summarizeAnalysisChangesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/analysis-change-summary",
		tags: ["Projects", "Publishing Suite"],
		summary: "Summarize a pending planning-analysis rewrite for review",
	})
	.input(
		z.object({
			projectId: z.string(),
			/**
			 * Carried for the route's shape and for the caller's own logging —
			 * deliberately never resolved to a row. Both versions arrive in the
			 * request body, so no topic is read and there is nothing a topic id
			 * from another project could surface: unlike its siblings in this
			 * directory, this handler has no lookup to scope by `{ topicId,
			 * projectId }` (DV16) because it performs no lookup at all.
			 */
			topicId: z.string(),
			/**
			 * F2 client-org shape guard. Never a scoping key and never stamped
			 * anywhere — `requireEligibleProjectForTopic` rejects a
			 * positively-wrong non-null value and the tenant below comes off
			 * the loaded Project row.
			 */
			organizationId: z.string().nullable().optional(),
			before: z.string().max(VERSION_MAX),
			after: z.string().max(VERSION_MAX),
		}),
	)
	.output(z.object({ changeSummary: z.array(z.string()) }))
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		// The project ratchet, though this reads nothing — the exception to
		// `analysis-revision.ts`'s "reads stay permissive" rule, and for the
		// reason that rule gives. A permissive read exists there so the version
		// drawer cannot 404 while the tab beside it keeps rendering; there is no
		// panel to contradict here, because a refusal renders nothing at all.
		// What the ratchet buys instead is the two things this handler actually
		// needs: the org taken from the Project row rather than from input
		// (SOC 2 CC6.1/CC6.3), and a model call that cannot be opened against an
		// archived or soft-deleted project.
		const project = await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId,
		});

		// Loaded here, not imported at the top, and this is a property of the
		// BARREL rather than a local quirk — the next AI-using procedure added
		// to this directory should do the same. Every other procedure exported
		// from `publishing-suite/index.ts` is DB-only, so importing that barrel
		// costs a `@repo/database` mock and nothing else. A static import here
		// would drag `@repo/ai` — and through it `@repo/payments`, which calls
		// `setAiUsageRecorder(...)` at module scope — into the graph of all
		// forty of them, for the sake of the one that needs it.
		//
		// Same shape as `planning-analysis.ts`'s `await import("@repo/temporal")`
		// a few files over. Placed after the gate and the ratchet on purpose: a
		// disabled suite or an ineligible project never loads the AI stack at all.
		const { summarizeAnalysisChanges } = await import(
			"../../lib/summarize-analysis-changes"
		);

		const changeSummary = await summarizeAnalysisChanges({
			before: input.before,
			after: input.after,
			tenantFilter: {
				organizationId: project.organizationId,
				userId: context.user.id,
			},
			projectId: project.id,
		});
		return { changeSummary };
	});
