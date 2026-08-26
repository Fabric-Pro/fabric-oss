/**
 * Behavioral (TestWorkflowEnvironment) tests for the v6 release-note-exclusion
 * wiring in `generateDailyBriefWorkflow`.
 *
 * A source-scan (daily-brief-workflow-wiring.test.ts) can prove the tokens are
 * present but CANNOT prove that the workflow's broad top-level `catch` actually
 * rethrows the Temporal `ContinueAsNew` control-flow error instead of converting
 * the self-rerun into a FAILED brief. That is exactly the Codex-critical failure
 * mode, so it needs a real execution.
 *
 * This file spins up a local time-skipping Temporal test server, bundles the
 * REAL workflow code from the workflows barrel, injects mocked activities, and
 * asserts the observable behavior:
 *
 *   1. Stable exclusion signature → the run finalizes normally (no continue-as-new;
 *      persist called ONCE with a terminal READY/EMPTY status).
 *   2. A signature that changes mid-generation → exactly one continue-as-new, then
 *      convergence. `execute()` (which follows the run chain) RESOLVES successfully
 *      and the ONLY persist is terminal, non-FAILED — proving the catch rethrew
 *      `ContinueAsNew` rather than persisting FAILED.
 *   3. A signature that keeps changing for two runs (depth 0 → 1 → 2) converges
 *      within `MAX_REGEN_CHAIN`.
 *   4. Scope boundary — a STORY-level exclusion (`F-123`) removes the F-123
 *      `pr_merged` items from the `github` handed to both summarizers, while
 *      `sections.storyChanges` / `sections.taskChanges` pass through UNCHANGED
 *      (the filter is release-notes-scoped; it must not touch the story narrative).
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use. In a network-restricted environment
 * `beforeAll` will fail; run this once online to populate the binary cache. The
 * companion source-scan test remains the fast, always-runnable gate.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test daily-brief-workflow-convergence
 */

import { resolve } from "node:path";
import type {
	GithubItem,
	StoryChangeItem,
	TaskChangeItem,
} from "@repo/database";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	CollectGitHubPullRequestsActivityOutput,
	CollectGitHubReleasesActivityOutput,
	CollectStoryActivityOutput,
	PersistDailyBriefInput,
	SummarizeDailyBriefInput,
	SummarizeDailyBriefOutput,
	SummarizeReleaseNotesInput,
	SummarizeReleaseNotesOutput,
} from "../src/activities/daily-brief";
import type { GenerateDailyBriefInput } from "../src/workflows/daily-brief-generation-workflow";
import type { ReleaseNoteExclusion } from "../src/workflows/daily-brief-release-note-exclusions";

// Bundle the whole barrel (webpack resolves .ts internally). Same path the
// replay-validation test uses — `require.resolve` is unreliable for .ts under
// vitest, so hand a directory to the bundler.
const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "generateDailyBriefWorkflow";

// ---------------------------------------------------------------------------
// Fixtures — a story-scoped exclusion (F-123). The F-123 merged PR must be
// dropped from the release-notes set; the F-999 merged PR must survive.
// ---------------------------------------------------------------------------

const OCCURRED = new Date("2026-07-03T12:00:00.000Z");

const PR_F123: GithubItem = {
	kind: "pr_merged",
	prNumber: 101,
	repoFullName: "acme/app",
	url: "https://github.com/acme/app/pull/101",
	title: "F-123: add the widget",
	baseRef: "staging",
	occurredAt: OCCURRED,
};
const PR_F999: GithubItem = {
	kind: "pr_merged",
	prNumber: 102,
	repoFullName: "acme/app",
	url: "https://github.com/acme/app/pull/102",
	title: "F-999: unrelated change",
	baseRef: "staging",
	occurredAt: OCCURRED,
};

const STORY_F123: StoryChangeItem = {
	kind: "created",
	storyCuid: "story_cuid_1",
	storyIdentifier: "F-123",
	title: "F-123 created",
	occurredAt: OCCURRED,
};
const TASK_T1: TaskChangeItem = {
	kind: "created",
	taskCuid: "task_cuid_1",
	taskIdentifier: "T-1",
	title: "T-1 created",
	occurredAt: OCCURRED,
};

const EXCL_STORY_F123: ReleaseNoteExclusion = {
	kind: "story",
	repoFullName: null,
	prNumber: null,
	storyIdentifier: "F-123",
};
const EXCL_PR_102: ReleaseNoteExclusion = {
	kind: "pr",
	repoFullName: "acme/app",
	prNumber: 102,
	storyIdentifier: null,
};

const BASE_INPUT: GenerateDailyBriefInput = {
	briefId: "brief-1",
	projectId: "proj-1",
	organizationId: null,
	triggeredByUserId: "user-1",
	timeWindowStart: new Date("2026-07-01T00:00:00.000Z").toISOString(),
	timeWindowEnd: new Date("2026-07-08T00:00:00.000Z").toISOString(),
};

