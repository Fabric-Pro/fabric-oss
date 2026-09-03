/**
 * Behavioral (TestWorkflowEnvironment) tests for `publishingSuggestionWorkflow`.
 *
 * A source-scan can prove the tokens are present but CANNOT prove the outcome
 * matrix: that empty collectors terminalize INSUFFICIENT_CONTEXT, that a
 * sufficient + fresh cycle runs the summarizer and terminalizes READY, that the
 * F7 freshness gate blocks the summarizer when all qualifying content is aged,
 * and that a lost CAS (M6) returns SUPERSEDED WITHOUT calling markCycleFailed.
 * Those need a real execution.
 *
 * Mirrors `__tests__/daily-brief-workflow-convergence.test.ts`: spins up a local
 * time-skipping Temporal test server, bundles the REAL workflow code from the
 * workflows barrel, injects mocked activities, and asserts observable behavior.
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use. In a network-restricted environment
 * `beforeAll` will fail; run once online to populate the binary cache.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test publishing-suggestion-workflow
 */

import { resolve } from "node:path";
import {
	buildPublishingPreferencesSnapshot,
	type PublishingPreferencesSnapshot,
} from "@repo/database";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	PublishingSuggestionStatus,
	PublishingSuggestionWorkflowInput,
} from "../publishing-suggestion-generation-workflow";

// Bundle the whole barrel (webpack resolves .ts internally). `__dirname` is
// src/workflows/__tests__, so the barrel is one level up.
const WORKFLOWS_PATH = resolve(__dirname, "..");
const WORKFLOW_NAME = "publishingSuggestionWorkflow";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COVERED_THROUGH = "2026-07-14T00:00:00.000Z";

const BASE_INPUT: PublishingSuggestionWorkflowInput = {
	cycleId: "cycle-1",
	projectId: "proj-1",
	organizationId: null,
	tenantUserId: "user-1",
	actorUserId: "user-1",
	coveredThroughIso: COVERED_THROUGH,
	priorCoverage: {},
};

type SourceKey =
	| "stories"
	| "documents"
	| "transcripts"
	| "pullRequests"
	| "releases";

interface CollectorOutMock {
	items: unknown[];
	count: number;
	qualifyingCount: number;
	newestQualifyingIso: string | null;
	capExhausted: boolean;
	failures: unknown[];
}

const EMPTY: CollectorOutMock = {
	items: [],
	count: 0,
	qualifyingCount: 0,
	newestQualifyingIso: null,
	capExhausted: false,
	failures: [],
};

interface PersistInput {
	cycleId: string;
	kind: "SUGGESTIONS" | "INSUFFICIENT_CONTEXT";
	topics: unknown[];
	sourceCoverage: Record<string, string>;
	// 1C-2b: set from patched("publishing-1c-notify-v1"). Optional here on
	// purpose — the INSUFFICIENT_CONTEXT persist must not pass it at all.
	activateNotificationLifecycle?: boolean;
	// 1C-1b: the preferences snapshot the workflow forwards from its input.
	// Optional so the "an old history carries none" case can assert on its
	// ABSENCE rather than on an explicit undefined the writer would still see.
	preferences?: PublishingPreferencesSnapshot;
}

interface PersistResult {
	persisted: boolean;
	status: "READY" | "NO_TOPICS" | "INSUFFICIENT_CONTEXT";
}

