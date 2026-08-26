/**
 * Function-tag AI-context clause (#1767 Stage 4). Sibling of
 * `getLockedAttachmentRulesClause`. PURE — receives pre-resolved label strings
 * (never Prisma/@repo/database) so this package stays dependency-light. The
 * caller (@repo/ai wrapper) resolves the roster composition + requester labels
 * via FUNCTION_TAG_LABELS and passes them here.
 *
 * Calibrate-only: states the team's role composition as facts and instructs
 * proportional, balanced tone/technical-depth. Callers MUST append
 * the return value verbatim (concatenation only), and only when non-empty.
 */
export interface FunctionTagClauseInput {
	/** Ordered, deduped role composition rendered as labels + counts. */
	composition: { label: string; count: number }[];
	/** The requesting contributor's own role labels (empty if untagged/absent). */
	requesterLabels: string[];
}

export function getFunctionTagContextClause(
	input: FunctionTagClauseInput,
): string {
	if (input.composition.length === 0) {
		return "";
	}

	const compositionLine = input.composition
		.map((c) => `${c.count} × ${c.label}`)
		.join(", ");

	const requesterLine =
		input.requesterLabels.length > 0
			? `\nYou are assisting a contributor whose role is: ${input.requesterLabels.join(", ")}.`
			: "";

	return `PROJECT CONTRIBUTOR ROLES — AUDIENCE & TONE CONTEXT
The following project contributors hold these declared function roles (project-level
role/function tags). Use them only to calibrate the tone, technical depth, and framing
of what you write. They do not grant permissions, change what you may access, or dictate
document structure.

Contributor role composition: ${compositionLine}.${requesterLine}

Guidance:
- Frame the content for this mix of roles proportionally; do not optimise for one role
  at the expense of others.
- Where the composition includes engineering roles (Developer, Architect, SDET/QA,
  Designer), technical precision and implementation detail are appropriate.
- Where it includes product/business roles (Product Owner, Product Contributor,
  Stakeholder, Subject-Matter Expert), keep intent and value clear and avoid unnecessary
  implementation jargon.
- Do not invent an audience for a role that is absent from the composition above.`;
}
