import { ORPCError } from "@orpc/server";
import {
	db,
	getLinkedChannelNames,
	listChatDeliveriesForProjectSend,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { describeChatDeliveryFailure } from "../lib/chat-delivery-error";

/**
 * Per-channel chat delivery detail for one newsletter send (Fizzy #2013).
 *
 * Kept as its own procedure rather than widened into `sends.list` on purpose:
 * `buildSendsListArgs` has a deliberately narrow, member-safe projection, and
 * this data is only needed when an admin expands a single row. Failure text is
 * mapped through `describeChatDeliveryFailure`, so the raw provider payload
 * never crosses the wire.
 */
export const chatDeliveriesProcedure = tenantProtectedProcedure
	// Verifies membership of the organization named in the INPUT. Required, and
	// not covered by requireProjectPermission below: that middleware resolves on
	// (projectId, userId) and never reads the org, and `resolveOrganizationId`
	// returns the caller's string verbatim with no membership lookup. Sibling
	// newsletter procedures omit this only because they predate the ratchet and
	// sit on the unaudited debt baseline — new procedures must not copy them
	// (packages/api/__tests__/input-org-unverified-ratchet.test.ts).
	.use(requireInputOrgPermission(Permissions.PROJECT_SETTINGS_READ))
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			sendId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const project = await db.project.findFirst({
			where: organizationId
				? { id: input.projectId, organizationId }
				: {
						id: input.projectId,
						organizationId: null,
						userId: context.user.id,
					},
			select: { id: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const rows = await listChatDeliveriesForProjectSend(
			input.sendId,
			input.projectId,
		);
		if (rows.length === 0) {
			return { deliveries: [] };
		}

		// The ledger stores opaque provider ids only. Resolve display names from
		// the live linked-channel tables; a channel unlinked (or never named)
		// since the send falls back to its id rather than disappearing.
		const names = await getLinkedChannelNames(input.projectId);

		return {
			deliveries: rows.map((r) => ({
				// CONTENT is the published release-notes post; APPROVAL is the
				// "awaiting review" alert. Both can exist for the same channel
				// tuple on one send, so the client needs this to tell them
				// apart (Fizzy #2203).
				kind: r.kind,
				platform: r.platform,
				// The ledger's identity is (platform, externalTeamId, channelId)
				// — a channel id is only unique WITHIN a workspace/team. The
				// client needs the team id to build a collision-free row key,
				// so it is returned rather than used only for the name lookup.
				// Not sensitive: it is already visible in linked-channel settings.
				externalTeamId: r.externalTeamId,
				channelId: r.channelId,
				channelName:
					names.get(
						`${r.platform}:${r.externalTeamId}:${r.channelId}`,
					) ?? r.channelId,
				status: r.status,
				reason: describeChatDeliveryFailure(
					r.status,
					r.errorMessage,
					r.platform,
				),
			})),
		};
	});
