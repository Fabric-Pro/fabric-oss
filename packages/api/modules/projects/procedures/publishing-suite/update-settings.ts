import { ORPCError } from "@orpc/client";
import {
	getLinkedSlackChannels,
	getLinkedTeamsChannels,
	MAX_PUBLISHING_LOOKBACK_DAYS,
	MAX_PUBLISHING_PREFERENCE_ITEM_LENGTH,
	MAX_PUBLISHING_PREFERENCE_ITEMS,
	MAX_PUBLISHING_STRATEGIC_PRIORITIES_LENGTH,
	MIN_PUBLISHING_LOOKBACK_DAYS,
	normalizePreferenceLabel,
	PUBLISHING_CADENCES,
	PUBLISHING_CHAT_PLATFORMS,
	PUBLISHING_TOPIC_POST_TYPES,
	PublishingSettingsProjectNotFoundError,
	PublishingSettingsTenantMismatchError,
	upsertPublishingSuiteSettings,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/**
 * Procedure-side mirror of `publishingChatChannelSchema` from
 * `@repo/database/src/publishing-chat-channel`. Defined locally with the api
 * package's own zod — the cross-package re-export trips Zod's TS-internal
 * `version.minor` mismatch when packages pin different Zod 4.x patches. Same
 * pattern, and the same reason, as `apiNewsletterChatChannelSchema` in
 * `newsletter/procedures/settings-update.ts`.
 *
 * MUST stay in lockstep with the database export. This schema governs the WIRE
 * boundary only — the handler below re-validates the submitted triples against
 * the project's live linked-channel set, and the send path re-resolves them
 * again at post time.
 */
const apiPublishingChatChannelSchema = z.object({
	platform: z.enum(PUBLISHING_CHAT_PLATFORMS),
	teamId: z.string().min(1),
	channelId: z.string().min(1),
	channelName: z.string().optional(),
});

export const updatePublishingSuiteSettingsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "PUT",
		path: "/projects/{projectId}/publishing-settings",
		tags: ["Projects", "Publishing Suite"],
		summary: "Update the project's Publishing Suite configuration",
	})
	.input(
		z.object({
			projectId: z.string(),
			// Guard only — never stamped. The helper derives tenant columns from
			// the locked Project row.
			organizationId: z.string().nullable().optional(),
			cadence: z.enum(PUBLISHING_CADENCES).optional(),
			// null clears the override back to the engine default.
			lookbackDays: z
				.number()
				.int()
				.min(MIN_PUBLISHING_LOOKBACK_DAYS)
				.max(MAX_PUBLISHING_LOOKBACK_DAYS)
				.nullable()
				.optional(),
			notificationsEnabled: z.boolean().optional(),
			// Selected broadcast targets. `[]` turns chat off; omitted leaves the
			// stored selection alone. Re-validated against the project's LIVE
			// linked set below — a channel unlinked since the form loaded is
			// dropped silently rather than persisted or rejected.
			chatChannels: z
				.array(apiPublishingChatChannelSchema)
				.max(50)
				.optional(),
			// 1C-1b (§7.1(a), FR8–FR10): the advisory recommendation preferences.
			//
			// Three states and all three are meaningful — omitted leaves the stored
			// value alone, `[]` clears it, a list replaces it. `.optional()` without
			// `.nullable()` is what keeps them distinct: a null here would be a
			// fourth spelling of "clear" that nothing produces and no test reaches.
			//
			// Bounded per ITEM as well as per list. One very long "theme" bloats a
			// generation prompt as effectively as a hundred short ones, and only the
			// per-item cap would notice it.
			//
			// `.trim()` BEFORE `.min(1)`, and the order is the whole point: `.min(1)`
			// alone rejects "" but accepts "   ", which the snapshot normalizer then
			// drops — leaving the stored row saying a theme is configured while the
			// prompt and the hash both see none. That is exactly the stored-vs-hashed
			// disagreement this bound exists to prevent, arriving through the one
			// input shape the check did not cover. The form already trims; this is
			// for every other caller.
			preferredThemes: z
				.array(
					// NORMALIZE FIRST, then bound — and with the snapshot's own
					// exported rule rather than a lookalike. Raised in adversarial
					// review: `.trim()` alone still accepted "Developer   Experience"
					// and an item carrying a line break, so the row an admin read
					// back differed from the text the prompt was built from, and a
					// newline inside a theme would have been rendered into the middle
					// of the clause's list. Bounding AFTER normalization also means
					// the cap counts the characters that actually reach the model.
					z
						.string()
						.transform(normalizePreferenceLabel)
						.pipe(
							z
								.string()
								.min(1)
								.max(MAX_PUBLISHING_PREFERENCE_ITEM_LENGTH),
						),
				)
				.max(MAX_PUBLISHING_PREFERENCE_ITEMS)
				.optional(),
			// The CLOSED vocabulary, not free text, and capped at its own size
			// rather than by the shared item limit — a cap of 25 on a four-value
			// enum is a limit that can never fire, which reads to a later editor as
			// a limit nobody thought about.
			//
			// What this rejects is the point: a plausible-but-absent "NEWSLETTER",
			// or the human label "Blog Post". Either would be stored, hashed, and
			// injected into the prompt as guidance the generator cannot satisfy,
			// because what it produces is validated against this very enum.
			preferredPostTypes: z
				.array(z.enum(PUBLISHING_TOPIC_POST_TYPES))
				.max(PUBLISHING_TOPIC_POST_TYPES.length)
				.optional(),
			// Nullable, unlike the two lists: null is how the form clears it,
			// matching `lookbackDays`. Line structure is preserved downstream, so
			// this is trimmed by the snapshot builder but never reflowed.
			//
			// The transform folds blank INTO that clear rather than rejecting it.
			// Without it "" and "   " are a fourth stored representation of "not
			// set" that the snapshot reads as null — the row and the canonical
			// preferences disagreeing again. Rejecting blank was the other option
			// and is worse: a caller sending "" plainly means clear, and answering
			// that with a 400 buys nothing.
			//
			// ABSENT STAYS ABSENT. Measured, not assumed: the transform does not
			// add the key when it was not sent, so the three states this field
			// contracts for — omitted leaves it alone, null/blank clears, a value
			// replaces — all survive intact.
			strategicPriorities: z
				.string()
				.max(MAX_PUBLISHING_STRATEGIC_PRIORITIES_LENGTH)
				.nullable()
				.optional()
				.transform((value) =>
					typeof value === "string" ? value.trim() || null : value,
				),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPublishingSuiteFeatureEnabled();
		// Re-validate against the LIVE linked-channel set. Not a security boundary
		// — the send path resolves these again and skips anything it cannot find —
		// but without it the stored list accumulates targets that can never be
		// delivered to, and the picker shows a selection the product will never
		// honour.
		//
		// Guarded on LENGTH rather than on presence: an empty list is the off
		// switch and must pass through as `[]`. Running the filter on it would cost
		// two reads to produce the same empty array, and folding it to `undefined`
		// would make "turn chat off" mean "change nothing".
		let chatChannels = input.chatChannels;
		if (chatChannels && chatChannels.length > 0) {
			const [teamsLinked, slackLinked] = await Promise.all([
				getLinkedTeamsChannels(input.projectId),
				getLinkedSlackChannels(input.projectId),
			]);
			const teamsKeys = new Set(
				teamsLinked.map((c) => `TEAMS:${c.teamId}:${c.channelId}`),
			);
			const slackKeys = new Set(
				slackLinked.map((c) => `SLACK:${c.slackTeamId}:${c.channelId}`),
			);
			chatChannels = chatChannels.filter((c) =>
				(c.platform === "TEAMS" ? teamsKeys : slackKeys).has(
					`${c.platform}:${c.teamId}:${c.channelId}`,
				),
			);
		}
		try {
			const settings = await upsertPublishingSuiteSettings({
				projectId: input.projectId,
				clientOrganizationId: input.organizationId ?? null,
				createdByUserId: context.user.id,
				cadence: input.cadence,
				lookbackDays: input.lookbackDays,
				notificationsEnabled: input.notificationsEnabled,
				chatChannels,
				// Straight through — no filtering step. Unlike `chatChannels` there
				// is no live external set to re-validate against: the post-type
				// vocabulary is closed at the schema above, and themes and
				// priorities are the project's own words.
				preferredThemes: input.preferredThemes,
				preferredPostTypes: input.preferredPostTypes,
				strategicPriorities: input.strategicPriorities,
			});
			return { settings };
		} catch (error) {
			if (error instanceof PublishingSettingsProjectNotFoundError) {
				throw new ORPCError("NOT_FOUND", {
					message: "Project not found",
				});
			}
			if (error instanceof PublishingSettingsTenantMismatchError) {
				throw new ORPCError("BAD_REQUEST", {
					message: "organizationId does not match the project",
				});
			}
			throw error;
		}
	});
