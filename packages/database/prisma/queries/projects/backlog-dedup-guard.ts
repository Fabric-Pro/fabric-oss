/**
 * Title-collision dedup guard for AI-driven story-creation flows.
 *
 * Originally shipped in PR #1232 at `packages/api/modules/projects/lib/`,
 * moved here so packages that don't depend on `@repo/api` (notably
 * `@repo/temporal` and its `fabric_create_story` agent tool) can use the
 * same guard. All callers — the AI Update sidebar (`applyBacklogChanges`),
 * the Teams + Slack channel-monitor approve procedures, the
 * `fabric_create_story` agent tool — share one implementation so they
 * produce the same equivalence class.
 *
 * The guard catches: (1) the analyzer/agent emitting a CREATE for an item
 * that already exists, (2) two paraphrased CREATEs of the same item in one
 * batch, (3) legacy `[BUG] ` prefixed rows colliding with new unprefixed
 * proposals. None of those produce a *same-identifier* duplicate (the
 * 2026-05-21 atomic counter + `@@unique([projectId, identifier])` prevents
 * that), but they DO produce same-title duplicate rows that users perceive
 * as duplicates.
 */
import {
	normalizeBacklogTitle,
	TERMINAL_DRAFTING_STAGES,
} from "../../../utils";
import { db, Prisma } from "../../client";

/**
 * A CREATE that the guard blocked because its normalized title matched an
 * existing same-family story. Surfaced in the calling procedure's response
 * so the UI / agent can tell the user which existing item the proposal
 * already aliases.
 */
export type SkippedDuplicate = {
	changeIndex: number;
	title: string;
	existingIdentifier: string;
	existingId: string;
};

/**
 * Title-dedup is per-family: bugs only dedup against bugs, features /
 * user-stories against each other. Cross-kind dedup is intentionally NOT
 * done here — matches the AI Update sidebar guard so both flows produce
 * the same equivalence class.
 */
export type DedupFamily = "BUG" | "FEATURE";

// ECMAScript's WhiteSpace + LineTerminator set. PostgreSQL btrim's one-argument
// form removes only ordinary spaces, which would drift from normalizeBacklogTitle.
const ECMASCRIPT_TRIM_CHARACTERS =
	"\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const LEGACY_BUG_PREFIX_PATTERN = `^\\[bug\\][${ECMASCRIPT_TRIM_CHARACTERS}]+`;

/**
 * Find one live same-family normalized-title collision without building the
 * batch guard's complete in-memory index. Gateway creates only need one title,
 * while batch callers still benefit from {@link buildBacklogDedupGuard}.
 */
export async function findOpenBacklogTitleCollision(
	projectId: string,
	family: DedupFamily,
	title: string,
): Promise<{ existingId: string; existingIdentifier: string } | null> {
	const normalizedTitle = normalizeBacklogTitle(title);
	const rows = await db.$queryRaw<
		Array<{
			existingId: string;
			existingIdentifier: string;
			title: string;
		}>
	>`
		SELECT id AS "existingId", identifier AS "existingIdentifier", title
		  FROM user_story
		 WHERE "projectId" = ${projectId}
		   AND kind = ${family}::"StoryKind"
		   AND "draftingStage" NOT IN (${Prisma.join(TERMINAL_DRAFTING_STAGES)})
		   AND replace(lower(normalize(
				btrim(
					regexp_replace(
						btrim(title, ${ECMASCRIPT_TRIM_CHARACTERS}),
						${LEGACY_BUG_PREFIX_PATTERN},
						'',
						'i'
					),
					${ECMASCRIPT_TRIM_CHARACTERS}
				),
				NFD
			)), 'ς', 'σ') = normalize(${normalizedTitle}, NFD)
		 ORDER BY "createdAt" ASC
		 LIMIT 10
	`;
	const collision = rows.find(
		(row) => normalizeBacklogTitle(row.title) === normalizedTitle,
	);
	return collision
		? {
				existingId: collision.existingId,
				existingIdentifier: collision.existingIdentifier,
			}
		: null;
}

