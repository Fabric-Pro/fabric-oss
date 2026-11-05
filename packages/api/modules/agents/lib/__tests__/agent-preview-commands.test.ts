import { createHash } from "node:crypto";
import {
	agentPreviewStartSchema,
	agentPreviewUnsupported,
} from "@repo/temporal/agent-preview-contracts";
import { defaultPayloadConverter } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	access: vi.fn(),
	start: vi.fn(),
	describe: vi.fn(),
	query: vi.fn(),
	result: vi.fn(),
	cancel: vi.fn(),
	getHandle: vi.fn(),
	audit: vi.fn(),
	history: vi.fn(),
	deadline: vi.fn(),
	codecs: [] as Array<{
		decode: (payloads: unknown[], context: unknown) => Promise<unknown[]>;
	}>,
}));
vi.mock("@repo/temporal/client", async () => {
	const { defaultPayloadConverter } = await import("@temporalio/client");
	return {
		getTemporalClient: async () => ({
			workflow: {
				start: m.start,
				getHandle: m.getHandle,
				withDeadline: m.deadline,
				workflowService: { getWorkflowExecutionHistory: m.history },
				options: {
					namespace: "example-namespace",
					loadedDataConverter: {
						payloadConverter: defaultPayloadConverter,
						payloadCodecs: m.codecs,
					},
				},
			},
		}),
	};
});
vi.mock("@repo/temporal/agent-preview-access", () => ({
	AgentPreviewAccessError: class extends Error {
		constructor(
			readonly code: string,
			message: string,
		) {
			super(message);
		}
	},
	assertAgentPreviewAccess: m.access,
	previewRequestHash: (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex"),
	previewWorkflowId: (
		actor: { userId: string; organizationId: string },
		key: string,
	) => `agent-preview-${actor.organizationId}-${actor.userId}-${key}`,
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: object) => ({
		...options,
		memo: {
			...(options as { memo: object }).memo,
			correlationId: "example-correlation",
		},
	}),
}));

import { AgentPreviewAccessError } from "@repo/temporal/agent-preview-access";
import {
	cancelAgentPreviewCommand,
	getAgentPreviewCommand,
	startAgentPreviewCommand,
} from "../agent-preview-commands";
import { agentPreviewSelectionScopePolicy } from "../agent-preview-selection-policy";

