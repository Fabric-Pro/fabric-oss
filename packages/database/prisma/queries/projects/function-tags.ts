import { FUNCTION_TAG_VALUES } from "../../../src/function-tags";
import { db, type FunctionTag, type Prisma } from "../../client";
import { getProjectMembers } from "./members";

/**
 * THE ONLY place a ProjectUserFunctionTag **UPDATE** payload is built.
 *
 * `confirmationVersion` is the compare-and-set token every project role
 * confirmation is conditional on (spec §5.7). A writer that changes `tags` or
 * `confirmedAt` without advancing it does not fail — it silently disarms the
 * CAS, leaving an old `expectedVersion` valid forever, which is how a prompt
 * left open across an admin edit comes to overwrite that edit and report
 * success. "Every writer must remember to increment" is precisely the
 * invariant a fifth writer breaks quietly, so no writer in this file composes
 * an update payload itself.
 *
 * This is layer 1 of three. Layer 2 is a test per writer. Layer 3 — the only
 * one that actually holds — is the `BEFORE UPDATE` trigger installed by
 * migration 20260821120000_project_user_function_tag_confirmation, which
 * covers writers added outside this file.
 *
 * CREATE payloads are deliberately not routed through here: a new row starts
 * at the schema default 0, there is no prior version to advance, and the
 * trigger is BEFORE UPDATE only. A create-side twin would only spread its
 * argument.
 */
export function tagRowUpdate(patch: {
	tags?: FunctionTag[];
	organizationId?: string | null;
	confirmedAt?: Date | null;
}) {
	return { ...patch, confirmationVersion: { increment: 1 } };
}

/**
 * Pure: same tags as SETS, ignoring order and duplicates.
 *
 * `[DEVELOPER, SME]` and `[SME, DEVELOPER, DEVELOPER]` are the same set, so
 * neither clears a member's confirmation (spec §5.2 / D6). UC3 says
 * "changed or cleared", and a save that writes the same set is neither — an
 * unconditional clear would re-prompt a member every time an admin opened and
 * closed the dialog, and forever under a provisioning flow that re-asserts
 * tags on a schedule.
 */
export function sameTagSet(a: FunctionTag[], b: FunctionTag[]): boolean {
	const left = new Set(a);
	const right = new Set(b);
	if (left.size !== right.size) {
		return false;
	}
	for (const tag of left) {
		if (!right.has(tag)) {
			return false;
		}
	}
	return true;
}

/**
 * Duck-typed rather than `instanceof Prisma.PrismaClientKnownRequestError`, so
 * a mocked test can produce one without importing Prisma's error class. Only
 * the code is read: `meta.target` is undefined on this client's P2002.
 */
function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "P2002"
	);
}

/**
 * Materialize a joining member's current global default into their project-level
 * tags. Runs inside the caller's transaction. Org is derived solely
 * from the project row. Skips the project creator (owner eager-copy is deferred).
 */
export async function applyGlobalDefaultFunctionTags(
	tx: Prisma.TransactionClient,
	args: { projectId: string; userId: string },
): Promise<void> {
	const project = await tx.project.findUnique({
		where: { id: args.projectId },
		select: { organizationId: true, userId: true },
	});
	if (!project) {
		return;
	}
	// Deferred owner scope: never materialize tags for the creator (even on a
	// self-invite member row). Spec §2.2 / §4.3.
	if (project.userId === args.userId) {
		return;
	}

	const user = await tx.user.findUnique({
		where: { id: args.userId },
		select: { defaultFunctionTags: true },
	});
	const tags = user?.defaultFunctionTags ?? [];

	if (tags.length > 0) {
		await tx.projectUserFunctionTag.upsert({
			where: {
				projectId_userId: {
					projectId: args.projectId,
					userId: args.userId,
				},
			},
			create: {
				projectId: args.projectId,
				userId: args.userId,
				organizationId: project.organizationId,
				tags,
			},
			update: tagRowUpdate({
				organizationId: project.organizationId,
				tags,
				// A removed member's row survives the hard delete of their
				// ProjectMember (spec §2.2), and on re-add their tags are
				// overwritten with their CURRENT account default. A
				// confirmation that referred to the old tag set must not
				// outlive the tags it confirmed.
				confirmedAt: null,
			}),
		});
		return;
	}

	// Empty current default: clear an existing row's tags (fresh re-apply), but
	// do not create a noise row. Spec §4.1 rejoin-clear.
	const existing = await tx.projectUserFunctionTag.findUnique({
		where: {
			projectId_userId: {
				projectId: args.projectId,
				userId: args.userId,
			},
		},
		select: { id: true },
	});
	if (existing) {
		await tx.projectUserFunctionTag.update({
			where: {
				projectId_userId: {
					projectId: args.projectId,
					userId: args.userId,
				},
			},
			data: tagRowUpdate({ tags: [], confirmedAt: null }),
		});
	}
}

