/**
 * The tenant fence shared by every Publishing Suite generation table.
 *
 * INTERNAL. Deliberately absent from `./index.ts`'s `export *` list: these are
 * building blocks for the query modules beside it, not part of
 * `@repo/database`'s public surface, and a caller reaching for
 * `lockProjectTenant` from outside is almost certainly about to reimplement one
 * of the transactions below rather than use one.
 *
 * Extracted from `publishing-planning.ts` unchanged when Phase 2B-2 added the
 * second generation table (Fizzy #1853). The alternative was a second copy, and
 * of everything in this subsystem this is the worst thing to have two of: it is
 * the check that stops one organization's row being written under another's
 * identity, so a fix applied to one copy and not the other is a tenancy hole
 * that still looks defended at the site anyone happens to read.
 */

/** The Project columns the lock reads. */
interface LockedProject {
	organizationId: string | null;
	userId: string;
	status: string;
	deletedAt: Date | null;
}

/** The tenant tuple a row or a project carries, XOR-normalised. */
export interface TenantTuple {
	organizationId: string | null;
	userId: string | null;
}

/** The transaction-client shape these helpers need — just raw SQL. */
export interface RawQueryClient {
	$queryRaw: (
		strings: TemplateStringsArray,
		...values: unknown[]
	) => Promise<unknown>;
}

/**
 * Lock the Project row and return the XOR-normalised tenant tuple, or null when
 * the project is missing or ineligible.
 *
 * `FOR UPDATE` blocks a concurrent org transfer from committing until the
 * calling transaction does, which CLOSES the window rather than detecting it
 * afterwards. Prisma has no `FOR UPDATE` on `findUnique`, so this is raw SQL —
 * the same shape `persistCycleTerminal` and `createManualPublishingTopic` use.
 *
 * Eligibility (`ACTIVE`, not soft-deleted) is checked on the locked row too,
 * mirroring `persistCycleTerminal`: a project archived after the request must
 * not receive new work.
 */
export async function lockProjectTenant(
	tx: RawQueryClient,
	projectId: string,
): Promise<TenantTuple | null> {
	const rows =
		(await tx.$queryRaw`SELECT "organizationId", "userId", "status", "deletedAt" FROM "project" WHERE "id" = ${projectId} FOR UPDATE`) as LockedProject[];
	const project = rows?.[0];
	if (!project || project.status !== "ACTIVE" || project.deletedAt !== null) {
		return null;
	}
	// XOR-normalise the LOCKED row: org project → userId null; personal → org
	// null. Identical to `resolveProjectTenant`, but derived from a row this
	// transaction holds a lock on rather than from a separate, race-prone read.
	const organizationId = project.organizationId ?? null;
	return {
		organizationId,
		userId: organizationId ? null : project.userId,
	};
}

/**
 * Whether a stored tuple still describes the project it hangs off.
 *
 * BOTH halves, always. For an organization project the org discriminates and
 * `userId` is null on each side; for a personal project the org is null on each
 * side and `userId` is the only thing telling one owner from another — so
 * comparing the org alone would call two different people's rows a match.
 */
export function sameTenant(a: TenantTuple, b: TenantTuple): boolean {
	return (
		(a.organizationId ?? null) === (b.organizationId ?? null) &&
		(a.userId ?? null) === (b.userId ?? null)
	);
}

/** Whether a thrown error is Prisma's unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: string }).code === "P2002"
	);
}

/**
 * Which unique constraint a `P2002` came from, or null when it cannot be told.
 *
 * Needed because `publishing_topic_draft` has TWO unique constraints where
 * `publishing_topic_planning_analysis` has one, so 2A's catch-all
 * `P2002 → "a run is already in flight"` would be a lie for the other. A caller
 * that cannot name the constraint must rethrow, not guess.
 *
 * EVERY LINE BELOW IS MEASURED, not inferred, and the difference was not
 * academic — the first draft of this function was written against a plausible
 * error shape and matched NOTHING, so it returned null for every conflict and
 * would have turned a routine double-click into a 500. Its unit test passed,
 * because the fixture encoded the same guess. What a real server actually
 * raises through this repo's driver adapter is:
 *
 *   meta.target                                  undefined
 *   meta.driverAdapterError.cause.originalCode   "23505"
 *   meta.driverAdapterError.cause.kind           "UniqueConstraintViolation"
 *   meta.driverAdapterError.cause.constraint     { fields: ['"topicId"', ...] }
 *   meta.driverAdapterError.cause.originalMessage
 *       'duplicate key value violates unique constraint "<name>"'
 *
 * So the name lives in `originalMessage` and nowhere else: `constraint` is an
 * OBJECT carrying the column list, and the documented `target` is not populated
 * at all. Pinned by real-Postgres cases that provoke BOTH constraints and assert
 * each comes back under its own name — a mocked test cannot prove any of it,
 * because the shape being read is the thing in question.
 */
export function uniqueViolationConstraint(error: unknown): string | null {
	if (!isUniqueViolation(error)) {
		return null;
	}

	const meta = (error as { meta?: Record<string, unknown> }).meta;
	if (!meta) {
		return null;
	}

	// The documented field, kept first and kept deliberately: it is populated on
	// other driver configurations, and this package is not the only place that
	// decides which one is in use.
	const target = meta.target;
	if (typeof target === "string") {
		return target;
	}
	if (Array.isArray(target) && typeof target[0] === "string") {
		return target[0];
	}

	const cause = (meta.driverAdapterError as { cause?: unknown } | undefined)
		?.cause as
		| {
				constraint?: unknown;
				originalMessage?: unknown;
				message?: unknown;
				detail?: unknown;
		  }
		| undefined;
	if (!cause) {
		return null;
	}

	// Some adapter versions hand back the name directly.
	if (typeof cause.constraint === "string") {
		return cause.constraint;
	}
	if (
		cause.constraint != null &&
		typeof cause.constraint === "object" &&
		typeof (cause.constraint as { name?: unknown }).name === "string"
	) {
		return (cause.constraint as { name: string }).name;
	}

	// The path this repo takes today, via `originalMessage`.
	//
	// ANCHORED on Postgres's own wording rather than "the first quoted token".
	// On `originalMessage` the two are equivalent — measured, both return the
	// constraint name — so the anchor buys nothing on the path normally taken.
	// It earns its place on the two FALLBACKS: `detail` reads
	// `Key ("topicId", "postType")=(…) already exists`, where an unanchored match
	// returns `topicId`. That is the worse failure of the two available, because
	// it is not a null a caller can see and rethrow on — it is a plausible-looking
	// string that matches neither constraint and sends the caller down the
	// rethrow path while appearing to have identified something.
	for (const field of [cause.originalMessage, cause.message, cause.detail]) {
		if (typeof field !== "string") {
			continue;
		}
		const match = field.match(/unique constraint "([^"]+)"/);
		if (match) {
			return match[1];
		}
	}

	return null;
}
