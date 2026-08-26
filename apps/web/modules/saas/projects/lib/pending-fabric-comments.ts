/** Minimal shape needed to detect an in-flight @fabric agent reply. */
export type FabricMentionComment = {
	id: string;
	authorType: "USER" | "AGENT";
	workflowId?: string | null;
	sourceCommentId?: string | null;
	createdAt?: string | Date | null;
};

/**
 * How long the client keeps polling for an @fabric reply before giving up. The
 * agent normally persists a success OR failure reply within seconds; if the
 * worker stalls or the workflow terminally fails WITHOUT persisting any reply
 * row, the mention would otherwise look "pending" forever. Bounding the poll to
 * a window from the mention's own `createdAt` caps a degraded dependency at a
 * fixed cost instead of an unbounded background poll on every future viewer.
 */
export const PENDING_FABRIC_POLL_WINDOW_MS = 10 * 60 * 1000;

/**
 * Ids of USER comments that mention @fabric (they carry a `workflowId`) and do
 * NOT yet have a matching AGENT reply (`sourceCommentId === comment.id`). A
 * non-empty result means an agent reply is still in flight, so consumers poll
 * until it lands. Shared by CommentsPanel (its 3s refetch while the sidebar is
 * open) and StoryCommentsButton (keeps the count badge fresh when the sidebar is
 * closed). #1779 / DEC-6.
 */
export function getPendingFabricCommentIds<T extends FabricMentionComment>(
	comments: T[],
): string[] {
	return comments
		.filter(
			(comment) =>
				comment.authorType === "USER" &&
				Boolean(comment.workflowId) &&
				!comments.some(
					(reply) =>
						reply.authorType === "AGENT" &&
						reply.sourceCommentId === comment.id,
				),
		)
		.map((comment) => comment.id);
}

/**
 * True when at least one @fabric mention is BOTH still awaiting a reply
 * (`getPendingFabricCommentIds`) AND recent enough to be worth polling for
 * (`createdAt` within `windowMs` of `nowMs`). The always-mounted
 * StoryCommentsButton uses this to drive its refetch interval so a stuck or
 * terminally-failed workflow that never persisted a reply row cannot make the
 * action bar poll indefinitely. Fail-closed: a pending mention with a
 * missing/unparseable `createdAt` is treated as NOT recent so the poll always
 * terminates (real `comments.list` rows always carry `createdAt`). The window is
 * two-sided: a modestly future `createdAt` (client clock slightly behind the
 * server) still counts as recent so fresh mentions keep polling, but a grossly
 * future timestamp (more than `windowMs` ahead — corrupt data or large skew) is
 * rejected so it cannot extend the poll far past the intended bound. #1779.
 */
export function hasRecentPendingFabricComment<T extends FabricMentionComment>(
	comments: T[],
	nowMs: number,
	windowMs: number = PENDING_FABRIC_POLL_WINDOW_MS,
): boolean {
	const pending = new Set(getPendingFabricCommentIds(comments));
	if (pending.size === 0) {
		return false;
	}
	return comments.some((comment) => {
		if (!pending.has(comment.id) || comment.createdAt == null) {
			return false;
		}
		const createdMs =
			comment.createdAt instanceof Date
				? comment.createdAt.getTime()
				: new Date(comment.createdAt).getTime();
		if (Number.isNaN(createdMs)) {
			return false;
		}
		const ageMs = nowMs - createdMs;
		return ageMs < windowMs && ageMs > -windowMs;
	});
}
