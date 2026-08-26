/**
 * Database queries for semantic duplicate detection on the roadmap.
 *
 * A `StoryDuplicateLink` is a pairwise, project-scoped record of a confirmed
 * potential duplicate (stored canonically with storyAId < storyBId). These
 * power the roadmap "possible duplicate" chips and the Merge/Dismiss dialog.
 *
 * Tenant isolation: these helpers are always reached through a procedure that
 * has already validated project access (`requireProjectPermission`), and every
 * query is scoped by `projectId` — mirroring how UserStory/StoryTask are
 * protected (no direct row-level security on story child-tables).
 */

import { TERMINAL_DRAFTING_STAGES } from "../../../utils";
import { db, type FeatureDraftingStage } from "../../client";
import { updateStoryDraftingStage } from "./stories";

/**
 * Drafting stages that hide a story from the roadmap's default view and so
 * exclude it from duplicate detection and active surfacing — a declined/closed
 * item is already resolved and must not be flagged.
 *
 * Invariant ("no invisible duplicates"): this list MUST mirror the roadmap's
 * default visibility rule in `StoriesRoadmap.visibleStories`
 * (`draftingStage !== "DECLINED" && (showClosed || draftingStage !== "CLOSED")`).
 * A story is eligible for detection / can carry a "possible duplicate" chip IFF
 * it is part of that default-visible set. Status-lane completion
 * (`ProjectStoryStatus.isFinal`, e.g. "Done") is intentionally NOT a filter:
 * final-status items still appear on the roadmap, so they stay scannable and
 * countable. Changing this list without changing the roadmap rule (or vice
 * versa) would let a duplicate surface on a hidden item — which this invariant
 * forbids. Exported so the regression test can pin the two sides together.
 *
 * Sourced from the shared {@link TERMINAL_DRAFTING_STAGES} (`@repo/database`
 * utils) so the duplicate-detection scan, the AI-Update apply gate, and the
 * AI-Update dedup all share ONE definition of "terminal" (the stage half;
 * `pmAutoHidden` is handled by `isTerminalWorkItemState`, and `pmAutoHidden`
 * always implies `CLOSED`, so a stage-only `notIn` filter excludes hidden rows
 * too).
 */
export const INACTIVE_STAGES: FeatureDraftingStage[] = TERMINAL_DRAFTING_STAGES;

const STORY_SUMMARY_SELECT = {
	id: true,
	identifier: true,
	title: true,
	description: true,
	// Carried so the resolve dialog can show each side's FULL content
	// (description + acceptance criteria) and diff the merge result against the
	// survivor's current acceptance criteria — not just a description snippet.
	acceptanceCriteria: true,
	kind: true,
	draftingStage: true,
	// PM-tool link state, surfaced so the resolve dialog can detect each side's
	// link, render the pre-merge link badge, and drive the migrate / link-select
	// step — all from data already loaded for the dialog (no extra round-trip).
	// `externalId` is the detection field; `externalUrl` + `externalMcpServerId`
	// resolve the display name / brand; `pmAutoSyncEnabled` + `lastPmSyncStatus`
	// + `lastSyncedAt` drive the stale/broken-link flag; `createdAt` covers the
	// "creation timestamp if available" hint. The full transfer cluster is read
	// server-side inside the merge, not here.
	externalId: true,
	externalUrl: true,
	externalMcpServerId: true,
	pmAutoSyncEnabled: true,
	lastPmSyncStatus: true,
	lastSyncedAt: true,
	createdAt: true,
	// Per-column metadata strip in the resolve dialog: semantic last-edit event,
	// origin (StorySource), creator id (display name resolved separately —
	// UserStory has no creator relation), and the bug reporter name as an
	// author fallback. Word count is derived client-side from `description`.
	lastEditedAt: true,
	lastEditedByName: true,
	lastEditedSource: true,
	source: true,
	createdById: true,
	reporterName: true,
} as const;

/** Stories eligible for duplicate detection: everything in the project that is
 * not already declined or closed. Equals the roadmap's default-visible set (see
 * the {@link INACTIVE_STAGES} invariant) so detection never considers — and a
 * chip never surfaces on — an item the user cannot see by default. */
