/**
 * A HARD AI usage limit that refuses a request partway through a direct chat
 * turn ends the turn once: no rerun of the turn without tools, and no
 * Temporal retry of the activity.
 *
 * Runs the REAL `directChatWorkflow` on a time-skipping Temporal server with
 * mocked activities. MCP tools are in scope in every case, so the tools-off
 * rerun (`!result.success`) is reachable; the control case shows it is.
 * Covers:
 *  - both results the activity hands back for a refusal
 *    (direct-chat/ai-execution.ts): a failed turn with `error` and
 *    `usageLimit`, which the patch keeps from being rerun, and, as a control
 *    for behaviour that did not change, a partial answer with `partialError`
 *    and `usageLimit`;
 *  - the `direct-chat-usage-limit-no-rerun-v1` patch: a history recorded by
 *    the code before it (which reran the turn) replays on the current code;
 *  - the worker's activity interceptor, which unwraps a refusal the AI SDK
 *    wrapped in a `RetryError` so Temporal does not retry the activity.
 *
 * Offline note: `createTimeSkipping()` downloads a Temporal test-server binary
 * on first use; run once online to populate the cache.
 */

import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { defaultPayloadConverter } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { RetryError } from "ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AiUsageLimitActivityInboundInterceptor } from "../../lib/ai-usage-limit-interceptor";
import type {
	DirectChatWorkflowInput,
	DirectChatWorkflowOutput,
} from "../../types";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const PATCH_CALL = 'patched("direct-chat-usage-limit-no-rerun-v1")';

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let prePatchBundle: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

/**
 * `directChatWorkflow` as it was before the patch: the patched condition is
 * gone, so a refused turn is rerun without tools. Bundled from a copy one
 * directory deeper, with its relative imports moved to match.
 */
