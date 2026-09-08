/**
 * The ONLY writer for a topic's Planning & Analysis prose (Fizzy #1851).
 *
 * `PublishingTopicAnalysisRevision` is append-only: the current text is the
 * highest `version`, the history is every row, and a restore writes a new row
 * carrying an old body. Nothing else inserts into that table, which is what
 * makes the compare-and-set below a guarantee rather than a convention.
 *
 * The concurrency control is a COMPARE-AND-SET, not arithmetic on what the
 * caller sent. That distinction is the reason this module exists as its own
 * file, and it is spelled out at the site below where it would be easiest to
 * "simplify" away.
 *
 * Lock order is fixed — Project first via `lockProjectTenant`, then the topic,
 * the source analysis and the revision rows — matching
 * `startPlanningAnalysisAttempt`, so two concurrent saves on one topic cannot
 * deadlock against each other.
 */

import { db } from "../../client";
// The tenant fence is shared with `publishing-planning.ts` and
// `publishing-drafts.ts` rather than copied: it is the check that stops one
// organization's row being written under another's identity, and a fix applied
// to one copy and not the others is a tenancy hole that still looks defended at
// whichever site a reader happens to open.
import {
	lockProjectTenant,
	uniqueViolationConstraint,
} from "./publishing-tenant-lock";

/**
 * The unique index the writer's insert can legitimately violate.
 *
 * Named, not inferred from a bare `P2002`. Measured against a real violation in
 * `__tests__/publishing-analysis-revision.test.ts` rather than against a
 * fixture, because a fixture would only encode whatever shape the person
 * writing it assumed — the exact mistake `uniqueViolationConstraint`'s docblock
 * records having cost this repository once already.
 */
const VERSION_UNIQUE_CONSTRAINT =
	"publishing_topic_analysis_revision_topicId_version_key";

/**
 * Why a save was refused, or the version it landed on.
 *
 * Every refusal is a state the system reaches legitimately, so these are return
 * values rather than throws — and they are kept apart rather than collapsed
 * into one "could not save", because they send the author to four different
 * places:
 *
 *  - `conflict` — somebody else saved since this editor loaded. Refresh and
 *    re-apply; the other version is real and is not going away.
 *  - `not_found` — no such topic in this project. Indistinguishable from a
 *    topic id belonging to somebody else's project, on purpose (DV16).
 *  - `project_ineligible` — the project was archived or soft-deleted as of the
 *    lock. Nothing about the topic or the body is wrong.
 *  - `unknown_source_version` — the client named an analysis version that is
 *    not there or is not READY. The editor is seeded from something this server
 *    cannot see, which is a bug in the caller, not a race.
 */
export type SaveAnalysisRevisionResult =
	| { status: "saved"; version: number }
	| { status: "conflict" }
	| { status: "not_found" }
	| { status: "project_ineligible" }
	| { status: "unknown_source_version" };

/**
 * Append one revision of a topic's analysis prose.
 *
 * `expectedVersion` is the version the caller's editor was showing — `null`
 * when it was seeded from the AI analysis and no revision exists yet.
 */
export async function saveAnalysisRevision(input: {
	topicId: string;
	projectId: string;
	body: string;
	expectedVersion: number | null;
	sourceAnalysisVersion: number;
	changeSummary?: string | null;
	authorUserId: string;
}): Promise<SaveAnalysisRevisionResult> {
	return db.$transaction(async (tx) => {
		// Project first, then the revision rows — the same lock order
		// `startPlanningAnalysisAttempt` fixes, so two concurrent saves on one
		// topic cannot deadlock against each other. FOR UPDATE closes the
		// tenant-transfer window rather than detecting it afterwards.
		const tenant = await lockProjectTenant(
			tx as unknown as Parameters<typeof lockProjectTenant>[0],
			input.projectId,
		);
		if (!tenant) {
			return { status: "project_ineligible" as const };
		}

		// Both ids, never the topic id alone: a valid id from another project
		// must resolve to the same nothing a missing one does.
		const topic = await tx.publishingTopic.findFirst({
			where: { id: input.topicId, projectId: input.projectId },
			select: { id: true },
		});
		if (!topic) {
			return { status: "not_found" as const };
		}

		// The client says which AI version it was seeded from; the server proves
		// that version exists and is READY. Deriving it here instead would stamp
		// the newest version onto an older body and permanently silence the
		// stale-analysis banner.
		const source = await tx.publishingTopicPlanningAnalysis.findFirst({
			where: {
				topicId: input.topicId,
				projectId: input.projectId,
				version: input.sourceAnalysisVersion,
				status: "READY",
			},
			select: { id: true },
		});
		if (!source) {
			return { status: "unknown_source_version" as const };
		}

		// A COMPARE-AND-SET, not arithmetic on what the client sent.
		//
		// `nextVersion = expectedVersion + 1` plus a unique index is NOT
		// optimistic concurrency: the index only rejects a pair that already
		// exists, so a caller holding a stale or forged `expectedVersion: 99`
		// against a current version of 2 inserts version 100 and wins. The
		// guarantee would be client etiquette. Read the real current version
		// here, inside the same transaction that holds the project lock, and
		// require the caller to have seen it.
		const current = await tx.publishingTopicAnalysisRevision.findFirst({
			where: { topicId: input.topicId, projectId: input.projectId },
			orderBy: { version: "desc" },
			select: { version: true },
		});
		const currentVersion = current?.version ?? null;
		if (currentVersion !== input.expectedVersion) {
			return { status: "conflict" as const };
		}

		const nextVersion = (currentVersion ?? 0) + 1;
		try {
			await tx.publishingTopicAnalysisRevision.create({
				data: {
					topicId: input.topicId,
					projectId: input.projectId,
					organizationId: tenant.organizationId,
					userId: tenant.userId,
					version: nextVersion,
					body: input.body,
					sourceAnalysisVersion: input.sourceAnalysisVersion,
					authorUserId: input.authorUserId,
					changeSummary: input.changeSummary ?? null,
				},
			});
		} catch (e) {
			// The compare-and-set above is the guarantee; this is the backstop
			// for the window between the read and the insert. Match the ONE
			// constraint this can legitimately be. A catch-all `P2002` would
			// turn an unrelated violation — the primary key included — into a
			// false "somebody else saved first", which sends the author away to
			// refresh over a bug that will still be there.
			if (uniqueViolationConstraint(e) === VERSION_UNIQUE_CONSTRAINT) {
				return { status: "conflict" as const };
			}
			throw e;
		}
		return { status: "saved" as const, version: nextVersion };
	});
}