// A minimal, schema-valid DailyBriefContent the mocked summarizer returns. The
// non-empty executiveSummary makes assembleFinalBrief resolve to READY.
const SUMMARY_OUTPUT: SummarizeDailyBriefOutput = {
	content: {
		schemaVersion: 2,
		executiveSummary: "Test summary.",
		priorityActions: [],
		sections: {},
	},
	aiUsageTokens: null,
};
const RELEASE_NOTES_OUTPUT: SummarizeReleaseNotesOutput = {
	summary: { staging: "Staging blurb." },
	aiUsageTokens: null,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RunCaptures {
	result: { success: boolean; status: string };
	loadCallCount: number;
	persistInputs: PersistDailyBriefInput[];
	summarizeInputs: SummarizeDailyBriefInput[];
	releaseNotesInputs: SummarizeReleaseNotesInput[];
}

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

let taskQueueSeq = 0;

async function runGeneration(opts: {
	/** Per-CALL responses of loadReleaseNoteExclusionsActivity. Each run calls it
	 *  twice: once for the apply filter, once for the freshness re-check. */
	exclusionResponses: ReleaseNoteExclusion[][];
	github: GithubItem[];
	stories: StoryChangeItem[];
	tasks: TaskChangeItem[];
}): Promise<RunCaptures> {
	const persistInputs: PersistDailyBriefInput[] = [];
	const summarizeInputs: SummarizeDailyBriefInput[] = [];
	const releaseNotesInputs: SummarizeReleaseNotesInput[] = [];
	let loadCallCount = 0;

	const storyOut: CollectStoryActivityOutput = {
		stories: opts.stories,
		tasks: opts.tasks,
	};
	const prOut: CollectGitHubPullRequestsActivityOutput = {
		items: opts.github,
		failures: [],
		stalePrActions: [],
	};
	const releasesOut: CollectGitHubReleasesActivityOutput = {
		items: [],
		failures: [],
	};

	const activities = {
		collectGitHubReleasesActivity: async () => releasesOut,
		collectStoryActivity: async () => storyOut,
		collectDocumentChanges: async () => [],
		collectMeetingTranscripts: async () => [],
		collectTeamsProposals: async () => [],
		collectGitHubPullRequestsActivity: async () => prOut,
		collectAhead: async () => [],
		loadReleaseNoteExclusionsActivity: async () => {
			const idx = Math.min(
				loadCallCount,
				opts.exclusionResponses.length - 1,
			);
			loadCallCount += 1;
			return opts.exclusionResponses[idx] ?? [];
		},
		extractMeetingInsightsActivity: async () => ({
			insights: [],
			extractedCount: 0,
			cachedCount: 0,
		}),
		detectPriorityActionsActivity: async () => [],
		summarizeReleaseNotesActivity: async (
			input: SummarizeReleaseNotesInput,
		) => {
			releaseNotesInputs.push(input);
			return RELEASE_NOTES_OUTPUT;
		},
		summarizeDailyBriefActivity: async (
			input: SummarizeDailyBriefInput,
		) => {
			summarizeInputs.push(input);
			return SUMMARY_OUTPUT;
		},
		persistDailyBriefActivity: async (input: PersistDailyBriefInput) => {
			persistInputs.push(input);
		},
	};

	const taskQueue = `daily-brief-convergence-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});

	const result = (await worker.runUntil(
		env.client.workflow.execute(WORKFLOW_NAME, {
			args: [BASE_INPUT],
			taskQueue,
			workflowId: `${taskQueue}-wf`,
		}),
	)) as { success: boolean; status: string };

	return {
		result,
		loadCallCount,
		persistInputs,
		summarizeInputs,
		releaseNotesInputs,
	};
}

// ---------------------------------------------------------------------------
// 1 — Stable signature finalizes with no continue-as-new
// ---------------------------------------------------------------------------

describe("generateDailyBriefWorkflow — v6 exclusion convergence", () => {
	it("stable exclusion signature: finalizes in a single run (no continue-as-new)", async () => {
		const { result, loadCallCount, persistInputs } = await runGeneration({
			// Both loads return the same (empty) set → no divergence.
			exclusionResponses: [[], []],
			github: [PR_F123, PR_F999],
			stories: [STORY_F123],
			tasks: [TASK_T1],
		});

		expect(result.success).toBe(true);
		// One run only: apply-load + freshness-load = 2 calls.
		expect(loadCallCount).toBe(2);
		// Persisted exactly once with a terminal, non-FAILED status.
		expect(persistInputs).toHaveLength(1);
		expect(persistInputs[0]?.status).not.toBe("FAILED");
		expect(["READY", "EMPTY"]).toContain(persistInputs[0]?.status);
	});

	// -------------------------------------------------------------------------
	// 2 — A mid-generation change triggers exactly one continue-as-new and the
	// catch does NOT convert it into a FAILED brief (Codex-critical guard).
	// -------------------------------------------------------------------------

	it("signature changes once mid-run: exactly one continue-as-new, then converges (catch rethrows ContinueAsNew)", async () => {
		const { result, loadCallCount, persistInputs } = await runGeneration({
			// run0: apply=[] (sig ""), fresh=[F123] (sig differs) → continue-as-new
			// run1: apply=[F123], fresh=[F123] (equal) → converge + finalize
			exclusionResponses: [
				[],
				[EXCL_STORY_F123],
				[EXCL_STORY_F123],
				[EXCL_STORY_F123],
			],
			github: [PR_F123, PR_F999],
			stories: [STORY_F123],
			tasks: [TASK_T1],
		});

		// execute() follows the run chain; a RESOLVED success proves the
		// ContinueAsNew was rethrown by the catch, not persisted as FAILED.
		expect(result.success).toBe(true);
		// Two runs × two loads each.
		expect(loadCallCount).toBe(4);
		// The ONLY persist is the terminal one from the converged run — never FAILED.
		expect(persistInputs).toHaveLength(1);
		expect(persistInputs[0]?.status).not.toBe("FAILED");
	});

	// -------------------------------------------------------------------------
	// 3 — Depth 0 → 1 → 2 convergence within MAX_REGEN_CHAIN.
	// -------------------------------------------------------------------------

	it("signature changes for two consecutive runs: converges at depth 2 within the cap", async () => {
		const { result, loadCallCount, persistInputs } = await runGeneration({
			// run0: apply=[] , fresh=[F123]            → depth 1
			// run1: apply=[F123], fresh=[pr#102]       → depth 2
			// run2: apply=[pr#102], fresh=[pr#102]     → converge
			exclusionResponses: [
				[],
				[EXCL_STORY_F123],
				[EXCL_STORY_F123],
				[EXCL_PR_102],
				[EXCL_PR_102],
				[EXCL_PR_102],
			],
			github: [PR_F123, PR_F999],
			stories: [STORY_F123],
			tasks: [TASK_T1],
		});

		expect(result.success).toBe(true);
		// Three runs × two loads each = 6.
		expect(loadCallCount).toBe(6);
		expect(persistInputs).toHaveLength(1);
		expect(persistInputs[0]?.status).not.toBe("FAILED");
	});

	// -------------------------------------------------------------------------
	// 4 — Scope boundary: a story-level exclusion strips the F-123 merged PR from
	// the release-notes set BUT leaves storyChanges / taskChanges untouched.
	// -------------------------------------------------------------------------

	it("story exclusion is release-notes-scoped: filters github but passes storyChanges/taskChanges through unchanged", async () => {
		const { result, summarizeInputs, releaseNotesInputs } =
			await runGeneration({
				exclusionResponses: [[EXCL_STORY_F123], [EXCL_STORY_F123]],
				github: [PR_F123, PR_F999],
				stories: [STORY_F123],
				tasks: [TASK_T1],
			});

		expect(result.success).toBe(true);

		// The daily-brief summarizer sees the filtered github.
		const lastSummarize = summarizeInputs.at(-1);
		expect(lastSummarize).toBeDefined();
		const summarizedGithub = (lastSummarize?.sections.github ??
			[]) as GithubItem[];
		const summarizedPrNumbers = summarizedGithub
			.filter((g) => g.kind === "pr_merged")
			.map((g) => g.prNumber);
		expect(summarizedPrNumbers).toContain(102); // F-999 survives
		expect(summarizedPrNumbers).not.toContain(101); // F-123 removed

		// CRITICAL scope boundary — the story's in-progress narrative is untouched.
		// Compare against the JSON-roundtripped fixtures: Temporal's payload
		// converter serializes the activity input, so `occurredAt` Dates arrive as
		// ISO strings (the summarizer re-coerces them via z.coerce.date()). The
		// structural pass-through is what matters — the filter must not drop, add,
		// or mutate a single story/task change.
		const serialize = <T>(v: T): unknown => JSON.parse(JSON.stringify(v));
		expect(lastSummarize?.sections.storyChanges).toEqual([
			serialize(STORY_F123),
		]);
		expect(lastSummarize?.sections.taskChanges).toEqual([
			serialize(TASK_T1),
		]);

		// The release-notes summarizer likewise never sees the F-123 PR.
		const lastReleaseNotes = releaseNotesInputs.at(-1);
		expect(lastReleaseNotes).toBeDefined();
		const releaseNotesPrNumbers = [
			...(lastReleaseNotes?.prodPrs ?? []),
			...(lastReleaseNotes?.stagingPrs ?? []),
		].map((g) => g.prNumber);
		expect(releaseNotesPrNumbers).toContain(102);
		expect(releaseNotesPrNumbers).not.toContain(101);
	});
});