export async function listActiveStoriesForDetection(projectId: string) {
	return db.userStory.findMany({
		where: { projectId, draftingStage: { notIn: INACTIVE_STAGES } },
		select: {
			id: true,
			identifier: true,
			title: true,
			description: true,
			// Part of what the feature IS, so it belongs in the comparison —
			// and it is where the maturation flow's agreed outcomes land
			// (there is no separate clean-spec field; the spec is description +
			// acceptanceCriteria). Budgeted in buildDetectionText.
			acceptanceCriteria: true,
			// Creation time feeds the proximity relaxation: items created close
			// together (possibly via different paths) get a slightly lower
			// candidate threshold.
			createdAt: true,
			// A split ticket keeps most of its substance in its tasks: the
			// parent often degrades to a one-line umbrella while the real
			// wording — the words an action item will echo — lives in the
			// parts. Comparing only the parent makes exactly those tickets
			// look unrelated to work that plainly belongs to them.
			tasks: {
				select: { title: true, description: true },
				orderBy: { createdAt: "asc" },
			},
		},
		orderBy: { createdAt: "asc" },
	});
}

/** Canonical "aId:bId" keys of pairs the user already dismissed, so a re-scan
 * never re-surfaces them. */
export async function listDismissedDuplicatePairKeys(
	projectId: string,
): Promise<string[]> {
	const rows = await db.storyDuplicateLink.findMany({
		where: { projectId, status: "DISMISSED" },
		select: { storyAId: true, storyBId: true },
	});
	return rows.map((r) => `${r.storyAId}:${r.storyBId}`);
}

/**
 * Upsert a confirmed duplicate/overlap pair as PENDING. On conflict the
 * similarity / confidence / reasoning / linkType / verified hashes are
 * refreshed but the status is deliberately left untouched — so a DISMISSED or
 * RESOLVED pair is never resurrected to PENDING even if it is somehow
 * re-submitted. The one sanctioned resurrection is NOT_DUPLICATE → PENDING:
 * a cached negative verdict only holds while both texts are unchanged, so a
 * fresh positive verdict (which implies at least one side changed, or the
 * detection logic was upgraded) reopens the pair for review.
 */
export async function upsertPendingDuplicateLink(params: {
	projectId: string;
	storyAId: string;
	storyBId: string;
	similarity: number;
	confidence: number;
	reasoning?: string | null;
	linkType?: "DUPLICATE" | "OVERLAP";
	contentHashA?: string;
	contentHashB?: string;
}) {
	const { projectId, storyAId, storyBId, similarity, confidence, reasoning } =
		params;
	const linkType = params.linkType ?? "DUPLICATE";
	const verifiedHashes = {
		verifiedContentHashA: params.contentHashA ?? null,
		verifiedContentHashB: params.contentHashB ?? null,
	};
	const link = await db.storyDuplicateLink.upsert({
		where: { storyAId_storyBId: { storyAId, storyBId } },
		create: {
			projectId,
			storyAId,
			storyBId,
			similarity,
			confidence,
			reasoning: reasoning ?? null,
			status: "PENDING",
			linkType,
			...verifiedHashes,
		},
		update: {
			similarity,
			confidence,
			reasoning: reasoning ?? null,
			linkType,
			...verifiedHashes,
			detectedAt: new Date(),
		},
	});
	if (link.status === "NOT_DUPLICATE") {
		await db.storyDuplicateLink.updateMany({
			where: {
				projectId,
				storyAId,
				storyBId,
				status: "NOT_DUPLICATE",
			},
			data: { status: "PENDING", resolvedAt: null, resolvedById: null },
		});
	}
	return link;
}

/**
 * Record the verifier's NEGATIVE verdict for a pair so re-scans skip it while
 * both sides' detection texts are unchanged.
 *
 * The stamp on `verifiedContentHashA/B` is the load-bearing part: it is what
 * {@link listVerdictValidPairKeys} matches to exclude the pair from the next
 * scan. It MUST land on whatever row already exists — including a PENDING one.
 * A pre-existing PENDING link (all rows written before the hash columns
 * existed carry NULL hashes) that the verifier now judges distinct would
 * otherwise never be stamped, so it would be re-selected and re-billed on
 * EVERY scan forever, permanently occupying candidate-cap slots and breaking
 * the "each pair paid at most once per content change" guarantee.
 *
 * Status is preserved, never changed: a PENDING pair stays flagged for the
 * user to resolve (we don't silently un-flag something they were asked to
 * review), and a DISMISSED / RESOLVED row is never resurrected. Only the
 * cache-facing fields (similarity/confidence/reasoning) are refreshed, and
 * only on a NOT_DUPLICATE row, so a PENDING pair keeps the score/reasoning the
 * user is looking at.
 */