async function bundlePrePatchWorkflow() {
	const source = readFileSync(join(WORKFLOWS_PATH, "direct-chat.ts"), "utf8");
	const prePatch = source.replace(
		/&&\s*!\(\s*result\.usageLimit &&\s*patched\("direct-chat-usage-limit-no-rerun-v1"\)\s*\)/,
		"",
	);
	if (prePatch === source || !source.includes(PATCH_CALL)) {
		throw new Error("the usage-limit patch moved; update this test");
	}
	// Under __tests__, which the starter-allowlist scan skips.
	const dir = mkdtempSync(join(__dirname, ".direct-chat-pre-patch-"));
	try {
		writeFileSync(
			join(dir, "workflow.ts"),
			prePatch
				.replace(/from "\.\.\//g, 'from "../../../')
				.replace(/from "\.\//g, 'from "../../'),
		);
		return await bundleWorkflowCode({
			workflowsPath: join(dir, "workflow.ts"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
	prePatchBundle = await bundlePrePatchWorkflow();
}, 300_000);

afterAll(async () => {
	await env?.teardown();
	// A crashed run can leave its bundling directory behind.
	for (const entry of readdirSync(__dirname)) {
		if (entry.startsWith(".direct-chat-pre-patch-")) {
			rmSync(join(__dirname, entry), { recursive: true, force: true });
		}
	}
});

const INPUT = {
	executionId: "example-execution",
	history: [],
	message: "What is on the roadmap?",
	userId: "user-1",
	organizationId: "org-1",
	reasoningMode: "balanced",
} as DirectChatWorkflowInput;

function limitError() {
	return new AiUsageLimitExceededError({
		message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
		limitId: "limit-1",
		dimension: "TOKENS" as never,
		window: "MONTHLY" as never,
		used: BigInt(100),
		max: BigInt(100),
		manageLimitsUrl: "https://example.com/limits",
	});
}

const USAGE_LIMIT = {
	message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
	limitId: "limit-1",
	dimension: "TOKENS" as const,
	window: "MONTHLY" as const,
	used: "100",
	max: "100",
	manageLimitsUrl: "https://example.com/limits",
};

const REFUSED_TURN: DirectChatWorkflowOutput = {
	success: false,
	error: USAGE_LIMIT.message,
	usageLimit: USAGE_LIMIT,
};

async function runTurn(options: {
	conversationId?: string;
	execute: () => Promise<DirectChatWorkflowOutput>;
	bundle?: WorkflowBundleWithSourceMap;
	withInterceptor?: boolean;
}) {
	const executeDirectChatActivity = vi.fn(
		(_input: DirectChatWorkflowInput, ..._rest: unknown[]) =>
			options.execute(),
	);
	const generateMemoryContextActivity = vi.fn(
		async (..._args: unknown[]) => ({ context: "", memoryCount: 0 }),
	);
	const retrieveWorkspaceDocumentsActivity = vi.fn(
		async (..._args: unknown[]) => ({ context: "", chunkCount: 0 }),
	);
	const taskQueue = `direct-usage-limit-${taskQueueSeq++}`;
	const workflowId = `${taskQueue}-wf`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: options.bundle ?? workflowBundle,
		activities: {
			collectMcpToolsActivity: async () => ({
				tools: {},
				toolToServerMap: {},
				// Tools in scope: the tools-off rerun is reachable.
				mcpToolInfo: [
					{
						configId: "mcp-1",
						serverName: "example",
						configName: "Example",
						tools: [{ name: "search" }],
					},
				],
			}),
			generateMemoryContextActivity,
			retrieveWorkspaceDocumentsActivity,
			generateToolSuggestionsActivity: async () => "",
			executeDirectChatActivity,
		},
		...(options.withInterceptor
			? {
					interceptors: {
						activityInbound: [
							() => new AiUsageLimitActivityInboundInterceptor(),
						],
					},
				}
			: {}),
	});
	const outcome: { result?: DirectChatWorkflowOutput; error?: unknown } =
		await worker
			.runUntil(
				env.client.workflow.execute("directChatWorkflow", {
					args: [
						{
							...INPUT,
							executionId: workflowId,
							conversationId: options.conversationId,
						},
					],
					taskQueue,
					workflowId,
				}),
			)
			.then(
				(
					result,
				): { result?: DirectChatWorkflowOutput; error?: unknown } => ({
					result: result as DirectChatWorkflowOutput,
				}),
				(error: unknown) => ({ error }),
			);
	return {
		...outcome,
		executeDirectChatActivity,
		workflowId,
	};
}

describe("directChatWorkflow — a usage limit reached during the turn", () => {
	// Unchanged-behaviour control: a partial answer is `success: true`, which
	// never reached the tools-off rerun, so this passes with or without the
	// new patch. It pins that the result's `usageLimit` survives the workflow.
	it("control: returns a partial answer and its limit unchanged, with no rerun as before", async () => {
		const { result, executeDirectChatActivity } = await runTurn({
			execute: async () => ({
				success: true,
				responseText: "Here is the first part.",
				partialError: USAGE_LIMIT.message,
				usageLimit: USAGE_LIMIT,
			}),
		});

		expect(executeDirectChatActivity).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			success: true,
			responseText: "Here is the first part.",
			partialError: USAGE_LIMIT.message,
			usageLimit: USAGE_LIMIT,
		});
	});

	it("returns a refused turn with its limit, without rerunning it without tools", async () => {
		const { result, executeDirectChatActivity } = await runTurn({
			execute: async () => REFUSED_TURN,
		});

		expect(executeDirectChatActivity).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject(REFUSED_TURN);
	});

	it("still reruns a turn that failed for any other reason without tools", async () => {
		const { executeDirectChatActivity } = await runTurn({
			execute: async () => ({ success: false, error: "tools rejected" }),
		});

		expect(executeDirectChatActivity).toHaveBeenCalledTimes(2);
		expect(executeDirectChatActivity.mock.calls[1]?.[0]).toMatchObject({
			forceDisableTools: true,
		});
	});

	it("replays a refused turn recorded before the patch, which reran it", async () => {
		const { executeDirectChatActivity, workflowId } = await runTurn({
			bundle: prePatchBundle,
			execute: async () => REFUSED_TURN,
		});
		// The code before the patch reran the refused turn without tools.
		expect(executeDirectChatActivity).toHaveBeenCalledTimes(2);

		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();
		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	});
});

describe("directChatWorkflow failure cause", () => {
	it("posts the inner activity error as the failure summary", async () => {
		const { error, workflowId } = await runTurn({
			conversationId: "example-conversation",
			execute: async () => {
				throw new Error("Example provider is not configured");
			},
		});
		expect(error).toBeDefined();
		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();
		const child = history.events?.find(
			(event) =>
				event.startChildWorkflowExecutionInitiatedEventAttributes
					?.workflowType?.name === "directChatPostOperationWorkflow",
		)?.startChildWorkflowExecutionInitiatedEventAttributes;
		expect(child).toBeDefined();
		const payload = child?.input?.payloads?.[0];
		if (!payload) {
			throw new Error("Failure summary child input is missing");
		}
		expect(defaultPayloadConverter.fromPayload(payload)).toMatchObject({
			conversationId: "example-conversation",
			outcome: "failure",
			summary: "Example provider is not configured",
		});
	});

	it("preserves the activity failure and its original generic error", async () => {
		const { error } = await runTurn({
			execute: async () => {
				throw new Error("Example provider is not configured");
			},
		});
		expect(error).toMatchObject({
			cause: {
				type: "DIRECT_CHAT_FAILED",
				message: "Activity task failed",
				nonRetryable: true,
				cause: {
					name: "ActivityFailure",
					cause: {
						message: "Example provider is not configured",
						type: "Error",
					},
				},
			},
		});
	});
});

describe("the worker's AI usage-limit activity interceptor", () => {
	const wrappedRefusal = () =>
		new RetryError({
			message: "Failed after 2 attempts.",
			reason: "errorNotRetryable",
			errors: [new Error("provider overloaded"), limitError()],
		});

	it("stops Temporal retrying an activity whose limit refusal the SDK wrapped", async () => {
		const { error, executeDirectChatActivity } = await runTurn({
			withInterceptor: true,
			execute: async () => {
				throw wrappedRefusal();
			},
		});

		expect(error).toBeDefined();
		expect(executeDirectChatActivity).toHaveBeenCalledTimes(1);
	});

	it("is what stops it: without the interceptor the wrapped refusal is retried", async () => {
		const { error, executeDirectChatActivity } = await runTurn({
			execute: async () => {
				throw wrappedRefusal();
			},
		});

		expect(error).toBeDefined();
		// The activity's retry policy allows three attempts.
		expect(executeDirectChatActivity).toHaveBeenCalledTimes(3);
	});
});
