/**
 * Replay proof for the 1C-1b part 2 forwarding change (§7.1(a)).
 *
 * THE QUESTION. `publishingSuggestionWorkflow` now forwards `input.preferences`
 * into the `summarizeTopicSuggestions` activity call. Mid-rollout there will be
 * histories whose workflow INPUT carries `preferences` — a new dispatcher
 * started them — but whose RECORDED summarize command does not, because an old
 * worker executed the first task. Does replaying one of those against the new
 * code count as nondeterminism?
 *
 * WHY THIS FILE EXISTS RATHER THAN A CITATION. The C-1 slice measured exactly
 * this for `persistCycleTerminal` and got CLEAN. The mechanism is the same, but
 * that measurement covered a different activity, and the ordinary
 * `pnpm --filter @repo/temporal test` command is not a substitute: the repo's
 * real gate, `__tests__/replay-validation.test.ts`, SKIPS when no fixtures are
 * on disk unless `REPLAY_REQUIRE_FIXTURES=1`, which only CI sets. Locally it
 * exits 0 having replayed nothing. Citing a green run of it would be citing a
 * suite that never executed.
 *
 * WHY THE NEGATIVE CONTROL. A CLEAN verdict from a replayer that silently did
 * nothing looks identical to a CLEAN verdict from one that checked. In C-1 the
 * first attempt returned the same error for both the real and the corrupted
 * history — the fault was history serialization, not determinism — and only the
 * control revealed it. So the second case here corrupts the recorded activity
 * type and REQUIRES a nondeterminism error. If it ever stops throwing, the
 * first case's pass has stopped meaning anything.
 */

import { resolve } from "node:path";
import { buildPublishingPreferencesSnapshot } from "@repo/database";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PublishingSuggestionWorkflowInput } from "../publishing-suggestion-generation-workflow";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const WORKFLOW_NAME = "publishingSuggestionWorkflow";
const COVERED_THROUGH = "2026-07-14T00:00:00.000Z";

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

/** Enough qualifying content that the workflow actually reaches summarization. */
const COLLECTOR_RESULT = {
	items: [],
	qualifyingCount: 1,
	newestQualifyingIso: "2026-07-10T00:00:00.000Z",
	advancedThroughIso: "2026-07-10T00:00:00.000Z",
	truncated: false,
};

const collector = async () => COLLECTOR_RESULT;

const activities = {
	assertProjectTenantTuple: async () => {},
	collectStories: collector,
	collectDocuments: collector,
	collectTranscripts: collector,
	collectPullRequests: collector,
	collectReleases: collector,
	summarizeTopicSuggestions: async () => ({
		topics: [{ title: "Ship it", pitch: "A pitch.", provenance: {} }],
		aiUsageTokens: null,
	}),
	computeSuggestionTopics: async (args: {
		topics: { title: string; pitch: string; provenance: unknown }[];
	}) => ({
		topics: args.topics.map((t) => ({
			...t,
			dedupeKey: `dedupe-${t.title}`,
			contributorUserIds: [],
		})),
	}),
	resolveTopicContributors: async (args: { topics: unknown[] }) => ({
		topics: args.topics,
	}),
	persistCycleTerminal: async () => ({ persisted: true, status: "READY" }),
	notifyPublishingContributors: async () => ({
		notified: true,
		recipientCount: 0,
		failedCount: 0,
		skippedCount: 0,
	}),
	broadcastTopicsToChat: async () => ({
		delivered: true,
		channelCount: 0,
		failedCount: 0,
	}),
	markCycleFailed: async () => {},
};

/**
 * Runs the workflow WITHOUT `preferences`, so the recorded
 * `summarizeTopicSuggestions` command carries no such field — byte-for-byte
 * what an old worker would have written — and returns its history.
 */
async function recordOldShapedHistory() {
	const taskQueue = "publishing-preferences-replay";
	const workflowId = `${taskQueue}-wf`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});

	const input: PublishingSuggestionWorkflowInput = {
		cycleId: "cycle-1",
		projectId: "proj-1",
		organizationId: null,
		tenantUserId: "user-1",
		actorUserId: "user-1",
		coveredThroughIso: COVERED_THROUGH,
		priorCoverage: {},
	};

	await worker.runUntil(
		env.client.workflow.execute(WORKFLOW_NAME, {
			args: [input],
			taskQueue,
			workflowId,
		}),
	);

	return env.client.workflow.getHandle(workflowId).fetchHistory();
}

