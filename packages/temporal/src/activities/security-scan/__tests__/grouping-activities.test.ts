/**
 * Activity-level unit tests for `grouping-activities.ts` — the PROPOSE-phase
 * rewrite (spec `2026-07-01-security-finding-tickets`).
 *
 * The grouping run was refactored from "write tickets during the run" to a
 * PROPOSE-only phase: the activities gather themes, DRAFT one proposal per
 * theme (create / update / skip / declined) WITHOUT any DB writes, and persist
 * the proposals onto the run at `AWAITING_REVIEW`. The real story/comment/tag
 * writes happen later in the `scan.grouping.apply` procedure.
 *
 * This file invokes the REAL activity functions and mocks only their
 * dependencies (`@repo/database`, `@repo/ai`) — the only layer that can
 * genuinely prove:
 *   - the severity-split slicing (a >THEME_SPLIT_THRESHOLD theme -> one
 *     per-severity sub-theme, each with its own themeTagValue key),
 *   - the declined-theme flagging + the `declined` outcome (still drafted),
 *   - the create / update / skip decisioning (incl. the null-fingerprint-is-
 *     always-new diff filter),
 *   - the draft-failure deterministic fallback (never throws),
 *   - the theme-cap overflow slicing,
 *   - the "no scan yet" -> graceful-empty contract.
 *
 * `./grouping-schemas` and `./grouping-tags` are deliberately left UNMOCKED —
 * both are pure, dependency-free modules with their own dedicated unit tests;
 * letting them run for real here integrates the genuine tagging/body logic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// Mocks — every dependency of grouping-activities.ts except ./grouping-schemas
// and ./grouping-tags (left real; see file header).
// =============================================================================

vi.mock("@repo/database", () => ({
	// persistGroupingProposalsActivity reads `startedAt` (for durationMs) and the
	// aiModel row (for cost); nothing else touches `db`. Deliberately NO other
	// model keys — a regression to a hand-rolled write during the propose phase
	// would throw "Cannot read properties of undefined" here rather than
	// silently pass, a stronger guarantee than a call-count assertion.
	db: {
		scanFindingGrouping: { findUnique: vi.fn() },
		aiModel: { findUnique: vi.fn() },
	},
	findOpenStoryByThemeTag: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	getDeclinedGroupingThemes: vi.fn(),
	getEligibleFindingsForGrouping: vi.fn(),
	getLastKnownFingerprints: vi.fn(),
	getLatestProjectScan: vi.fn(),
	updateScanFindingGrouping: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateText: vi.fn(),
	generateStoryTitleFromDescription: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

import {
	generateStoryTitleFromDescription,
	generateText,
	getAIModelWithMetadata,
} from "@repo/ai";
import type { FindingForGrouping } from "@repo/database";
import {
	db,
	findOpenStoryByThemeTag,
	getBoundPromptForAgent,
	getDeclinedGroupingThemes,
	getEligibleFindingsForGrouping,
	getLastKnownFingerprints,
	getLatestProjectScan,
	updateScanFindingGrouping,
} from "@repo/database";
import {
	buildFindingsContext,
	chooseThemeTitle,
	failGroupingActivity,
	type GroupingFailedTheme,
	type GroupingProposalCreate,
	type GroupingSkippedTheme,
	type GroupingTheme,
	gatherEligibleFindingsActivity,
	MAX_FINDINGS_IN_DRAFT_PROMPT,
	MAX_THEMES_PER_GROUPING_RUN,
	markGroupingRunningActivity,
	persistGroupingProposalsActivity,
	proposeThemeActivity,
	THEME_SPLIT_THRESHOLD,
} from "../grouping-activities";
import { themeTagValue } from "../grouping-tags";

// =============================================================================
// Fixtures
// =============================================================================

function makeFinding(
	overrides: Partial<FindingForGrouping> = {},
): FindingForGrouping {
	return {
		id: "finding-1",
		category: "SECURITY",
		severity: "HIGH",
		title: "Hardcoded credential in config",
		description: "A credential is embedded directly in the config file.",
		remediation: "Rotate the credential and move it to a secret manager.",
		ruleSource: "OWASP Top 10 — A03:2021 Injection",
		location: "Document: config.yaml",
		confidence: 0.9,
		fingerprint: "fp-1",
		...overrides,
	};
}

function makeTheme(overrides: Partial<GroupingTheme> = {}): GroupingTheme {
	const category = overrides.category ?? "SECURITY";
	const ruleSource =
		overrides.ruleSource ?? "OWASP Top 10 — A03:2021 Injection";
	return {
		category,
		ruleSource,
		severity: null,
		themeKey: themeTagValue(category, ruleSource),
		declined: false,
		findings: [makeFinding()],
		...overrides,
	};
}

const BASE_PROPOSE_INPUT = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1" as string | null,
	scanCompletedAt: "2026-06-30T12:00:00.000Z" as string | null,
};

beforeEach(() => {
	vi.clearAllMocks();

	// --- AI drafting: success by default -------------------------------------
	vi.mocked(getBoundPromptForAgent).mockResolvedValue({
		version: { content: "SECURITY_FINDING_TICKET SYSTEM PROMPT" },
	} as never);
	vi.mocked(getAIModelWithMetadata).mockResolvedValue({
		model: {},
		metadata: { modelString: "test-model" },
		trackUsage: vi.fn(),
	} as never);
	vi.mocked(generateText).mockResolvedValue({
		text: "## Summary\nDrafted narrative body.",
		usage: { inputTokens: 100, outputTokens: 50 },
	} as never);
	vi.mocked(generateStoryTitleFromDescription).mockResolvedValue({
		title: "Drafted title",
		source: "ai",
		isInsufficient: false,
	});

	// --- DB query defaults ---------------------------------------------------
	vi.mocked(getLatestProjectScan).mockResolvedValue({
		id: "scan-1",
		completedAt: new Date("2026-06-30T12:00:00.000Z"),
	} as never);
	vi.mocked(getEligibleFindingsForGrouping).mockResolvedValue([]);
	vi.mocked(getDeclinedGroupingThemes).mockResolvedValue([]);
	vi.mocked(findOpenStoryByThemeTag).mockResolvedValue(null);
	vi.mocked(getLastKnownFingerprints).mockResolvedValue([]);
	vi.mocked(updateScanFindingGrouping).mockResolvedValue({} as never);
	vi.mocked(db.scanFindingGrouping.findUnique).mockResolvedValue({
		startedAt: new Date("2026-06-30T11:59:00.000Z"),
	} as never);
	vi.mocked(db.aiModel.findUnique).mockResolvedValue(null as never);
});

// =============================================================================
// gatherEligibleFindingsActivity — grouping, severity split, declined, cap
// =============================================================================

describe("gatherEligibleFindingsActivity", () => {
	it("no COMPLETED scan ever: null scan + [] findings -> empty themes/overflow, scanId null, findingCount 0, no throw", async () => {
		vi.mocked(getLatestProjectScan).mockResolvedValue(null);
		vi.mocked(getEligibleFindingsForGrouping).mockResolvedValue([]);

		const result = await gatherEligibleFindingsActivity({
			projectId: "project-1",
		});

		expect(result).toEqual({
			themes: [],
			overflowThemes: [],
			scanId: null,
			scanCompletedAt: null,
			findingCount: 0,
		});
		expect(getLatestProjectScan).toHaveBeenCalledWith("project-1", {
			status: "COMPLETED",
		});
	});

	it("resolved scan with zero eligible findings takes the identical all-zero path (surfacing scanId/scanCompletedAt)", async () => {
		vi.mocked(getEligibleFindingsForGrouping).mockResolvedValue([]);

		const result = await gatherEligibleFindingsActivity({
			projectId: "project-1",
		});

		expect(result.themes).toEqual([]);
		expect(result.overflowThemes).toEqual([]);
		expect(result.findingCount).toBe(0);
		expect(result.scanId).toBe("scan-1");
		expect(result.scanCompletedAt).toBe("2026-06-30T12:00:00.000Z");
	});

	it("groups by (category, ruleSource): same rule -> one whole theme (severity null, declined false); different rule -> separate theme; keys via themeTagValue", async () => {
		vi.mocked(getEligibleFindingsForGrouping).mockResolvedValue([
			makeFinding({ id: "f1", ruleSource: "Rule A" }),
			makeFinding({ id: "f2", ruleSource: "Rule A" }),
			makeFinding({ id: "f3", ruleSource: "Rule B" }),
		]);

		const result = await gatherEligibleFindingsActivity({
			projectId: "project-1",
		});

		expect(result.themes).toHaveLength(2);
		const a = result.themes.find((t) => t.ruleSource === "Rule A");
		const b = result.themes.find((t) => t.ruleSource === "Rule B");
		expect(a?.findings).toHaveLength(2);
		expect(a?.severity).toBeNull();
		expect(a?.declined).toBe(false);
		expect(a?.themeKey).toBe(themeTagValue("SECURITY", "Rule A"));
		expect(b?.findings).toHaveLength(1);
		expect(result.findingCount).toBe(3);
	});

	it("severity split: a theme over THEME_SPLIT_THRESHOLD splits into one sub-theme per severity, each with severity set + a DISTINCT themeTagValue(cat,rule,severity) key", async () => {
		// 26 findings (> 25) all sharing (SECURITY, "Catch-all rule"), spread over
		// three severities -> three severity slices.
		const findings = [
			...Array.from({ length: 10 }, (_, i) =>
				makeFinding({
					id: `c-${i}`,
					ruleSource: "Catch-all rule",
					severity: "CRITICAL",
				}),
			),
			...Array.from({ length: 10 }, (_, i) =>
				makeFinding({
					id: `h-${i}`,
					ruleSource: "Catch-all rule",
					severity: "HIGH",
				}),
			),
			...Array.from({ length: 6 }, (_, i) =>
				makeFinding({
					id: `m-${i}`,
					ruleSource: "Catch-all rule",
					severity: "MEDIUM",
				}),
			),
		];
		expect(findings.length).toBeGreaterThan(THEME_SPLIT_THRESHOLD);
		vi.mocked(getEligibleFindingsForGrouping).mockResolvedValue(findings);

		const result = await gatherEligibleFindingsActivity({
			projectId: "project-1",
		});

		expect(result.themes).toHaveLength(3);
		const crit = result.themes.find((t) => t.severity === "CRITICAL");
		const high = result.themes.find((t) => t.severity === "HIGH");
		const med = result.themes.find((t) => t.severity === "MEDIUM");
		expect(crit?.findings).toHaveLength(10);
		expect(high?.findings).toHaveLength(10);
		expect(med?.findings).toHaveLength(6);
		expect(crit?.themeKey).toBe(
			themeTagValue("SECURITY", "Catch-all rule", "CRITICAL"),
		);
		expect(high?.themeKey).toBe(
			themeTagValue("SECURITY", "Catch-all rule", "HIGH"),
		);
		// Every slice's key is distinct (the hash incorporates the severity).
		const keys = new Set(result.themes.map((t) => t.themeKey));
		expect(keys.size).toBe(3);
	});

	it("a theme at the split threshold stays whole (severity null, not split)", async () => {
		const findings = Array.from({ length: THEME_SPLIT_THRESHOLD }, (_, i) =>
			makeFinding({
				id: `f-${i}`,
				ruleSource: "Small rule",
				severity: i % 2 === 0 ? "HIGH" : "LOW",
			}),
		);
		vi.mocked(getEligibleFindingsForGrouping).mockResolvedValue(findings);

		const result = await gatherEligibleFindingsActivity({
			projectId: "project-1",
		});

		expect(result.themes).toHaveLength(1);
		expect(result.themes[0]?.severity).toBeNull();
		expect(result.themes[0]?.findings).toHaveLength(THEME_SPLIT_THRESHOLD);
	});

	it("declined flagging: a theme whose key is in getDeclinedGroupingThemes is marked declined:true; others stay false", async () => {
		vi.mocked(getEligibleFindingsForGrouping).mockResolvedValue([
			makeFinding({ id: "f1", ruleSource: "Rule A" }),
			makeFinding({ id: "f2", ruleSource: "Rule B" }),
		]);
		const declinedKey = themeTagValue("SECURITY", "Rule A");
		vi.mocked(getDeclinedGroupingThemes).mockResolvedValue([
			{
				themeKey: declinedKey,
				category: "SECURITY",
				ruleSource: "Rule A",
				severity: null,
				declinedByUserId: "user-9",
				declinedAt: "2026-06-30T00:00:00.000Z",
			},
		]);

		const result = await gatherEligibleFindingsActivity({
			projectId: "project-1",
		});

		const a = result.themes.find((t) => t.ruleSource === "Rule A");
		const b = result.themes.find((t) => t.ruleSource === "Rule B");
		expect(a?.declined).toBe(true);
		expect(b?.declined).toBe(false);
	});

	it("theme cap: MAX+1 distinct rules -> MAX kept themes + 1 overflow theme (theme_limit_exceeded); nothing silently dropped", async () => {
		const findings = Array.from(
			{ length: MAX_THEMES_PER_GROUPING_RUN + 1 },
			(_, i) => makeFinding({ id: `f-${i}`, ruleSource: `Rule ${i}` }),
		);
		vi.mocked(getEligibleFindingsForGrouping).mockResolvedValue(findings);

		const result = await gatherEligibleFindingsActivity({
			projectId: "project-1",
		});

		expect(result.themes).toHaveLength(MAX_THEMES_PER_GROUPING_RUN);
		expect(result.overflowThemes).toHaveLength(1);
		expect(result.overflowThemes[0]?.reason).toBe("theme_limit_exceeded");
		// Every theme (kept + overflow) is accounted for — nothing vanished.
		expect(result.themes.length + result.overflowThemes.length).toBe(
			MAX_THEMES_PER_GROUPING_RUN + 1,
		);
		expect(result.findingCount).toBe(MAX_THEMES_PER_GROUPING_RUN + 1);
	});
});

// =============================================================================
// proposeThemeActivity — create / declined (drafts, NO writes)
// =============================================================================

describe("proposeThemeActivity — create / declined", () => {
	it("no existing story: drafts body + title, returns 'create' with the proposal ([Security]-prefixed title, severity, fingerprints) + telemetry; performs NO db writes", async () => {
		const theme = makeTheme();

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("create");
		if (result.outcome === "create") {
			expect(result.proposal.title).toBe("[Security] Drafted title");
			expect(result.proposal.themeKey).toBe(theme.themeKey);
			expect(result.proposal.body).toContain("Drafted narrative body");
			// The deterministic tail (100% of findings) is appended after the
			// AI narrative.
			expect(result.proposal.body).toContain("## Findings (1)");
			expect(result.proposal.fingerprints).toEqual(["fp-1"]);
			expect(result.proposal.severity).toBeNull();
			expect(result.modelName).toBe("test-model");
			expect(result.inputTokens).toBe(100);
			expect(result.outputTokens).toBe(50);
		}
		expect(findOpenStoryByThemeTag).toHaveBeenCalledWith(
			"project-1",
			theme.themeKey,
		);
		// The PROPOSE phase writes nothing — the run row is only touched at persist.
		expect(updateScanFindingGrouping).not.toHaveBeenCalled();
	});

	it("ACCESSIBILITY theme: title is [Accessibility]-prefixed", async () => {
		const theme = makeTheme({
			category: "ACCESSIBILITY",
			ruleSource: "WCAG 2.1 AA — 1.4.3 Contrast (Minimum)",
			findings: [
				makeFinding({ category: "ACCESSIBILITY", severity: "MEDIUM" }),
			],
		});

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("create");
		if (result.outcome === "create") {
			expect(result.proposal.title).toBe("[Accessibility] Drafted title");
		}
	});

	it("severity-split slice: the proposal carries the slice severity and the derived priority", async () => {
		const theme = makeTheme({
			ruleSource: "Catch-all rule",
			severity: "CRITICAL",
			themeKey: themeTagValue("SECURITY", "Catch-all rule", "CRITICAL"),
			findings: [makeFinding({ severity: "CRITICAL" })],
		});

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("create");
		if (result.outcome === "create") {
			expect(result.proposal.severity).toBe("CRITICAL");
			expect(result.proposal.priority).toBe("P0_CRITICAL");
		}
	});

	it("declined theme: returns 'declined' (still drafts a body) and SKIPS the existing-ticket lookup entirely", async () => {
		const theme = makeTheme({ declined: true });

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("declined");
		if (result.outcome === "declined") {
			expect(result.proposal.title).toBe("[Security] Drafted title");
			expect(result.proposal.themeKey).toBe(theme.themeKey);
		}
		// A declined theme is surfaced for Re-add regardless of a stale ticket —
		// the dedup lookup is never performed for it.
		expect(findOpenStoryByThemeTag).not.toHaveBeenCalled();
	});
});

// =============================================================================
// proposeThemeActivity — draft-failure fallback (never throws)
// =============================================================================

describe("proposeThemeActivity — draft-failure fallback (never throws)", () => {
	it("generateText throwing: falls back to a deterministic narrative, still 'create', telemetry empty (modelName null)", async () => {
		vi.mocked(generateText).mockRejectedValue(new Error("gateway 500"));
		const theme = makeTheme({ ruleSource: "Semgrep: js.rule.foo" });

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("create");
		if (result.outcome === "create") {
			expect(result.proposal.body).toContain(
				"This ticket groups 1 security finding(s)",
			);
			expect(result.modelName).toBeNull();
			expect(result.inputTokens).toBe(0);
			expect(result.outputTokens).toBe(0);
		}
	});

	it("no bound prompt: uses the deterministic fallback and never calls getAIModelWithMetadata / generateText", async () => {
		vi.mocked(getBoundPromptForAgent).mockResolvedValue(null as never);
		const theme = makeTheme();

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("create");
		if (result.outcome === "create") {
			expect(result.modelName).toBeNull();
		}
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(generateText).not.toHaveBeenCalled();
	});

	it("title generation throwing falls back to a rule-based title (still [Security]-prefixed), no throw", async () => {
		vi.mocked(generateStoryTitleFromDescription).mockRejectedValue(
			new Error("title gateway down"),
		);
		const theme = makeTheme({ ruleSource: "Semgrep: js.rule.foo" });

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("create");
		if (result.outcome === "create") {
			expect(result.proposal.title).toBe(
				"[Security] Semgrep: js.rule.foo",
			);
		}
	});

	it("an insufficient title (isInsufficient:true) falls back to the rule-based title", async () => {
		vi.mocked(generateStoryTitleFromDescription).mockResolvedValue({
			title: "unusable",
			source: "description-fallback",
			isInsufficient: true,
		});
		const theme = makeTheme({ ruleSource: "Semgrep: js.rule.foo" });

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("create");
		if (result.outcome === "create") {
			expect(result.proposal.title).toBe(
				"[Security] Semgrep: js.rule.foo",
			);
		}
	});
});

// =============================================================================
// proposeThemeActivity — update / skip decisioning
// =============================================================================

describe("proposeThemeActivity — update / skip decisioning", () => {
	const existing = { id: "story-existing", identifier: "F-500" };

	beforeEach(() => {
		vi.mocked(findOpenStoryByThemeTag).mockResolvedValue(existing as never);
	});

	it("existing ticket + genuinely new findings -> 'update' with commentBody, newFingerprints, cumulativeFingerprints, storyId/identifier", async () => {
		vi.mocked(getLastKnownFingerprints).mockResolvedValue(["fp-old"]);
		const theme = makeTheme({
			findings: [
				makeFinding({ id: "f-old", fingerprint: "fp-old" }),
				makeFinding({ id: "f-new", fingerprint: "fp-new" }),
			],
		});

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("update");
		if (result.outcome === "update") {
			expect(result.proposal.newFindingCount).toBe(1);
			expect(result.proposal.storyId).toBe("story-existing");
			expect(result.proposal.storyIdentifier).toBe("F-500");
			expect(result.proposal.commentBody).toContain(
				"Found 1 new finding",
			);
			expect(result.proposal.newFingerprints).toEqual(["fp-new"]);
			// cumulative = previously-known ∪ newly-added (never a reset).
			expect(result.proposal.cumulativeFingerprints.sort()).toEqual([
				"fp-new",
				"fp-old",
			]);
		}
		// A proposed update never posts the comment — no write.
		expect(updateScanFindingGrouping).not.toHaveBeenCalled();
	});

	it("null-fingerprint finding is ALWAYS new even when every fingerprinted finding is known; it is excluded from cumulative (no stable identity)", async () => {
		vi.mocked(getLastKnownFingerprints).mockResolvedValue(["fp-known"]);
		const theme = makeTheme({
			findings: [
				makeFinding({ id: "f-known", fingerprint: "fp-known" }),
				makeFinding({ id: "f-legacy", fingerprint: null }),
			],
		});

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("update");
		if (result.outcome === "update") {
			expect(result.proposal.newFindingCount).toBe(1);
			expect(result.proposal.newFingerprints).toEqual([]);
			expect(result.proposal.cumulativeFingerprints).toEqual([
				"fp-known",
			]);
		}
	});

	it("a theme with ONLY a null-fingerprint finding still reports it as new (not the buggy `f.fingerprint && !lastKnown.has(...)` predicate)", async () => {
		vi.mocked(getLastKnownFingerprints).mockResolvedValue([]);
		const theme = makeTheme({
			findings: [makeFinding({ id: "f-legacy", fingerprint: null })],
		});

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("update");
		if (result.outcome === "update") {
			expect(result.proposal.newFindingCount).toBe(1);
		}
	});

	it("existing ticket + nothing new -> 'skip' (no_new_findings); never drafts a body", async () => {
		vi.mocked(getLastKnownFingerprints).mockResolvedValue(["fp-1"]);
		const theme = makeTheme({
			findings: [makeFinding({ fingerprint: "fp-1" })],
		});

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("skip");
		if (result.outcome === "skip") {
			expect(result.skipped.reason).toBe("no_new_findings");
			expect(result.skipped.storyId).toBe("story-existing");
			expect(result.skipped.storyIdentifier).toBe("F-500");
			expect(result.skipped.findingCount).toBe(1);
		}
		// A skip short-circuits before any drafting.
		expect(generateText).not.toHaveBeenCalled();
	});

	it("AC10 — a pre-tagged ticket never touched before (lastKnown=[]) reports ALL current findings as new in one comment (cumulative = every fingerprint)", async () => {
		vi.mocked(getLastKnownFingerprints).mockResolvedValue([]);
		const theme = makeTheme({
			findings: [
				makeFinding({ id: "f1", fingerprint: "fp-1" }),
				makeFinding({ id: "f2", fingerprint: "fp-2" }),
				makeFinding({ id: "f3", fingerprint: "fp-3" }),
			],
		});

		const result = await proposeThemeActivity({
			theme,
			...BASE_PROPOSE_INPUT,
		});

		expect(result.outcome).toBe("update");
		if (result.outcome === "update") {
			expect(result.proposal.newFindingCount).toBe(3);
			expect(result.proposal.commentBody).toContain(
				"Found 3 new findings",
			);
			expect(result.proposal.cumulativeFingerprints.sort()).toEqual([
				"fp-1",
				"fp-2",
				"fp-3",
			]);
		}
	});
});

// =============================================================================
// persistGroupingProposalsActivity — AWAITING_REVIEW + results + counts
// =============================================================================

describe("persistGroupingProposalsActivity", () => {
	const createProposal: GroupingProposalCreate = {
		category: "SECURITY",
		ruleSource: "Rule A",
		themeKey: "theme-a",
		findingCount: 2,
		severity: null,
		title: "[Security] Rule A",
		body: "body",
		priority: "P1_HIGH",
		fingerprints: ["fp-1", "fp-2"],
	};
	const skipped: GroupingSkippedTheme = {
		category: "SECURITY",
		ruleSource: "Rule B",
		themeKey: "theme-b",
		findingCount: 1,
		storyId: "story-b",
		storyIdentifier: "F-2",
		reason: "no_new_findings",
	};
	const failed: GroupingFailedTheme = {
		category: "SECURITY",
		ruleSource: "Rule C",
		themeKey: "theme-c",
		findingCount: 1,
		reason: "theme_limit_exceeded",
	};

	it("flips the run to AWAITING_REVIEW, writes results {proposedCreate,proposedUpdate,declinedThemes,skippedThemes,failedThemes} + counts, returns the count summary", async () => {
		const result = await persistGroupingProposalsActivity({
			groupingId: "grouping-1",
			proposedCreate: [createProposal],
			proposedUpdate: [],
			declinedThemes: [],
			skippedThemes: [skipped],
			failedThemes: [failed],
			themeCount: 3,
			findingCount: 4,
			modelName: "test-model",
			inputTokens: 100,
			outputTokens: 50,
		});

		expect(result).toEqual({
			proposedCreateCount: 1,
			proposedUpdateCount: 0,
			declinedCount: 0,
			skippedCount: 1,
			failedCount: 1,
		});
		expect(updateScanFindingGrouping).toHaveBeenCalledWith(
			"grouping-1",
			expect.objectContaining({
				status: "AWAITING_REVIEW",
				results: {
					proposedCreate: [createProposal],
					proposedUpdate: [],
					declinedThemes: [],
					skippedThemes: [skipped],
					failedThemes: [failed],
				},
				skippedCount: 1,
				failedCount: 1,
				themeCount: 3,
				findingCount: 4,
				modelName: "test-model",
				inputTokens: 100,
				outputTokens: 50,
			}),
		);
	});

	it("declinedThemes count is surfaced in the summary and persisted onto results", async () => {
		const result = await persistGroupingProposalsActivity({
			groupingId: "grouping-1",
			proposedCreate: [],
			proposedUpdate: [],
			declinedThemes: [createProposal],
			skippedThemes: [],
			failedThemes: [],
			themeCount: 1,
			findingCount: 2,
			modelName: null,
			inputTokens: 0,
			outputTokens: 0,
		});

		expect(result.declinedCount).toBe(1);
		expect(updateScanFindingGrouping).toHaveBeenCalledWith(
			"grouping-1",
			expect.objectContaining({
				results: expect.objectContaining({
					declinedThemes: [createProposal],
				}),
			}),
		);
	});

	it("null modelName short-circuits cost estimation — db.aiModel.findUnique is never queried", async () => {
		await persistGroupingProposalsActivity({
			groupingId: "grouping-1",
			proposedCreate: [],
			proposedUpdate: [],
			declinedThemes: [],
			skippedThemes: [],
			failedThemes: [],
			themeCount: 0,
			findingCount: 0,
			modelName: null,
			inputTokens: 0,
			outputTokens: 0,
		});

		expect(db.aiModel.findUnique).not.toHaveBeenCalled();
	});
});

// =============================================================================
// markGroupingRunningActivity / failGroupingActivity
// =============================================================================

describe("markGroupingRunningActivity / failGroupingActivity", () => {
	it("markGroupingRunning: PENDING -> RUNNING with a startedAt", async () => {
		await markGroupingRunningActivity({ groupingId: "grouping-1" });

		expect(updateScanFindingGrouping).toHaveBeenCalledWith(
			"grouping-1",
			expect.objectContaining({
				status: "RUNNING",
				startedAt: expect.any(Date),
			}),
		);
	});

	it("failGrouping: writes FAILED + completedAt + the error message", async () => {
		await failGroupingActivity({
			groupingId: "grouping-1",
			message: "boom",
		});

		expect(updateScanFindingGrouping).toHaveBeenCalledWith(
			"grouping-1",
			expect.objectContaining({
				status: "FAILED",
				completedAt: expect.any(Date),
				error: "boom",
			}),
		);
	});

	it("failGrouping caps the persisted error at 1000 chars", async () => {
		await failGroupingActivity({
			groupingId: "grouping-1",
			message: "x".repeat(5000),
		});

		const patch = vi.mocked(updateScanFindingGrouping).mock.calls[0]?.[1];
		expect(patch?.error).toHaveLength(1000);
	});
});

// =============================================================================
// buildFindingsContext — drafting-prompt input cap (pure helper)
// =============================================================================

describe("buildFindingsContext — drafting-prompt input cap", () => {
	/** Count the numbered "N. [SEVERITY] …" finding lines in the context. */
	const countFindingLines = (ctx: string) =>
		(ctx.match(/^\d+\. \[/gm) ?? []).length;

	it("inlines every finding and adds no overflow note under the cap", () => {
		const findings = Array.from({ length: 5 }, (_, i) =>
			makeFinding({ id: `f-${i}`, title: `Finding ${i}` }),
		);
		const ctx = buildFindingsContext(makeTheme({ findings }));

		expect(countFindingLines(ctx)).toBe(5);
		expect(ctx).toContain("findingCount: 5");
		expect(ctx).not.toContain("omitted for brevity");
	});

	it("caps the inlined findings and notes the omitted remainder for a large theme (the observed 119-finding case)", () => {
		const total = MAX_FINDINGS_IN_DRAFT_PROMPT + 59;
		const findings = Array.from({ length: total }, (_, i) =>
			makeFinding({ id: `f-${i}`, title: `Finding ${i}` }),
		);
		const ctx = buildFindingsContext(makeTheme({ findings }));

		// Only the cap's worth of findings are inlined…
		expect(countFindingLines(ctx)).toBe(MAX_FINDINGS_IN_DRAFT_PROMPT);
		// …the remainder is explicitly acknowledged, never silently dropped.
		expect(ctx).toContain(
			`+${total - MAX_FINDINGS_IN_DRAFT_PROMPT} more finding(s)`,
		);
		expect(ctx).toContain(`findingCount: ${total}`);
	});
});

