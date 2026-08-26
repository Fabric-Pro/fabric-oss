import { ORPCError } from "@orpc/client";
import { db, type SubscriptionSubjectType } from "@repo/database";

/**
 * Guard that `subjectId` actually belongs to `projectId` for the given subject
 * type. `requireProjectPermission` only proves the caller may read
 * `input.projectId` — it does NOT prove the named document/feature lives there.
 * Without this, a caller with access to project A could subscribe to a subject
 * in project B by passing `{ projectId: A, subjectId: <B's doc> }`, creating an
 * orphan watch row against a project they cannot access. Throws NOT_FOUND on
 * mismatch (same shape as a genuinely missing subject).
 */
export async function assertSubjectInProject(args: {
	subjectType: SubscriptionSubjectType;
	subjectId: string;
	projectId: string;
}): Promise<void> {
	const found =
		args.subjectType === "DOCUMENT"
			? await db.projectDocument.findFirst({
					where: { id: args.subjectId, projectId: args.projectId },
					select: { id: true },
				})
			: await db.userStory.findFirst({
					where: { id: args.subjectId, projectId: args.projectId },
					select: { id: true },
				});
	if (!found) {
		throw new ORPCError("NOT_FOUND", {
			message: "Subscription subject not found in this project",
		});
	}
}

/**
 * Whether a user is subscribed to a given subject in a given tenant scope.
 *
 * Uniqueness is on `(userId, subjectType, subjectId)` — organizationId is
 * intentionally NOT part of the key (subjectId is a globally unique cuid bound
 * to one tenant), so a plain `findUnique` on the compound key is exact and
 * side-steps the Postgres "NULL is distinct" trap for personal context.
 */
export async function isSubscribed(args: {
	userId: string;
	subjectType: SubscriptionSubjectType;
	subjectId: string;
}): Promise<boolean> {
	const row = await db.subscription.findUnique({
		where: {
			userId_subjectType_subjectId: {
				userId: args.userId,
				subjectType: args.subjectType,
				subjectId: args.subjectId,
			},
		},
		select: { id: true },
	});
	return row !== null;
}
