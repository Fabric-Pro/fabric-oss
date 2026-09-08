/**
 * Document prerequisite graph — CLIENT-SAFE.
 *
 * Deliberately free of value imports. Its only Prisma reference is `import
 * type`, which the compiler erases, so a browser bundle can deep-import this
 * module (`@repo/database/src/document-dependency-graph`) without dragging the
 * generated Prisma client in behind it. Same rule, and same reason, as
 * `publishing-post-types.ts`. The Temporal workflow bundle imports it under the
 * same constraint: a workflow may not pull the Prisma client into its sandbox.
 *
 * DO NOT re-export this through the queries barrel to save the deep import. That
 * barrel re-exports the whole database surface, so one `export * from` would put
 * ~100 db-bound modules into every bundle that wanted a prerequisite list.
 *
 * It exists because the graph was written twice — once as `DOCUMENT_TIERS` in
 * the project wizard, once as the phase numbers in the batch generation
 * workflow, whose comment could only ask the next reader to keep the two
 * matching by hand. One of them was going to drift, and the failure is silent:
 * a document generated before the document it is supposed to build on.
 */

import type { ProjectDocumentType } from "../prisma/client";

/**
 * One node of the graph: which tier the type sits in, and which types satisfy
 * it.
 *
 * `prerequisites` is `string[]` rather than `ProjectDocumentType[]` because
 * every caller holds a plain `string` — a document row's `type` column read
 * back as a string, a wizard checkbox id, a workflow input field. Narrowing the
 * READ type would only push an `as` cast out to each of them, which is the
 * assertion that stops meaning anything. The narrow type is enforced where it
 * can be checked instead: at the literal below.
 */
type DocumentDependency = {
	/** 1 = foundation. Each higher tier needs one of the tier beneath it. */
	tier: number;
	/** OR semantics — ANY ONE of these satisfies the type. */
	prerequisites: string[];
};

/**
 * The graph itself, exhaustive over `ProjectDocumentType` by `satisfies`.
 *
 * Exhaustive so that a value added to the enum fails to compile HERE rather
 * than silently arriving prerequisite-free — an unknown key reads as "available
 * now, phase 1" at every lookup below, which is the most permissive answer the
 * system can give and the one nobody would have chosen deliberately.
 */
const GRAPH = {
	// Tier 1 — foundation documents. Nothing has to exist first.
	GENERAL: { tier: 1, prerequisites: [] },
	BUSINESS_CASE: { tier: 1, prerequisites: [] },
	DESIGN_SYSTEM: { tier: 1, prerequisites: [] },
	PRD: { tier: 1, prerequisites: [] },
	PROPOSAL: { tier: 1, prerequisites: [] },

	// Tier 2 — technical documents. Either requirements document will do; they
	// are two ways of writing down the same intent, not two halves of one.
	ARCHITECTURE: { tier: 2, prerequisites: ["PRD", "PROPOSAL"] },
	TECHNICAL_SPEC: { tier: 2, prerequisites: ["PRD", "PROPOSAL"] },
	API_SPEC: { tier: 2, prerequisites: ["PRD", "PROPOSAL"] },

	// Tier 3 — features, which need something technical to be derived from.
	USER_STORY: {
		tier: 3,
		prerequisites: ["ARCHITECTURE", "TECHNICAL_SPEC", "API_SPEC"],
	},

	// Quality and requirements types no generation surface offers yet. Tier 1
	// with no prerequisites is what they ALREADY resolve to: neither the
	// wizard's table nor the workflow's phase table named them, and both fall
	// back to "available, phase 1" for a key they do not hold. They are written
	// out so the exhaustive check above stays honest — giving them real
	// prerequisites is a behaviour change, and belongs to whoever first puts
	// them in front of a user.
	QA_STRATEGY: { tier: 1, prerequisites: [] },
	TEST_PLAN: { tier: 1, prerequisites: [] },
	TEST_REPORT: { tier: 1, prerequisites: [] },
	TRACEABILITY_MATRIX: { tier: 1, prerequisites: [] },
	SRS: { tier: 1, prerequisites: [] },
} satisfies Record<
	ProjectDocumentType,
	{ tier: number; prerequisites: ProjectDocumentType[] }
>;

/**
 * Document generation tiers: requirements first, technical documents second,
 * features last. A type above tier 1 needs at least one prerequisite (OR) to be
 * selected or to already exist.
 */
export const DOCUMENT_TIERS: Record<string, DocumentDependency> = GRAPH;

/**
 * Returns true if the document type can be selected or generated given the set
 * of satisfied types (selected in the same batch, or already on the project).
 *
 * Prerequisites are OR: one is enough. A type the graph does not know is
 * available — the graph is exhaustive over the enum, so reaching that branch
 * means the caller passed something that is not a document type at all, and
 * blocking it here would present as a checkbox that cannot be ticked with no
 * explanation.
 */
export function isDocumentAvailable(
	type: string,
	satisfiedTypes: Set<string>,
): boolean {
	const node = DOCUMENT_TIERS[type];
	if (!node || node.prerequisites.length === 0) {
		return true;
	}
	return node.prerequisites.some((prerequisite) =>
		satisfiedTypes.has(prerequisite),
	);
}