describe("chooseThemeTitle", () => {
	it("uses the generated title when it is present and sufficient", () => {
		const theme = makeTheme({ severity: "HIGH" });
		expect(
			chooseThemeTitle(
				"Rotate exposed staging credentials",
				false,
				theme,
			),
		).toBe("Rotate exposed staging credentials");
	});

	it("falls back to the rule when the model returns a literal 'Untitled' (is_insufficient=false)", () => {
		const theme = makeTheme({
			ruleSource: "OWASP Top 10 — A09:2021 Security Logging",
			severity: "MEDIUM",
		});
		// The title generator sometimes emits a bare "Untitled" without flagging
		// it insufficient — it must never surface as the ticket headline.
		expect(chooseThemeTitle("Untitled", false, theme)).toBe(
			"OWASP Top 10 — A09:2021 Security Logging — Medium",
		);
	});

	it("treats a timestamped 'Untitled – …' sentinel as no title", () => {
		const theme = makeTheme({ ruleSource: "WCAG 2.1 AA — 1.1.1 Non-text" });
		expect(
			chooseThemeTitle("Untitled – 2026-07-03 07:15", true, theme),
		).toBe("WCAG 2.1 AA — 1.1.1 Non-text");
	});

	it("falls back to the rule when the title is empty or insufficient", () => {
		const theme = makeTheme({ ruleSource: "Custom: No hardcoded secrets" });
		expect(chooseThemeTitle("", false, theme)).toBe(
			"Custom: No hardcoded secrets",
		);
		expect(chooseThemeTitle("Add MFA", true, theme)).toBe(
			"Custom: No hardcoded secrets",
		);
	});

	it("uses a generic base (never blank / never 'Untitled') when even the rule is empty", () => {
		const theme = makeTheme({ ruleSource: "", severity: "LOW" });
		expect(chooseThemeTitle("Untitled", false, theme)).toBe(
			"Other findings — Low",
		);
	});
});