export async function getUserDefaultFunctionTags(
	userId: string,
): Promise<FunctionTag[]> {
	const user = await db.user.findUnique({
		where: { id: userId },
		select: { defaultFunctionTags: true },
	});
	return user?.defaultFunctionTags ?? [];
}

export async function setUserDefaultFunctionTags(
	userId: string,
	tags: FunctionTag[],
): Promise<void> {
	await db.user.update({
		where: { id: userId },
		data: { defaultFunctionTags: tags },
	});
}

export async function getProjectFunctionTagRows(
	projectId: string,
): Promise<{ userId: string; tags: FunctionTag[] }[]> {
	return db.projectUserFunctionTag.findMany({
		where: { projectId },
		select: { userId: true, tags: true },
	});
}

/**
 * The admin write path (`functionTags.setForProjectMember`).
 *
 * Clears `confirmedAt` when the normalized tag set it is about to write
 * DIFFERS from the one already stored — that single rule is AC12 and AC13
 * together. There is no branch on "did the admin clear all tags": clearing all
 * tags is an admin edit whose `tags` happens to be `[]`, and it resets
 * confirmation for the same reason every other change does. A separate code
 * path for the empty case would be a second thing to keep in sync with the
 * first.
 *
 * Compare and write are ONE atomic, row-locked operation. The comparison is a
 * read-then-write and the interleaving it loses to is not hypothetical
 * (spec §5.2):
 *
 *   admin   reads tags = A, classifies the save as a no-op
 *   member  confirms tags = B          -> tags = B, confirmedAt = t
 *   admin   writes tags = A, confirmedAt untouched
 *   result  tags = A, confirmedAt = t  -> the row claims the member confirmed A
 *
 * The member confirmed B, holds A, and is never re-prompted — the exact state
 * AC12 exists to prevent.
 *
 * READ COMMITTED (the default) is LOAD-BEARING here and must not be "hardened"
 * to a higher level. The lock-then-read only works because the `findUnique`
 * after `FOR UPDATE` sees the newly committed row. Under REPEATABLE READ or
 * SERIALIZABLE that read returns the transaction's original snapshot, or
 * aborts with 40001 — either way the stale-read window this lock closes is
 * re-opened.
 *
 * Returns `{ changed }` because the no-op skip made silence ambiguous. The
 * caller fires an audit action named `…function_tags_changed`, whose name
 * asserts a change in the past tense; before the skip existed the write was
 * unconditional and that was always true. Now an admin who opens the dialog
 * and saves the same tags writes nothing, and a caller that cannot tell would
 * record a change that did not happen. An audit trail is only worth what its
 * least reliable row is worth, so the one bit that resolves it is returned
 * rather than left to be inferred.
 */
export async function upsertProjectUserFunctionTags(args: {
	projectId: string;
	userId: string;
	organizationId: string | null;
	tags: FunctionTag[];
}): Promise<{ changed: boolean }> {
	const where = {
		projectId_userId: { projectId: args.projectId, userId: args.userId },
	};

	return db.$transaction(async (tx) => {
		// LOCK -> COMPARE -> WRITE, never COMPARE -> LOCK.
		//
		// Parameterized template tag — never interpolate ids into the SQL
		// text. The table name is the DB-level identifier from `@@map`; the
		// Prisma model name raises 42P01 at runtime. Same pattern as
		// `updateOnboardingTourState` (queries/onboarding-tour.ts:298).
		await tx.$queryRaw`SELECT id FROM "project_user_function_tag" WHERE "projectId" = ${args.projectId} AND "userId" = ${args.userId} FOR UPDATE`;

		const existing = await tx.projectUserFunctionTag.findUnique({
			where,
			select: { tags: true, organizationId: true },
		});

		if (
			existing &&
			sameTagSet(existing.tags, args.tags) &&
			existing.organizationId === args.organizationId
		) {
			// A TRUE no-op skips the write entirely rather than writing
			// identical values. Writing would advance `confirmationVersion`
			// and force an open confirmation prompt into a spurious CONFLICT
			// for an admin who changed nothing.
			return { changed: false };
		}

		// `upsert` rather than `create` for the missing-row case: SELECT … FOR
		// UPDATE locks nothing when the row does not exist, so a concurrent
		// create can still win that race. Losing it lands on the same update
		// branch an existing row would have taken, which is correct rather
		// than a 500.
		await tx.projectUserFunctionTag.upsert({
			where,
			create: {
				projectId: args.projectId,
				userId: args.userId,
				organizationId: args.organizationId,
				tags: args.tags,
			},
			update: tagRowUpdate({
				organizationId: args.organizationId,
				tags: args.tags,
				confirmedAt: null,
			}),
		});

		return { changed: true };
	});
}