export async function recordDistinctVerdict(params: {
	projectId: string;
	storyAId: string;
	storyBId: string;
	similarity: number;
	confidence: number;
	reasoning?: string | null;
	contentHashA: string;
	contentHashB: string;
}) {
	const { projectId, storyAId, storyBId, similarity, confidence, reasoning } =
		params;
	await db.storyDuplicateLink.upsert({
		where: { storyAId_storyBId: { storyAId, storyBId } },
		create: {
			projectId,
			storyAId,
			storyBId,
			similarity,
			confidence,
			reasoning: reasoning ?? null,
			status: "NOT_DUPLICATE",
			verifiedContentHashA: params.contentHashA,
			verifiedContentHashB: params.contentHashB,
		},
		// On conflict, stamp the current hashes onto whatever row exists so the
		// verdict cache excludes it next scan — WITHOUT touching status (never
		// un-flag a PENDING pair or resurrect a DISMISSED/RESOLVED one).
		update: {
			verifiedContentHashA: params.contentHashA,
			verifiedContentHashB: params.contentHashB,
			detectedAt: new Date(),
		},
	});
	// Refresh the display fields only on a pure cache row; a PENDING/DISMISSED
	// row keeps the similarity/confidence/reasoning the user last saw.
	await db.storyDuplicateLink.updateMany({
		where: { projectId, storyAId, storyBId, status: "NOT_DUPLICATE" },
		data: {
			similarity,
			confidence,
			reasoning: reasoning ?? null,
		},
	});
}

/**
 * Pairs whose stored verdict is still valid at the given current content
 * hashes — returned as canonical "aId:bId" keys for the candidate-selection
 * exclude set. Covers BOTH verdict polarities: a NOT_DUPLICATE row (skip —
 * the LLM already judged these texts distinct) and a PENDING row (skip — the
 * pair is already flagged and awaiting the user; re-verifying identical texts
 * buys nothing). A row with null hashes (written before the verdict-cache
 * columns existed) never matches, so legacy pairs are re-verified once and
 * stamped.
 */
export async function listVerdictValidPairKeys(
	projectId: string,
	currentHashByStoryId: Map<string, string>,
): Promise<string[]> {
	const rows = await db.storyDuplicateLink.findMany({
		where: {
			projectId,
			status: { in: ["NOT_DUPLICATE", "PENDING"] },
			verifiedContentHashA: { not: null },
			verifiedContentHashB: { not: null },
		},
		select: {
			storyAId: true,
			storyBId: true,
			verifiedContentHashA: true,
			verifiedContentHashB: true,
		},
	});
	return rows
		.filter(
			(r) =>
				currentHashByStoryId.get(r.storyAId) ===
					r.verifiedContentHashA &&
				currentHashByStoryId.get(r.storyBId) === r.verifiedContentHashB,
		)
		.map((r) => `${r.storyAId}:${r.storyBId}`);
}

/** PENDING links for a project, both members still active, richest first.
 *
 * Requiring BOTH sides `notIn INACTIVE_STAGES` enforces the "no invisible
 * duplicates" invariant: a chip can only surface on a story the roadmap shows by
 * default, so a link whose other side has gone DECLINED/CLOSED is omitted rather
 * than rendering a duplicate against a hidden item.
 *
 * Each side is enriched with a resolved `createdByName` for the dialog's
 * "Author" metadata. `UserStory` has no creator relation (`createdById` is a
 * bare `User.id`), so creator display names are resolved in ONE batched lookup
 * over the distinct ids across all returned links. Falls back to the email
 * local-part, then `null` (the FE then falls back to the bug reporter name). */
export async function listPendingDuplicateLinks(projectId: string) {
	const links = await db.storyDuplicateLink.findMany({
		where: {
			projectId,
			status: "PENDING",
			storyA: { is: { draftingStage: { notIn: INACTIVE_STAGES } } },
			storyB: { is: { draftingStage: { notIn: INACTIVE_STAGES } } },
		},
		select: {
			id: true,
			similarity: true,
			confidence: true,
			reasoning: true,
			linkType: true,
			detectedAt: true,
			storyA: { select: STORY_SUMMARY_SELECT },
			storyB: { select: STORY_SUMMARY_SELECT },
		},
		orderBy: { similarity: "desc" },
	});

	const creatorIds = Array.from(
		new Set(
			links.flatMap((l) => [l.storyA.createdById, l.storyB.createdById]),
		),
	).filter((id): id is string => Boolean(id));

	const creators = creatorIds.length
		? await db.user.findMany({
				where: { id: { in: creatorIds } },
				select: { id: true, name: true, email: true },
			})
		: [];
	const nameById = new Map<string, string | null>(
		creators.map((u) => [
			u.id,
			u.name?.trim() || u.email?.split("@")[0] || null,
		]),
	);

	const withAuthor = <T extends { createdById: string }>(story: T) => ({
		...story,
		createdByName: nameById.get(story.createdById) ?? null,
	});

	return links.map((link) => ({
		...link,
		storyA: withAuthor(link.storyA),
		storyB: withAuthor(link.storyB),
	}));
}

