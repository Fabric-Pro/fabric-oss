import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentPreviewState,
	agentPreviewStartSchema,
} from "../../lib/agent-preview-contracts";

const m = vi.hoisted(() => ({
	prepare: vi.fn(),
	model: vi.fn(),
	read: vi.fn(),
	options: [] as Array<Record<string, unknown>>,
	query: undefined as undefined | (() => AgentPreviewState),
	cancelled: false,
}));
vi.mock("@temporalio/workflow", async () => ({
	...(await vi.importActual<typeof import("@temporalio/common")>(
		"@temporalio/common",
	)),
	ActivityCancellationType: {
		WAIT_CANCELLATION_COMPLETED: "WAIT_CANCELLATION_COMPLETED",
	},
	CancellationScope: {
		current: () => ({ consideredCancelled: m.cancelled }),
	},
	isCancellation: (error: unknown) =>
		error instanceof Error && error.name === "CancelledFailure",
	defineQuery: (name: string) => name,
	setHandler: (_name: string, handler: () => AgentPreviewState) => {
		m.query = handler;
	},
	proxyActivities: (options: Record<string, unknown>) => {
		m.options.push(options);
		return {
			prepareAgentPreview: (input: unknown) =>
				m.prepare(structuredClone(input)),
			executeAgentPreviewModelStep: (input: unknown) =>
				m.model(structuredClone(input)),
			executeAgentPreviewReadStep: (input: unknown) =>
				m.read(structuredClone(input), options),
		};
	},
}));

import { agentDraftPreviewWorkflow } from "../agent-draft-preview";

