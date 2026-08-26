import {
	countPublishingCycleRecipients,
	countPublishingCycles,
	getPublishingSuiteSettings,
	listPublishingCycles,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/**
 * One page of a project's suggestion-cycle history (Fizzy #1850, Phase 1C-4a).
 *
 * The tab renders only the LATEST cycle, so a run that failed or produced
 * nothing disappears the moment the next one starts — including the failure
 * somebody would open the tab to investigate.
 */
export const listPublishingCyclesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-topics/cycles",
		tags: ["Projects", "Publishing Suite"],
		summary: "List the project's past publishing suggestion cycles",
	})
	.input(
		z.object({
			projectId: z.string(),
			// Accepted for symmetry with every sibling in this namespace, and
			// deliberately NOT used to scope the read. Authorization is
			// `requireProjectPermission` on (projectId, userId) and the query is
			// keyed on projectId, which belongs to exactly one tenant — so there
			// is no path by which a caller reaches a project's cycles without
			// reaching the project. Resolving the org from input instead would
			// introduce `resolveOrganizationId`, whose whole hazard is that it
			// returns the caller's string with no membership lookup.
			organizationId: z.string().nullable().optional(),
			// A literal union rather than a bounded integer: it stops a caller
			// asking for an unbounded page at all, rather than clamping one.
			// Same three sizes the newsletter send history offers.
			limit: z
				.union([z.literal(15), z.literal(50), z.literal(100)])
				.default(15),
			offset: z.number().int().min(0).default(0),
			status: z.enum(["all", "ready", "failed", "empty"]).default("all"),
		}),
	)
	.handler(async ({ input }) => {
		assertPublishingSuiteFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(PUBLISHING_TOPIC_READ) gates
		// project access, exactly as it does for `latestCycle`.
		const [rows, total, settings] = await Promise.all([
			listPublishingCycles(input.projectId, {
				limit: input.limit,
				offset: input.offset,
				status: input.status,
			}),
			// The SAME filter the page was read with. Two different filters give
			// a total that does not describe the rows, and the pager then offers
			// pages that hold nothing.
			countPublishingCycles(input.projectId, input.status),
			// One read per REQUEST, not per row — see `chatChannelsConfigured`.
			getPublishingSuiteSettings(input.projectId),
		]);

		// SEQUENTIAL, not folded into the Promise.all above, because it is keyed
		// on the ids the page returned and cannot be issued before they exist.
		// One extra round trip per page, over at most `limit` cycles.
		const recipients = await countPublishingCycleRecipients(
			input.projectId,
			rows.map((c) => c.id),
		);

		return {
			// Rebuilt field by field, never spread. `triggeredByUserId` is an
			// audit breadcrumb with no FK, and this procedure is reachable by
			// every project member — so the shape is stated explicitly, which
			// also keeps a column added to the model later from riding along by
			// default.
			cycles: rows.map((c) => ({
				id: c.id,
				status: c.status,
				startedAt: c.startedAt,
				completedAt: c.completedAt,
				trigger: c.triggeredByUserId
					? ("manual" as const)
					: ("scheduled" as const),
				topicCount: c._count.topics,
				// No `?? 0`. Prisma returns 0, never undefined, for a selected
				// relation, so a coalesce would assert a possibility that cannot
				// occur — and it would not mask a missing select either, since
				// that is a type error with or without it.
				chatDeliveryCount: c._count.chatDeliveries,
				// Why in-app and email did or did not go out. Safe to expose to
				// every project member, unlike `triggeredByUserId` above: it
				// names an outcome, never a person. The history table is the
				// first reader this column has ever had — it has been written
				// since 1C-2b and read by nothing, so a project could not tell
				// "nobody was attributed to these topics" from "the recipient
				// lookup threw", which is the distinction the vocabulary exists
				// to preserve.
				notificationOutcome: c.notificationOutcome,
				// COUNTS OF PEOPLE, not of ledger rows — see the query's own
				// note. Absent means the cycle owed nobody anything, which is
				// the ordinary state for six of the nine outcomes, so it reads
				// as zero rather than as missing data.
				//
				// Numbers, never names. The outcome and these two counts are
				// safe for every project member; WHO was notified is a
				// different question with a different audience, and this
				// procedure deliberately does not answer it.
				notifiedRecipients: recipients[c.id] ?? {
					owed: 0,
					delivered: 0,
				},
			})),
			total,
			// Separates "this refresh recorded no delivery rows" from "this project
			// never targeted a chat channel". The broadcast has six whole-run gates
			// that write NO ledger row by design, so a zero count alone renders a
			// refused broadcast identically to an unconfigured project — which is
			// the failure #2013 was, and the one this slice exists to end.
			// `Array.isArray`, not a cast plus `.length`. The column is `Json?`
			// with no CHECK, and a STRING has a length — so a corrupted scalar
			// like "SLACK" would read as five configured channels and offer the
			// disclosure on a project that targets none. Non-array scalars other
			// than strings degrade to `undefined > 0` and happen to be safe,
			// which is what makes the cast look correct until it is not.
			chatChannelsConfigured:
				Array.isArray(settings.chatChannels) &&
				settings.chatChannels.length > 0,
		};
	});
