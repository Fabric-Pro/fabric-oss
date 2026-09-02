import {
	getLinkedChannelNames,
	listPublishingChatDeliveriesForProjectCycle,
} from "@repo/database";
import { z } from "zod";
// `Permissions` comes from HERE, not from `@repo/permissions`, and that matters
// for more than tidiness. The procedure test mocks this module and supplies a
// hand-written `Permissions` literal, while asserting against the real constant
// imported from `@repo/permissions`. Taking it from the mocked module makes the
// gating assertion a cross-check of two independently-sourced values; taking it
// from `@repo/permissions` would make both sides the same object and the
// assertion `expect(x).toBe(x)`. Every sibling in this directory imports it here.
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { describePublishingChatDelivery } from "../../lib/publishing-chat-delivery-outcome";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/**
 * One cycle's per-channel chat delivery detail (Fizzy #1850, Phase 1C-4b).
 *
 * Its own procedure rather than a widening of `listCycles`: this is only needed
 * when someone expands a single row, and the raw provider text it reads has to
 * be translated away before it crosses the wire.
 *
 * AUTHORIZATION: `requireProjectPermission(PUBLISHING_TOPIC_READ)` resolves
 * object-level against the real project row, and the reader is bound by
 * `projectId` — which is what makes the untrusted `cycleId` safe.
 *
 * No `requireInputOrgPermission`, and the reason is NOT that it would be awkward
 * to add: it reads `input.organizationId` through its own resolver and needs no
 * `resolveOrganizationId` call, so it would not trip the ratchet either. It is
 * declined because its own docstring says "Do NOT use on project-scoped
 * procedures", and because THIS HANDLER NEVER READS `input.organizationId`. That
 * is the precise difference from the newsletter sibling, which does read it (it
 * re-resolves the project under an org XOR filter) and therefore does need the
 * guard. Where no input-derived org is in play, there is no target org to
 * authorize.
 */
export const listCycleChatDeliveriesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-topics/cycles/{cycleId}/chat-deliveries",
		tags: ["Publishing Suite"],
		summary: "List a publishing cycle's per-channel chat delivery outcomes",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			cycleId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		const rows = await listPublishingChatDeliveriesForProjectCycle(
			input.cycleId,
			input.projectId,
		);
		if (rows.length === 0) {
			return { deliveries: [] };
		}

		// The ledger stores opaque provider ids only. Resolved from the LIVE
		// linked-channel tables, so a channel unlinked since the broadcast falls
		// back to its id rather than dropping out of a historical record.
		const names = await getLinkedChannelNames(input.projectId);

		return {
			// Rebuilt field by field, never spread: `errorMessage` is selected by
			// the reader and must not reach the wire, and a spread would ship it
			// the moment anyone touched that select.
			deliveries: rows.map((r) => ({
				platform: r.platform,
				// The ledger's identity is (platform, externalTeamId, channelId) —
				// a channel id is unique only WITHIN a workspace, so the client
				// needs the team id for a collision-free row key. Not sensitive:
				// already visible in linked-channel settings, whose listers gate
				// on the same audience.
				externalTeamId: r.externalTeamId,
				channelId: r.channelId,
				channelName:
					names.get(
						`${r.platform}:${r.externalTeamId}:${r.channelId}`,
					) ?? r.channelId,
				status: r.status,
				// Positional, and `reason` / `errorMessage` are both `String?` —
				// so transposing them compiles cleanly and collapses both skip
				// classifications into the generic sentence. The SKIPPED case in
				// publishing-suite-procedures.test.ts is the only thing that
				// catches it; the mapper's own unit test cannot see the wiring.
				reason: describePublishingChatDelivery(
					r.status,
					r.reason,
					r.errorMessage,
					r.platform,
					r.createdAt,
				),
			})),
		};
	});
