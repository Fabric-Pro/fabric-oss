/**
 * `projects.backlog.history.sessions.get` — read-only detail for a single AI
 * Backlog Update session, INCLUDING the captured chat transcript (which the
 * list endpoint omits to stay light — fetched lazily when a session is
 * expanded).
 *
 * Project-READ-gated. The session is fetched scoped to the project id, so it
 * cannot be read across projects even with a guessed session id.
 */

import { ORPCError } from "@orpc/client";
import {
	getAppliedTicketsForProposal,
	getBacklogUpdateSession,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	sessionDetailSchema,
	toErrorList,
	toLightweightChanges,
	toSessionMessages,
} from "./history-mapping";

export const getBacklogSessionHistoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/backlog/history/sessions/{sessionId}",
		tags: ["Projects", "Backlog"],
		summary: "Get an AI Backlog Update session with transcript",
		description:
			"Read-only detail for one AI Update session, including the chat transcript and results.",
	})
	.input(
		z.object({
			projectId: z.string(),
			sessionId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(sessionDetailSchema)
	.handler(async ({ input }) => {
		const row = await getBacklogUpdateSession({
			id: input.sessionId,
			projectId: input.projectId,
		});
		if (!row) {
			throw new ORPCError("NOT_FOUND", {
				message: "Session not found",
			});
		}
		const changes = toLightweightChanges(row.changes);
		// Resolve the tickets this session created/updated (with their current
		// identifiers) so the result card can link to them. Two-tier: by proposal
		// id, else by the apply window + proposed-change titles — so older runs
		// whose audit rows weren't proposal-id-tagged still resolve their links.
		const appliedItems = await getAppliedTicketsForProposal({
			projectId: input.projectId,
			proposalId: row.pendingProposalId ?? null,
			window: { from: row.createdAt, to: row.finalizedAt },
			proposedTitles: changes.map((c) => c.title),
		});
		return {
			id: row.id,
			status: row.status,
			pendingProposalId: row.pendingProposalId ?? null,
			source: row.source,
			summary: row.summary,
			changeCount: row.changeCount,
			createCount: row.createCount,
			updateCount: row.updateCount,
			appliedCount: row.appliedCount,
			failedCount: row.failedCount,
			syncedToPMCount: row.syncedToPMCount,
			changes,
			errors: toErrorList(row.errors),
			authorName: row.user?.name ?? null,
			authorEmail: row.user?.email ?? null,
			createdAt: row.createdAt,
			finalizedAt: row.finalizedAt,
			messages: toSessionMessages(row.messages),
			appliedItems,
		};
	});
