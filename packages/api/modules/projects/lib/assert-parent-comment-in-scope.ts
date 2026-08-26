import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";

/**
 * Reject a `parentId` that is not a comment on the same story as the comment
 * being created. The parent must share `storyId`, which (because story access is
 * gated by `hasProjectAccess` on the story's project) keeps a reply inside the
 * same project — hence the same tenant. The comment-level `organizationId` is a
 * denormalized copy of the caller-resolved org and is deliberately NOT part of
 * the predicate: it can legitimately differ across a story's comments by create
 * path, so predicating on it would false-reject valid replies without tightening
 * the real (project) boundary. The parent must also be a USER comment — `parentId`
 * is the user-reply self-relation, while agent replies use the separate
 * `sourceCommentId` relation — so an AGENT parent is rejected (enforced
 * server-side, not just by hiding the UI's Reply button on agent comments).
 * No-op when `parentId` is absent (top-level).
 */
export async function assertStoryParentCommentInScope(args: {
	parentId: string | null | undefined;
	storyId: string;
}): Promise<void> {
	if (!args.parentId) {
		return;
	}
	const parent = await db.userStoryComment.findFirst({
		where: { id: args.parentId, storyId: args.storyId },
		select: { id: true, authorType: true },
	});
	if (!parent || parent.authorType === "AGENT") {
		throw new ORPCError("NOT_FOUND", {
			message: "Parent comment not found",
		});
	}
}

/** Task-scoped twin of {@link assertStoryParentCommentInScope}. Rejects a parent
 * that is missing/out-of-scope or is an AGENT comment (parentId must reference a
 * USER comment; agent replies use `sourceCommentId`). */
export async function assertTaskParentCommentInScope(args: {
	parentId: string | null | undefined;
	taskId: string;
}): Promise<void> {
	if (!args.parentId) {
		return;
	}
	const parent = await db.storyTaskComment.findFirst({
		where: { id: args.parentId, taskId: args.taskId },
		select: { id: true, authorType: true },
	});
	if (!parent || parent.authorType === "AGENT") {
		throw new ORPCError("NOT_FOUND", {
			message: "Parent comment not found",
		});
	}
}
