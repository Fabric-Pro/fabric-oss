/**
 * A scheduled run's outcome is counted after its graph finishes, so an
 * unattended workflow that keeps failing pauses itself. The count is a new
 * activity after the child workflow, so the whole path sits behind
 * `patched("scheduled-run-outcome-v1")`. On real bundles:
 *
 * - each terminal status, a thrown child and a cancelled one reach the counting
 *   activity (or, for cancellation, deliberately do not);
 * - a counting failure never fails the kickoff;
 * - a history recorded before the patch (the check replaced by `false`) replays
 *   against today's kickoff, and fails to replay against a mutant whose check is
 *   `true`, so the replay really exercises the gate;
 * - a history recorded by today's kickoff holds the counting activity, and
 *   replays.
 *
 * The graph executor is a stub. No production history of the kickoff is
 * available locally, so the "before" history is recorded here.
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { WorkflowHandle } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type History = Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>;

const WORKFLOWS_DIR = resolve(__dirname, "..");
const FILE = "scheduled-workflow-kickoff.ts";
const CHECK = 'patched("scheduled-run-outcome-v1")';

const STUB_CHILD = `import { ApplicationFailure } from "@temporalio/workflow";

export async function workflowBuilderExecutionWorkflow(input: {
	executionId: string;
	triggerData?: { stub?: string };
}) {
	const stub = input.triggerData?.stub;
	if (stub === "throw") {
		throw ApplicationFailure.nonRetryable("child blew up");
	}
	return {
		executionId: input.executionId,
		status: stub ?? "COMPLETED",
		outputs: {},
		executedNodes: [],
		duration: 1,
	};
}
`;

/** The kickoff with its check replaced (or as it is, for null), stub child. */
async function bundleKickoff(
	replacement: string | null,
): Promise<WorkflowBundleWithSourceMap> {
	const original = readFileSync(join(WORKFLOWS_DIR, FILE), "utf8");
	const source =
		replacement === null ? original : original.replace(CHECK, replacement);
	const dir = mkdtempSync(join(__dirname, ".kickoff-outcome-"));
	const fromDir = (specifier: string) => {
		const target = relative(dir, resolve(WORKFLOWS_DIR, specifier))
			.split("\\")
			.join("/");
		return target.startsWith(".") ? target : `./${target}`;
	};
	try {
		const rewritten = source.replace(
			/from "(\.{1,2}\/[^"]+)"/g,
			(_match, specifier: string) => `from "${fromDir(specifier)}"`,
		);
		writeFileSync(join(dir, "stub-child.ts"), STUB_CHILD);
		writeFileSync(join(dir, "kickoff.ts"), rewritten);
		writeFileSync(
			join(dir, "entry.ts"),
			'export * from "./kickoff";\nexport { workflowBuilderExecutionWorkflow } from "./stub-child";\n',
		);
		return await bundleWorkflowCode({
			workflowsPath: join(dir, "entry.ts"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

interface OutcomeCall {
	workflowId: string;
	executionId: string;
	organizationId?: string;
	status: string;
}

let env: TestWorkflowEnvironment;
let current: WorkflowBundleWithSourceMap;
let before: WorkflowBundleWithSourceMap;
let mutant: WorkflowBundleWithSourceMap;
let runSeq = 0;
let outcomeCalls: OutcomeCall[];
let outcomeFails = false;
let shouldRun = true;

async function startKickoff(
	bundle: WorkflowBundleWithSourceMap,
	stub?: string,
): Promise<{
	workflowId: string;
	history: () => Promise<History>;
	result: () => Promise<unknown>;
}> {
	const taskQueue = `kickoff-outcome-${++runSeq}`;
	const workflowId = `kickoff-outcome-wf-${runSeq}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
		activities: {
			createScheduledExecution: async () =>
				shouldRun
					? {
							executionId: `exec-${runSeq}`,
							version: 1,
							shouldRun: true,
						}
					: {
							executionId: "",
							version: 0,
							shouldRun: false,
							reason: "Workflow no longer exists",
						},
			recordScheduledRunOutcome: async (call: OutcomeCall) => {
				outcomeCalls.push(call);
				if (outcomeFails) {
					throw ApplicationFailure.nonRetryable("database is down");
				}
				return {
					recorded: true,
					consecutiveFailures: 0,
					paused: false,
				};
			},
		},
	});
	const handle = await env.client.workflow.start("scheduledWorkflowKickoff", {
		taskQueue,
		workflowId,
		args: [
			{
				workflowId: "wf-1",
				userId: "user-1",
				organizationId: "org-1",
				triggerData: stub ? { stub } : undefined,
			},
		],
	});
	return {
		workflowId,
		history: () => handle.fetchHistory(),
		result: () => worker.runUntil(handle.result()),
	};
}

function scheduledActivities(history: History): string[] {
	return (history.events ?? []).flatMap((event) => {
		const name =
			event.activityTaskScheduledEventAttributes?.activityType?.name;
		return name ? [name] : [];
	});
}

beforeAll(async () => {
	const source = readFileSync(join(WORKFLOWS_DIR, FILE), "utf8");
	// The copies below replace exactly this call; if it moves or doubles,
	// they would silently test nothing.
	if (source.split(CHECK).length !== 2) {
		throw new Error(`${FILE}: the outcome patch check moved`);
	}
	env = await TestWorkflowEnvironment.createTimeSkipping();
	current = await bundleKickoff(null);
	before = await bundleKickoff("false");
	mutant = await bundleKickoff("true");
}, 300_000);

afterAll(async () => {
	await env?.teardown();
});

beforeEach(() => {
	outcomeCalls = [];
	outcomeFails = false;
	shouldRun = true;
});

describe("scheduledWorkflowKickoff - counting the outcome", () => {
	it.each([
		["COMPLETED", undefined],
		["FAILED", "FAILED"],
		["CANCELLED", "CANCELLED"],
	])(
		"counts a %s run once, against the right workflow and tenant",
		async (status, stub) => {
			const run = await startKickoff(current, stub);

			const result = await run.result();

			expect(result).toMatchObject({ started: true, status });
			expect(outcomeCalls).toEqual([
				{
					workflowId: "wf-1",
					executionId: `exec-${runSeq}`,
					organizationId: "org-1",
					status,
				},
			]);
		},
		60_000,
	);

	it("counts a child that blew up as a failure, then still fails the kickoff", async () => {
		const run = await startKickoff(current, "throw");

		await expect(run.result()).rejects.toThrow();

		expect(outcomeCalls.map((call) => call.status)).toEqual(["FAILED"]);
	}, 60_000);

	it("counts nothing for a tick that could not run", async () => {
		shouldRun = false;
		const run = await startKickoff(current);

		const result = await run.result();

		expect(result).toMatchObject({ started: false });
		expect(outcomeCalls).toEqual([]);
	}, 60_000);

	it("never fails a finished run because the count could not be written", async () => {
		outcomeFails = true;
		const run = await startKickoff(current);

		const result = await run.result();

		expect(result).toMatchObject({ started: true, status: "COMPLETED" });
		expect(outcomeCalls).toHaveLength(1);
	}, 60_000);
});

describe("scheduledWorkflowKickoff - outcome patch, replay", () => {
	it("replays a history recorded before the patch, and the gate is what it replays", async () => {
		const run = await startKickoff(before);
		await run.result();
		const legacy = await run.history();
		expect(scheduledActivities(legacy)).not.toContain(
			"recordScheduledRunOutcome",
		);

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: current },
				legacy,
				run.workflowId,
			),
		).resolves.toBeUndefined();

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: mutant },
				legacy,
				run.workflowId,
			),
		).rejects.toThrow(DeterminismViolationError);
	}, 120_000);

	it("records the count on today's kickoff, and replays that history", async () => {
		const run = await startKickoff(current);
		await run.result();
		const today = await run.history();
		expect(scheduledActivities(today)).toEqual([
			"createScheduledExecution",
			"recordScheduledRunOutcome",
		]);

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: current },
				today,
				run.workflowId,
			),
		).resolves.toBeUndefined();
	}, 120_000);
});
