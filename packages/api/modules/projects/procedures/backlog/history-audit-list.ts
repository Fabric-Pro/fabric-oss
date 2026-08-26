/**
 * `projects.backlog.history.audit.list` — the read-only Audit history.
 *
 * A project-scoped, project-READ-gated view of the ticket-tied audit trail:
 * backlog item changes (create / update / status-change / delete) for one
 * project, newest first, cursor-paginated. Supports free-text search and
 * filters by actor bucket (AI/people), specific person, action, and date
 * range. Reuses the existing `AuditLog` store and `listAuditLog` query.
 *
 * Each row resolves the live triggering user, the ticket's human identifier
 * (F-XXX / B-XXX), and a human-readable change `source` (AI Update / Slack /
 * Teams / manual).
 *
 * Deliberately distinct from the org-admin-gated `audit.list` endpoint: this
 * one is visible to anyone with read access to the project's backlog. Tenant
 * XOR is resolved from the project's tenancy; RLS is the DB-level floor.
 */

import { db, listAuditLog } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	auditHistoryItemSchema,
	extractProposalId,
	mapAuditRow,
	STORY_AUDIT_ACTIONS,
} from "./history-mapping";

/** Friendly action-filter keys → the underlying `AuditLog.action` values. */
const ACTION_BY_KEY: Record<string, string> = {
	created: "story.created",
	updated: "story.updated",
	status_changed: "story.status_changed",
	deleted: "story.deleted",
};

export const listBacklogAuditHistoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/backlog/history/audit",
		tags: ["Projects", "Backlog"],
		summary: "List AI Backlog audit history",
		description:
			"Read-only, project-scoped audit trail of backlog item changes (create/update/status/delete), newest first, with search + actor/person/action/date filters.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			cursor: z.string().optional(),
			limit: z.number().int().min(1).max(100).optional(),
			/** Free-text search over ticket title + actor name/email. */
			search: z.string().max(200).optional(),
			/** Actor bucket: AI-made, people-made, or all. */
			actor: z.enum(["all", "ai", "human"]).optional(),
			/** Restrict to a single project member (by user id). */
			actorUserId: z.string().optional(),
			/** Restrict to a single change kind, or all four. */
			action: z
				.enum([
					"all",
					"created",
					"updated",
					"status_changed",
					"deleted",
				])
				.optional(),
			/** Inclusive lower bound on the change time. */
			dateFrom: z.coerce.date().optional(),
			/** Exclusive upper bound on the change time. */
			dateTo: z.coerce.date().optional(),
		}),
	)
	.output(
		z.object({
			items: z.array(auditHistoryItemSchema),
			nextCursor: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Resolve the project's tenancy for the audit scope. requireProjectPermission
		// has already confirmed the caller can read THIS project.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { organizationId: true },
		});

		const scope = project?.organizationId
			? { organizationId: project.organizationId, userId: null }
			: { organizationId: null, userId: context.user.id };

		// Action filter → the story.* action set (default: all four).
		const actions =
			input.action &&
			input.action !== "all" &&
			ACTION_BY_KEY[input.action]
				? [ACTION_BY_KEY[input.action]]
				: [...STORY_AUDIT_ACTIONS];

		// Actor filter → actorType buckets. AI = agent/system; people = user.
		const actorTypes =
			input.actor === "ai"
				? ["agent", "system"]
				: input.actor === "human"
					? ["user"]
					: undefined;

		// Resolve users whose name/email match the search term so AI-attributed
		// rows surface by the human who triggered them (consistent with display).
		const term = input.search?.trim();
		let searchUserIds: string[] | undefined;
		if (term) {
			const matched = await db.user.findMany({
				where: {
					OR: [
						{ name: { contains: term, mode: "insensitive" } },
						{ email: { contains: term, mode: "insensitive" } },
					],
				},
				select: { id: true },
				take: 50,
			});
			searchUserIds = matched.map((u) => u.id);
		}

		const result = await listAuditLog({
			scope,
			filter: {
				projectId: input.projectId,
				actions,
				...(actorTypes ? { actorTypes } : {}),
				...(input.actorUserId ? { actorIds: [input.actorUserId] } : {}),
				...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
				...(input.dateTo ? { dateTo: input.dateTo } : {}),
				...(term ? { search: term, searchUserIds } : {}),
			},
			cursor: input.cursor ?? null,
			limit: input.limit ?? 50,
			sort: "newest",
		});

		// Batch-resolve the live triggering users so AI rows show the human + tag.
		const userIds = [
			...new Set(
				result.items
					.map((r) => r.userId)
					.filter((id): id is string => Boolean(id)),
			),
		];
		const users = userIds.length
			? await db.user.findMany({
					where: { id: { in: userIds } },
					select: { id: true, name: true, email: true, image: true },
				})
			: [];
		const userById = new Map(users.map((u) => [u.id, u]));

		// Batch-resolve the originating AI Update session via metadata.proposalId
		// (scoped to this project as a defensive guard).
		const proposalIds = [
			...new Set(
				result.items
					.map((r) => extractProposalId(r.metadata))
					.filter((id): id is string => Boolean(id)),
			),
		];
		const sessions = proposalIds.length
			? await db.backlogUpdateSession.findMany({
					where: {
						pendingProposalId: { in: proposalIds },
						projectId: input.projectId,
					},
					select: { id: true, pendingProposalId: true },
				})
			: [];
		const sessionByProposal = new Map(
			sessions
				.filter((s) => s.pendingProposalId)
				.map((s) => [s.pendingProposalId as string, s.id]),
		);

		// Batch-resolve ticket identifiers (F-XXX / B-XXX) for the still-live
		// stories. Deleted stories won't resolve — the UI falls back to the
		// snapshotted title.
		const storyIds = [
			...new Set(
				result.items
					.map((r) => r.resourceId)
					.filter((id): id is string => Boolean(id)),
			),
		];
		const stories = storyIds.length
			? await db.userStory.findMany({
					where: { id: { in: storyIds }, projectId: input.projectId },
					select: { id: true, identifier: true },
				})
			: [];
		const identifierById = new Map(
			stories.map((s) => [s.id, s.identifier]),
		);

		return {
			items: result.items.map((row) => {
				const proposalId = extractProposalId(row.metadata);
				return mapAuditRow(row, {
					user: row.userId
						? (userById.get(row.userId) ?? null)
						: null,
					sessionId: proposalId
						? (sessionByProposal.get(proposalId) ?? null)
						: null,
					identifier: row.resourceId
						? (identifierById.get(row.resourceId) ?? null)
						: null,
					// A story-resource row whose id no longer resolves ⇒ the
					// ticket was deleted (the UI shows a "(deleted)" tag).
					deleted: row.resourceId
						? !identifierById.has(row.resourceId)
						: false,
				});
			}),
			nextCursor: result.nextCursor,
		};
	});