export interface BacklogDedupGuard {
	/**
	 * Look up an existing same-family story whose normalized title matches
	 * the given proposed title. Returns `null` on no collision.
	 */
	findCollision(
		family: DedupFamily,
		title: string,
	): { existingIdentifier: string; existingId: string } | null;

	/**
	 * Record a successful create so a later same-batch CREATE of the same
	 * title is caught. The caller must invoke this after every create that
	 * actually persisted, with the family the row landed in (may differ
	 * from the call-site's pre-create kind hint if the classifier flipped
	 * it — but per the family-inference contract we match the call-site
	 * hint, see `inferDedupFamily`).
	 */
	recordCreated(
		family: DedupFamily,
		title: string,
		created: { id: string; identifier: string },
	): void;
}

/**
 * Read every NON-TERMINAL `UserStory` for the project once, then return a
 * guard backed by an in-memory per-family normalized-title index. Cost is one
 * indexed query at the start of each operation; the loop body becomes O(1) per
 * proposed CREATE.
 *
 * Terminal items (closed / declined / auto-hidden — see
 * {@link TERMINAL_DRAFTING_STAGES}) are EXCLUDED from the index: a closed ticket
 * is a resolved, immutable record and must not block a new create that happens
 * to share its title (and must not make the AI-Update terminal-state redirect
 * skip itself as a "duplicate" of the very ticket it is superseding).
 *
 * Selects only the columns the guard needs (no description / status /
 * etc.) so the query stays cheap even on projects with thousands of
 * stories.
 */
export async function buildBacklogDedupGuard(
	projectId: string,
): Promise<BacklogDedupGuard> {
	const existing = await db.userStory.findMany({
		where: {
			projectId,
			draftingStage: { notIn: TERMINAL_DRAFTING_STAGES },
		},
		select: { id: true, identifier: true, title: true, kind: true },
	});
	const index = new Map<
		DedupFamily,
		Map<string, { id: string; identifier: string }>
	>([
		["BUG", new Map()],
		["FEATURE", new Map()],
	]);
	for (const story of existing) {
		const family: DedupFamily = story.kind === "BUG" ? "BUG" : "FEATURE";
		index.get(family)?.set(normalizeBacklogTitle(story.title), {
			id: story.id,
			identifier: story.identifier,
		});
	}
	return {
		findCollision(family, title) {
			const hit = index.get(family)?.get(normalizeBacklogTitle(title));
			return hit
				? { existingIdentifier: hit.identifier, existingId: hit.id }
				: null;
		},
		recordCreated(family, title, created) {
			index.get(family)?.set(normalizeBacklogTitle(title), {
				id: created.id,
				identifier: created.identifier,
			});
		},
	};
}

/**
 * Infer the dedup family for a proposed change.
 *
 * Mirrors the kind-inference at the `createStoryFromProposal` call site
 * (`overrideKind ?? (type === "bug" ? "BUG" : undefined)`), so the guard
 * checks against the same family the create would land in:
 *
 *   - A caller-supplied `kindOverride` is authoritative if present —
 *     picking `FEATURE` for an analyzer-tagged `"bug"` change must surface
 *     as the FEATURE family, not BUG.
 *   - Otherwise the analyzer's `type` decides: `"bug"` → BUG, anything
 *     else → FEATURE.
 *
 * The classifier inside `createStoryFromProposal` may still flip kind
 * after the fact — this matches the sidebar guard's behavior; the rare
 * cross-classifier-flip miss is no worse than what already exists for the
 * AI Update sidebar.
 */
export function inferDedupFamily(change: {
	kindOverride?: string | null;
	type: string;
}): DedupFamily {
	if (change.kindOverride) {
		return change.kindOverride === "BUG" ? "BUG" : "FEATURE";
	}
	return change.type === "bug" ? "BUG" : "FEATURE";
}
