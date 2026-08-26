/**
 * Which kinds of test a project requires, and what each depth tier asks for by
 * default.
 *
 * Settings ▸ Testing lets a project state this explicitly. Until this module
 * existed the answer was implicit: the depth tier carried a hard-coded sentence
 * in the drafting prompt, so a team could read "Standard" but had no way to see
 * — let alone change — which types that actually meant. The tier still supplies
 * the default, and a project that has never touched the control behaves exactly
 * as it did before; the difference is that the answer is now visible and
 * editable rather than buried in a prompt string.
 *
 * One mechanism, deliberately. The drafting prompt composes its sentence from
 * the resolved list rather than keeping a parallel per-tier sentence of its own,
 * because two sources for "which types" is how a settings page comes to disagree
 * with the software it configures.
 *
 * Pure and dependency-free so the settings UI, the API layer and the drafting
 * prompt can all share it.
 */

/** The kinds a project can require, in the order the settings page lists them. */
export const QA_TEST_TYPES = [
	"functional",
	"integration",
	"e2e",
	"security",
	"performance",
	"accessibility",
] as const;

export type QaTestType = (typeof QA_TEST_TYPES)[number];

const QA_TEST_TYPE_SET = new Set<string>(QA_TEST_TYPES);

/**
 * What each depth tier requires when a project has not said otherwise.
 *
 * These sets are the depth tiers' documented meaning: light is functional only,
 * standard adds integration and end-to-end, enterprise adds security and
 * accessibility. `performance` is in no tier's default — it stays available to
 * select, matching the standing guidance that a performance case is written
 * where a criterion names one rather than on every feature.
 */
export const DEFAULT_TEST_TYPES_BY_DEPTH: Record<
	string,
	readonly QaTestType[]
> = {
	EASY: ["functional"],
	AVERAGE: ["functional", "integration", "e2e"],
	HARD: ["functional", "integration", "e2e", "security", "accessibility"],
};

/** The tier's default set, falling back to the middle tier for an unknown value. */
export function defaultTestTypesForDepth(
	depth: string | null | undefined,
): readonly QaTestType[] {
	return (
		DEFAULT_TEST_TYPES_BY_DEPTH[String(depth ?? "").toUpperCase()] ??
		DEFAULT_TEST_TYPES_BY_DEPTH.AVERAGE
	);
}

/**
 * The types a project actually requires.
 *
 * An EMPTY stored list means "follow the tier" rather than "require nothing".
 * That distinction is why the stored column defaults to empty: a project that
 * never opens the control keeps tracking its tier as the tier changes, instead
 * of freezing whatever the default happened to be on the day the column shipped.
 *
 * A project that genuinely wants no required types is not expressible, and that
 * is deliberate — "draft nothing" is what the generation toggle is for, and a
 * settings page with two different ways to say it would be worse.
 *
 * Unknown values are dropped rather than passed through: the list reaches a
 * prompt, and a stored typo should not become an instruction.
 */
export function resolveRequiredTestTypes(
	depth: string | null | undefined,
	stored: readonly string[] | null | undefined,
): readonly QaTestType[] {
	const known = (stored ?? []).filter((t): t is QaTestType =>
		QA_TEST_TYPE_SET.has(t),
	);
	if (known.length === 0) {
		return defaultTestTypesForDepth(depth);
	}
	// Canonical order, so the prompt sentence and the settings page read the same
	// way whatever order the chips were clicked in.
	return QA_TEST_TYPES.filter((t) => known.includes(t));
}

/**
 * Which dimension each sceptic role writes cases in.
 *
 * Only the three roles that map onto a test type appear. `ux` and `edgeCase`
 * write functional cases through a different lens, so no tier excludes them and
 * capping them would remove review depth without removing a dimension.
 */
const SCEPTIC_ROLE_TEST_TYPE: Record<string, QaTestType> = {
	security: "security",
	performance: "performance",
	accessibility: "accessibility",
};

/**
 * The sceptic roles a project actually applies, after its depth has capped them.
 *
 * Roles used to be entirely independent of depth, which made the Light tier
 * unable to do what it says: all five default ON, so a project set to Light
 * still received security, performance and accessibility cases, and the drafting
 * prompt had to carry a clause explaining that the lenses were deliberate
 * exceptions to the scope it had just stated.
 *
 * A role is now dropped when the dimension it writes in is outside the project's
 * effective test types. Note *effective*, not the tier's default: a project that
 * explicitly selects `security` under Depth & scope keeps its security lens at
 * any depth, because it has said what it wants and the tier is only the fallback.
 * That is the whole reason this reads `resolveRequiredTestTypes` rather than
 * `defaultTestTypesForDepth` — capping against the tier would silently overrule
 * an explicit choice.
 *
 * Returns [] when roles are switched off, so callers have one thing to read.
 */
export function resolveScepticRoles(input: {
	depth: string | null | undefined;
	requiredTestTypes: readonly string[] | null | undefined;
	scepticRoles: readonly string[] | null | undefined;
	scepticRolesEnabled: boolean;
}): string[] {
	if (!input.scepticRolesEnabled) {
		return [];
	}
	const inScope = new Set<string>(
		resolveRequiredTestTypes(input.depth, input.requiredTestTypes),
	);
	return (input.scepticRoles ?? []).filter((role) => {
		const dimension = SCEPTIC_ROLE_TEST_TYPE[role];
		// A role with no dimension of its own is never capped.
		return dimension === undefined || inScope.has(dimension);
	});
}

/**
 * The enabled roles this project's depth is currently suppressing.
 *
 * For the settings page, which has to be able to say *why* a chip the reader
 * ticked is not producing cases. Showing the toggle as on while it silently does
 * nothing is the failure this exists to prevent.
 */
export function scepticRolesSuppressedByDepth(input: {
	depth: string | null | undefined;
	requiredTestTypes: readonly string[] | null | undefined;
	scepticRoles: readonly string[] | null | undefined;
	scepticRolesEnabled: boolean;
}): string[] {
	if (!input.scepticRolesEnabled) {
		return [];
	}
	const applied = new Set(resolveScepticRoles(input));
	return (input.scepticRoles ?? []).filter((role) => !applied.has(role));
}

/** True when the project has overridden its tier rather than following it. */
export function isOverridingDepthDefault(
	depth: string | null | undefined,
	stored: readonly string[] | null | undefined,
): boolean {
	if (!stored || stored.length === 0) {
		return false;
	}
	const resolved = resolveRequiredTestTypes(depth, stored);
	const tier = defaultTestTypesForDepth(depth);
	return (
		resolved.length !== tier.length ||
		resolved.some((t, i) => t !== tier[i])
	);
}
