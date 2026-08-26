/**
 * Custom changeset changelog formatter.
 *
 * Keeps each release-note entry to a single scannable line. The first
 * paragraph of every `.changeset/*.md` body (the headline) is published;
 * anything below the first blank line — or below the first Markdown block
 * such as a list, sub-heading, or blockquote — is treated as internal
 * context (PR rationale, staging traces, file lists, test counts) and
 * dropped from `CHANGELOG.md`.
 *
 * The authoring convention is still "headline on line 1, blank line, then
 * context" — see AGENTS.md § Changesets. But authors and LLM-generated
 * changesets routinely violate it in two ways, so this formatter is robust
 * to both rather than emitting broken entries:
 *
 *   1. Soft-wrapped headline — the headline is wrapped across several
 *      physical lines with no blank line between them. Taking only the first
 *      physical line published a mid-sentence fragment ("…and harden the",
 *      "…a 2-way,"). We now join the whole headline paragraph back into one
 *      line, stopping at the first blank line or Markdown block marker.
 *   2. Leading Markdown heading / blockquote — a body that opens with
 *      "# Title" or "> quote" leaked the literal "#"/">" into CHANGELOG.md.
 *      We strip leading markers from the assembled headline, looping so
 *      nested combinations in either order ("> # Title", "> > ## Title") are
 *      fully removed. A headline left empty by stripping throws, like an
 *      empty body.
 *
 * Convention for authors / LLM-generated changesets:
 *
 *     ---
 *     "fabric-app": patch
 *     ---
 *
 *     One-sentence release-note headline (<=150 chars, no soft-wrap).
 *
 *     Everything below the first blank line is internal context that does
 *     NOT appear in CHANGELOG.md. Diagnosis prose, staging trace IDs, file
 *     lists, test counts, before/after snippets all belong here.
 *
 * See CLAUDE.md / AGENTS.md § Changesets for the full convention.
 */

// A line that begins a new Markdown block: unordered/ordered list item,
// ATX heading, blockquote, or table row. Such a line ends the headline
// paragraph even when no blank line precedes it (so a headline immediately
// followed by a bullet list does not absorb the list).
const BLOCK_START = /^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>\s|\|)/;

const getReleaseLine = async (changeset) => {
	const lines = changeset.summary.split("\n");

	// Find the first non-blank line — the start of the headline.
	let start = 0;
	while (start < lines.length && lines[start].trim() === "") {
		start++;
	}

	if (start >= lines.length) {
		const slug = changeset.id ? `"${changeset.id}"` : "(unknown)";
		throw new Error(
			`Changeset ${slug} has an empty body. Add a one-sentence headline as the first non-blank line — see AGENTS.md § Changesets.`,
		);
	}

	// Reassemble the headline paragraph: the first non-blank line plus any
	// immediately-following soft-wrap continuation lines. Stop at the first
	// blank line or the first line that starts a new Markdown block — those
	// mark the start of the internal-context body.
	const parts = [lines[start].trim()];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "" || BLOCK_START.test(line)) {
			break;
		}
		parts.push(line.trim());
	}

	// Collapse the soft-wrap whitespace into single spaces, then strip any
	// leading blockquote (">") and ATX heading ("#"…"######") markers so they
	// never leak into CHANGELOG.md. Strip in a loop because the two can nest in
	// either order — e.g. "> # Title" needs both removed, and a single ordered
	// pass would leave the inner marker behind.
	let headline = parts.join(" ").replace(/\s+/g, " ").trim();
	let stripped;
	do {
		stripped = headline;
		headline = headline
			.replace(/^>\s*/, "")
			.replace(/^#{1,6}(?:\s+|$)/, "")
			.trim();
	} while (headline !== stripped);

	// After stripping, the headline can be empty (e.g. the body was just "#"
	// or "> "). Fail fast with the same guidance as an empty body rather than
	// emitting a malformed, headline-less bullet.
	if (!headline) {
		const slug = changeset.id ? `"${changeset.id}"` : "(unknown)";
		throw new Error(
			`Changeset ${slug} has no headline text — only Markdown markers ("#"/">"). Add a one-sentence headline as the first non-blank line — see AGENTS.md § Changesets.`,
		);
	}

	const prefix = changeset.commit ? `${changeset.commit.slice(0, 7)}: ` : "";
	return `- ${prefix}${headline}`;
};

const getDependencyReleaseLine = async (changesets, dependenciesUpdated) => {
	if (dependenciesUpdated.length === 0) {
		return "";
	}
	const changesetLinks = changesets.map(
		(changeset) =>
			`- Updated dependencies${changeset.commit ? ` [${changeset.commit.slice(0, 7)}]` : ""}`,
	);
	const updatedDependenciesList = dependenciesUpdated.map(
		(dependency) => `  - ${dependency.name}@${dependency.newVersion}`,
	);
	return [...changesetLinks, ...updatedDependenciesList].join("\n");
};

module.exports = {
	default: { getReleaseLine, getDependencyReleaseLine },
	getReleaseLine,
	getDependencyReleaseLine,
};
