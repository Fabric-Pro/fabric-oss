/**
 * Copy + option sets for the QA policy page (Settings ▸ Testing).
 *
 * Kept beside the form rather than in the i18n catalogue for the same reason the
 * Get Started page tours are: this is descriptive product copy that only ever
 * renders on one screen, and inlining it keeps each option's meaning next to the
 * value it sets.
 *
 * The depth tiers read Light / Standard / Enterprise here while the stored enum
 * stays EASY / AVERAGE / HARD. The tiers were always these three; only the words
 * on screen were the engineering ones, and renaming the column would rewrite
 * every project's row to say the same thing it already says.
 */

import type { QaTestType } from "@repo/utils/qa-test-types";

export const STRATEGY_DEPTHS = ["HARD", "AVERAGE", "EASY"] as const;
export type StrategyDepth = (typeof STRATEGY_DEPTHS)[number];

/**
 * What each depth actually implies.
 *
 * Every bullet here must be something the tier GENUINELY causes. These lines
 * previously promised a confidence floor, an evidence policy, an eval mode and a
 * sceptic-role count per tier — none of which the tier set. Confidence, evidence
 * and sceptic roles are independent controls further down this same page, so
 * picking Easy left the 0.80 threshold and every enabled lens exactly where they
 * were while the page said otherwise.
 *
 * What the tier does determine is scope and rigour, and both are enforced
 * server-side in `DEPTH_GUIDANCE` / `DEPTH_TEST_TYPES`
 * (`packages/ai/lib/prompts/test-case-drafting.ts`). Keep these bullets in step
 * with those two records — they are the same statement rendered for a reader.
 */
export const STRATEGY_DEPTH_INFO: Record<
	StrategyDepth,
	{ label: string; bullets: string[] }
> = {
	HARD: {
		label: "Enterprise",
		bullets: [
			"Functional + integration + E2E",
			"Security and accessibility cases",
			"Boundary values and concurrency",
			"Tenant-isolation cases",
		],
	},
	AVERAGE: {
		label: "Standard",
		bullets: [
			"Functional + integration + E2E",
			"Main negative paths",
			"Obvious edge cases",
			"Security, performance and accessibility only on request",
		],
	},
	EASY: {
		label: "Light",
		bullets: [
			"Functional / acceptance cases only",
			"Happy path + the key negative case",
			"No integration or E2E cases",
			"No security, performance or accessibility cases",
		],
	},
};

/**
 * The kinds of test a project can require, as the settings page names them.
 *
 * Keys are the stored values — see `QA_TEST_TYPES` in `@repo/utils/qa-test-types`,
 * which is also where the tier defaults and the resolution rule live. This copy
 * is display only, so re-wording a label needs no migration.
 */
export const REQUIRED_TEST_TYPE_LABELS: Record<QaTestType, string> = {
	functional: "Functional",
	integration: "Integration",
	e2e: "End-to-end",
	security: "Security",
	performance: "Performance",
	accessibility: "Accessibility",
};

/**
 * Shown under the sceptic-role list so the interaction with depth is visible
 * where the roles are actually toggled.
 *
 * Depth now CAPS the roles rather than sitting beside them. The two used to be
 * independent, which made it possible to pick Light — "no security, performance
 * or accessibility cases" — and still receive all three, because the roles
 * default to on. The tier said one thing and the suite did another.
 *
 * A role whose dimension the project's effective test types exclude is dropped.
 * "Effective", not "the tier's default": ticking that dimension under Depth &
 * scope brings the role back at any depth, because an explicit choice outranks
 * the fallback. That is the escape hatch this note has to make findable, or a
 * reader whose security chip stopped producing cases has no way to get it back.
 */
export const SCEPTIC_DEPTH_INTERACTION_NOTE =
	"Depth caps these roles: one whose dimension your depth excludes writes nothing. To keep a lens at a lighter depth, tick its dimension under Depth & scope — an explicit choice wins over the tier.";

export const EVIDENCE_POLICIES = [
	"SCREENSHOT_REQUIRED",
	"OPTIONAL",
	"NONE",
] as const;
export type EvidencePolicy = (typeof EVIDENCE_POLICIES)[number];

export const EVIDENCE_POLICY_LABEL: Record<EvidencePolicy, string> = {
	SCREENSHOT_REQUIRED: "Screenshot required",
	OPTIONAL: "Optional",
	NONE: "None",
};

export const BROWSERS = ["chromium", "firefox", "webkit"] as const;
export type Browser = (typeof BROWSERS)[number];

export const BROWSER_LABEL: Record<Browser, string> = {
	chromium: "Chromium",
	firefox: "Firefox",
	webkit: "WebKit",
};

/** Common defaults offered as one-click toggles; any WxH can still be typed. */
export const SUGGESTED_RESOLUTIONS = [
	"1920x1080",
	"1366x768",
	"1440x900",
	"390x844",
] as const;

/**
 * The adversarial personas that may append test cases during planning. Keys
 * match `QA_SCEPTIC_ROLES` in @repo/database — the stored value is the key, so
 * this copy can change without a migration.
 */
export const SCEPTIC_ROLES = [
	{
		key: "security",
		label: "Security Reviewer",
		description:
			"Probes auth, tenant isolation (XOR), injection, and data-leak paths.",
	},
	{
		key: "ux",
		label: "UX Skeptic",
		description:
			"Challenges empty/error states, focus order, and ambiguous copy.",
	},
	{
		key: "performance",
		label: "Performance Critic",
		description:
			"Targets N+1 queries, unbounded lists, and slow first paint.",
	},
	{
		key: "accessibility",
		label: "Accessibility Auditor",
		description:
			"Verifies keyboard nav, labels, contrast, and live regions.",
	},
	{
		key: "edgeCase",
		label: "Edge-Case Hunter",
		description:
			"Pushes boundary inputs, race conditions, and concurrency.",
	},
] as const;

export type ScepticRoleKey = (typeof SCEPTIC_ROLES)[number]["key"];

const SCEPTIC_ROLE_KEYS = new Set<string>(SCEPTIC_ROLES.map((r) => r.key));

/**
 * Narrow stored role keys to the ones this build knows about. A row written by
 * a newer build (or with a since-removed role) must not be sent back to the API,
 * which validates against the current key set and would reject the whole save.
 */
export function knownScepticRoles(roles: string[]): ScepticRoleKey[] {
	return roles.filter((r): r is ScepticRoleKey => SCEPTIC_ROLE_KEYS.has(r));
}

/**
 * How often Fabric may check for new CI results, for the Settings ▸ Testing
 * select.
 *
 * The minutes MUST stay in step with `PIPELINE_SYNC_INTERVAL_MINUTES` in
 * `@repo/database` — the procedure validates against that set, so an option
 * offered here and missing there is a save the user cannot make. Labels live
 * here rather than server-side because they are copy, not contract.
 */
export const PIPELINE_SYNC_INTERVAL_OPTIONS = [
	{ minutes: 15, label: "15 minutes" },
	{ minutes: 30, label: "30 minutes" },
	{ minutes: 60, label: "1 hour" },
	{ minutes: 240, label: "4 hours" },
] as const;