/**
 * Number of distinct ACTIVE stories that belong to at least one PENDING
 * duplicate link — i.e. exactly the set the roadmap "Possible duplicates" filter
 * shows. Reuses the same predicate as {@link listPendingDuplicateLinks} (PENDING,
 * both sides notIn INACTIVE_STAGES) so the post-scan completion modal's headline
 * count and the filtered roadmap can never disagree. Cheap: selects only the two
 * id columns and sizes a Set rather than loading the enriched links.
 */
export async function countItemsWithPendingDuplicateLinks(
	projectId: string,
): Promise<number> {
	const links = await db.storyDuplicateLink.findMany({
		where: {
			projectId,
			status: "PENDING",
			storyA: { is: { draftingStage: { notIn: INACTIVE_STAGES } } },
			storyB: { is: { draftingStage: { notIn: INACTIVE_STAGES } } },
		},
		select: { storyAId: true, storyBId: true },
	});
	const flaggedStoryIds = new Set<string>();
	for (const link of links) {
		flaggedStoryIds.add(link.storyAId);
		flaggedStoryIds.add(link.storyBId);
	}
	return flaggedStoryIds.size;
}

/** Mark a pair "not a duplicate" — persisted so re-scans skip it. Scoped by
 * projectId so a foreign linkId cannot be dismissed cross-tenant. */
export async function dismissDuplicateLink(
	linkId: string,
	projectId: string,
	userId: string,
): Promise<number> {
	const result = await db.storyDuplicateLink.updateMany({
		where: { id: linkId, projectId, status: "PENDING" },
		data: {
			status: "DISMISSED",
			resolvedAt: new Date(),
			resolvedById: userId,
		},
	});
	return result.count;
}

/** The two ways the merge resolves the PM-tool link across the pair. The dialog
 * computes which one applies from the two stories' link state (its UC
 * classification); this query just carries it out.
 *  - `keep-survivor` (default): the survivor's link is left untouched and the
 *    discarded story's link cluster is nulled (DV-3 — a retired duplicate must
 *    not keep an orphaned link). Covers UC0, UC1-decline, UC2, UC3 same-ticket,
 *    and UC3 where the user keeps the survivor's link.
 *  - `transfer-from-duplicate`: the discarded story's link cluster is copied onto
 *    the survivor (which INHERITS its sync state — DV-5) and nulled on the
 *    discarded story. Covers UC1-accept and UC3 where the user adopts the
 *    discarded item's link. */
export type PmLinkResolution = "keep-survivor" | "transfer-from-duplicate";

/** PM-link cluster: the fields that together mean "this story is synced to one
 * external PM ticket". They move as a unit onto the survivor on transfer and
 * null as a unit on the discarded story. Read off the discarded story up-front
 * so the transfer can run entirely inside the merge transaction. */
const PM_LINK_CLUSTER_SELECT = {
	externalId: true,
	externalUrl: true,
	externalMcpServerId: true,
	pmAutoSyncEnabled: true,
	lastSyncedAt: true,
	lastPmSyncStatus: true,
	lastSyncedPmHash: true,
	lastPmSyncAttemptAt: true,
	lastPmSyncError: true,
	lastSyncedStatusId: true,
} as const;

/**
 * One duplicate attachment row's move onto the survivor.
 *
 * `storageKey` is the key the object was COPIED to under the survivor, not the
 * key the row currently carries. Attachment download mints a signed URL only for
 * keys under `story-attachments/{projectId}/{storyId}/`, and `storageKey` is
 * `@unique` — so a row re-parented while keeping the duplicate's key would
 * render as a dead entry that can never be downloaded. The caller
 * (`copyStoryAssetsToStory`, via `merge-duplicate.ts`) performs the storage copy
 * BEFORE the merge and passes only the rows whose copy succeeded; a row missing
 * from this list stays on the duplicate, where its object is still reachable.
 * Fizzy #2048.
 */
export interface MergedAttachmentKeyUpdate {
	/** `StoryAttachment.id` on the duplicate. */
	attachmentId: string;
	/** The new key, under `story-attachments/{projectId}/{survivorId}/`. */
	storageKey: string;
}