/**
 * The columns every revision read returns. Named once so the current-row read
 * and the history read cannot drift into showing different fields for the same
 * row — the version drawer and the editor must agree on what a revision is.
 *
 * `author` is a relation, not just `authorUserId`: the footer promises a human
 * name, and the id alone cannot produce one without an undeclared second
 * lookup. `onDelete: SetNull` means it can be null for a departed author —
 * render "unknown author" rather than hiding the version.
 */
const REVISION_SELECT = {
	id: true,
	version: true,
	body: true,
	sourceAnalysisVersion: true,
	changeSummary: true,
	authorUserId: true,
	createdAt: true,
	author: { select: { id: true, name: true } },
} as const;

/** The current revision — the highest version. Project-scoped, always. */
export async function getCurrentAnalysisRevision(input: {
	topicId: string;
	projectId: string;
}) {
	return db.publishingTopicAnalysisRevision.findFirst({
		where: { topicId: input.topicId, projectId: input.projectId },
		orderBy: { version: "desc" },
		select: REVISION_SELECT,
	});
}

/**
 * Page size for the history read when the caller names none.
 *
 * Deliberately below the 50 the audit-history sibling takes, because a page
 * here is not a page of rows: `REVISION_SELECT` carries `body`, which the
 * writer bounds at 40,000 characters. The response is therefore rows times
 * prose, and 25 is what keeps the worst case near a megabyte while still
 * filling a tall drawer on the first request.
 */
const DEFAULT_PAGE_SIZE = 25;

/**
 * Ceiling on a caller-named page size, matching the API schema at
 * `analysis-revision.ts`. Duplicated on purpose rather than shared: this is
 * the floor for any caller that does not come through oRPC, and a helper
 * exported from `@repo/database` cannot assume its input was validated.
 */
const MAX_PAGE_SIZE = 100;

/**
 * One page of history, newest first.
 *
 * A KEYSET cursor on `version` — not an offset, and not the opaque encoded
 * string the `listAuditLog` sibling uses. That sibling encodes `(createdAt,
 * id)` because its order has no single monotonic key; this table has one.
 * `version` is assigned by the compare-and-set in `saveAnalysisRevision`
 * under the project lock and is unique per topic, so it orders the history
 * completely on its own. Base64 around one integer would hide nothing and
 * cost every reader of a log or a URL the ability to see where they are.
 *
 * `take: limit + 1` asks for one row past the page on purpose. Its presence
 * is the whole of "is there more", so that answer comes from the same query
 * and the same snapshot as the rows themselves — a separate count could be
 * taken after a concurrent save and disagree with the page it describes.
 */
export async function listAnalysisRevisions(input: {
	topicId: string;
	projectId: string;
	/**
	 * The oldest version the caller already holds. The next page is strictly
	 * below it. Omit for the newest page.
	 */
	cursor?: number | null;
	limit?: number | null;
}) {
	const limit = Math.min(
		Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1),
		MAX_PAGE_SIZE,
	);

	const rows = await db.publishingTopicAnalysisRevision.findMany({
		where: {
			topicId: input.topicId,
			projectId: input.projectId,
			// Strictly less-than. The cursor names a row the caller has
			// already been given, never one to send again — an inclusive
			// bound would repeat a revision at every page boundary, which in
			// a version list reads as a duplicate save rather than as a
			// paging artefact.
			...(input.cursor != null ? { version: { lt: input.cursor } } : {}),
		},
		orderBy: { version: "desc" },
		take: limit + 1,
		select: REVISION_SELECT,
	});

	const hasMore = rows.length > limit;
	const revisions = hasMore ? rows.slice(0, limit) : rows;

	return {
		revisions,
		// Null means "this is the last page", never "start again": the caller
		// stops when it is null rather than treating it as an absent filter.
		nextCursor: hasMore
			? (revisions[revisions.length - 1]?.version ?? null)
			: null,
	};
}
