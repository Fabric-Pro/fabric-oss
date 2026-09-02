/**
 * Settings ▸ Testing, as ten short sections instead of one long page.
 *
 * The page previously stacked every control the testing policy has into a
 * single column several thousand pixels tall. Everything was reachable and
 * almost nothing was findable: a reader looking for the CI sync interval had to
 * scroll past depth, coverage, environments, devices and evidence rules to get
 * to it, and once there had no way to link a colleague to the thing they had
 * found.
 *
 * This is the index. It is the single source for the second-level nav, the
 * per-section unsaved markers, and the save bar's "unsaved in <section>" line —
 * three things that have to agree about which control lives where.
 */

export const TESTING_SECTIONS = [
	{
		id: "generation",
		label: "Generation",
		icon: "sparkles",
		title: "Generation",
		blurb: "Whether Fabric drafts test cases at all, when it drafts them, and what happens when CI reports a failure. These apply the moment you change them — there is nothing to save.",
	},
	{
		id: "depth",
		label: "Depth & scope",
		icon: "layers",
		title: "Depth & scope",
		blurb: "How far a drafted suite goes. Depth sets the baseline scope and rigour of every case Fabric writes for this project — it is a floor, not a ceiling.",
	},
	{
		id: "coverage",
		label: "Confidence & coverage",
		icon: "target",
		title: "Confidence & coverage",
		blurb: "The bar a verdict must clear before it is recorded against a case, and the coverage level the automation figure on the Testing tab is measured against. The automation target is reporting only — it blocks nothing.",
	},
	{
		id: "reviewLenses",
		label: "Review lenses",
		icon: "git-pull-request-arrow",
		title: "Pull-request review lenses",
		blurb: "Which lenses Fabric applies when it reads a pull request for this project.",
	},
	{
		id: "environments",
		label: "Environments",
		icon: "globe",
		title: "Environments",
		blurb: "The deployment targets Fabric can drive a browser against, and which one a planned run uses by default.",
	},
	{
		id: "devices",
		label: "Devices & browsers",
		icon: "monitor-smartphone",
		title: "Devices & browsers",
		blurb: "The browser and resolution a run uses unless you override them when starting it. Fabric runs ONE combination per run — the first selected — so these are defaults, not a matrix.",
	},
	{
		id: "rules",
		label: "Rules & evidence",
		icon: "scroll-text",
		title: "Rules & evidence",
		blurb: "Project-specific policy an agent must follow when writing or running tests, the evidence it has to capture while doing it, and how long that evidence is kept.",
	},
	{
		id: "sync",
		label: "CI & result sync",
		icon: "refresh-cw",
		title: "CI & result sync",
		blurb: "Where automated results come from, how often Fabric checks for them, and how a provider can push them instead of waiting to be asked.",
	},
	{
		id: "signOff",
		label: "Sign-off",
		icon: "user-check",
		title: "Sign-off",
		blurb: "What blocks a feature from moving to Done: how many people must record a QA sign-off, and what share of its acceptance criteria must have at least one test case linked. Both ship disabled — a project that has not chosen a number is not silently blocked.",
	},
	{
		id: "sceptics",
		label: "Sceptic roles",
		icon: "user-search",
		title: "Sceptic roles",
		blurb: "Adversarial AI personas that append extra cases during planning. Their cases arrive as Proposed for a person to accept or reject — never straight into the suite.",
	},
] as const;

export type TestingSectionId = (typeof TESTING_SECTIONS)[number]["id"];

export const DEFAULT_TESTING_SECTION: TestingSectionId = "generation";

export function isTestingSectionId(
	value: string | null | undefined,
): value is TestingSectionId {
	return TESTING_SECTIONS.some((s) => s.id === value);
}

/**
 * Which draft fields each section owns.
 *
 * Drives the unsaved dot beside a section in the rail and the save bar's
 * "unsaved changes in X" line. Sections whose controls save instantly
 * (`generation`) or live in their own components with their own writes
 * (`sync`'s pipeline sources, webhooks) own no draft fields and so never show a
 * dot — which is the honest answer, because there is nothing pending for them.
 */
export const SECTION_FIELDS: Record<TestingSectionId, readonly string[]> = {
	generation: [],
	depth: ["strategyDepth", "requiredTestTypes"],
	coverage: ["confidenceThreshold", "indexCoverageEnabled", "coverageTarget"],
	reviewLenses: [
		"prReviewQaLensEnabled",
		"prReviewArchitectureLensEnabled",
		"prReviewAutoReviewEnabled",
		"architectureRules",
	],
	environments: ["defaultEnvironmentId"],
	devices: ["resolutions", "browsers"],
	rules: [
		"rulesMarkdown",
		"implementationNotes",
		"evidencePolicy",
		"evidenceRetentionDays",
	],
	sync: ["pipelineSyncEnabled", "pipelineSyncIntervalMinutes"],
	signOff: ["requiredQaSignOffs", "testCoverageTarget"],
	sceptics: ["scepticRolesEnabled", "scepticRoles"],
};

/**
 * The sections whose fields differ between the draft and what was last saved.
 *
 * Compares by value with lists order-normalised, for the same reason
 * `draftFingerprint` does: `resolutions` and `scepticRoles` are sets in
 * everything but type, so toggling a chip off and back on must not leave a
 * section claiming an edit it does not have.
 */
export function dirtySections<T extends Record<string, unknown>>(
	draft: T,
	saved: T | null,
): TestingSectionId[] {
	if (!saved) {
		return [];
	}
	const same = (a: unknown, b: unknown) =>
		JSON.stringify(Array.isArray(a) ? [...a].sort() : a) ===
		JSON.stringify(Array.isArray(b) ? [...b].sort() : b);

	return TESTING_SECTIONS.filter((section) =>
		SECTION_FIELDS[section.id].some(
			(field) => !same(draft[field], saved[field]),
		),
	).map((section) => section.id);
}

/**
 * Every draft field must belong to exactly one section, or a change to it
 * produces a save bar that cannot say where the change was. Exported for the
 * unit test that asserts it against the real `Draft` keys.
 */
export const ALL_SECTION_FIELDS: string[] =
	Object.values(SECTION_FIELDS).flat();
