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
import { listProjectMentionableMembers } from "../../lib/project-mentionable-members";

/** Typeahead popover — a short list the author scans while typing. */
const MENTION_SUGGESTION_LIMIT = 10;

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

		// Member lookup is shared with question assignment (Fizzy #1751); the
		// function-tag groups below stay here, since a group is mentionable but
		// not assignable.
		const filtered = await listProjectMentionableMembers({
			projectId,
			query,
			limit: MENTION_SUGGESTION_LIMIT,
		});

		if (!filtered) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found for document",
			});
		}

		const needle = query.trim().toLowerCase();

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

		return { members: filtered, groups };
	});
