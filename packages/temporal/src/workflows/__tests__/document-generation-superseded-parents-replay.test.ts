/**
 * Replay safety of the batch and existing-project-setup parents' superseded
 * branch (Fizzy #2801).
 *
 * Each parent now skips its per-document FAILED write when the child ended
 * with `DOCUMENT_GENERATION_SUPERSEDED`, with no patch marker: no recorded
 * child ever ended with that type, so every recorded history takes the write
 * exactly as before. This proves it on real bundles, per parent:
 *
 * - a history recorded by the parent as it was before the branch (the check
 *   replaced by `false`, which always writes), with a child failing the way
 *   children always have, replays against today's parent;
 * - the same history fails to replay against a mutant whose check is `true`
 *   (never writes), so the replay really exercises that write;
 * - a history recorded by today's parent with a superseded child holds no
 *   FAILED write for that document, and replays.
 *
 * The child is a stub that fails or succeeds by document id. No production
 * history of either parent is available locally, so the "before" history is
 * recorded here.
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

/** The stub child: its outcome is read off the document id's suffix. */
const STUB_CHILD = `import { ApplicationFailure } from "@temporalio/workflow";

export async function documentGenerationChildWorkflow(input: {
	documentId: string;
}) {
	if (input.documentId.endsWith("-superseded")) {
		throw ApplicationFailure.nonRetryable(
			"A newer generation of this document started, so this one stopped without changing it.",
			"DOCUMENT_GENERATION_SUPERSEDED",
		);
	}
	if (input.documentId.endsWith("-failed")) {
		throw ApplicationFailure.nonRetryable(
			"agent unreachable",
			"DOCUMENT_GENERATION_CHILD_FAILED",
		);
	}
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

interface Parent {
	file: string;
	workflowType: string;
	/** The one call the "before" copy and the mutant replace. */
	check: string;
}

const PARENTS: Parent[] = [
	{
		file: "batch-document-generation.ts",
		workflowType: "batchDocumentGenerationWorkflow",
		check: "isSupersededGenerationFailure(error)",
	},
	{
		file: "existing-project-setup.ts",
		workflowType: "existingProjectSetupWorkflow",
		check: "isSupersededGenerationFailure(docError)",
	},
];

/**
 * Bundle `parent` with its check replaced by `replacement` (or as it is, for
 * null) and its child replaced by the stub. The copy sits in a temporary
 * directory under __tests__, its relative imports re-pointed at the real
 * modules.
 */
async function bundleParent(
	parent: Parent,
	replacement: string | null,
): Promise<WorkflowBundleWithSourceMap> {
	const original = readFileSync(join(WORKFLOWS_DIR, parent.file), "utf8");
	const source =
		replacement === null
			? original
			: original.replace(parent.check, replacement);
	const dir = mkdtempSync(join(__dirname, ".superseded-parent-replay-"));
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
			join(dir, "parent.ts"),
			`${rewritten}\nexport { documentGenerationChildWorkflow } from "./stub-child";\n`,
		);
		return await bundleWorkflowCode({
			workflowsPath: join(dir, "parent.ts"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

let env: TestWorkflowEnvironment;
let runSeq = 0;

/** Run `parent` once on `bundle` with documents of these ids; its history. */
async function record(
	parent: Parent,
	bundle: WorkflowBundleWithSourceMap,
	documents: Array<{ id: string; type: string }>,
): Promise<{ workflowId: string; history: History }> {
	const workflowId = `superseded-parent-replay-${++runSeq}`;
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
			createExistingProjectDocumentRecords: async () => ({ documents }),
		},
	});
	const args =
		parent.workflowType === "batchDocumentGenerationWorkflow"
			? {
					projectId: "project-1",
					userId: "user-1",
					organizationId: "org-1",
					aiToken: "token-1",
					documents: documents.map((doc) => ({
						...doc,
						title: doc.id,
						prompt: "",
					})),
				}
			: {
					projectId: "project-1",
					userId: "user-1",
					organizationId: "org-1",
					aiToken: "token-1",
					repoUrls: [],
					selectedDocumentTypes: documents.map((doc) => doc.type),
					projectTypes: [],
					projectName: "Example project",
				};
	const handle = await env.client.workflow.start(parent.workflowType, {
		taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
		workflowId,
		args: [args],
	});
	await worker.runUntil(handle.result());
	return { workflowId, history: await handle.fetchHistory() };
}

/** `updateProjectDocumentStatus` inputs the history scheduled, as JSON. */
function statusWrites(history: History): string[] {
	return (history.events ?? []).flatMap((event) => {
		const attributes = event.activityTaskScheduledEventAttributes;
		if (attributes?.activityType?.name !== "updateProjectDocumentStatus") {
			return [];
		}
		return [
			(attributes.input?.payloads ?? [])
				.map((payload) =>
					Buffer.from(payload.data ?? []).toString("utf8"),
				)
				.join("\n"),
		];
	});
}

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	for (const parent of PARENTS) {
		const source = readFileSync(join(WORKFLOWS_DIR, parent.file), "utf8");
		// The copies below replace exactly this call; if it moves or
		// doubles, they would silently test nothing.
		if (source.split(parent.check).length !== 2) {
			throw new Error(`${parent.file}: the superseded check moved`);
		}
	}
}, 300_000);

afterAll(async () => {
	await env?.teardown();
});

describe.each(PARENTS)("$workflowType — superseded child, replay", (parent) => {
	let current: WorkflowBundleWithSourceMap;
	let before: WorkflowBundleWithSourceMap;
	let mutant: WorkflowBundleWithSourceMap;

	beforeAll(async () => {
		current = await bundleParent(parent, null);
		before = await bundleParent(parent, "false");
		mutant = await bundleParent(parent, "true");
	}, 300_000);

	it("replays a history recorded before the branch, and the FAILED write is what it replays", async () => {
		// The failing document goes last, so its FAILED write is followed by
		// a different command and a skipped write cannot line up by chance.
		const legacy = await record(parent, before, [
			{ id: "doc-ok", type: "BUSINESS_CASE" },
			{ id: "doc-failed", type: "PRD" },
		]);
		expect(
			statusWrites(legacy.history).filter(
				(write) =>
					write.includes("doc-failed") && write.includes("FAILED"),
			),
		).toHaveLength(1);

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

	it("records no FAILED write for a superseded child, and replays that history", async () => {
		const today = await record(parent, current, [
			{ id: "doc-ok", type: "BUSINESS_CASE" },
			{ id: "doc-superseded", type: "PROPOSAL" },
			{ id: "doc-failed", type: "PRD" },
		]);
		const writes = statusWrites(today.history);
		expect(
			writes.filter((write) => write.includes("doc-superseded")),
		).toEqual([expect.stringContaining("GENERATING")]);
		expect(
			writes.filter(
				(write) =>
					write.includes("doc-failed") && write.includes("FAILED"),
			),
		).toHaveLength(1);

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: current },
				today.history,
				today.workflowId,
			),
		).resolves.toBeUndefined();
	}, 120_000);
});