/**
 * The caller's own confirmation status on one project (spec §5.4).
 *
 * `defaultTags` rides along so the prompt can pre-fill without a second
 * round-trip AND can tell the member when an administrator's assignment
 * diverges from their account default (spec §3.1).
 */
export async function getMyProjectFunctionTagStatus(
	projectId: string,
	userId: string,
): Promise<{
	confirmed: boolean;
	tags: FunctionTag[];
	defaultTags: FunctionTag[];
	version: number | null;
}> {
	const [row, defaultTags] = await Promise.all([
		db.projectUserFunctionTag.findUnique({
			where: { projectId_userId: { projectId, userId } },
			select: {
				tags: true,
				confirmedAt: true,
				confirmationVersion: true,
			},
		}),
		getUserDefaultFunctionTags(userId),
	]);

	return {
		// Confirmed <=> a row exists AND confirmedAt is set (spec §5.1).
		confirmed: row?.confirmedAt != null,
		tags: row?.tags ?? [],
		defaultTags,
		// `null`, NOT 0, when no row exists. 0 is a REAL version that an
		// existing untouched row holds; conflating the two would let a
		// confirmation whose prompt opened against nothing take the update
		// path against a row that appeared in the meantime.
		version: row?.confirmationVersion ?? null,
	};
}

export type ConfirmProjectFunctionTagsResult =
	| {
			outcome: "confirmed";
			tags: FunctionTag[];
			version: number;
			/** What the row held before this confirmation — `[]` when the row
			 * did not exist. Lets the audit row distinguish a member accepting
			 * an administrator's assignment from replacing it. */
			previousTags: FunctionTag[];
	  }
	| { outcome: "conflict" };

/**
 * Record the caller's own confirmation, conditional on the row not having
 * moved since the prompt opened (spec §5.7, D8).
 *
 * A confirmation prompt can sit open for minutes. In that window an admin can
 * change the member's tags — which by §5.2 also clears `confirmedAt`, so the
 * member is MEANT to re-confirm the admin's choice. An unconditional upsert on
 * submit would instead write back the tags the prompt was opened with, mark
 * them confirmed, and silently revert the admin's assignment: the member sees
 * a success toast and the admin's change is gone with no trace but the audit
 * log.
 */
