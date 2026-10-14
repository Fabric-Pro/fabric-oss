/**
 * Replay safety of project setup's pause for a ChatGPT plan reset (Fizzy
 * #2770). The run row it pauses on is created by new activities, so the
 * whole path sits behind `patched("bulk-pause-resume-v1")`. On real bundles:
 *
 * - a history recorded by the setup as it was before the patch (the check
 *   replaced by `false`) replays against today's setup;
 * - the same history fails to replay against a mutant whose check is `true`,
 *   so the replay really exercises the gate;
 * - a history recorded by today's setup holds the run row's activities, and
 *   replays.
 *
 * The document child is a stub that succeeds. No production history of the
 * setup is available locally, so the "before" history is recorded here.
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
import { PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE } from "../../task-queues";

type History = Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>;

const WORKFLOWS_DIR = resolve(__dirname, "..");
const FILE = "existing-project-setup.ts";
const CHECK = "patched(BULK_RUN_PAUSE_PATCH)";

const STUB_CHILD = `export async function documentGenerationChildWorkflow(input: {
	documentId: string;
}) {
	return {
		success: true,
		documentId: input.documentId,
		documentContent: "",
		metrics: {
			contextCount: 0,
			episodeCount: 0,
			integrationMessageCount: 0,
			teamsSearchCount: 0,
			documentLength: 0,
			wordCount: 0,
			durationMs: 0,
		},
	};
}
`;

/** The setup with its check replaced (or as it is, for null), stub child. */
async function bundleSetup(
	replacement: string | null,
): Promise<WorkflowBundleWithSourceMap> {
	const original = readFileSync(join(WORKFLOWS_DIR, FILE), "utf8");
	const source =
		replacement === null ? original : original.replace(CHECK, replacement);
	const dir = mkdtempSync(join(__dirname, ".setup-pause-replay-"));
	const fromDir = (specifier: string) => {
		const target = relative(dir, resolve(WORKFLOWS_DIR, specifier))
			.split("\\")
			.join("/");
		return target.startsWith(".") ? target : `./${target}`;
	};
	try {
		const rewritten = source.replace(
			/from "(\.{1,2}\/[^"]+)"/g,
			(_match, specifier: string) =>
				specifier === "./document-generation-child"
					? 'from "./stub-child"'
					: `from "${fromDir(specifier)}"`,
		);
		writeFileSync(join(dir, "stub-child.ts"), STUB_CHILD);
		writeFileSync(
			join(dir, "setup.ts"),
			`${rewritten}\nexport { documentGenerationChildWorkflow } from "./stub-child";\n`,
		);
		return await bundleWorkflowCode({
			workflowsPath: join(dir, "setup.ts"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

let env: TestWorkflowEnvironment;
let runSeq = 0;

async function record(
	bundle: WorkflowBundleWithSourceMap,
): Promise<{ workflowId: string; history: History }> {
	const workflowId = `setup-pause-replay-${++runSeq}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
		workflowBundle: bundle,
		activities: {
			createAgentTask: async () => ({ id: "task-1" }),
			updateAgentTaskWorkflow: async () => undefined,
			updateAgentTaskStatus: async () => undefined,
			updateProjectDocumentStatus: async () => undefined,
			updateProjectCodeAnalysisStatus: async () => undefined,
			updateProjectRagSettings: async () => undefined,
			createExistingProjectDocumentRecords: async () => ({
				documents: [
					{ id: "doc-prd", type: "PRD", title: "PRD" },
					{ id: "doc-proposal", type: "PROPOSAL", title: "Proposal" },
				],
			}),
		},
	});
	const handle = await env.client.workflow.start(
		"existingProjectSetupWorkflow",
		{
			taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
			workflowId,
			args: [
				{
					projectId: "project-1",
					userId: "user-1",
					organizationId: "org-1",
					aiToken: "token-1",
					repoUrls: [],
					selectedDocumentTypes: ["PRD", "PROPOSAL"],
					projectTypes: [],
					projectName: "Example project",
				},
			],
		},
	);
	await worker.runUntil(handle.result());
	return { workflowId, history: await handle.fetchHistory() };
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
	// The copies below replace exactly this call; if it moves or doubles,
	// they would silently test nothing.
	if (source.split(CHECK).length !== 2) {
		throw new Error(`${FILE}: the pause patch check moved`);
	}
	env = await TestWorkflowEnvironment.createTimeSkipping();
	current = await bundleSetup(null);
	before = await bundleSetup("false");
	mutant = await bundleSetup("true");
}, 300_000);

afterAll(async () => {
	await env?.teardown();
});

describe("existingProjectSetupWorkflow — pause patch, replay", () => {
	it("replays a history recorded before the patch, and the gate is what it replays", async () => {
		const legacy = await record(before);
		expect(scheduledActivities(legacy.history)).not.toContain(
			"createAgentTask",
		);

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

	it("records the run row on today's setup, and replays that history", async () => {
		const today = await record(current);
		const activities = scheduledActivities(today.history);
		expect(activities.slice(0, 3)).toEqual([
			"createAgentTask",
			"updateAgentTaskWorkflow",
			"updateAgentTaskStatus",
		]);
		expect(activities.at(-1)).toBe("updateAgentTaskStatus");

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: current },
				today.history,
				today.workflowId,
			),
		).resolves.toBeUndefined();
	}, 120_000);
});
