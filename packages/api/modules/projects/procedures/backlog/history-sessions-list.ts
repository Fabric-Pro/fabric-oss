/**
 * `projects.backlog.history.sessions.list` — the read-only "Session history" tab.
 *
 * A project-scoped, project-READ-gated list of AI Backlog Update sessions (one
 * row per "AI Update" apply), newest first, cursor-paginated. Backed by the
 * dedicated `BacklogUpdateSession` store (kept separate from the audit trail).
 *
 * Each row carries its author, created time, terminal status, the proposed
 * changes snapshot, and outcome counts. Tenant XOR is enforced by the procedure
 * gate + RLS; the query filters by `projectId`.
 */

import { listBacklogUpdateSessions } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	sessionItemSchema,
	toErrorList,
	toLightweightChanges,
} from "./history-mapping";

export const listBacklogSessionHistoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/backlog/history/sessions",
		tags: ["Projects", "Backlog"],
		summary: "List AI Backlog Update session history",
		description:
			"Read-only, project-scoped log of AI Backlog Update sessions, newest first.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			cursor: z.string().optional(),
			limit: z.number().int().min(1).max(100).optional(),
		}),
	)
	.output(
		z.object({
			items: z.array(sessionItemSchema),
			nextCursor: z.string().nullable(),
		}),
	)
	.handler(async ({ input }) => {
		const result = await listBacklogUpdateSessions({
			projectId: input.projectId,
			cursor: input.cursor ?? null,
			limit: input.limit ?? 25,
		});

		return {
			items: result.items.map((row) => ({
				id: row.id,
				status: row.status,
				source: row.source,
				summary: row.summary,
				changeCount: row.changeCount,
				createCount: row.createCount,
				updateCount: row.updateCount,
				appliedCount: row.appliedCount,
				failedCount: row.failedCount,
				syncedToPMCount: row.syncedToPMCount,
				changes: toLightweightChanges(row.changes),
				errors: toErrorList(row.errors),
				authorName: row.user?.name ?? null,
				authorEmail: row.user?.email ?? null,
				createdAt: row.createdAt,
				finalizedAt: row.finalizedAt,
			})),
			nextCursor: result.nextCursor,
		};
	});
