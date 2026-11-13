/**
 * Which writer made a document version, as its `changeDescription` records it
 * (Fizzy #2946). Shared by the writers, which store these descriptions, and by
 * version history, which shows each as its own translated label.
 *
 * The description stays the only record: a writer's stored text is the
 * contract, so a stored one is never renamed here. Rows written before a
 * writer had its own description keep their text: an "Assistant edit" from
 * before chat edits and Edit with instructions were told apart cannot be
 * attributed to either, and is shown as stored.
 */

/** The descriptions the writers store, one per writer. */
export const DOCUMENT_VERSION_CHANGE_DESCRIPTIONS = {
	/** An accepted chat proposal on a client-document Proposal. */
	CHAT_EDIT: "Chat edit",
	/** A diagram replaced through Edit with instructions. */
	EDIT_WITH_INSTRUCTIONS: "Edit with instructions",
	/** An accepted finding-driven section revision (Apply recommendation). */
	RECOMMENDATION_APPLIED: "Applied a review recommendation",
	/** An accepted instruction-driven section revision (Revise this section). */
	SECTION_REVISED: "Revised a section with instructions",
	/** Update using context. */
	UPDATED_FROM_CONTEXT: "Updated with latest context",
	/** A regeneration run's version. */
	REGENERATED: "Regenerated version",
} as const;

const RESTORED_PREFIX = "Restored to version ";

/** The description a restore of `version` stores. */
export function restoredVersionDescription(version: number): string {
	return `${RESTORED_PREFIX}${version}`;
}

/** The writer a stored description names, when it names one. */
export type DocumentVersionChange =
	| {
			kind:
				| "chatEdit"
				| "editWithInstructions"
				| "recommendationApplied"
				| "sectionRevised"
				| "updatedFromContext"
				| "regenerated";
	  }
	| { kind: "restored"; version: number };

// A Map, not an object: a stored description is free text, and one such as
// "constructor" or "__proto__" must not read an object's inherited member.
const BY_DESCRIPTION: ReadonlyMap<string, DocumentVersionChange> = new Map(
	Object.entries({
		[DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.CHAT_EDIT]: { kind: "chatEdit" },
		[DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.EDIT_WITH_INSTRUCTIONS]: {
			kind: "editWithInstructions",
		},
		[DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.RECOMMENDATION_APPLIED]: {
			kind: "recommendationApplied",
		},
		[DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.SECTION_REVISED]: {
			kind: "sectionRevised",
		},
		[DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.UPDATED_FROM_CONTEXT]: {
			kind: "updatedFromContext",
		},
		[DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.REGENERATED]: {
			kind: "regenerated",
		},
	} satisfies Record<string, DocumentVersionChange>),
);

const RESTORED_PATTERN = /^Restored to version (\d+)$/;

/**
 * The writer a version's stored description names, or null for any other
 * text: a person's own description, an older writer's, or none.
 */
export function describeDocumentVersionChange(
	description: string | null | undefined,
): DocumentVersionChange | null {
	if (!description) {
		return null;
	}
	const known = BY_DESCRIPTION.get(description);
	if (known) {
		return known;
	}
	const restored = RESTORED_PATTERN.exec(description);
	if (restored) {
		return { kind: "restored", version: Number(restored[1]) };
	}
	return null;
}

/** What a document's first version records about its creation. */
const INITIAL_VERSION_DESCRIPTION = "Initial version";

/**
 * Descriptions stored on a row that holds the body its own change made: a
 * document's creation or import (always version 1) and a regeneration. Every
 * other writer snapshots the body it is about to replace, on that body's
 * version, with the description of the replacing change.
 *
 * Kept in step with the writers: `createDocument` and `createVersionWithGuards`
 * / `createDocumentVersion` (initial, regenerated), `create-document` (pasted
 * source), the onboarding and context imports in `create-project`,
 * `update-project` and `create-context`, the imported-document generation
 * and the Discovery draft. The last two entries come from writers since
 * removed (the external PRD sync and pipeline documents) whose rows remain.
 */
const MADE_BY_ITS_OWN_ROW: ReadonlySet<string> = new Set([
	INITIAL_VERSION_DESCRIPTION,
	DOCUMENT_VERSION_CHANGE_DESCRIPTIONS.REGENERATED,
	"Initial version from imported document",
	"Created from pasted source content",
	"Imported from onboarding",
	"Imported from uploaded context",
	"Drafted by Discovery run",
	"Initial version from external source",
	"Initial version from pipeline",
]);

/**
 * Snapshots a regeneration takes of the body it replaces. The regeneration's
 * own row names it; a body that follows such a snapshot without one (the
 * regeneration was rejected and the next change found the snapshot already
 * there) has no recorded maker.
 */
const NEVER_NAMES_A_MAKER: ReadonlySet<string> = new Set([
	"Pre-regeneration snapshot (auto)",
]);

/** A version row as the maker lookup reads it. */
export interface DocumentVersionRowForMaker<TAt> {
	version: number;
	changeDescription: string | null;
	createdAt: TAt;
}

/**
 * The change that made a version's body, and when. `description` is null for
 * a save that recorded none and for a change nothing recorded; `at` is null
 * when no row recorded when it was made.
 */
export interface DocumentVersionMaker<TAt> {
	description: string | null;
	at: TAt | null;
}

/**
 * The change that made `version`'s body, read from the document's version
 * rows (Fizzy #2946).
 *
 * A row holds the body of its version, but most writers store on it the
 * description and time of the change that replaced that body, so the change
 * that made version N is on row N - 1. Creations, imports and regenerations
 * store their own body instead, so for them it is row N itself. Version 1
 * is always the creation: a creator either records its own row there or
 * none (an upload, an empty document filled by its first generation). For
 * a later version, when row N - 1 is missing, holds its own maker, or is a
 * pre-regeneration snapshot, nothing recorded what made version N.
 */
export function documentVersionMaker<TAt>(
	version: number,
	rowsByVersion: ReadonlyMap<number, DocumentVersionRowForMaker<TAt>>,
): DocumentVersionMaker<TAt> {
	const own = rowsByVersion.get(version);
	if (
		own?.changeDescription &&
		MADE_BY_ITS_OWN_ROW.has(own.changeDescription)
	) {
		return { description: own.changeDescription, at: own.createdAt };
	}
	if (version === 1) {
		return { description: INITIAL_VERSION_DESCRIPTION, at: null };
	}
	const previous = rowsByVersion.get(version - 1);
	if (
		!previous ||
		(previous.changeDescription !== null &&
			(MADE_BY_ITS_OWN_ROW.has(previous.changeDescription) ||
				NEVER_NAMES_A_MAKER.has(previous.changeDescription)))
	) {
		return { description: null, at: null };
	}
	return {
		description: previous.changeDescription,
		at: previous.createdAt,
	};
}
