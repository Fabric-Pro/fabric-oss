/**
 * The conversation-bundle embedding sweep also runs the context re-enrichment
 * pass (Fizzy #2770), behind `patched(CONTEXT_REENRICHMENT_PATCH_ID)`. On real
 * bundles:
 *
 * - a history recorded by the sweep as it was before (the check replaced by
 *   `false`) replays against today's sweep, and fails against a mutant whose
 *   check is `true` — so the replay really exercises the gate;
 * - today's sweep runs the re-enrichment pass after the bundle sweep, and a
 *   failure of that pass leaves the run (and the bundle sweep's result) intact.
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use.
 */

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

type History = Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>;

const WORKFLOWS_DIR = resolve(__dirname, "..");
const FILE = "conversation-bundle-embedding-sweep.ts";
const CHECK = "patched(CONTEXT_REENRICHMENT_PATCH_ID)";
const TASK_QUEUE = "bundle-sweep-reenrichment-replay";
const SWEEP_RESULT = { candidates: 0 };

async function bundleSweep(
	replacement: string | null,
): Promise<WorkflowBundleWithSourceMap> {
	const original = readFileSync(join(WORKFLOWS_DIR, FILE), "utf8");
	const source =
		replacement === null ? original : original.replace(CHECK, replacement);
	const dir = mkdtempSync(join(__dirname, ".bundle-sweep-replay-"));
	try {
		const rewritten = source.replace(
			/from "(\.{1,2}\/[^"]+)"/g,
			(_match, specifier: string) => {
				const target = relative(dir, resolve(WORKFLOWS_DIR, specifier))
					.split("\\")
					.join("/");
				return `from "${target.startsWith(".") ? target : `./${target}`}"`;
			},
		);
		writeFileSync(join(dir, "sweep.ts"), rewritten);
		return await bundleWorkflowCode({
			workflowsPath: join(dir, "sweep.ts"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

let env: TestWorkflowEnvironment;
let runSeq = 0;

async function record(
	bundle: WorkflowBundleWithSourceMap,
	reenrich: () => Promise<unknown> = async () => ({ candidates: 0 }),
): Promise<{ workflowId: string; history: History; result: unknown }> {
	const workflowId = `bundle-sweep-replay-${++runSeq}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: TASK_QUEUE,
		workflowBundle: bundle,
		activities: {
			sweepConversationBundleEmbeddingsActivity: async () => SWEEP_RESULT,
			reenrichDeferredContextsActivity: reenrich,
		},
	});
	const handle = await env.client.workflow.start(
		"conversationBundleEmbeddingSweepWorkflow",
		{ taskQueue: TASK_QUEUE, workflowId, args: [{}] },
	);
	const result = await worker.runUntil(handle.result());
	return { workflowId, history: await handle.fetchHistory(), result };
}

function scheduledActivities(history: History): string[] {
	return (history.events ?? []).flatMap((event) => {
		const name =
			event.activityTaskScheduledEventAttributes?.activityType?.name;
		return name ? [name] : [];
	});
}

let current: WorkflowBundleWithSourceMap;
let before: WorkflowBundleWithSourceMap;
let mutant: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	const source = readFileSync(join(WORKFLOWS_DIR, FILE), "utf8");
	if (source.split(CHECK).length !== 2) {
		throw new Error(`${FILE}: the re-enrichment patch check moved`);
	}
	env = await TestWorkflowEnvironment.createTimeSkipping();
	current = await bundleSweep(null);
	before = await bundleSweep("false");
	mutant = await bundleSweep("true");
}, 300_000);

afterAll(async () => {
	await env?.teardown();
});

describe("conversationBundleEmbeddingSweepWorkflow — re-enrichment patch", () => {
	it("replays a history recorded before the patch, and the gate is what it replays", async () => {
		const legacy = await record(before);
		expect(scheduledActivities(legacy.history)).toEqual([
			"sweepConversationBundleEmbeddingsActivity",
		]);

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

	it("runs the re-enrichment pass after the bundle sweep, and replays that history", async () => {
		const today = await record(current);
		expect(scheduledActivities(today.history)).toEqual([
			"sweepConversationBundleEmbeddingsActivity",
			"reenrichDeferredContextsActivity",
		]);
		expect(today.result).toEqual(SWEEP_RESULT);

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: current },
				today.history,
				today.workflowId,
			),
		).resolves.toBeUndefined();
	}, 120_000);

	it("keeps the bundle sweep's result when the re-enrichment pass fails", async () => {
		const failing = await record(current, async () => {
			throw new Error("re-enrichment failed");
		});
		expect(failing.result).toEqual(SWEEP_RESULT);
	}, 120_000);
});
