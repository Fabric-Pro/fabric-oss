import { ORPCError } from "@orpc/client";
import {
	computeGroupMemberCounts,
	db,
	getProjectMemberFunctionTags,
} from "@repo/database";
import {
	FUNCTION_TAG_GROUP_LABELS,
	FUNCTION_TAG_ORDER,
} from "@repo/database/src/function-tags";
import { isFunctionTagsEnabled } from "@repo/utils/feature-flag";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Search users who can be @-mentioned in a given document. The candidate
 * set mirrors `hasProjectAccess`: project owner ∪ accepted, non-expired
 * ProjectMembers. Org membership alone does not grant mentionability —
 * it must come paired with a ProjectMember row, same as document read
 * access. This guarantees an author can only mention people who can read
 * the doc.
 *
 * AUTHORIZATION: `requireProjectPermission(PROJECT_READ)` enforces caller
 * has read access to the given project. The handler then verifies the
 * `documentId` actually belongs to that project (otherwise a caller who
 * can read project A could enumerate mentionables for a document in
 * project B by passing mismatched ids).
 */
export const searchMentionablesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/documents/{documentId}/search-mentionables",
		tags: ["Projects", "Documents"],
		summary: "Search mentionable users for a document",
		description:
			"Returns users (project owner + accepted ProjectMembers) who can be @-mentioned in the given document",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			query: z.string().max(100),
		}),
	)
	.handler(async ({ input }) => {
		const { projectId, documentId, query } = input;

		const document = await db.projectDocument.findUnique({
			where: { id: documentId },
			select: { projectId: true },
		});
		if (!document) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found",
			});
		}
		if (document.projectId !== projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found in this project",
			});
		}

		const [project, projectMembers] = await Promise.all([
			db.project.findUnique({
				where: { id: projectId },
				select: {
					id: true,
					user: {
						select: {
							id: true,
							name: true,
							email: true,
							image: true,
						},
					},
				},
			}),
			db.projectMember.findMany({
				where: {
					projectId: projectId,
					acceptedAt: { not: null },
					OR: [
						{ expiresAt: null },
						{ expiresAt: { gt: new Date() } },
					],
				},
				select: { userId: true },
			}),
		]);

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found for document",
			});
		}

		const memberUsers = projectMembers.length
			? await db.user.findMany({
					where: {
						id: { in: projectMembers.map((m) => m.userId) },
					},
					select: {
						id: true,
						name: true,
						email: true,
						image: true,
					},
				})
			: [];

		const candidates = new Map<
			string,
			{
				id: string;
				name: string | null;
				email: string | null;
				avatarUrl: string | null;
			}
		>();

		candidates.set(project.user.id, {
			id: project.user.id,
			name: project.user.name,
			email: project.user.email,
			avatarUrl: project.user.image,
		});
		for (const u of memberUsers) {
			if (!candidates.has(u.id)) {
				candidates.set(u.id, {
					id: u.id,
					name: u.name,
					email: u.email,
					avatarUrl: u.image,
				});
			}
		}

		const needle = query.trim().toLowerCase();
		const filtered = needle.length
			? Array.from(candidates.values()).filter((c) => {
					const nameMatch =
						c.name?.toLowerCase().includes(needle) ?? false;
					const emailMatch =
						c.email?.toLowerCase().includes(needle) ?? false;
					return nameMatch || emailMatch;
				})
			: Array.from(candidates.values());

		// Sort by name ASC; null names last. Stable by id within a tier.
		filtered.sort((a, b) => {
			if (a.name === null && b.name === null) {
				return a.id.localeCompare(b.id);
			}
			if (a.name === null) {
				return 1;
			}
			if (b.name === null) {
				return -1;
			}
			return a.name.localeCompare(b.name);
		});

		let groups: {
			kind: "group";
			tag: (typeof FUNCTION_TAG_ORDER)[number];
			label: string;
			memberCount: number;
		}[] = [];
		if (isFunctionTagsEnabled()) {
			const roster = await getProjectMemberFunctionTags(projectId);
			const counts = computeGroupMemberCounts(roster);
			const all = FUNCTION_TAG_ORDER.map((tag) => ({
				kind: "group" as const,
				tag,
				label: FUNCTION_TAG_GROUP_LABELS[tag],
				memberCount: counts[tag],
			}));
			groups = needle.length
				? all.filter((g) => g.label.toLowerCase().includes(needle))
				: all;
		}

		return { members: filtered.slice(0, 10), groups };
	});
