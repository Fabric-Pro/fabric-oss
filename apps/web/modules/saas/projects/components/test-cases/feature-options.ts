/**
 * The work-item shape the feature picker hands back, and the shape the cases
 * toolbar resolves a stored id into. Shared here rather than on either of them
 * so a caller can hold the type without importing a component or a hook.
 *
 * Deliberately thin: matching, ranking and the coverage tally are the coverage
 * QUERY's job (`listFeatureCoverage`), not this module's. This is the selection
 * contract, and nothing more.
 */

type FeatureKind = "FEATURE" | "BUG";

/** A pickable work item. */
export type FeatureOption = {
	id: string;
	/** Plain decimal (e.g. "177"). Bugs and features share one counter, so the
	 * identifier alone never says which kind this is — `kind` does. */
	identifier: string;
	title: string;
	kind: FeatureKind | null;
};