/**
 * Merge a genuine duplicate into a survivor, in ONE transaction:
 *   1. Re-parent the duplicate's tasks onto the survivor (appended in order),
 *      and its copied attachment rows (each re-keyed to its new object).
 *   2. Resolve every PENDING link touching the duplicate.
 *   3. PM-link handling (`pmLink`): always null the discarded story's link
 *      cluster (DV-3); on `transfer-from-duplicate` also copy that cluster onto
 *      the survivor. The discarded story's `externalId` is nulled BEFORE the
 *      survivor's is written, so the partial unique index on
 *      (projectId, externalId) — which is NOT deferrable — never transiently
 *      sees two rows with the same id.
 *   4. Move the duplicate to the CLOSED stage and stamp `mergedIntoStoryId` with
 *      the survivor's id, threaded with the transaction client so the version
 *      snapshot + stage + merge-marker commit (or roll back) together with 1-3.
 *      CLOSED (not DECLINED) keeps the discarded item hidden-by-default but
 *      revealable via the roadmap "Show hidden" toggle, where it carries the
 *      "Declined duplicate" chip; both stages are in INACTIVE_STAGES so it stays
 *      excluded from re-detection regardless.
 *
 * Running everything in a single `db.$transaction` makes the link transfer atomic
 * with the merge (DV-6): a failure anywhere — including a constraint violation on
 * the link write — rolls the whole thing back, leaving neither story's link state
 * modified and the duplicate still active (FR-14). The kanban column is left
 * untouched. No outbound PM-tool push is issued — only Fabric-side fields change
 * (INT-2).
 */