const actor = { userId: "example-user", organizationId: "example-org" };
const request = agentPreviewStartSchema.parse({
	draft: { instructions: "Use only authorized knowledge." },
	userMessage: "Summarize delivery",
	idempotencyKey: "0f8792a1-1591-4db9-9231-05ada4259bb5",
});
const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
const runId = "d2e118c6-e4f9-47f8-93da-74f26d22f497";
const identity = {
	workflowId: `agent-preview-${actor.organizationId}-${actor.userId}-${request.idempotencyKey}`,
	runId,
};
const description = () => ({
	runId,
	type: "agentDraftPreviewWorkflow",
	status: { name: "RUNNING" },
	memo: {
		fabricAgentPreview: {
			...actor,
			draftHash: hash,
			version: 1,
		},
	},
});
const historyFor = (
	snapshot: unknown = { actor, request, draftHash: hash },
) => ({
	history: {
		events: [
			{
				workflowExecutionStartedEventAttributes: {
					workflowType: { name: "agentDraftPreviewWorkflow" },
					input: {
						payloads: [defaultPayloadConverter.toPayload(snapshot)],
					},
				},
			},
		],
	},
	nextPageToken: new Uint8Array([1]),
});
function selectRetained(draft: typeof request.draft) {
	const retained = { ...request, draft };
	const draftHash = createHash("sha256")
		.update(JSON.stringify(retained))
		.digest("hex");
	m.describe.mockResolvedValue({
		...description(),
		memo: { fabricAgentPreview: { version: 1, ...actor, draftHash } },
	});
	m.history.mockResolvedValue(
		historyFor({ actor, request: retained, draftHash }),
	);
	m.query.mockResolvedValue({
		status: "RUNNING",
		phase: "Preparing",
		toolCalls: [],
		sources: [],
		draftHash,
	});
}
beforeEach(() => {
	vi.resetAllMocks();
	m.codecs.length = 0;
	m.history.mockResolvedValue(historyFor());
	m.deadline.mockImplementation(
		(_deadline: number, run: () => Promise<unknown>) => run(),
	);
	m.getHandle.mockReturnValue({
		describe: m.describe,
		query: m.query,
		result: m.result,
		cancel: m.cancel,
	});
	m.describe.mockResolvedValue(description());
	m.query.mockResolvedValue({
		status: "RUNNING",
		phase: "Preparing",
		toolCalls: [],
		sources: [],
		draftHash: hash,
	});
	m.access.mockImplementation(async (_actor, draft) => {
		const issues = agentPreviewUnsupported(draft);
		if (issues.length) {
			throw new AgentPreviewAccessError("BAD_REQUEST", issues.join(" "));
		}
	});
});
describe("draft preview command boundaries", () => {
	it("keeps user content out of describe/list memo and uses the known admitted request at start", async () => {
		await startAgentPreviewCommand(actor, request, m.audit);
		const memo = m.start.mock.calls[0][1].memo;
		expect(memo.fabricAgentPreview).toEqual({
			version: 1,
			...actor,
			draftHash: hash,
		});
		expect(JSON.stringify(memo)).not.toContain(request.draft.instructions);
		expect(JSON.stringify(memo)).not.toContain(request.userMessage);
		expect(m.history).not.toHaveBeenCalled();
	});
	it("fetches only the first Started-event page for the described pinned run", async () => {
		await getAgentPreviewCommand(actor, identity);
		expect(m.history).toHaveBeenCalledExactlyOnceWith({
			namespace: "example-namespace",
			execution: { workflowId: identity.workflowId, runId },
			maximumPageSize: 1,
			waitNewEvent: false,
			skipArchival: true,
		});
		expect(m.deadline).toHaveBeenCalledWith(
			expect.any(Number),
			expect.any(Function),
		);
		expect(m.access).toHaveBeenCalledWith(actor, request.draft);
	});
	it.each([
		{
			actor: { ...actor, userId: "example-other-user" },
			request,
			draftHash: hash,
		},
		{
			actor: { ...actor, organizationId: "example-other-org" },
			request,
			draftHash: hash,
		},
		{
			actor,
			request: { ...request, userMessage: "Changed immutable task" },
			draftHash: hash,
		},
		{ actor, request, draftHash: "b".repeat(64) },
	])(
		"refuses frozen actor/hash mismatch before releasing or cancelling: %j",
		async (snapshot) => {
			m.history.mockResolvedValue(historyFor(snapshot));
			await expect(
				getAgentPreviewCommand(actor, identity),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			await expect(
				cancelAgentPreviewCommand(actor, identity, m.audit),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.access).not.toHaveBeenCalled();
			expect(m.query).not.toHaveBeenCalled();
			expect(m.cancel).not.toHaveBeenCalled();
		},
	);
	it("applies configured payload codecs in reverse order with workflow context", async () => {
		const order: string[] = [];
		m.codecs.push(
			{
				decode: async (payloads, context) => {
					expect(context).toEqual({
						type: "workflow",
						namespace: "example-namespace",
						workflowId: identity.workflowId,
					});
					order.push("first");
					return payloads;
				},
			},
			{
				decode: async (payloads) => {
					order.push("second");
					return payloads;
				},
			},
		);
		await expect(
			getAgentPreviewCommand(actor, identity),
		).resolves.toMatchObject(identity);
		expect(order).toEqual(["second", "first"]);
	});
	it("bounds the first serialized input before decoding it", async () => {
		m.history.mockResolvedValue({
			history: {
				events: [
					{
						workflowExecutionStartedEventAttributes: {
							workflowType: { name: "agentDraftPreviewWorkflow" },
							input: {
								payloads: [
									{ data: Buffer.alloc(128 * 1024 + 8193) },
								],
							},
						},
					},
				],
			},
		});
		await expect(
			getAgentPreviewCommand(actor, identity),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(m.query).not.toHaveBeenCalled();
		expect(m.access).not.toHaveBeenCalled();
	});
	it("fails closed when the initial input cannot be obtained instead of trusting memo as authority", async () => {
		m.history.mockResolvedValue({
			history: { events: [] },
			nextPageToken: new Uint8Array([1]),
		});
		await expect(
			getAgentPreviewCommand(actor, identity),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(m.history).toHaveBeenCalledOnce();
		expect(m.query).not.toHaveBeenCalled();
	});
	it("requires workspace and skill credential scopes before starting selected-resource previews", async () => {
		for (const extra of [
			{ workspaceIds: ["example-workspace"] },
			{ skillIds: ["example-skill"] },
		]) {
			await expect(
				startAgentPreviewCommand(
					actor,
					{ ...request, draft: { ...request.draft, ...extra } },
					m.audit,
					agentPreviewSelectionScopePolicy(["agents:execute"]),
				),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "INSUFFICIENT_SCOPE" },
			});
		}
		expect(m.start).not.toHaveBeenCalled();
	});
	it.each(["get", "cancel"])(
		"checks retained selected-resource scopes before %s dispatch",
		async (operation) => {
			selectRetained({
				...request.draft,
				workspaceIds: ["example-workspace"],
			});
			const policy = agentPreviewSelectionScopePolicy([
				"agents:read",
				"agents:execute",
			]);
			await expect(
				operation === "get"
					? getAgentPreviewCommand(actor, identity, policy)
					: cancelAgentPreviewCommand(
							actor,
							identity,
							m.audit,
							policy,
						),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { code: "INSUFFICIENT_SCOPE" },
			});
			expect(m.query).not.toHaveBeenCalled();
			expect(m.cancel).not.toHaveBeenCalled();
		},
	);
	it("permits wildcard selection scopes without bypassing current access", async () => {
		const selected = {
			...request.draft,
			workspaceIds: ["example-workspace"],
			skillIds: ["example-skill"],
		};
		selectRetained(selected);
		await expect(
			getAgentPreviewCommand(
				actor,
				identity,
				agentPreviewSelectionScopePolicy(["*"]),
			),
		).resolves.toMatchObject(identity);
		expect(m.access).toHaveBeenCalledWith(actor, selected);
	});
	it("returns verified identity while a new workflow is installing its query handler", async () => {
		m.query.mockRejectedValue(new Error("Query handler unavailable"));
		await expect(
			startAgentPreviewCommand(actor, request, m.audit),
		).resolves.toMatchObject({
			...identity,
			state: { status: "RUNNING", phase: "Preparing" },
		});
	});
	it("uses the final result when a completed workflow cannot answer a query", async () => {
		m.describe.mockResolvedValue({
			...description(),
			status: { name: "COMPLETED" },
		});
		m.query.mockRejectedValue(new Error("Query unavailable"));
		m.result.mockResolvedValue({
			status: "COMPLETED",
			phase: "Preview complete",
			response: "Verified response",
			toolCalls: [],
			sources: [],
			draftHash: hash,
		});
		await expect(
			getAgentPreviewCommand(actor, identity),
		).resolves.toMatchObject({
			state: { status: "COMPLETED", response: "Verified response" },
		});
	});
	it("rejects actor or organization injection in command input", async () => {
		await expect(
			getAgentPreviewCommand(actor, {
				...identity,
				organizationId: "example-other-org",
			}),
		).rejects.toBeInstanceOf(Error);
		expect(m.getHandle).not.toHaveBeenCalled();
	});
	it("rejects an unrecognized result shape instead of returning unvalidated fields", async () => {
		m.query.mockResolvedValue({
			status: "COMPLETED",
			phase: "Done",
			response: "Response",
			draftHash: hash,
			secret: "private",
		});
		await expect(
			getAgentPreviewCommand(actor, identity),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});
	it("checks memo ownership even when a caller guesses an actor-scoped workflow ID", async () => {
		m.describe.mockResolvedValue({
			...description(),
			memo: {
				fabricAgentPreview: {
					...actor,
					userId: "example-other",
					draftHash: hash,
					version: 1,
				},
			},
		});
		await expect(
			getAgentPreviewCommand(actor, identity),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.query).not.toHaveBeenCalled();
	});
	it("starts an isolated bounded workflow and pins results to its verified run", async () => {
		expect(
			await startAgentPreviewCommand(actor, request, m.audit),
		).toMatchObject({
			...identity,
			draftHash: hash,
			state: { status: "RUNNING" },
		});
		expect(m.start).toHaveBeenCalledWith(
			"agentDraftPreviewWorkflow",
			expect.objectContaining({
				workflowId: identity.workflowId,
				taskQueue: "agents",
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowIdConflictPolicy: "USE_EXISTING",
				args: [{ actor, request, draftHash: hash }],
				memo: expect.objectContaining({
					correlationId: "example-correlation",
				}),
			}),
		);
		expect(m.getHandle).toHaveBeenCalledWith(identity.workflowId, runId);
		expect(m.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "org.agent_preview.started",
				resource: { type: "agent_preview", id: identity.workflowId },
			}),
		);
		expect(JSON.stringify(m.audit.mock.calls)).not.toContain(
			request.draft.instructions,
		);
	});
	it.each([
		{ executionMode: "goal_oriented" },
		{ mcpConfigIds: ["example-external"] },
		{ integrationIds: ["example-integration"] },
		{ capabilityIds: ["send-email"] },
	])(
		"refuses unsupported configuration before starting: %j",
		async (extra) => {
			await expect(
				startAgentPreviewCommand(
					actor,
					{ ...request, draft: { ...request.draft, ...extra } },
					m.audit,
				),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(m.start).not.toHaveBeenCalled();
		},
	);
	it("bounds the complete raw payload before parsing or engine I/O", async () => {
		await expect(
			startAgentPreviewCommand(
				actor,
				{
					...request,
					history: [{ role: "user", content: "x".repeat(132000) }],
				},
				m.audit,
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.access).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});
	it("reconnects to a completed identical idempotent request", async () => {
		m.start.mockRejectedValue(
			Object.assign(new Error("duplicate"), {
				name: "WorkflowExecutionAlreadyStartedError",
			}),
		);
		await expect(
			startAgentPreviewCommand(actor, request, m.audit),
		).resolves.toMatchObject(identity);
	});
	it("refuses key reuse with a changed request", async () => {
		m.describe.mockResolvedValue({
			...description(),
			memo: {
				fabricAgentPreview: {
					...actor,
					draftHash: "a".repeat(64),
					version: 1,
				},
			},
		});
		await expect(
			startAgentPreviewCommand(actor, request, m.audit),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.query).not.toHaveBeenCalled();
		expect(m.audit).not.toHaveBeenCalled();
	});
	it.each([
		{ userId: "example-other" },
		{ organizationId: "example-other-org" },
	])("refuses another actor or tenant", async (override) => {
		await expect(
			getAgentPreviewCommand({ ...actor, ...override }, identity),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.query).not.toHaveBeenCalled();
	});
	it("does not query a different workflow type", async () => {
		m.describe.mockResolvedValue({
			...description(),
			type: "savedAgentWorkflow",
		});
		await expect(
			getAgentPreviewCommand(actor, identity),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.query).not.toHaveBeenCalled();
	});
	it("does not release results after access is revoked during retrieval", async () => {
		m.access
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(
				new AgentPreviewAccessError(
					"FORBIDDEN",
					"Current access revoked",
				),
			);
		await expect(
			getAgentPreviewCommand(actor, identity),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("pins cancellation and checks current authority", async () => {
		await expect(
			cancelAgentPreviewCommand(actor, identity, m.audit),
		).resolves.toMatchObject({ ...identity, requested: true });
		expect(m.cancel).toHaveBeenCalledOnce();
		expect(m.access).toHaveBeenCalledTimes(2);
		m.cancel.mockClear();
		m.access.mockRejectedValue(
			new AgentPreviewAccessError("FORBIDDEN", "Revoked"),
		);
		await expect(
			cancelAgentPreviewCommand(actor, identity, m.audit),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.cancel).not.toHaveBeenCalled();
	});
	it("reports failed engine state safely without internal failures", async () => {
		m.describe.mockResolvedValue({
			...description(),
			status: { name: "FAILED" },
		});
		m.query.mockRejectedValue(new Error("private provider failure"));
		const value = await getAgentPreviewCommand(actor, identity);
		expect(value.state.status).toBe("FAILED");
		expect(JSON.stringify(value)).not.toContain("private provider");
	});
});
