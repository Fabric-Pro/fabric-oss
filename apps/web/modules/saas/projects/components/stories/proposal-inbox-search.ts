/**
 * Proposal Inbox search: which list rows a reviewer's query keeps visible.
 *
 * A row matches when its summary, or the title or identifier of any of its
 * items, contains the query, ignoring case. The query is literal text: it is
 * never compiled into a regular expression, so `(`, `*` or `[` match
 * themselves and matching stays linear in the row's text.
 */

export type ProposalInboxItem = {
	title: string;
	identifier: string | null;
};

export type SearchableProposal = {
	summary: string;
	/** Compact per-item titles and identifiers from the list payload. */
	items?: readonly ProposalInboxItem[];
};

/** The comparable form of a query; empty when nothing is being searched. */
export function normalizeProposalQuery(query: string): string {
	return query.trim().toLocaleLowerCase();
}

function contains(text: string | null | undefined, needle: string): boolean {
	return !!text && text.toLocaleLowerCase().includes(needle);
}

/** Whether a row matches an already-normalized, non-empty query. */
export function proposalMatchesQuery(
	proposal: SearchableProposal,
	needle: string,
): boolean {
	return (
		contains(proposal.summary, needle) ||
		(proposal.items ?? []).some(
			(item) =>
				contains(item.title, needle) ||
				contains(item.identifier, needle),
		)
	);
}

/** The rows a query keeps, in their original order. A blank query keeps all. */
export function filterProposalsByQuery<T extends SearchableProposal>(
	proposals: readonly T[],
	query: string,
): T[] {
	const needle = normalizeProposalQuery(query);
	if (!needle) {
		return [...proposals];
	}
	return proposals.filter((proposal) =>
		proposalMatchesQuery(proposal, needle),
	);
}