type MutableHistory = Awaited<ReturnType<typeof recordOldShapedHistory>>;

/**
 * Rewrites the WorkflowExecutionStarted input to carry `preferences`, leaving
 * every recorded COMMAND untouched.
 *
 * This is the mid-rollout shape and the whole point of the exercise: input has
 * the field, the recorded summarize command does not. Replaying it exercises
 * the new forwarding code against a history written without it.
 */
function addPreferencesToStartInput(history: MutableHistory): MutableHistory {
	const started = history.events?.find(
		(e) => e.workflowExecutionStartedEventAttributes,
	);
	const payload =
		started?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
	if (!payload?.data) {
		throw new Error(
			"could not find the workflow input payload — the fixture is not what this test assumes",
		);
	}
	const decoded = JSON.parse(Buffer.from(payload.data).toString("utf8"));
	decoded.preferences = buildPublishingPreferencesSnapshot({
		preferredThemes: ["Developer Experience"],
	});
	payload.data = Buffer.from(JSON.stringify(decoded), "utf8");
	return history;
}

/** Decodes the workflow input recorded in WorkflowExecutionStarted. */
function readStartInput(history: MutableHistory): Record<string, unknown> {
	const payload = history.events?.find(
		(e) => e.workflowExecutionStartedEventAttributes,
	)?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
	return JSON.parse(Buffer.from(payload?.data ?? []).toString("utf8"));
}

/** Decodes the ARGUMENT recorded on the scheduled summarize command. */
function recordedSummarizeInput(
	history: MutableHistory,
): Record<string, unknown> {
	const payload = history.events?.find(
		(e) =>
			e.activityTaskScheduledEventAttributes?.activityType?.name ===
			"summarizeTopicSuggestions",
	)?.activityTaskScheduledEventAttributes?.input?.payloads?.[0];
	return JSON.parse(Buffer.from(payload?.data ?? []).toString("utf8"));
}

/** The negative control: rename the recorded activity so replay MUST object. */
function corruptRecordedActivityType(history: MutableHistory): MutableHistory {
	const scheduled = history.events?.find(
		(e) =>
			e.activityTaskScheduledEventAttributes?.activityType?.name ===
			"summarizeTopicSuggestions",
	);
	const activityType =
		scheduled?.activityTaskScheduledEventAttributes?.activityType;
	if (!activityType) {
		throw new Error(
			"no recorded summarizeTopicSuggestions command — the control cannot corrupt what is not there",
		);
	}
	activityType.name = "someActivityThatWasNeverScheduled";
	return history;
}

async function replay(history: MutableHistory): Promise<string | null> {
	const results = await Worker.runReplayHistories(
		{ workflowsPath: WORKFLOWS_PATH },
		[{ workflowId: "replay-under-test", history }],
	);
	for await (const result of results) {
		if (result.error) {
			return result.error.message ?? String(result.error);
		}
	}
	return null;
}

describe("preferences forwarding — replay determinism", () => {
	it("replays CLEAN when the input carries preferences the recorded command does not", async () => {
		const history = addPreferencesToStartInput(
			await recordOldShapedHistory(),
		);

		// PRECONDITION, asserted rather than assumed. If the mutation silently
		// failed to land, this test would replay an unmodified history against
		// unmodified code and pass for a reason that has nothing to do with the
		// question — a clean verdict on a scenario that was never constructed.
		expect(readStartInput(history).preferences).toBeDefined();
		expect(recordedSummarizeInput(history)).not.toHaveProperty(
			"preferences",
		);

		expect(await replay(history)).toBeNull();
	}, 120_000);

	it("NEGATIVE CONTROL: the same history with a renamed command is refused", async () => {
		// Without this the case above is indistinguishable from a replayer that
		// examined nothing. If this ever stops throwing, the clean verdict above
		// has stopped being evidence — fix the instrument before trusting it.
		const history = corruptRecordedActivityType(
			addPreferencesToStartInput(await recordOldShapedHistory()),
		);

		const error = await replay(history);

		expect(error).not.toBeNull();
		expect(error).toMatch(/nondeterminism|TMPRL1100/i);
	}, 120_000);
});
