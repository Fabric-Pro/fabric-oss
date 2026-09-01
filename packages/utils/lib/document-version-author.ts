/**
 * Document version authorship — the single source of truth for who wrote a
 * `DocumentVersion`, shared by the server (which resolves it) and the client
 * (which renders it).
 *
 * `DocumentVersion.changedBy` is a bare `String?` with NO foreign key to `user`
 * (schema.prisma:1818). That is what makes the AI sentinel below schema-legal:
 * the Living-Documents auto-refresh agent has no `user` row, yet must be
 * attributable in version history exactly like a person is. The column therefore
 * holds EITHER a real `user.id` OR the sentinel OR null (legacy rows written
 * before authorship was recorded).
 *
 * The flip side of having no FK is that nothing constrains the column: a user id
 * in it can point at a row that has since been deleted. `resolveDocumentVersionAuthor`
 * is the only place allowed to turn a raw `changedBy` into something renderable,
 * and it never lets a raw id reach the UI — an unresolvable id becomes
 * `UNKNOWN_AUTHOR_NAME`, not the cuid.
 */

/**
 * `DocumentVersion.changedBy` value stamped on versions committed by the
 * Living-Documents auto-refresh agent.
 *
 * The `agent:` prefix cannot collide with a cuid (`user.id`'s format), so a
 * sentinel is unambiguously distinguishable from a real user id without a
 * lookup.
 */
export const AI_REFRESH_AUTHOR_ID = "agent:living-docs-refresh";

/**
 * Display name for {@link AI_REFRESH_AUTHOR_ID}.
 *
 * Deliberately a NAMED identity rather than a generic "System" / "Automation"
 * label: R13 requires an AI-authored version be recognizable AS the refresh
 * agent, so a reader can tell it apart both from a human editor and from any
 * other machine writer.
 */
export const AI_REFRESH_AUTHOR_NAME = "Fabric Refresh Agent";

/**
 * `DocumentVersion.changedBy` / `ProjectDocument.lastEditedBy` value stamped by
 * the one-time quote-artifact repair (Fizzy #2210).
 *
 * A second non-human writer, so it needs registering below for the same reason
 * the first one did: an `agent:` sentinel that {@link resolveDocumentVersionAuthor}
 * does not recognise falls through to the human branch, matches no `user` row,
 * and renders as {@link UNKNOWN_AUTHOR_NAME} — which means "the account was
 * deleted". Version history would then show an automated repair as a vanished
 * person's edit, which is the ledger inversion this module exists to prevent.
 */
export const QUOTE_REPAIR_AUTHOR_ID = "agent:quote-artifact-repair";

/** Display name for {@link QUOTE_REPAIR_AUTHOR_ID}. */
export const QUOTE_REPAIR_AUTHOR_NAME = "Fabric Content Repair";

/**
 * Every non-human writer, by sentinel. Adding a writer means adding it HERE —
 * a sentinel absent from this map is indistinguishable from a deleted user.
 */
const AGENT_AUTHOR_NAMES: Record<string, string> = {
	[AI_REFRESH_AUTHOR_ID]: AI_REFRESH_AUTHOR_NAME,
	[QUOTE_REPAIR_AUTHOR_ID]: QUOTE_REPAIR_AUTHOR_NAME,
};

/**
 * Rendered when `changedBy` holds an id that resolves to no `user` row (the
 * account was deleted — nothing cleans up the FK-less column). Neutral on
 * purpose, and never the raw id: leaking an internal cuid into the UI is a
 * (small) information disclosure and is meaningless to the reader either way.
 */
export const UNKNOWN_AUTHOR_NAME = "Unknown user";

/** Whether a version's author is a person or the refresh agent. */
export type DocumentVersionAuthorKind = "HUMAN" | "AI_AGENT";

/**
 * The renderable identity of a version's author.
 *
 * `kind` — not a name match — is what the UI branches on to pick the agent's
 * icon: a human who happens to be called "Fabric Refresh Agent" must still
 * render as a human.
 */
export interface DocumentVersionAuthor {
	kind: DocumentVersionAuthorKind;
	name: string;
}

/** Minimal `user` shape needed to name a human author. */
export interface DocumentVersionAuthorUser {
	name?: string | null;
	email?: string | null;
}

/**
 * True when `changedBy` identifies the Living-Documents auto-refresh agent
 * rather than a person.
 *
 * Null-safe so callers can hand it a raw column value.
 */
export function isAiRefreshAuthor(
	changedBy: string | null | undefined,
): boolean {
	return changedBy === AI_REFRESH_AUTHOR_ID;
}

/**
 * Turn a raw `DocumentVersion.changedBy` into a renderable author.
 *
 * @param changedBy the raw column value: a `user.id`, the AI sentinel, or null.
 * @param user the `user` row `changedBy` resolved to, if any. Ignored for the
 *   sentinel (which can never have one). Pass `null`/`undefined` for a
 *   `changedBy` that matched no row — a deleted account.
 * @returns `null` for a legacy row with no recorded author (the UI omits the
 *   author line entirely rather than inventing one); otherwise an author whose
 *   `name` is always safe to display.
 */
export function resolveDocumentVersionAuthor(
	changedBy: string | null | undefined,
	user?: DocumentVersionAuthorUser | null,
): DocumentVersionAuthor | null {
	if (!changedBy) {
		return null;
	}

	const agentName = AGENT_AUTHOR_NAMES[changedBy];
	if (agentName) {
		return { kind: "AI_AGENT", name: agentName };
	}

	// `user.name` is non-null in the schema but can be whitespace; fall back to
	// email, then to the neutral placeholder. The raw id is never a candidate.
	const name =
		user?.name?.trim() || user?.email?.trim() || UNKNOWN_AUTHOR_NAME;

	return { kind: "HUMAN", name };
}