function defaultPersist(input: PersistInput): PersistResult {
	if (input.kind === "INSUFFICIENT_CONTEXT") {
		return { persisted: true, status: "INSUFFICIENT_CONTEXT" };
	}
	return {
		persisted: true,
		status: input.topics.length > 0 ? "READY" : "NO_TOPICS",
	};
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ComputedTopic {
	title: string;
	dedupeKey: string;
	contributorUserIds: string[];
	[key: string]: unknown;
}

interface RunOpts {
	collectors?: Partial<Record<SourceKey, CollectorOutMock>>;
	topics?: { title: string; pitch: string; provenance: unknown }[];
	persist?: (input: PersistInput) => PersistResult;
	priorCoverage?: PublishingSuggestionWorkflowInput["priorCoverage"];
	// Phase 1B Task 8: override the (otherwise identity) resolveTopicContributors
	// mock to prove the workflow actually threads its output into persist.
	resolveContributors?: (topics: ComputedTopic[]) => ComputedTopic[];
	// 1C-1: per-project lookback override and the manual "Generate now" force flag.
	lookbackDays?: number;
	force?: boolean;
	// 1C-1b: the preferences snapshot dispatch captured, forwarded verbatim.
	preferences?: PublishingPreferencesSnapshot;
	/**
	 * Simulate a pre-1C-1b-part-2 activity worker: one that accepts the
	 * `preferences` field, ignores it, and returns a payload with no
	 * `preferencesRead` key. This is the shape a rolling deploy puts on the
	 * task queue, and the only way to reach the branch that withholds the
	 * hash.
	 */
	staleSummarizeWorker?: boolean;
	// 1C-1: observes the windowStart each collector call receives, proving the
	// configured lookbackDays actually reaches the collection boundary.
	onCollect?: (args: { windowStart: string }) => void;
	// 1C-2b: the notification activity's behaviour. Receives the 1-based attempt
	// number so a test can distinguish "always rejects" from "times out".
	notify?: (attempt: number) => Promise<void>;
	// 1C-3b: the chat broadcast activity's behaviour, same shape as `notify`.
	chat?: (attempt: number) => Promise<void>;
	// 1C-2b: fired the moment the WORKFLOW settles, which is strictly before
	// `runWorkflow` returns — `worker.runUntil` still has to drain outstanding
	// activities after that. A test whose activity is deliberately still hanging
	// uses this to release it: without a hook at this exact point there is no
	// way to release it late enough to be sure it was not the cause of the
	// failure, yet early enough not to stall shutdown.
	onWorkflowSettled?: () => void;
}

interface RunCaptures {
	result: { status: PublishingSuggestionStatus };
	summarizeCount: number;
	// 1C-1b part 2: the argument object each summarize call received.
	summarizeInputs: Record<string, unknown>[];
	markFailedCount: number;
	resolveContributorsCount: number;
	persistInputs: PersistInput[];
	notifyAttempts: number;
	chatAttempts: number;
	notificationOutcome: NotificationOutcome;
	workflowSettledAfterMs: number | null;
}

/**
 * 1C-2b: a deliberately small model of the cycle's notification lifecycle
 * column, so "the outcome is left at PENDING" is an assertion about state
 * rather than about a mock never having been called.
 *
 * It mirrors the two real writers and nothing else:
 *   - persistCycleTerminal moves NOT_APPLICABLE -> PENDING, but only when the
 *     workflow asked for activation AND the cycle actually reached READY (the
 *     `status === "READY"` gate lives in the real helper too);
 *   - the notification activity is the only thing that terminalizes it, and
 *     only when it COMPLETES. An attempt that rejects or times out writes
 *     nothing, which is the whole point of the assertion.
 */
type NotificationOutcome = "NOT_APPLICABLE" | "PENDING" | "SENT";

interface MarkFailedCall {
	cycleId: string;
	projectId: string;
}

// External capture bag: when the workflow run THROWS, `runWorkflow`'s promise
// rejects before it can return a `RunCaptures`, so its local counters would
// otherwise be unreachable. Passing a `CaptureState` in lets a caller inspect
// activity call state (e.g. markCycleFailed) even after catching a rejection.
interface CaptureState {
	summarizeCount: number;
	// 1C-1b part 2: the ARGUMENT object each summarize call received, so a test
	// can assert on the ABSENCE of `preferences` (an old history) as well as on
	// its presence. A boolean would collapse those two into one.
	summarizeInputs: Record<string, unknown>[];
	markFailedCount: number;
	resolveContributorsCount: number;
	persistInputs: PersistInput[];
	markFailedCalls: MarkFailedCall[];
	// 1C-2b. `notifyAttempts` counts ATTEMPTS, not calls: every Temporal retry
	// increments it, which is what makes the retry ceiling observable.
	notifyAttempts: number;
	// 1C-3b, counted the same way and for the same reason: every Temporal retry
	// increments it, which is what makes the chat proxy's retry ceiling — and its
	// deliberate difference from the notify proxy's — observable.
	chatAttempts: number;
	notificationOutcome: NotificationOutcome;
	// Wall-clock ms from the start of the run to the moment the WORKFLOW settled
	// — deliberately not to the moment `runWorkflow` returned, which also
	// includes draining any still-running activity.
	workflowSettledAfterMs: number | null;
}

function emptyCaptureState(): CaptureState {
	return {
		summarizeCount: 0,
		summarizeInputs: [],
		markFailedCount: 0,
		resolveContributorsCount: 0,
		persistInputs: [],
		markFailedCalls: [],
		notifyAttempts: 0,
		chatAttempts: 0,
		notificationOutcome: "NOT_APPLICABLE",
		workflowSettledAfterMs: null,
	};
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

async function runWorkflow(
	opts: RunOpts = {},
	captures?: CaptureState,
): Promise<RunCaptures> {
	const state: CaptureState = captures ?? emptyCaptureState();

	const collect =
		(key: SourceKey) => async (args: { windowStart: string }) => {
			opts.onCollect?.(args);
			return opts.collectors?.[key] ?? EMPTY;
		};

	const activities = {
		assertProjectTenantTuple: async () => {},
		collectStories: collect("stories"),
		collectDocuments: collect("documents"),
		collectTranscripts: collect("transcripts"),
		collectPullRequests: collect("pullRequests"),
		collectReleases: collect("releases"),
		summarizeTopicSuggestions: async (args: Record<string, unknown>) => {
			state.summarizeCount += 1;
			state.summarizeInputs.push(args);
			return {
				topics: opts.topics ?? [],
				aiUsageTokens: null,
				// The capability echo a current worker sends. Omitted — not set
				// false — when simulating an old one, because ABSENCE is what the
				// workflow actually keys on.
				...(opts.staleSummarizeWorker ? {} : { preferencesRead: true }),
			};
		},
		computeSuggestionTopics: async (args: {
			projectId: string;
			topics: { title: string; pitch: string; provenance: unknown }[];
		}) => ({
			topics: args.topics.map((t) => ({
				...t,
				dedupeKey: `dedupe-${t.title}`,
				contributorUserIds: [], // seeded [] by the real activity (Task 4)
			})),
		}),
		resolveTopicContributors: async (args: {
			tenant: unknown;
			topics: ComputedTopic[];
		}) => {
			state.resolveContributorsCount += 1;
			return {
				topics: (opts.resolveContributors ?? ((t) => t))(args.topics),
			};
		},
		persistCycleTerminal: async (input: PersistInput) => {
			state.persistInputs.push(input);
			const result = (opts.persist ?? defaultPersist)(input);
			// Mirrors the real helper: the lifecycle is entered in the SAME
			// transaction that makes the cycle READY, and only when the workflow
			// asked for it.
			if (
				input.activateNotificationLifecycle === true &&
				result.persisted &&
				result.status === "READY"
			) {
				state.notificationOutcome = "PENDING";
			}
			return result;
		},
		notifyPublishingTopicsReady: async () => {
			state.notifyAttempts += 1;
			if (opts.notify) {
				await opts.notify(state.notifyAttempts);
			}
			// Only a COMPLETED attempt terminalizes the outcome.
			state.notificationOutcome = "SENT";
		},
		// 1C-3b. Note what it does NOT touch: `notificationOutcome`. FR18 makes
		// the cycle's outcome a statement about the ADDRESSED channels, so a
		// broadcast that succeeds or fails must leave it exactly as the notify
		// step left it — which is what the isolation cases below assert.
		broadcastPublishingTopicsToChat: async () => {
			state.chatAttempts += 1;
			if (opts.chat) {
				await opts.chat(state.chatAttempts);
			}
			return {
				targetCount: 0,
				sentCount: 0,
				failedCount: 0,
				skippedCount: 0,
			};
		},
		markCycleFailed: async (cycleId: string, projectId: string) => {
			state.markFailedCount += 1;
			state.markFailedCalls.push({ cycleId, projectId });
		},
	};

	const taskQueue = `publishing-suggestion-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});

	const input: PublishingSuggestionWorkflowInput = {
		...BASE_INPUT,
		priorCoverage: opts.priorCoverage ?? BASE_INPUT.priorCoverage,
		...(opts.lookbackDays != null && { lookbackDays: opts.lookbackDays }),
		...(opts.force === true && { force: true }),
		...(opts.preferences && { preferences: opts.preferences }),
	};

	const startedAtMs = Date.now();
	const onSettled = () => {
		state.workflowSettledAfterMs = Date.now() - startedAtMs;
		opts.onWorkflowSettled?.();
	};
	const result = (await worker.runUntil(
		env.client.workflow
			.execute(WORKFLOW_NAME, {
				args: [input],
				taskQueue,
				workflowId: `${taskQueue}-wf`,
			})
			.then(
				(value) => {
					onSettled();
					return value;
				},
				(error) => {
					onSettled();
					throw error;
				},
			),
	)) as { status: PublishingSuggestionStatus };

	return {
		result,
		summarizeCount: state.summarizeCount,
		summarizeInputs: state.summarizeInputs,
		markFailedCount: state.markFailedCount,
		resolveContributorsCount: state.resolveContributorsCount,
		persistInputs: state.persistInputs,
		notifyAttempts: state.notifyAttempts,
		chatAttempts: state.chatAttempts,
		notificationOutcome: state.notificationOutcome,
		workflowSettledAfterMs: state.workflowSettledAfterMs,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("publishingSuggestionWorkflow — outcome matrix", () => {
	it("empty collectors → INSUFFICIENT_CONTEXT and never summarizes", async () => {
		const { result, summarizeCount, markFailedCount } = await runWorkflow();

		expect(result.status).toBe("INSUFFICIENT_CONTEXT");
		expect(summarizeCount).toBe(0);
		expect(markFailedCount).toBe(0);
	});

	it("sufficient + fresh qualifying content + 1 topic → READY", async () => {
		const { result, summarizeCount, persistInputs } = await runWorkflow({
			collectors: {
				transcripts: {
					...EMPTY,
					qualifyingCount: 1,
					newestQualifyingIso: "2026-07-10T00:00:00.000Z",
				},
			},
			topics: [{ title: "Ship it", pitch: "A pitch.", provenance: {} }],
		});

		expect(result.status).toBe("READY");
		expect(summarizeCount).toBe(1);
		// SUGGESTIONS branch commits the advanced coverage for the succeeded source.
		const suggestPersist = persistInputs.find(
			(p) => p.kind === "SUGGESTIONS",
		);
		expect(suggestPersist?.sourceCoverage.transcripts).toBe(
			COVERED_THROUGH,
		);
	});

	it("F7: sufficient but every qualifier ≤ priorCoverage → INSUFFICIENT_CONTEXT and never summarizes", async () => {
		const { result, summarizeCount, persistInputs } = await runWorkflow({
			collectors: {
				transcripts: {
					...EMPTY,
					qualifyingCount: 1,
					// Aged relative to the prior watermark below.
					newestQualifyingIso: "2026-07-10T00:00:00.000Z",
				},
			},
			priorCoverage: { transcripts: "2026-07-20T00:00:00.000Z" },
		});

		expect(result.status).toBe("INSUFFICIENT_CONTEXT");
		expect(summarizeCount).toBe(0);
		// INSUFFICIENT persists NO coverage (P5).
		const insuffPersist = persistInputs.find(
			(p) => p.kind === "INSUFFICIENT_CONTEXT",
		);
		expect(insuffPersist?.sourceCoverage).toEqual({});
	});

	it("M6: CAS-loss on the INSUFFICIENT branch → SUPERSEDED, no markCycleFailed", async () => {
		const { result, markFailedCount } = await runWorkflow({
			// All empty → INSUFFICIENT branch; persist reports the CAS lost.
			persist: () => ({
				persisted: false,
				status: "INSUFFICIENT_CONTEXT",
			}),
		});

		expect(result.status).toBe("SUPERSEDED");
		expect(markFailedCount).toBe(0);
	});

	it("M6: CAS-loss on the SUGGESTIONS branch → SUPERSEDED, no markCycleFailed", async () => {
		const { result, summarizeCount, markFailedCount } = await runWorkflow({
			collectors: {
				transcripts: {
					...EMPTY,
					qualifyingCount: 1,
					newestQualifyingIso: "2026-07-10T00:00:00.000Z",
				},
			},
			topics: [{ title: "Ship it", pitch: "A pitch.", provenance: {} }],
			// SUGGESTIONS-branch tx lost the CAS (reclaimed) → persisted:false.
			persist: () => ({ persisted: false, status: "NO_TOPICS" }),
		});

		expect(result.status).toBe("SUPERSEDED");
		// The summarizer DID run — only the terminal persist lost the CAS.
		expect(summarizeCount).toBe(1);
		expect(markFailedCount).toBe(0);
	});

	it("all 5 collectors fail → workflow throws PUBLISHING_ALL_SOURCES_FAILED and markCycleFailed runs exactly once", async () => {
		// F5/M6 heart: nothing above ever asserts markFailedCount === 1, so a
		// regression that stopped calling markCycleFailed on a thrown error would
		// pass every other scenario green. Drive succeeded.size === 0 by making
		// every collector capExhausted (no reject/`failures[]` plumbing needed).
		const captures: CaptureState = emptyCaptureState();

		await expect(
			runWorkflow(
				{
					collectors: {
						stories: { ...EMPTY, capExhausted: true },
						documents: { ...EMPTY, capExhausted: true },
						transcripts: { ...EMPTY, capExhausted: true },
						pullRequests: { ...EMPTY, capExhausted: true },
						releases: { ...EMPTY, capExhausted: true },
					},
				},
				captures,
			),
		).rejects.toThrow();

		expect(captures.markFailedCount).toBe(1);
		expect(captures.markFailedCalls).toEqual([
			{ cycleId: BASE_INPUT.cycleId, projectId: BASE_INPUT.projectId },
		]);
		expect(captures.summarizeCount).toBe(0);
	});

	it("persistCycleTerminal throws a non-CAS-lost error on the SUGGESTIONS path → workflow throws and markCycleFailed runs exactly once", async () => {
		const captures: CaptureState = emptyCaptureState();

		await expect(
			runWorkflow(
				{
					collectors: {
						transcripts: {
							...EMPTY,
							qualifyingCount: 1,
							newestQualifyingIso: "2026-07-10T00:00:00.000Z",
						},
					},
					topics: [
						{ title: "Ship it", pitch: "A pitch.", provenance: {} },
					],
					persist: () => {
						throw new Error("db connection reset");
					},
				},
				captures,
			),
		).rejects.toThrow();

		expect(captures.markFailedCount).toBe(1);
		expect(captures.markFailedCalls).toEqual([
			{ cycleId: BASE_INPUT.cycleId, projectId: BASE_INPUT.projectId },
		]);
		// The summarizer DID run — the terminal persist is what threw.
		expect(captures.summarizeCount).toBe(1);
	});

	it("Phase 1B Task 8: resolves contributors between compute and persist", async () => {
		const { resolveContributorsCount, persistInputs } = await runWorkflow({
			collectors: {
				transcripts: {
					...EMPTY,
					qualifyingCount: 1,
					newestQualifyingIso: "2026-07-10T00:00:00.000Z",
				},
			},
			topics: [{ title: "Ship it", pitch: "A pitch.", provenance: {} }],
			// computeSuggestionTopics seeds contributorUserIds: [] (Task 4);
			// resolveTopicContributors (Task 5) is the only activity that can
			// populate it — prove the workflow actually calls it and threads its
			// output (not compute's) into persistCycleTerminal.
			resolveContributors: (topics) =>
				topics.map((t) => ({ ...t, contributorUserIds: ["u1"] })),
		});

		expect(resolveContributorsCount).toBe(1);
		const suggestPersist = persistInputs.find(
			(p) => p.kind === "SUGGESTIONS",
		);
		expect(
			(suggestPersist?.topics[0] as ComputedTopic).contributorUserIds,
		).toEqual(["u1"]);
	});

	it("uses a configured lookbackDays instead of the 180-day default", async () => {
		let seenWindowStart: string | undefined;
		const { result } = await runWorkflow({
			lookbackDays: 30,
			collectors: {
				transcripts: {
					...EMPTY,
					qualifyingCount: 1,
					newestQualifyingIso: "2026-07-10T00:00:00.000Z",
				},
			},
			topics: [{ title: "Ship it", pitch: "A pitch.", provenance: {} }],
			onCollect: (args: { windowStart: string }) => {
				seenWindowStart = args.windowStart;
			},
		});

		expect(result.status).toBe("READY");
		// coveredThrough is 2026-07-14T00:00:00.000Z; 30 days back is 2026-06-14.
		expect(seenWindowStart).toBe("2026-06-14T00:00:00.000Z");
	});

	// Guard for old-history replay: every pre-1C-1 execution recorded its
	// command history with lookbackDays absent from the input. The workflow is
	// safe today only because an omitted lookbackDays still resolves to the
	// 180-day WINDOW_DAYS default through the identity clamp — nothing above
	// asserts that, since the only other onCollect case always passes an
	// explicit lookbackDays. A future edit to the fallback (e.g. `?? 90`) or to
	// the clamp so it stops being an identity at the default would leave every
	// other test green while silently changing the window an already-running
	// (old-payload) execution replays with. Do not delete this as redundant
	// with the lookbackDays: 30 case — that case can never catch this.
	it("pins the 180-day default window when lookbackDays is omitted", async () => {
		let seenWindowStart: string | undefined;
		const { result } = await runWorkflow({
			collectors: {
				transcripts: {
					...EMPTY,
					qualifyingCount: 1,
					newestQualifyingIso: "2026-07-10T00:00:00.000Z",
				},
			},
			topics: [{ title: "Ship it", pitch: "A pitch.", provenance: {} }],
			onCollect: (args: { windowStart: string }) => {
				seenWindowStart = args.windowStart;
			},
		});

		expect(result.status).toBe("READY");
		// coveredThrough is 2026-07-14T00:00:00.000Z; 180 days back is 2026-01-15.
		expect(seenWindowStart).toBe("2026-01-15T00:00:00.000Z");
	});

	it("force skips the freshness gate but NOT the sufficiency thresholds", async () => {
		// Aged content only: newestQualifyingIso is NOT newer than priorCoverage,
		// so the freshness gate would normally stop this before the summarizer.
		const aged = {
			...EMPTY,
			qualifyingCount: 1,
			newestQualifyingIso: "2026-07-01T00:00:00.000Z",
		};
		const priorCoverage = { transcripts: "2026-07-05T00:00:00.000Z" };

		const forced = await runWorkflow({
			force: true,
			priorCoverage,
			collectors: { transcripts: aged },
			topics: [{ title: "Forced", pitch: "A pitch.", provenance: {} }],
		});
		expect(forced.result.status).toBe("READY");
		expect(forced.summarizeCount).toBe(1);

		// Same input WITHOUT force is still blocked — proves the gate exists.
		const unforced = await runWorkflow({
			priorCoverage,
			collectors: { transcripts: aged },
			topics: [{ title: "Forced", pitch: "A pitch.", provenance: {} }],
		});
		expect(unforced.result.status).toBe("INSUFFICIENT_CONTEXT");
		expect(unforced.summarizeCount).toBe(0);

		// force must NOT manufacture sufficiency out of nothing.
		const empty = await runWorkflow({ force: true });
		expect(empty.result.status).toBe("INSUFFICIENT_CONTEXT");
		expect(empty.summarizeCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 1C-2b: the contributor notification step
// ---------------------------------------------------------------------------

/**
 * These all run as FRESH executions, so `patched("publishing-1c-notify-v1")`
 * returns true in every one of them. That is a hard limit of this harness: it
 * can prove what the patched branch DOES, and it cannot prove what an old
 * history replays as, because there is no old history here to replay. Only
 * `.github/workflows/temporal-replay-validation.yml` — which replays real
 * recorded histories against this workflow code — can prove that, and it needs
 * TEMPORAL_* credentials against the dev namespace.
 */
describe("publishingSuggestionWorkflow — 1C-2b notification step", () => {
	const READY_RUN: RunOpts = {
		collectors: {
			transcripts: {
				...EMPTY,
				qualifyingCount: 1,
				newestQualifyingIso: "2026-07-10T00:00:00.000Z",
			},
		},
		topics: [{ title: "Ship it", pitch: "A pitch.", provenance: {} }],
	};

	it("READY → notifies exactly once and terminalizes the outcome", async () => {
		const { result, notifyAttempts, notificationOutcome, markFailedCount } =
			await runWorkflow(READY_RUN);

		expect(result.status).toBe("READY");
		expect(notifyAttempts).toBe(1);
		expect(notificationOutcome).toBe("SENT");
		expect(markFailedCount).toBe(0);
	});

	// -----------------------------------------------------------------------
	// 1C-3b: the chat broadcast step. Same harness limit as the block above —
	// every execution here is fresh, so `patched("publishing-1c3-chat-v1")` is
	// always true and what an OLD history replays as is only provable by
	// temporal-replay-validation.yml against real recorded histories.
	// -----------------------------------------------------------------------

	it("READY → broadcasts to chat exactly once", async () => {
		const { result, chatAttempts } = await runWorkflow(READY_RUN);

		expect(result.status).toBe("READY");
		expect(chatAttempts).toBe(1);
	});

	it("INSUFFICIENT_CONTEXT → never broadcasts", async () => {
		const { result, chatAttempts } = await runWorkflow();

		expect(result.status).toBe("INSUFFICIENT_CONTEXT");
		expect(chatAttempts).toBe(0);
	});

	it("SUPERSEDED → never broadcasts even though the status is READY", async () => {
		// Same sharp case as the notify block's: persist reports READY but the
		// compare-and-swap was LOST, so this run does not own the cycle and must
		// not announce its topics to a room.
		const { result, chatAttempts } = await runWorkflow({
			...READY_RUN,
			persist: () => ({ persisted: false, status: "READY" }),
		});

		expect(result.status).toBe("SUPERSEDED");
		expect(chatAttempts).toBe(0);
	});

	// FR18 stated as a test rather than as prose, and the case the whole
	// isolation argument exists for.
	it("chat retry exhaustion → cycle stays READY, outcome untouched, no failure path", async () => {
		const { result, chatAttempts, markFailedCount, notificationOutcome } =
			await runWorkflow({
				...READY_RUN,
				chat: async () => {
					throw new Error("chat is down");
				},
			});

		expect(result.status).toBe("READY");
		// The inner try/catch is what keeps this at 0: without it the workflow-wide
		// catch would run markCycleFailed and rethrow, leaving a READY cycle
		// attached to a FAILED workflow.
		expect(markFailedCount).toBe(0);
		// Bounded, and deliberately SMALLER than the notify proxy's 5: chat never
		// re-posts, so extra attempts can only help a target with no ledger row.
		expect(chatAttempts).toBe(3);
		// The addressed channels succeeded, so the outcome says so. A chat outage
		// must not downgrade it.
		expect(notificationOutcome).toBe("SENT");
	}, 60_000);

	// Independence in BOTH directions. The interesting direction to a reader who
	// has just read FR18 is the one above; this is the other one, and without it
	// an implementation that nested the chat call inside the notify try-block
	// would pass every case above.
	it("still broadcasts when the notify step exhausts its retries", async () => {
		const { result, chatAttempts, notificationOutcome } = await runWorkflow(
			{
				...READY_RUN,
				notify: async () => {
					throw new Error("in-app delivery unavailable");
				},
			},
		);

		expect(result.status).toBe("READY");
		expect(chatAttempts).toBe(1);
		expect(notificationOutcome).toBe("PENDING");
	}, 60_000);

	it("patched path passes activateNotificationLifecycle: true to the SUGGESTIONS persist", async () => {
		const { persistInputs } = await runWorkflow(READY_RUN);

		const suggestPersist = persistInputs.find(
			(p) => p.kind === "SUGGESTIONS",
		);
		expect(suggestPersist?.activateNotificationLifecycle).toBe(true);
		// The KEY, not just the value. The field is built by a conditional spread
		// so an old history replays the payload it recorded (no key at all); this
		// asserts the on-branch really does put the key there, which is the half
		// of that property this harness can reach. The off branch is asserted in
		// __tests__/publishing-suggestion-notify-activation.test.ts, because every
		// execution here is fresh and `patched()` is therefore always true.
		expect(
			Object.hasOwn(
				suggestPersist as object,
				"activateNotificationLifecycle",
			),
		).toBe(true);
	});

	it("NO_TOPICS → never notifies", async () => {
		// Sufficient + fresh so the SUGGESTIONS branch is reached, but the
		// summarizer produces nothing, so the persist terminalizes NO_TOPICS.
		const { result, notifyAttempts, notificationOutcome } =
			await runWorkflow({
				...READY_RUN,
				topics: [],
			});

		expect(result.status).toBe("NO_TOPICS");
		expect(notifyAttempts).toBe(0);
		// A NO_TOPICS cycle never enters the lifecycle, even though the workflow
		// asked for activation — the READY gate is what stops it.
		expect(notificationOutcome).toBe("NOT_APPLICABLE");
	});

	it("INSUFFICIENT_CONTEXT → never notifies, and that persist is not asked to activate", async () => {
		const { result, notifyAttempts, persistInputs } = await runWorkflow();

		expect(result.status).toBe("INSUFFICIENT_CONTEXT");
		expect(notifyAttempts).toBe(0);
		// Step 2's explicit rule: the INSUFFICIENT_CONTEXT branch never notifies,
		// so activating it would enter a cycle into a lifecycle nothing resolves.
		const insuffPersist = persistInputs.find(
			(p) => p.kind === "INSUFFICIENT_CONTEXT",
		);
		expect(insuffPersist).toBeDefined();
		expect(insuffPersist?.activateNotificationLifecycle).toBeUndefined();
	});

	it("SUPERSEDED → never notifies even though the status is READY", async () => {
		// The sharp case: persist reports status READY but a LOST compare-and-swap
		// (persisted:false). Gating on `status === READY` alone would notify for a
		// cycle this run does not own.
		const { result, notifyAttempts, notificationOutcome, markFailedCount } =
			await runWorkflow({
				...READY_RUN,
				persist: () => ({ persisted: false, status: "READY" }),
			});

		expect(result.status).toBe("SUPERSEDED");
		expect(notifyAttempts).toBe(0);
		expect(notificationOutcome).toBe("NOT_APPLICABLE");
		expect(markFailedCount).toBe(0);
	});

	it("retry exhaustion → workflow COMPLETES READY, cycle stays READY, outcome left PENDING", async () => {
		// The inner try/catch is structural, not positional: this call sits inside
		// the workflow-wide try whose catch runs markCycleFailed and RETHROWS.
		// Without the inner catch this run would fail the workflow while leaving a
		// READY cycle behind, so `markFailedCount === 0` is the assertion that
		// actually pins the isolation.
		const { result, notifyAttempts, notificationOutcome, markFailedCount } =
			await runWorkflow({
				...READY_RUN,
				notify: async () => {
					throw new Error("in-app delivery unavailable");
				},
			});

		expect(result.status).toBe("READY");
		expect(markFailedCount).toBe(0);
		// Bounded, not infinite: maximumAttempts is 5.
		expect(notifyAttempts).toBe(5);
		// Nothing terminalized the outcome — the unresolved PENDING row is the
		// operator-visible residue 1C-2d's sweep reads.
		expect(notificationOutcome).toBe("PENDING");
	}, 60_000);

	it("activity TIMEOUT exhausts the budget → workflow COMPLETES READY, cycle stays READY, outcome left PENDING", async () => {
		// A DIFFERENT path from rejection: the failure that finally exhausts the
		// budget here is a server-generated START_TO_CLOSE timeout, so the workflow
		// receives an ActivityFailure whose cause is a TimeoutFailure rather than an
		// ApplicationFailure. The catch above is unfiltered, which is exactly the
		// property under test — narrow it to `instanceof ApplicationFailure` later
		// and the rejection test stays green while this one fails, with the
		// timed-out run escaping into the outer catch and running markCycleFailed
		// against a READY cycle.
		//
		// COST NOTE, and why the shape is what it is. The time-skipping test server
		// does NOT skip time while an activity task is outstanding (verified: a
		// never-settling attempt burns real wall-clock), so every attempt that must
		// actually time out costs a real minute. Only the LAST attempt is made to
		// hang; the first four reject immediately. That buys a genuine timeout as
		// the terminal failure for the price of one deadline instead of five.
		//
		// TWO discriminators, and both are needed to stop this test quietly
		// degrading into a second copy of the rejection test:
		//
		//   1. The hang is released ONLY once the workflow has already settled, so
		//      the orphaned attempt provably cannot be what failed it. The failure
		//      that exhausted the budget therefore came from the server, and a
		//      start-to-close timeout is the only thing the server had to give.
		//   2. The workflow settled more than a deadline's worth of wall clock
		//      after the run began. Had attempt 5 rejected like the others, the
		//      whole run would have finished in about a second. This is measured to
		//      the WORKFLOW settling, never to `runWorkflow` returning — the latter
		//      also waits for the orphan to drain and so would be satisfied by the
		//      release itself, which is exactly the false pass to avoid.
		//
		// The orphan outliving its own deadline is not an artifact of the test; it
		// is the real hazard. A start-to-close timeout does NOT stop the attempt
		// that timed out, which is why the activity and its ledger are idempotent
		// and why the attempt budget is bounded.
		let releaseOrphan: (() => void) | undefined;

		const {
			result,
			notifyAttempts,
			notificationOutcome,
			markFailedCount,
			workflowSettledAfterMs,
		} = await runWorkflow({
			...READY_RUN,
			onWorkflowSettled: () => releaseOrphan?.(),
			notify: (attempt) => {
				if (attempt < 5) {
					return Promise.reject(
						new Error("in-app delivery unavailable"),
					);
				}
				return new Promise<void>((_, rejectPromise) => {
					releaseOrphan = () =>
						rejectPromise(
							new Error(
								"orphaned attempt released after the workflow had already settled",
							),
						);
				});
			},
		});

		expect(result.status).toBe("READY");
		expect(markFailedCount).toBe(0);
		expect(notifyAttempts).toBe(5);
		expect(notificationOutcome).toBe("PENDING");
		expect(workflowSettledAfterMs).toBeGreaterThan(55_000);
	}, 300_000);

	// -----------------------------------------------------------------------
	// 1C-1b: the preferences snapshot rides through to the terminal writer.
	// -----------------------------------------------------------------------

	const PREFS: PublishingPreferencesSnapshot = {
		lookbackDays: 30,
		preferredThemes: [],
		excludedKeywords: [],
		preferredPostTypes: [],
		strategicPriorities: null,
	};

	it("passes the preferences snapshot through to the success terminal", async () => {
		const { persistInputs } = await runWorkflow({
			preferences: PREFS,
			collectors: {
				transcripts: {
					...EMPTY,
					qualifyingCount: 1,
					newestQualifyingIso: "2026-07-10T00:00:00.000Z",
				},
			},
			topics: [{ title: "t", pitch: "p", provenance: {} }],
		});

		const persist = persistInputs.find((p) => p.kind === "SUGGESTIONS");
		expect(persist?.preferences).toEqual(PREFS);
	});

	it("passes the preferences snapshot through to the INSUFFICIENT_CONTEXT terminal", async () => {
		// The insufficient path is the one § 7.1 singles out: a clean
		// INSUFFICIENT_CONTEXT counts as a run for cadence, so if it did not
		// carry the snapshot, a preference change on a content-poor project would
		// show a mismatch at every later due date and never settle.
		const { persistInputs } = await runWorkflow({ preferences: PREFS });

		expect(persistInputs[0]?.kind).toBe("INSUFFICIENT_CONTEXT");
		expect(persistInputs[0]?.preferences).toEqual(PREFS);
	});

	it("omits the field entirely when the input carries no preferences", async () => {
		// An old history replays with it absent. Sending `undefined` explicitly
		// is fine; sending `null` would reach a writer that expects an object.
		const { persistInputs } = await runWorkflow({
			collectors: {
				transcripts: {
					...EMPTY,
					qualifyingCount: 1,
					newestQualifyingIso: "2026-07-10T00:00:00.000Z",
				},
			},
			topics: [{ title: "t", pitch: "p", provenance: {} }],
		});

		const persist = persistInputs.find((p) => p.kind === "SUGGESTIONS");
		expect(persist?.preferences).toBeUndefined();
	});

	it("withholds the hash when the summarize activity never confirmed it read the preferences", async () => {
		// The rolling-deploy hole, raised in adversarial review. The hash is
		// written from the WORKFLOW's input, so on its own it records what the
		// dispatcher intended rather than what ran. An old activity worker on the
		// same task queue accepts the `preferences` field, ignores it, and builds
		// the old prompt — and before the capability echo the cycle was still
		// stamped with that hash, so the next dispatch saw no change and never
		// fired the corrective run. The edit was swallowed until preferences
		// changed again.
		//
		// Recording NO hash is what makes this self-healing: the reader treats a
		// null hash on the newest counted cycle as a mismatch, so the next
		// dispatch regenerates on its own.
		const { persistInputs } = await runWorkflow({
			preferences: PREFS,
			staleSummarizeWorker: true,
			collectors: {
				transcripts: {
					...EMPTY,
					qualifyingCount: 1,
					newestQualifyingIso: "2026-07-10T00:00:00.000Z",
				},
			},
			topics: [{ title: "t", pitch: "p", provenance: {} }],
		});

		const persist = persistInputs.find((p) => p.kind === "SUGGESTIONS");
		// The cycle still persists — the run produced real topics and throwing
		// them away would be a far worse trade than one extra generation.
		expect(persist).toBeDefined();
		expect(persist).not.toHaveProperty("preferences");
	});

	it("still records the hash on the INSUFFICIENT_CONTEXT terminal, which never summarizes at all", async () => {
		// The confirmation gate is deliberately NOT applied to this path, and
		// this case is what keeps a later editor from "tidying up" by applying it
		// to both. That path never calls the summarize activity, so there is no
		// prompt for a stale worker to get wrong and the hash is honest on every
		// worker version. Gating it here would withhold the hash on every
		// content-poor cycle and buy that project a pointless regeneration at
		// every due date forever — a clean INSUFFICIENT_CONTEXT counts as a run.
		const { persistInputs } = await runWorkflow({
			preferences: PREFS,
			staleSummarizeWorker: true,
		});

		expect(persistInputs[0]?.kind).toBe("INSUFFICIENT_CONTEXT");
		expect(persistInputs[0]?.preferences).toEqual(PREFS);
	});
});

/**
 * 1C-1b part 2 (§7.1(a)): the snapshot also reaches SUMMARIZATION, not just the
 * terminal writer.
 *
 * The fingerprint slice already forwards `preferences` to `persistCycleTerminal`
 * so the cycle records what it ran with. This half forwards the same object to
 * `summarizeTopicSuggestions` so the prompt is built from it — one snapshot
 * driving both, rather than the prompt re-reading settings at a different
 * instant and disagreeing with the hash stored beside it.
 */
describe("preferences reach the summarize activity", () => {
	it("forwards the snapshot from workflow input", async () => {
		const preferences = buildPublishingPreferencesSnapshot({
			preferredThemes: ["Developer Experience"],
		});

		const { summarizeInputs } = await runWorkflow({
			collectors: {
				transcripts: {
					...EMPTY,
					qualifyingCount: 1,
					newestQualifyingIso: "2026-07-10T00:00:00.000Z",
				},
			},
			topics: [{ title: "Ship it", pitch: "A pitch.", provenance: {} }],
			preferences,
		});

		expect(summarizeInputs).toHaveLength(1);
		expect(summarizeInputs[0]?.preferences).toEqual(preferences);
	});

	it("sends no preferences field at all for an old history that carries none", async () => {
		// Asserted as ABSENT rather than as undefined. A workflow started before
		// this slice forwards nothing, and the activity's own tests pin that this
		// produces a byte-identical prompt — but only if the field is genuinely
		// missing rather than present-and-undefined.
		const { summarizeInputs } = await runWorkflow({
			collectors: {
				transcripts: {
					...EMPTY,
					qualifyingCount: 1,
					newestQualifyingIso: "2026-07-10T00:00:00.000Z",
				},
			},
			topics: [{ title: "Ship it", pitch: "A pitch.", provenance: {} }],
		});

		expect(summarizeInputs).toHaveLength(1);
		expect(summarizeInputs[0]).not.toHaveProperty("preferences");
	});
});