const base = {
	actor: { userId: "example-user", organizationId: "example-org" },
	request: agentPreviewStartSchema.parse({
		draft: { instructions: "Use selected knowledge", maxIterations: 3 },
		userMessage: "Summarize delivery",
		idempotencyKey: "94770974-0787-46ec-ac0a-1d5898c43c8c",
	}),
	draftHash: "a".repeat(64),
};
const calls = [
	{
		id: "example-read-1",
		name: "fabric_get_project_document",
		args: { documentId: "example-document" },
		source: {
			configId: "builtin",
			originalName: "fabric_get_project_document",
		},
	},
	{
		id: "example-read-2",
		name: "fabric_get_project_source",
		args: { sourceId: "example-source" },
		source: {
			configId: "builtin",
			originalName: "fabric_get_project_source",
		},
	},
];
const messages = [
	{
		role: "assistant",
		content: calls.map((call) => ({
			type: "tool-call",
			toolCallId: call.id,
			toolName: call.name,
			input: call.args,
		})),
		providerOptions: { example: { preserved: true } },
	},
];
const decision = {
	success: true,
	response: "",
	modelStep: { messages, toolCalls: calls },
};
const prepared = {
	documents: [],
	sources: [
		{
			id: "example-skill",
			title: "Delivery reporting",
			kind: "skill",
			revision: "a".repeat(64),
		},
	],
	turn: { systemPrompt: "Frozen draft", userMessage: "Summarize delivery" },
};
beforeEach(() => {
	vi.resetAllMocks();
	m.cancelled = false;
	m.query = undefined;
	m.options.length = 0;
	m.prepare.mockResolvedValue(prepared);
	m.model.mockResolvedValueOnce(decision).mockResolvedValue({
		success: true,
		response: "Verified report",
		modelStep: {
			messages: [{ role: "assistant", content: "Verified report" }],
			toolCalls: [],
		},
	});
	m.read.mockImplementation(async ({ decision: call }) => ({
		call: {
			id: call.id,
			name: call.name,
			status: "success",
			durationMs: 3,
		},
		result: { text: `Read ${call.id}` },
		source: {
			id: call.id,
			title: `Document ${call.id}`,
			kind: "project_source",
			revision: "b".repeat(64),
		},
	}));
});
describe("draft preview durable orchestration", () => {
	it("checkpoints model decisions separately from ordered read activities and preserves exact continuation", async () => {
		const result = await agentDraftPreviewWorkflow(base);
		expect(result).toMatchObject({
			status: "COMPLETED",
			response: "Verified report",
			draftHash: base.draftHash,
		});
		expect(m.prepare).toHaveBeenCalledWith(base);
		expect(m.model).toHaveBeenCalledTimes(2);
		expect(m.read).toHaveBeenCalledTimes(2);
		expect(m.model.mock.calls[0][0].continuationMessages).toEqual([]);
		const continued = m.model.mock.calls[1][0].continuationMessages;
		expect(continued[0]).toEqual(messages[0]);
		expect(
			continued
				.slice(1)
				.map(
					(message: { content: Array<{ toolCallId: string }> }) =>
						message.content[0].toolCallId,
				),
		).toEqual(calls.map((call) => call.id));
		expect(
			m.read.mock.calls.map(([, options]) => options.activityId),
		).toEqual(["preview-read-0-0", "preview-read-0-1"]);
		for (const [, options] of m.read.mock.calls) {
			expect(options).toMatchObject({
				retry: { maximumAttempts: 1 },
				cancellationType: "WAIT_CANCELLATION_COMPLETED",
			});
		}
		expect(result.toolCalls.map((call) => call.id)).toEqual(
			calls.map((call) => call.id),
		);
		expect(result.sources).toHaveLength(3);
		expect(m.query?.()).toEqual(result);
	});
	it("retains acknowledged earlier reads when a later read fails", async () => {
		m.read
			.mockResolvedValueOnce({
				call: {
					id: calls[0].id,
					name: calls[0].name,
					status: "success",
					durationMs: 1,
				},
				result: { text: "Verified first read" },
			})
			.mockRejectedValueOnce(new Error("private connector failure"));
		const result = await agentDraftPreviewWorkflow(base);
		expect(result.status).toBe("FAILED");
		expect(result.toolCalls).toMatchObject([
			{ id: calls[0].id, status: "success" },
		]);
		expect(m.model).toHaveBeenCalledTimes(1);
		expect(result.error).not.toContain("private");
	});
	it("retains acknowledged reads when the next model fails", async () => {
		m.model
			.mockReset()
			.mockResolvedValueOnce(decision)
			.mockRejectedValueOnce(new Error("private provider failure"));
		const result = await agentDraftPreviewWorkflow(base);
		expect(result.status).toBe("FAILED");
		expect(result.toolCalls).toHaveLength(2);
		expect(m.read).toHaveBeenCalledTimes(2);
		expect(result.error).not.toContain("private");
	});
	it("bounds continuation and does not ask the model to process excessive read output", async () => {
		m.read.mockResolvedValue({
			call: {
				id: calls[0].id,
				name: calls[0].name,
				status: "success",
				durationMs: 1,
			},
			result: { text: "x".repeat(132000) },
		});
		const result = await agentDraftPreviewWorkflow(base);
		expect(result.status).toBe("FAILED");
		expect(result.toolCalls).toHaveLength(1);
		expect(m.model).toHaveBeenCalledTimes(1);
		expect(m.read).toHaveBeenCalledTimes(1);
	});
	it("stops at the configured iteration limit with a clear outcome", async () => {
		m.model.mockReset().mockResolvedValue(decision);
		const result = await agentDraftPreviewWorkflow({
			...base,
			request: {
				...base.request,
				draft: { ...base.request.draft, maxIterations: 1 },
			},
		});
		expect(result).toMatchObject({
			status: "FAILED",
			phase: "Preview stopped at its step limit",
		});
		expect(result.error).toContain("step limit");
		expect(m.model).toHaveBeenCalledTimes(1);
	});
	it("reports cooperative cancellation without leaking underlying activity text", async () => {
		m.read.mockRejectedValue(
			Object.assign(new Error("private aborted read"), {
				name: "CancelledFailure",
			}),
		);
		const result = await agentDraftPreviewWorkflow(base);
		expect(result).toMatchObject({
			status: "CANCELLED",
			phase: "Preview stopped",
		});
		expect(result.error).toContain("draft is preserved");
		expect(m.model).toHaveBeenCalledTimes(1);
		expect(m.read).toHaveBeenCalledTimes(1);
	});
	it("preserves prepared sources when the first model fails", async () => {
		m.model
			.mockReset()
			.mockRejectedValue(new Error("private provider failure"));
		const result = await agentDraftPreviewWorkflow(base);
		expect(result.sources).toEqual(prepared.sources);
		expect(result.toolCalls).toEqual([]);
		expect(result.status).toBe("FAILED");
	});
	it("stops before any model when preparation loses access", async () => {
		m.prepare.mockRejectedValue(new Error("private inaccessible source"));
		const result = await agentDraftPreviewWorkflow(base);
		expect(result.status).toBe("FAILED");
		expect(m.model).not.toHaveBeenCalled();
		expect(m.read).not.toHaveBeenCalled();
	});
});

it.each([
	["AGENT_PREVIEW_TOO_LARGE", "Select at most 30"],
	["AGENT_PREVIEW_NOT_READY", "Choose specific ready documents"],
	["AGENT_PREVIEW_TOOL_REFUSED", "source read could not complete"],
	["AGENT_PREVIEW_MODEL_INVALID_DECISION", "invalid read request"],
	["AGENT_PREVIEW_MODEL_FAILED", "AI connection"],
	["AgentPreviewAccessError", "current access"],
])(
	"maps safe failure type %s without exposing its raw message",
	async (type, hint) => {
		const { ApplicationFailure, ActivityFailure, RetryState } =
			await import("@temporalio/common");
		m.prepare.mockRejectedValue(
			new ActivityFailure(
				"private activity metadata",
				"prepareAgentPreview",
				"example-activity",
				RetryState.NON_RETRYABLE_FAILURE,
				"example-worker",
				ApplicationFailure.nonRetryable(
					"private provider/source message",
					type,
				),
			),
		);
		const result = await agentDraftPreviewWorkflow(base);
		expect(result.status).toBe("FAILED");
		expect(result.error).toContain(hint);
		expect(JSON.stringify(result)).not.toContain("private");
	},
);
