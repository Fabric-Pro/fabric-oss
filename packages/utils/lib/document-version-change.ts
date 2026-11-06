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
