/**
 * Replay safety of the batch and existing-project-setup parents' skip of a
 * document their run no longer holds (Fizzy #2946).
 *
 * Each parent now starts no child, no evaluation and no COMPLETE write for a
 * document whose GENERATING write reported `held: false`. That removes
 * commands from a path recorded histories took, so the skip sits behind
 * `patched("bulk-document-held-guard-v1")`. On real bundles, per parent:
 *
 * - a history recorded by the parent as it was before the guard (the check
 *   replaced by `false`, which never skips), whose write for one document
 *   reported it not held, replays against today's parent;
 * - the same history fails to replay against a mutant whose check is `true`
 *   (always takes the skip), so the replay really exercises the gate;
 * - a history recorded by today's parent holds the marker and no child for
 *   that document, and replays.
 *
 * The child is a stub that succeeds, and the status activity reports the
 * hold by document id. No production history of either parent is available
 * locally, so the "before" history is recorded here.
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

/** The one call the "before" copy and the mutant replace, in each parent. */
const CHECK = "patched(BULK_DOCUMENT_HELD_PATCH)";

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

interface Parent {
	file: string;
	workflowType: string;
}

const PARENTS: Parent[] = [
	{
		file: "batch-document-generation.ts",
		workflowType: "batchDocumentGenerationWorkflow",
	},
	{
		file: "existing-project-setup.ts",
		workflowType: "existingProjectSetupWorkflow",
	},
];

/**
 * The released document sits between two others, so a skipped child is
 * followed by a different command and cannot line up by chance. The batch
 * runs these three in this order (one phase, by intra-phase order); the
 * setup runs its records in the order the activity returns them.
 */
const DOCUMENTS = [
	{ id: "doc-first", type: "BUSINESS_CASE" },
	{ id: "doc-released", type: "PROPOSAL" },
	{ id: "doc-last", type: "PRD" },
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
		replacement === null ? original : original.replace(CHECK, replacement);
	const dir = mkdtempSync(join(__dirname, ".bulk-document-held-replay-"));
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

/** Run `parent` once on `bundle`; its history. */
async function record(
	parent: Parent,
	bundle: WorkflowBundleWithSourceMap,
): Promise<{ workflowId: string; history: History }> {
	const workflowId = `bulk-document-held-replay-${++runSeq}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
		workflowBundle: bundle,
		activities: {
			createAgentTask: async () => ({ id: "task-1" }),
			updateAgentTaskWorkflow: async () => undefined,
			updateAgentTaskStatus: async () => undefined,
			// The released document's hold was lost; every other one
			// starts its attempt.
			updateProjectDocumentStatus: async (input: {
				documentId: string;
				status: string;
			}) => {
				if (input.status !== "GENERATING") {
					return undefined;
				}
				return input.documentId === "doc-released"
					? { held: false }
					: { generationStartedAt: "2026-10-21T09:00:00.000Z" };
			},
			updateProjectCodeAnalysisStatus: async () => undefined,
			updateProjectRagSettings: async () => undefined,
			createExistingProjectDocumentRecords: async () => ({
				documents: DOCUMENTS,
			}),
		},
	});
	const args =
		parent.workflowType === "batchDocumentGenerationWorkflow"
			? {
					projectId: "project-1",
					userId: "user-1",
					organizationId: "org-1",
					aiToken: "token-1",
					documents: DOCUMENTS.map((doc) => ({
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
					selectedDocumentTypes: DOCUMENTS.map((doc) => doc.type),
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

/** The workflow ids of the children the history started. */
function startedChildren(history: History): string[] {
	return (history.events ?? []).flatMap((event) => {
		const id =
			event.startChildWorkflowExecutionInitiatedEventAttributes
				?.workflowId;
		return id ? [id] : [];
	});
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

/** Whether the history recorded a patch marker naming the guard. */
function recordsHeldGuardMarker(history: History): boolean {
	return (history.events ?? []).some((event) => {
		const marker = event.markerRecordedEventAttributes;
		if (!marker) {
			return false;
		}
		return Object.values(marker.details ?? {}).some((payloads) =>
			(payloads.payloads ?? []).some((payload) =>
				Buffer.from(payload.data ?? [])
					.toString("utf8")
					.includes("bulk-document-held-guard-v1"),
			),
		);
	});
}

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	for (const parent of PARENTS) {
		const source = readFileSync(join(WORKFLOWS_DIR, parent.file), "utf8");
		// The copies below replace exactly this call; if it moves or
		// doubles, they would silently test nothing.
		if (source.split(CHECK).length !== 2) {
			throw new Error(`${parent.file}: the held-document check moved`);
		}
	}
}, 300_000);

afterAll(async () => {
	await env?.teardown();
});

describe.each(PARENTS)(
	"$workflowType — held-document guard, replay",
	(parent) => {
		let current: WorkflowBundleWithSourceMap;
		let before: WorkflowBundleWithSourceMap;
		let mutant: WorkflowBundleWithSourceMap;

		beforeAll(async () => {
			current = await bundleParent(parent, null);
			before = await bundleParent(parent, "false");
			mutant = await bundleParent(parent, "true");
		}, 300_000);

		it("replays a history recorded before the guard, and the gate is what it replays", async () => {
			const legacy = await record(parent, before);
			// The write said the document was not held, and the run before the
			// guard generated it anyway.
			expect(
				startedChildren(legacy.history).filter((id) =>
					id.endsWith("doc-released"),
				),
			).toHaveLength(1);
			expect(recordsHeldGuardMarker(legacy.history)).toBe(false);

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

		it("records the marker and no child for a document it no longer holds, and replays that history", async () => {
			const today = await record(parent, current);
			expect(recordsHeldGuardMarker(today.history)).toBe(true);
			expect(
				startedChildren(today.history).map((id) =>
					id.split("-").at(-1),
				),
			).toEqual(["first", "last"]);
			expect(
				statusWrites(today.history).filter((write) =>
					write.includes("doc-released"),
				),
			).toEqual([expect.stringContaining("GENERATING")]);

			await expect(
				Worker.runReplayHistory(
					{ workflowBundle: current },
					today.history,
					today.workflowId,
				),
			).resolves.toBeUndefined();
		}, 120_000);
	},
);
