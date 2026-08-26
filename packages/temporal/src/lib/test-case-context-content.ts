/**
 * The plain-text body a test case is embedded as for AI retrieval.
 *
 * Pure — no I/O, no Prisma, no Temporal. It lives here rather than in @repo/api
 * because BOTH sides need it and only one may own it: the request-path mirror
 * (create / update / clone, via `@repo/api`'s `syncTestCaseContext`) and the
 * background drafting activity in this package, which cannot import @repo/api.
 * @repo/api already depends on @repo/temporal, so this is the direction the
 * dependency graph already runs. Re-exported from
 * `packages/api/modules/projects/lib/test-case-context.ts` so existing callers
 * and its test are unaffected.
 *
 * This is what the project AI reads about a test case — change it here and both
 * paths move together.
 */
import { criterionIndexFromRef } from "@repo/utils/acceptance-criteria";

export interface TestCaseContextStep {
	action: string;
	expected: string;
}

export interface TestCaseContextLinkedFeature {
	/** Feature/bug identifier shown to the model, e.g. "F-012". */
	identifier: string;
	title: string;
	/**
	 * The acceptance-criterion reference when the link names one — an index or
	 * short text. Rendered as "Covers AC N" so the model knows which slice of
	 * the feature this case verifies.
	 */
	acceptanceCriterionRef?: string | null;
	/**
	 * Every criterion the stored link covers. A case routinely proves more than
	 * one, and the embedded body has to name each — retrieval answering "which
	 * cases cover AC 3" has only this text to work from. The request path passes
	 * this list; the drafting activity passes the singular field above, because
	 * the model names at most one criterion per case.
	 */
	acceptanceCriterionRefs?: readonly string[] | null;
}

/**
 * Compose the plain-text body embedded for AI retrieval. Self-contained and
 * machine-readable: identifier + title, state/priority, preconditions, the
 * ordered Action → Expected steps (numbered), the features it covers (with the
 * acceptance criterion when set), and tags. Pure — no I/O.
 */
export function buildTestCaseContextContent(input: {
	identifier: string;
	title: string;
	state: string;
	priority: string;
	/** Preconditions / summary (the case `description`). */
	preconditions?: string | null;
	steps?: TestCaseContextStep[];
	linkedFeatures?: TestCaseContextLinkedFeature[];
	tags?: string[];
}): string {
	const lines = [
		`${input.identifier} ${input.title}`.trim(),
		`State: ${input.state}`,
		`Priority: ${input.priority}`,
	];

	if (input.preconditions?.trim()) {
		lines.push(`Preconditions: ${input.preconditions.trim()}`);
	}

	const steps = (input.steps ?? []).filter((s) => s.action.trim().length > 0);
	if (steps.length > 0) {
		lines.push("", "Steps:");
		steps.forEach((step, i) => {
			const action = step.action.trim();
			const expected = step.expected.trim();
			lines.push(
				expected
					? `${i + 1}. ${action} → ${expected}`
					: `${i + 1}. ${action}`,
			);
		});
	}

	const features = input.linkedFeatures ?? [];
	if (features.length > 0) {
		lines.push("", "Covers:");
		for (const feature of features) {
			const acText = formatAcceptanceCriterionRefs([
				...(feature.acceptanceCriterionRefs ?? []),
				feature.acceptanceCriterionRef,
			]);
			const label = `${feature.identifier} ${feature.title}`.trim();
			lines.push(acText ? `- ${label} (${acText})` : `- ${label}`);
		}
	}

	const tags = (input.tags ?? []).filter((t) => t.trim().length > 0);
	if (tags.length > 0) {
		lines.push("", `Tags: ${tags.join(", ")}`);
	}

	return lines.join("\n");
}

/**
 * Normalize the criteria a link covers into one "Covers AC N, AC M" phrase.
 *
 * Resolution goes through `criterionIndexFromRef` — the same first-integer rule
 * the coverage ring, the traceability matrix and the re-draft dedupe use — so
 * the embedded text can never claim a criterion the rest of the product does
 * not count. A ref that resolves ("AC 3", "3", "criterion 4") renders as
 * "AC <n>"; one that does not ("Tenant isolation") is rendered verbatim, since
 * asserting "AC Tenant isolation" would invent an identifier nothing can place.
 * Resolved references de-duplicate by index, so the same criterion arriving in
 * two spellings renders once. Blanks drop out.
 */
function formatAcceptanceCriterionRefs(
	refs: readonly (string | null | undefined)[],
): string | null {
	const parts: string[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const trimmed = ref?.trim();
		if (!trimmed) {
			continue;
		}
		const index = criterionIndexFromRef(trimmed);
		const rendered =
			index === null ? trimmed.replace(/^covers\s+/i, "") : `AC ${index}`;
		const key = rendered.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			parts.push(rendered);
		}
	}
	if (parts.length === 0) {
		return null;
	}
	return `Covers ${parts.join(", ")}`;
}
