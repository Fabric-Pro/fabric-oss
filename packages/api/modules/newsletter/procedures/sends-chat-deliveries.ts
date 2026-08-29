import { ORPCError } from "@orpc/server";
import {
	db,
	getLinkedChannelNames,
	listChatDeliveriesForProjectSend,
} from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
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
	// returns the caller's string verbatim with no membership lookup.
	//
	// The sibling newsletter procedures take the ratchet's other sanctioned
	// route — they no longer resolve the org from input at all, deriving it from
	// the loaded project row and treating `input.organizationId` as a guard
	// (`assertInputOrgMatchesProject`). Either is fine; what is not fine is
	// scoping the project lookup itself by the caller, which locked out every
	// non-owner member of a personal project.
	.use(requireInputOrgPermission(Permissions.PROJECT_SETTINGS_READ))
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			sendId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		// `requireProjectPermission` above has already authorized this caller for
		// THIS project — as owner, active ProjectMember, or via an org role. Load
		// the project by id and take the tenant from the loaded row;
		// `input.organizationId` is a guard, never a scoping key.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);

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