export async function confirmProjectUserFunctionTags(args: {
	projectId: string;
	userId: string;
	organizationId: string | null;
	tags: FunctionTag[];
	expectedVersion: number | null;
}): Promise<ConfirmProjectFunctionTagsResult> {
	if (args.tags.length === 0) {
		// The §5.8 floor, held at the lowest layer that can hold it. The
		// procedure rejects an empty array too; this is the copy of the rule
		// that survives a caller who does not go through the procedure.
		// "A confirmation never means zero roles" is an invariant the server
		// can hold unconditionally, unlike an invalidation some unpredicted
		// path can miss.
		throw new Error(
			"confirmProjectUserFunctionTags: a confirmation must name at least one tag",
		);
	}

	// Read the current tags for the audit trail. Safe to do outside the CAS:
	// if the row moves between this read and the `updateMany` below, the
	// version guard refuses and we never audit at all — so `previousTags` is
	// accurate whenever it is actually recorded.
	const before =
		args.expectedVersion === null
			? null
			: await db.projectUserFunctionTag.findUnique({
					where: {
						projectId_userId: {
							projectId: args.projectId,
							userId: args.userId,
						},
					},
					select: { tags: true },
				});

	if (args.expectedVersion === null) {
		// The prompt opened with no row at all. `create` IS the conditional
		// write in this branch — the unique index on (projectId, userId) is
		// what refuses if a row appeared in the window.
		try {
			await db.projectUserFunctionTag.create({
				data: {
					projectId: args.projectId,
					userId: args.userId,
					organizationId: args.organizationId,
					tags: args.tags,
					confirmedAt: new Date(),
					// No increment: a fresh row starts at the schema default
					// and the trigger is BEFORE UPDATE only.
				},
			});
			// A fresh row is at the schema default, and there was nothing
			// before it.
			return {
				outcome: "confirmed",
				tags: args.tags,
				version: 0,
				previousTags: [],
			};
		} catch (error) {
			if (isUniqueViolation(error)) {
				return { outcome: "conflict" };
			}
			throw error;
		}
	}

	// One statement: the guard and the increment cannot come apart.
	const { count } = await db.projectUserFunctionTag.updateMany({
		where: {
			projectId: args.projectId,
			userId: args.userId,
			confirmationVersion: args.expectedVersion,
		},
		// `organizationId` is deliberately absent: a confirmation must not be
		// able to move a row's tenancy. The row already carries the org the
		// admin path derived from the project.
		data: tagRowUpdate({ tags: args.tags, confirmedAt: new Date() }),
	});

	return count === 1
		? {
				outcome: "confirmed",
				tags: args.tags,
				previousTags: before?.tags ?? [],
				// Exact, not a guess: the row was proven to be at
				// `expectedVersion` by the WHERE clause, and this statement
				// incremented it by one. Returning it lets the client patch
				// its cache without a round-trip.
				version: args.expectedVersion + 1,
			}
		: { outcome: "conflict" };
}

/**
 * Pure: intersect the project roster with tag rows, one row per userId.
 * Extracted so the roster/de-dup logic is unit-testable without a DB.
 *  - roster is authoritative: a member not in `members` (e.g. removed —
 *    ProjectUserFunctionTag does NOT cascade on ProjectMember deletion) is
 *    excluded, so no stale former-member role leaks.
 *  - one row per userId: the creator can appear twice in getProjectMembers
 *    (synthesized owner + accepted self-invite); the `seen` set de-dups so a
 *    tagged owner is counted once.
 */
export function joinRosterFunctionTags(
	members: { userId: string }[],
	rows: { userId: string; tags: FunctionTag[] }[],
): { userId: string; tags: FunctionTag[] }[] {
	const tagMap = new Map(rows.map((r) => [r.userId, r.tags]));
	const seen = new Set<string>();
	const result: { userId: string; tags: FunctionTag[] }[] = [];
	for (const member of members) {
		if (seen.has(member.userId)) {
			continue;
		}
		seen.add(member.userId);
		result.push({
			userId: member.userId,
			tags: tagMap.get(member.userId) ?? [],
		});
	}
	return result;
}

/**
 * Function tags for the CURRENT project roster only (#1767 Stage 4). Mirrors
 * `listForProject`'s roster left-join so both surfaces share one implementation.
 */
export async function getProjectMemberFunctionTags(
	projectId: string,
): Promise<{ userId: string; tags: FunctionTag[] }[]> {
	const [members, rows] = await Promise.all([
		getProjectMembers(projectId),
		getProjectFunctionTagRows(projectId),
	]);
	return joinRosterFunctionTags(members, rows);
}

/**
 * Pure: userIds holding ANY of `tags`, deduped, in roster order.
 * Roster is the input (already roster-scoped by the caller), so this never
 * surfaces a removed member. Unit-testable without a DB.
 */
export function membersHoldingTags(
	roster: { userId: string; tags: FunctionTag[] }[],
	tags: FunctionTag[],
): string[] {
	const wanted = new Set(tags);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const member of roster) {
		if (seen.has(member.userId)) {
			continue;
		}
		if (member.tags.some((t) => wanted.has(t))) {
			seen.add(member.userId);
			out.push(member.userId);
		}
	}
	return out;
}

/**
 * Pure: number of distinct roster members holding each tag. A member with a
 * (defensively) duplicated tag is counted once for that tag.
 */
export function computeGroupMemberCounts(
	roster: { userId: string; tags: FunctionTag[] }[],
): Record<FunctionTag, number> {
	const counts = Object.fromEntries(
		FUNCTION_TAG_VALUES.map((t) => [t, 0]),
	) as Record<FunctionTag, number>;
	for (const member of roster) {
		const seen = new Set<FunctionTag>();
		for (const tag of member.tags) {
			if (seen.has(tag)) {
				continue;
			}
			seen.add(tag);
			counts[tag] += 1;
		}
	}
	return counts;
}
