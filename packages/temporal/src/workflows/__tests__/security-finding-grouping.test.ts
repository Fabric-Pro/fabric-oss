/**
 * Workflow-level integration tests for `securityFindingGroupingWorkflow` — the
 * PROPOSE-phase rewrite (spec `2026-07-01-security-finding-tickets`).
 *
 * The workflow was refactored from "check Fabric-Agent access + write tickets
 * during the run" to a propose-only pipeline:
 *   markGroupingRunning -> gatherEligibleFindings -> proposeTheme (bounded
 *   concurrency, per-theme continue-on-error) -> persistGroupingProposals
 * ending at AWAITING_REVIEW with NO writes. There is no access gate anymore.
 *
 * Test harness pattern follows existing workflow tests in this repo (e.g.
 * `story-sync-workflow.test.ts`): rather than spin up a Temporalite sandbox,
 * `@temporalio/workflow` is mocked so `proxyActivities` returns plain `vi.fn()`
 * stubs, then the workflow is invoked as a regular async function. This covers
 * the WORKFLOW's own control flow — per-theme outcome bucketing into the 5
 * proposal arrays, telemetry accumulation from create+declined outcomes,
 * per-theme continue-on-error, overflow-theme seeding, bounded concurrency, and
 * uncaught-throw -> failGrouping — with full control over each activity's
 * return value.
 *
 * What this file does NOT cover (by design — see `grouping-activities.test.ts`
 * for the activity-level counterparts): `proposeThemeActivity`'s OWN internals
 * (severity split, declined flagging, the null-fingerprint diff, the
 * draft-failure fallback). Those are implementation details of a function this
 * file mocks as an opaque black box; asserting "if the mock returns X the
 * workflow buckets it as X" would be tautological.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	markGroupingRunningActivity: vi.fn(),
	gatherEligibleFindingsActivity: vi.fn(),
	proposeThemeActivity: vi.fn(),
	persistGroupingProposalsActivity: vi.fn(),
	failGroupingActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: vi.fn(() => activityStubs),
	workflowInfo: vi.fn(() => ({ workflowId: "wf-grouping-test-1" })),
}));

import type {
	GatherEligibleFindingsOutput,
	GroupingProposalCreate,
	GroupingTheme,
	ProposeThemeOutcome,
} from "../../activities/security-scan/grouping-activities";
import {
	type SecurityFindingGroupingInput,
	securityFindingGroupingWorkflow,
} from "../security-finding-grouping";

// =============================================================================
// Fixtures
// =============================================================================

const BASE_INPUT: SecurityFindingGroupingInput = {
	groupingId: "grouping-1",
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
};

function makeFinding(
	overrides: Partial<{
		id: string;
		category: "SECURITY" | "ACCESSIBILITY";
		severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
		title: string;
		description: string;
		remediation: string;
		ruleSource: string;
		location: string | null;
		confidence: number | null;
		fingerprint: string | null;
	}> = {},
) {
	return {
		id: "finding-1",
		category: "SECURITY" as const,
		severity: "HIGH" as const,
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
	return {
		category: "SECURITY",
		ruleSource: "OWASP Top 10 — A03:2021 Injection",
		severity: null,
		themeKey: "theme-security-owasp-top-10-a03-2021-injection-aaaaaaaa",
		declined: false,
		findings: [makeFinding()],
		...overrides,
	};
}

function makeGathered(
	overrides: Partial<GatherEligibleFindingsOutput> = {},
): GatherEligibleFindingsOutput {
	return {
		themes: [],
		overflowThemes: [],
		scanId: "scan-1",
		scanCompletedAt: "2026-06-30T12:00:00.000Z",
		findingCount: 0,
		...overrides,
	};
}

function makeCreateProposal(
	theme: GroupingTheme,
	overrides: Partial<GroupingProposalCreate> = {},
): GroupingProposalCreate {
	return {
		category: theme.category,
		ruleSource: theme.ruleSource,
		themeKey: theme.themeKey,
		findingCount: theme.findings.length,
		severity: theme.severity,
		title: `[Security] ${theme.ruleSource}`,
		body: "## Summary\ndrafted",
		priority: "P1_HIGH",
		fingerprints: theme.findings
			.map((f) => f.fingerprint)
			.filter((f): f is string => f !== null),
		...overrides,
	};
}

function createOutcome(
	theme: GroupingTheme,
	overrides: Partial<
		Extract<ProposeThemeOutcome, { outcome: "create" }>
	> = {},
): ProposeThemeOutcome {
	return {
		outcome: "create",
		proposal: makeCreateProposal(theme),
		modelName: "test-model",
		inputTokens: 100,
		outputTokens: 50,
		...overrides,
	};
}

function declinedOutcome(
	theme: GroupingTheme,
	overrides: Partial<
		Extract<ProposeThemeOutcome, { outcome: "declined" }>
	> = {},
): ProposeThemeOutcome {
	return {
		outcome: "declined",
		proposal: makeCreateProposal(theme),
		modelName: "test-model",
		inputTokens: 100,
		outputTokens: 50,
		...overrides,
	};
}

function updateOutcome(
	theme: GroupingTheme,
	newFindingCount: number,
): ProposeThemeOutcome {
	return {
		outcome: "update",
		proposal: {
			category: theme.category,
			ruleSource: theme.ruleSource,
			themeKey: theme.themeKey,
			findingCount: theme.findings.length,
			storyId: `story-${theme.themeKey}`,
			storyIdentifier: `F-${theme.themeKey}`,
			newFindingCount,
			commentBody: `Found ${newFindingCount} new finding(s)`,
			newFingerprints: [],
			cumulativeFingerprints: [],
		},
	};
}

function skipOutcome(theme: GroupingTheme): ProposeThemeOutcome {
	return {
		outcome: "skip",
		skipped: {
			category: theme.category,
			ruleSource: theme.ruleSource,
			themeKey: theme.themeKey,
			findingCount: theme.findings.length,
			storyId: `story-${theme.themeKey}`,
			storyIdentifier: `F-${theme.themeKey}`,
			reason: "no_new_findings",
		},
	};
}

function failedOutcome(
	theme: GroupingTheme,
	reason = "drafting failed",
): ProposeThemeOutcome {
	return {
		outcome: "failed",
		failed: {
			category: theme.category,
			ruleSource: theme.ruleSource,
			themeKey: theme.themeKey,
			findingCount: theme.findings.length,
			reason,
		},
	};
}

describe("securityFindingGroupingWorkflow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		activityStubs.markGroupingRunningActivity.mockResolvedValue(undefined);
		activityStubs.gatherEligibleFindingsActivity.mockResolvedValue(
			makeGathered(),
		);
		activityStubs.failGroupingActivity.mockResolvedValue(undefined);
		// Default: echo the counts straight off whatever arrays the workflow
		// built, so tests that don't care about the exact persisted payload can
		// just assert on the workflow's own return value.
		activityStubs.persistGroupingProposalsActivity.mockImplementation(
			async (input: {
				proposedCreate: unknown[];
				proposedUpdate: unknown[];
				declinedThemes: unknown[];
				skippedThemes: unknown[];
				failedThemes: unknown[];
			}) => ({
				proposedCreateCount: input.proposedCreate.length,
				proposedUpdateCount: input.proposedUpdate.length,
				declinedCount: input.declinedThemes.length,
				skippedCount: input.skippedThemes.length,
				failedCount: input.failedThemes.length,
			}),
		);
	});

	describe("graceful empty (zero findings / no scan)", () => {
		it("no themes: COMPLETES success with all-zero counts, proposeTheme never called, persist called with empty arrays", async () => {
			const output = await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(output).toEqual({
				success: true,
				proposedCreateCount: 0,
				proposedUpdateCount: 0,
				declinedCount: 0,
				skippedCount: 0,
				failedCount: 0,
			});
			expect(activityStubs.proposeThemeActivity).not.toHaveBeenCalled();
			expect(
				activityStubs.persistGroupingProposalsActivity,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					proposedCreate: [],
					proposedUpdate: [],
					declinedThemes: [],
					skippedThemes: [],
					failedThemes: [],
					themeCount: 0,
					findingCount: 0,
				}),
			);
		});

		it("no scan yet (scanId null) is indistinguishable from zero eligible findings — identical all-zero path", async () => {
			activityStubs.gatherEligibleFindingsActivity.mockResolvedValue(
				makeGathered({
					scanId: null,
					scanCompletedAt: null,
					findingCount: 0,
				}),
			);

			const output = await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(output.success).toBe(true);
			expect(output.failedCount).toBe(0);
			expect(activityStubs.proposeThemeActivity).not.toHaveBeenCalled();
		});
	});

	describe("marks the run RUNNING before gathering", () => {
		it("calls markGroupingRunningActivity with the groupingId", async () => {
			await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(
				activityStubs.markGroupingRunningActivity,
			).toHaveBeenCalledWith({ groupingId: "grouping-1" });
		});
	});

	describe("per-theme outcome bucketing + output counts", () => {
		it("threads the full findings array + scanCompletedAt through to proposeThemeActivity", async () => {
			const theme = makeTheme({
				findings: [
					makeFinding({ id: "f-crit", severity: "CRITICAL" }),
					makeFinding({ id: "f-low", severity: "LOW" }),
				],
			});
			activityStubs.gatherEligibleFindingsActivity.mockResolvedValue(
				makeGathered({ themes: [theme], findingCount: 2 }),
			);
			activityStubs.proposeThemeActivity.mockResolvedValue(
				createOutcome(theme),
			);

			await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(activityStubs.proposeThemeActivity).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project-1",
					userId: "user-1",
					organizationId: "org-1",
					scanCompletedAt: "2026-06-30T12:00:00.000Z",
					theme: expect.objectContaining({
						findings: expect.arrayContaining([
							expect.objectContaining({ severity: "CRITICAL" }),
							expect.objectContaining({ severity: "LOW" }),
						]),
					}),
				}),
			);
		});

		it("aggregates create/update/skip/declined/failed into the 5 arrays and returns the matching counts", async () => {
			const tCreate = makeTheme({
				ruleSource: "R create",
				themeKey: "k-create",
			});
			const tUpdate = makeTheme({
				ruleSource: "R update",
				themeKey: "k-update",
			});
			const tSkip = makeTheme({
				ruleSource: "R skip",
				themeKey: "k-skip",
			});
			const tDeclined = makeTheme({
				ruleSource: "R declined",
				themeKey: "k-declined",
				declined: true,
			});
			const tFailed = makeTheme({
				ruleSource: "R failed",
				themeKey: "k-failed",
			});
			activityStubs.gatherEligibleFindingsActivity.mockResolvedValue(
				makeGathered({
					themes: [tCreate, tUpdate, tSkip, tDeclined, tFailed],
					findingCount: 5,
				}),
			);
			activityStubs.proposeThemeActivity
				.mockResolvedValueOnce(createOutcome(tCreate))
				.mockResolvedValueOnce(updateOutcome(tUpdate, 2))
				.mockResolvedValueOnce(skipOutcome(tSkip))
				.mockResolvedValueOnce(declinedOutcome(tDeclined))
				.mockResolvedValueOnce(failedOutcome(tFailed));

			const output = await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(output).toEqual({
				success: true,
				proposedCreateCount: 1,
				proposedUpdateCount: 1,
				declinedCount: 1,
				skippedCount: 1,
				failedCount: 1,
			});
			expect(
				activityStubs.persistGroupingProposalsActivity,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					proposedCreate: [
						expect.objectContaining({ themeKey: "k-create" }),
					],
					proposedUpdate: [
						expect.objectContaining({
							themeKey: "k-update",
							newFindingCount: 2,
						}),
					],
					declinedThemes: [
						expect.objectContaining({ themeKey: "k-declined" }),
					],
					skippedThemes: [
						expect.objectContaining({ themeKey: "k-skip" }),
					],
					failedThemes: [
						expect.objectContaining({ themeKey: "k-failed" }),
					],
					themeCount: 5,
					findingCount: 5,
				}),
			);
		});

		it("accumulates telemetry (tokens + modelName) from create AND declined outcomes only — skip contributes nothing", async () => {
			const tCreate = makeTheme({
				ruleSource: "R create",
				themeKey: "k-create",
			});
			const tDeclined = makeTheme({
				ruleSource: "R declined",
				themeKey: "k-declined",
				declined: true,
			});
			const tSkip = makeTheme({
				ruleSource: "R skip",
				themeKey: "k-skip",
			});
			activityStubs.gatherEligibleFindingsActivity.mockResolvedValue(
				makeGathered({
					themes: [tCreate, tDeclined, tSkip],
					findingCount: 3,
				}),
			);
			activityStubs.proposeThemeActivity
				.mockResolvedValueOnce(
					createOutcome(tCreate, {
						inputTokens: 100,
						outputTokens: 50,
					}),
				)
				.mockResolvedValueOnce(
					declinedOutcome(tDeclined, {
						inputTokens: 30,
						outputTokens: 20,
					}),
				)
				.mockResolvedValueOnce(skipOutcome(tSkip));

			await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(
				activityStubs.persistGroupingProposalsActivity,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					modelName: "test-model",
					inputTokens: 130,
					outputTokens: 70,
				}),
			);
		});

		it("all findings already ticketed: every theme skipped, all proposal counts zero except skipped", async () => {
			const a = makeTheme({ ruleSource: "Rule A", themeKey: "theme-a" });
			const b = makeTheme({ ruleSource: "Rule B", themeKey: "theme-b" });
			activityStubs.gatherEligibleFindingsActivity.mockResolvedValue(
				makeGathered({ themes: [a, b], findingCount: 2 }),
			);
			activityStubs.proposeThemeActivity
				.mockResolvedValueOnce(skipOutcome(a))
				.mockResolvedValueOnce(skipOutcome(b));

			const output = await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(output.proposedCreateCount).toBe(0);
			expect(output.proposedUpdateCount).toBe(0);
			expect(output.declinedCount).toBe(0);
			expect(output.skippedCount).toBe(2);
		});
	});

	describe("per-theme failure resilience", () => {
		it("a rejected proposeThemeActivity lands in failedThemes with a reason string; other themes still process; run stays success:true; failGrouping NOT called", async () => {
			const ok = makeTheme({
				ruleSource: "OK rule",
				themeKey: "theme-ok",
			});
			const bad = makeTheme({
				ruleSource: "Bad rule",
				themeKey: "theme-bad",
			});
			activityStubs.gatherEligibleFindingsActivity.mockResolvedValue(
				makeGathered({ themes: [ok, bad], findingCount: 2 }),
			);
			activityStubs.proposeThemeActivity
				.mockResolvedValueOnce(createOutcome(ok))
				.mockRejectedValueOnce(
					new Error("Ticket drafting exhausted its retries"),
				);

			const output = await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(output.success).toBe(true);
			expect(output.proposedCreateCount).toBe(1);
			expect(output.failedCount).toBe(1);
			expect(activityStubs.failGroupingActivity).not.toHaveBeenCalled();
			expect(
				activityStubs.persistGroupingProposalsActivity,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					failedThemes: [
						expect.objectContaining({
							themeKey: "theme-bad",
							reason: "Ticket drafting exhausted its retries",
						}),
					],
				}),
			);
		});

		it("a non-Error rejection still produces a String(reason) fallback", async () => {
			const theme = makeTheme();
			activityStubs.gatherEligibleFindingsActivity.mockResolvedValue(
				makeGathered({ themes: [theme], findingCount: 1 }),
			);
			activityStubs.proposeThemeActivity.mockRejectedValueOnce(
				"a plain string rejection",
			);

			const output = await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(output.failedCount).toBe(1);
			expect(
				activityStubs.persistGroupingProposalsActivity,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					failedThemes: [
						expect.objectContaining({
							reason: "a plain string rejection",
						}),
					],
				}),
			);
		});

		it("a RESOLVED 'failed' outcome (not a rejection) is also bucketed into failedThemes", async () => {
			const theme = makeTheme({ themeKey: "theme-resolved-fail" });
			activityStubs.gatherEligibleFindingsActivity.mockResolvedValue(
				makeGathered({ themes: [theme], findingCount: 1 }),
			);
			activityStubs.proposeThemeActivity.mockResolvedValue(
				failedOutcome(theme, "self-reported failure"),
			);

			const output = await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(output.failedCount).toBe(1);
			expect(
				activityStubs.persistGroupingProposalsActivity,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					failedThemes: [
						expect.objectContaining({
							themeKey: "theme-resolved-fail",
							reason: "self-reported failure",
						}),
					],
				}),
			);
		});

		it("no-rollback: a later batch failing never undoes an earlier batch's already-proposed create", async () => {
			// GROUPING_CONCURRENCY is 3, so 4 themes span two batches (3 + 1).
			const themes = [1, 2, 3, 4].map((n) =>
				makeTheme({ ruleSource: `Rule ${n}`, themeKey: `theme-${n}` }),
			);
			activityStubs.gatherEligibleFindingsActivity.mockResolvedValue(
				makeGathered({ themes, findingCount: 4 }),
			);
			activityStubs.proposeThemeActivity
				.mockResolvedValueOnce(createOutcome(themes[0]))
				.mockResolvedValueOnce(createOutcome(themes[1]))
				.mockResolvedValueOnce(createOutcome(themes[2]))
				.mockRejectedValueOnce(new Error("cut short"));

			const output = await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(output.success).toBe(true);
			expect(output.proposedCreateCount).toBe(3);
			expect(output.failedCount).toBe(1);
			expect(
				activityStubs.persistGroupingProposalsActivity,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					proposedCreate: [
						expect.objectContaining({ themeKey: "theme-1" }),
						expect.objectContaining({ themeKey: "theme-2" }),
						expect.objectContaining({ themeKey: "theme-3" }),
					],
					failedThemes: [
						expect.objectContaining({ themeKey: "theme-4" }),
					],
				}),
			);
		});
	});

	describe("theme count over the soft cap (overflow seeding)", () => {
		it("overflowThemes are seeded straight into failedThemes WITHOUT ever calling proposeThemeActivity for them; themeCount counts kept + overflow", async () => {
			const keptThemes = [makeTheme({ themeKey: "theme-kept" })];
			const overflow = Array.from({ length: 2 }, (_, i) => ({
				category: "SECURITY" as const,
				ruleSource: `Overflow rule ${i}`,
				themeKey: `theme-overflow-${i}`,
				findingCount: 1,
				reason: "theme_limit_exceeded",
			}));
			activityStubs.gatherEligibleFindingsActivity.mockResolvedValue(
				makeGathered({
					themes: keptThemes,
					overflowThemes: overflow,
					findingCount: 3,
				}),
			);
			activityStubs.proposeThemeActivity.mockResolvedValue(
				createOutcome(keptThemes[0]),
			);

			const output = await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(output.proposedCreateCount).toBe(1);
			expect(output.failedCount).toBe(2);
			// Only the KEPT theme was ever dispatched to proposeThemeActivity.
			expect(activityStubs.proposeThemeActivity).toHaveBeenCalledTimes(1);
			expect(
				activityStubs.persistGroupingProposalsActivity,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					failedThemes: expect.arrayContaining([
						expect.objectContaining({
							themeKey: "theme-overflow-0",
							reason: "theme_limit_exceeded",
						}),
						expect.objectContaining({
							themeKey: "theme-overflow-1",
							reason: "theme_limit_exceeded",
						}),
					]),
					// themeCount = 1 kept + 2 overflow.
					themeCount: 3,
				}),
			);
		});
	});

	describe("bounded concurrency", () => {
		it("processes themes in batches of GROUPING_CONCURRENCY (3), not all at once and not one at a time", async () => {
			const themes = Array.from({ length: 5 }, (_, i) =>
				makeTheme({ ruleSource: `Rule ${i}`, themeKey: `theme-${i}` }),
			);
			activityStubs.gatherEligibleFindingsActivity.mockResolvedValue(
				makeGathered({ themes, findingCount: 5 }),
			);

			let maxConcurrent = 0;
			let inFlight = 0;
			activityStubs.proposeThemeActivity.mockImplementation(
				async (args: { theme: GroupingTheme }) => {
					inFlight += 1;
					maxConcurrent = Math.max(maxConcurrent, inFlight);
					await Promise.resolve();
					inFlight -= 1;
					return createOutcome(args.theme);
				},
			);

			const output = await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(output.proposedCreateCount).toBe(5);
			expect(activityStubs.proposeThemeActivity).toHaveBeenCalledTimes(5);
			expect(maxConcurrent).toBeLessThanOrEqual(3);
			expect(maxConcurrent).toBeGreaterThan(1);
		});
	});

	describe("uncaught failure routing", () => {
		it("an uncaught throw (gather rejects) routes to failGroupingActivity and returns success:false; persist NOT called", async () => {
			activityStubs.gatherEligibleFindingsActivity.mockRejectedValue(
				new Error("DB unreachable"),
			);

			const output = await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(output.success).toBe(false);
			expect(output.error).toBe("DB unreachable");
			expect(activityStubs.failGroupingActivity).toHaveBeenCalledWith({
				groupingId: "grouping-1",
				message: "DB unreachable",
			});
			expect(
				activityStubs.persistGroupingProposalsActivity,
			).not.toHaveBeenCalled();
		});

		it("failGroupingActivity itself throwing is swallowed — still returns success:false with all-zero counts", async () => {
			activityStubs.gatherEligibleFindingsActivity.mockRejectedValue(
				new Error("DB unreachable"),
			);
			activityStubs.failGroupingActivity.mockRejectedValue(
				new Error("failGrouping also unreachable"),
			);

			const output = await securityFindingGroupingWorkflow(BASE_INPUT);

			expect(output.success).toBe(false);
			expect(output.error).toBe("DB unreachable");
			expect(output.proposedCreateCount).toBe(0);
			expect(output.failedCount).toBe(0);
		});
	});

	describe("no defineSignal/defineQuery (structural check)", () => {
		it("the module's only runtime value export is the workflow function itself", async () => {
			// Type-only exports (SecurityFindingGroupingInput/Output) are erased by
			// TS and never appear here — this is a genuine runtime check that no
			// defineSignal()/defineQuery() handle is exported alongside the workflow.
			const workflowModule = await import("../security-finding-grouping");
			expect(Object.keys(workflowModule)).toEqual([
				"securityFindingGroupingWorkflow",
			]);
		});
	});
});
