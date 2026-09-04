import { ORPCError } from "@orpc/server";
import { db, unlinkTeamsChatFromProject } from "@repo/database";
import { deleteMonitoredConversationContext } from "@repo/temporal/delete-channel-context";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireContextSourceAdmin } from "../../lib/require-context-source-admin";

/**
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can
 * unlink Teams chats.
 *
 * Unlinks a Teams chat from a project. Cascading deletes remove the
 * associated seen-message dedup rows. Existing PendingBacklogProposal rows
 * remain intact — they keep their reference to the chat via sourceMetadata
 * for historical display.
 *
 * The chat's `ProjectContext` pointer row goes too (Fizzy #2228, U7). Chats are
 * never a source of conversation capture — capture is scoped to shared channels
 * by decision, because a project is a wider audience than a private
 * conversation — so this one reliably finds no bundles. It runs the same path
 * anyway: leaving the pointer row behind would keep an unlinked chat listed as
 * a project context, and a chat row that HAS been embedded by some other route
 * would keep its vectors.
 */
export const unlinkChatProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-chat-monitor/unlink",
		tags: ["Projects", "Teams Chat Monitor"],
		summary: "Unlink a Teams chat from a project",
		description:
			"Removes a linked Teams chat, its seen-message markers, and its context row.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			linkedChatId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const tenantFilter = organizationId
			? { organizationId }
			: { organizationId: null, userId: user.id };

		const project = await db.project.findFirst({
			where: { id: input.projectId, ...tenantFilter },
			select: { id: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Destructive: raises the floor to PROJECT_ADMIN while the flag is on.
		// After the tenant check so a non-member still gets NOT_FOUND rather
		// than FORBIDDEN, which would confirm the project exists.
		await requireContextSourceAdmin({
			projectId: input.projectId,
			userId: user.id,
		});

		// The monitor row carries the provider identity — the input is this
		// row's own id, which no context's metadata records. Read it while it
		// is still there; the context lookup below matches on `chatId`.
		const linked = await db.projectLinkedTeamsChat.findFirst({
			where: { id: input.linkedChatId, projectId: input.projectId },
			select: { chatId: true },
		});

		if (linked) {
			await deleteMonitoredConversationContext({
				projectId: input.projectId,
				// The tenant a PERSONAL stranded-vector cleanup record is
				// written and read under. An organization unlink keys on
				// `organizationId` instead — the queue enforces the XOR.
				userId: user.id,
				organizationId,
				conversation: {
					provider: "MICROSOFT_TEAMS",
					kind: "chat",
					chatId: linked.chatId,
				},
			});
		}

		await unlinkTeamsChatFromProject(input.projectId, input.linkedChatId);

		return { success: true };
	});