export async function mergeDuplicateStories(params: {
	projectId: string;
	survivorId: string;
	duplicateId: string;
	userId: string;
	lastEditedByName?: string | null;
	pmLink?: PmLinkResolution;
	/**
	 * The duplicate's attachment rows to move onto the survivor, each with the
	 * key its object was already copied to. Omitted (or empty) ⇒ no attachment
	 * moves, which is exactly what happens when the duplicate has none or when
	 * every copy failed. See {@link MergedAttachmentKeyUpdate}.
	 */
	attachmentKeyUpdates?: readonly MergedAttachmentKeyUpdate[];
}): Promise<{
	survivorId: string;
	duplicateId: string;
	survivorExternalId: string | null;
}> {
	const { projectId, survivorId, duplicateId, userId } = params;
	const pmLink: PmLinkResolution = params.pmLink ?? "keep-survivor";
	const attachmentKeyUpdates = params.attachmentKeyUpdates ?? [];

	if (survivorId === duplicateId) {
		throw new Error("Cannot merge a story into itself");
	}

	const [survivor, duplicate] = await Promise.all([
		db.userStory.findFirst({
			where: { id: survivorId, projectId },
			select: { id: true, identifier: true, externalId: true },
		}),
		db.userStory.findFirst({
			where: { id: duplicateId, projectId },
			select: {
				id: true,
				identifier: true,
				draftingStage: true,
				...PM_LINK_CLUSTER_SELECT,
			},
		}),
	]);
	if (!survivor || !duplicate) {
		throw new Error("Both stories must belong to the project");
	}

	// Defensive: both sides carry the SAME non-null externalId. The partial
	// unique index on (projectId, externalId) should make this impossible, so it
	// points at a pre-existing data anomaly (an import that slipped past the
	// allocator). The merge proceeds — nulling the discarded story's externalId
	// below repairs the collision regardless of `pmLink`.
	if (
		duplicate.externalId !== null &&
		survivor.externalId === duplicate.externalId
	) {
		console.warn(
			"[Duplicate Merge] both stories share the same externalId; clearing the discarded story's link to repair the collision",
			{ projectId, survivorId, duplicateId },
		);
	}

	// What link the survivor ends up with — for the caller's structured log.
	const survivorExternalId =
		pmLink === "transfer-from-duplicate"
			? duplicate.externalId
			: survivor.externalId;

	await db.$transaction(async (tx) => {
		// 1. Append the duplicate's tasks after the survivor's existing tasks so
		// per-story ordering stays stable.
		const lastSurvivorTask = await tx.storyTask.findFirst({
			where: { storyId: survivorId },
			orderBy: { order: "desc" },
			select: { order: true },
		});
		let nextOrder = (lastSurvivorTask?.order ?? 0) + 1;
		const dupTasks = await tx.storyTask.findMany({
			where: { storyId: duplicateId },
			orderBy: { order: "asc" },
			select: { id: true },
		});
		for (const task of dupTasks) {
			await tx.storyTask.update({
				where: { id: task.id },
				data: { storyId: survivorId, order: nextOrder },
			});
			nextOrder += 1;
		}

		// 1b. Re-parent the duplicate's uploaded attachments, writing the new
		// storage key each object was copied to. `updateMany` (not `update`) so a
		// row that already moved — a replayed merge — is a silent no-op rather
		// than a P2025 that rolls the whole merge back; the `storyId: duplicateId`
		// predicate is what makes the replay inert, and it also keeps a
		// caller-supplied id from moving a row that never belonged to the
		// duplicate. Inside the transaction, so the moved rows and the retirement
		// commit (or roll back) together (DV-6).
		for (const move of attachmentKeyUpdates) {
			await tx.storyAttachment.updateMany({
				where: { id: move.attachmentId, storyId: duplicateId },
				data: {
					storyId: survivorId,
					storageKey: move.storageKey,
				},
			});
		}

		// 2. Any pending link touching the now-merged duplicate is resolved.
		await tx.storyDuplicateLink.updateMany({
			where: {
				projectId,
				status: "PENDING",
				OR: [{ storyAId: duplicateId }, { storyBId: duplicateId }],
			},
			data: {
				status: "RESOLVED",
				resolvedAt: new Date(),
				resolvedById: userId,
			},
		});

		// 3. PM-link handling. Null the discarded story's cluster FIRST — this
		// satisfies DV-3 in both modes and frees the survivor write in transfer
		// mode (null-then-write ordering for the non-deferrable partial unique
		// index). Only touch a row that actually carries a link.
		if (duplicate.externalId !== null) {
			await tx.userStory.update({
				where: { id: duplicateId, projectId },
				data: {
					externalId: null,
					externalUrl: null,
					externalMcpServerId: null,
					pmAutoSyncEnabled: false,
					lastSyncedAt: null,
					lastPmSyncStatus: null,
					lastSyncedPmHash: null,
					lastPmSyncAttemptAt: null,
					lastPmSyncError: null,
					lastSyncedStatusId: null,
				},
			});

			if (pmLink === "transfer-from-duplicate") {
				// Copy the discarded story's captured cluster onto the survivor.
				// It INHERITS the sync state (hash/timestamps) so the next sync
				// diffs against it (conflict-aware) instead of force-pushing
				// (DV-5). No outbound push is triggered here (INT-2).
				await tx.userStory.update({
					where: { id: survivorId, projectId },
					data: {
						externalId: duplicate.externalId,
						externalUrl: duplicate.externalUrl,
						externalMcpServerId: duplicate.externalMcpServerId,
						pmAutoSyncEnabled: duplicate.pmAutoSyncEnabled,
						lastSyncedAt: duplicate.lastSyncedAt,
						lastPmSyncStatus: duplicate.lastPmSyncStatus,
						lastSyncedPmHash: duplicate.lastSyncedPmHash,
						lastPmSyncAttemptAt: duplicate.lastPmSyncAttemptAt,
						lastPmSyncError: duplicate.lastPmSyncError,
						lastSyncedStatusId: duplicate.lastSyncedStatusId,
					},
				});
			}
		}

		// 4. Retire the duplicate to CLOSED inside the SAME transaction (DV-6),
		// threading `tx` so the snapshot + stage update roll back with the rest.
		// CLOSED (not DECLINED) so the discarded item is hidden-by-default but
		// stays revealable via the roadmap "Show hidden" toggle (where it shows
		// the "Declined duplicate" chip). Both stages are in INACTIVE_STAGES, so
		// it remains excluded from future duplicate detection either way.
		await updateStoryDraftingStage(
			duplicateId,
			projectId,
			"CLOSED" as FeatureDraftingStage,
			{
				userId,
				changedBy: userId,
				changeDescription: `Merged as duplicate of ${survivor.identifier}`,
				lastEditedByName: params.lastEditedByName ?? null,
				lastEditedSource: "MANUAL",
			},
			tx,
		);

		// Stamp the survivor's id so the roadmap can render the "Declined
		// duplicate" chip + "Merged into {identifier}" tooltip. Written in the
		// same transaction so it commits atomically with the stage change.
		await tx.userStory.update({
			where: { id: duplicateId, projectId },
			data: { mergedIntoStoryId: survivorId },
		});
	});

	return { survivorId, duplicateId, survivorExternalId };
}
