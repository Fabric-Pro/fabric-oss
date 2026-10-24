/** Replay proof for the trigger-event agent-failure gate, including a mutant. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TriggerWorkflowInput } from "../trigger-system/types";

type History = Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>;

const SOURCE_DIR = resolve(__dirname, "../trigger-system");
const PATCH_ID = "trigger-event-agent-failure-2026-10";
const CHECK = 'patched("trigger-event-agent-failure-2026-10")';
const TASK_QUEUE = "trigger-event-agent-failure-replay";
const ERROR = "Example provider failure";
const OUTPUT_ACTIVITIES = [
	"transformOutput",
	"sendWebhook",
	"sendEmail",
	"postToSlack",
	"storeResult",
];
const INPUT: TriggerWorkflowInput = {
	triggerId: "trigger1",
	userId: "user1",
	organizationId: "org1",
	event: {
		id: "event1",
		triggerId: "trigger1",
		triggerType: "WEBHOOK",
		rawInput: {},
		message: "Please help",
		context: { sourceId: "source1", metadata: {} },
		receivedAt: new Date("2026-10-01T00:00:00Z"),
		status: "pending",
	},
};

/** Re-point relative imports (including re-exports) from the temporary copy. */
async function bundleTrigger(
	replacement: "false" | "true" | null,
): Promise<WorkflowBundleWithSourceMap> {
	const original = readFileSync(join(SOURCE_DIR, "index.ts"), "utf8");
	// A moved or duplicated call would make the legacy/mutant copies invalid.
	expect(original.split(CHECK)).toHaveLength(2);
	const source =
		replacement === null ? original : original.replace(CHECK, replacement);
	const dir = mkdtempSync(
		join(__dirname, ".trigger-event-agent-failure-replay-"),
	);
	try {
		const rewritten = source.replace(
			/from "(\.{1,2}\/[^"]+)"/g,
			(_match, specifier: string) => {
				const target = relative(dir, resolve(SOURCE_DIR, specifier))
					.split("\\")
					.join("/");
				return `from "${target.startsWith(".") ? target : `./${target}`}"`;
			},
		);
		writeFileSync(join(dir, "workflow.ts"), rewritten);
		return await bundleWorkflowCode({
			workflowsPath: join(dir, "workflow.ts"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

let env: TestWorkflowEnvironment;
let current: WorkflowBundleWithSourceMap;
let before: WorkflowBundleWithSourceMap;
let mutant: WorkflowBundleWithSourceMap;
let runSeq = 0;

async function record(
	bundle: WorkflowBundleWithSourceMap,
	expectFailure: boolean,
): Promise<{ workflowId: string; history: History }> {
	const workflowId = `trigger-event-agent-failure-replay-${++runSeq}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: TASK_QUEUE,
		workflowBundle: bundle,
		activities: {
			loadTriggerConfig: async () => ({
				id: "trigger1",
				status: "ACTIVE",
				agentId: "agent1",
				agentName: "Example agent",
				inputTemplate: "{{message}}",
				outputConfig: {
					outputTemplate: "{{response}}",
					webhookUrl: "https://example.com/webhook",
					emailTo: ["dev@example.com"],
					slackChannel: "channel1",
					storeResults: true,
				},
			}),
			transformInput: async () => "Please help",
			invokeAgent: async () => ({
				success: false,
				response: "",
				error: ERROR,
			}),
			transformOutput: async ({ response }: { response: string }) =>
				response,
			sendWebhook: async () => undefined,
			sendEmail: async () => undefined,
			postToSlack: async () => undefined,
			storeResult: async () => undefined,
			updateTriggerStats: async () => undefined,
		},
	});
	const handle = await env.client.workflow.start("triggerEventWorkflow", {
		taskQueue: TASK_QUEUE,
		workflowId,
		args: [INPUT],
	});
	if (expectFailure) {
		await expect(worker.runUntil(handle.result())).rejects.toMatchObject({
			cause: {
				message: ERROR,
				type: "TRIGGER_SYSTEM_FAILED",
				nonRetryable: true,
			},
		});
	} else {
		await expect(worker.runUntil(handle.result())).resolves.toMatchObject({
			success: true,
		});
	}
	return { workflowId, history: await handle.fetchHistory() };
}

function scheduledActivities(history: History): string[] {
	return (history.events ?? []).flatMap((event) => {
		const name =
			event.activityTaskScheduledEventAttributes?.activityType?.name;
		return name ? [name] : [];
	});
}

function recordsFailureMarker(history: History): boolean {
	return (history.events ?? []).some((event) => {
		const marker = event.markerRecordedEventAttributes;
		return (
			marker?.markerName === "core_patch" &&
			Object.values(marker.details ?? {}).some((payloads) =>
				(payloads.payloads ?? []).some((payload) =>
					Buffer.from(payload.data ?? [])
						.toString("utf8")
						.includes(PATCH_ID),
				),
			)
		);
	});
}

beforeAll(async () => {
	current = await bundleTrigger(null);
	before = await bundleTrigger("false");
	mutant = await bundleTrigger("true");
	env = await TestWorkflowEnvironment.createTimeSkipping();
}, 300_000);

afterAll(async () => {
	await env?.teardown();
});

describe("trigger event agent failure gate, replay", () => {
	it("replays legacy output history, while an always-on failure check breaks replay", async () => {
		const legacy = await record(before, false);
		expect(scheduledActivities(legacy.history)).toEqual([
			"loadTriggerConfig",
			"transformInput",
			"invokeAgent",
			...OUTPUT_ACTIVITIES,
			"updateTriggerStats",
		]);
		expect(recordsFailureMarker(legacy.history)).toBe(false);
		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: current },
				legacy.history,
				legacy.workflowId,
			),
		).resolves.toBeUndefined();
		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: mutant },
				legacy.history,
				legacy.workflowId,
			),
		).rejects.toThrow(DeterminismViolationError);
	}, 120_000);

	it("records the failure marker without output activities and replays", async () => {
		const today = await record(current, true);
		expect(recordsFailureMarker(today.history)).toBe(true);
		expect(scheduledActivities(today.history)).toEqual([
			"loadTriggerConfig",
			"transformInput",
			"invokeAgent",
			"updateTriggerStats",
		]);
		expect(
			(today.history.events ?? []).some((event) =>
				Boolean(event.workflowExecutionFailedEventAttributes),
			),
		).toBe(true);
		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: current },
				today.history,
				today.workflowId,
			),
		).resolves.toBeUndefined();
	}, 120_000);
});
