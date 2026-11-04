import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	lookup: vi.fn(),
	scope: vi.fn(),
	project: vi.fn(),
	admitted: vi.fn(),
	signed: vi.fn(),
	client: vi.fn(),
	describe: vi.fn(),
	query: vi.fn(),
	result: vi.fn(),
	handle: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { agentDeploymentExecution: { findFirst: h.lookup } },
	getAgentTemplateInstanceForRead: h.scope,
	getProjectAccessContext: h.project,
	isProjectSoftDeleted: async () => false,
	readAgentExecutionAdmission: h.admitted,
	resolveExecutionChatMediaAccess: async () => "allow",
}));
vi.mock("@repo/storage", () => ({ getSignedUrl: h.signed }));
vi.mock("@repo/temporal", () => ({ getTemporalClient: h.client }));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { chatDocuments: "example" } } },
}));

import type { ExternalApiContext } from "../../types";
import {
	authorizeAgentExecutionStream,
	canReadAgentExecution,
	getExecution,
} from "../get-execution";

const actor: ExternalApiContext = {
	userId: "example-user",
	organizationId: "example-org",
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "example",
	scopes: ["agents:read"],
};
const scopeRow = {
	metadata: {},
	deployment: {
		instanceId: "example-instance",
		userId: actor.userId,
		organizationId: actor.organizationId,
	},
};
let execution: Record<string, unknown>;
beforeEach(() => {
	vi.clearAllMocks();
	execution = {
		id: "example-execution",
		executionId: "example-execution-uuid",
		deploymentId: "example-deployment",
		userId: actor.userId,
		organizationId: actor.organizationId,
		metadata: {},
		workflowId: "example-workflow",
		runId: "example-run",
		status: "COMPLETED",
		output: { text: "Example" },
		steps: [],
		inputTokens: 0,
		outputTokens: 0,
	};
	h.lookup.mockImplementation(async ({ select }) =>
		select.deployment ? scopeRow : execution,
	);
	h.scope.mockResolvedValue({ instance: {}, projectId: "example-project" });
	h.project.mockResolvedValue({ organizationId: actor.organizationId });
	h.admitted.mockReturnValue({
		requestHash: "a".repeat(64),
		dispatch: {
			projectId: "example-original",
			workflowType: "deploymentExecutionWorkflow",
		},
	});
	h.client.mockRejectedValue(new Error("Offline"));
	h.handle.mockReturnValue({
		describe: h.describe,
		query: h.query,
		result: h.result,
	});
	h.describe.mockResolvedValue({
		type: "deploymentExecutionWorkflow",
		runId: "example-run",
		status: { name: "COMPLETED" },
		memo: {
			fabricAgentAdmission: {
				version: 1,
				executionId: "example-execution",
				organizationId: actor.organizationId,
				userId: actor.userId,
				requestHash: "a".repeat(64),
			},
		},
	});
	h.result.mockResolvedValue({
		executionId: "example-execution-uuid",
		status: "COMPLETED",
		output: { text: "Actual native output" },
		durationMs: 700,
	});
	h.signed.mockResolvedValue("https://example.com/signed-artifact");
});
function online() {
	h.client.mockResolvedValue({
		workflow: { getHandle: h.handle },
		connection: {
			withDeadline: (_deadline: number, fn: () => unknown) => fn(),
		},
	});
}
describe("execution output audience", () => {
	it("queries owner and organization and intersects current and admitted project scope", async () => {
		expect(await canReadAgentExecution("example-execution", actor)).toBe(
			true,
		);
		expect(h.lookup).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "example-execution",
					userId: actor.userId,
					organizationId: actor.organizationId,
				},
			}),
		);
		expect(h.project).toHaveBeenCalledWith(
			"example-original",
			actor.userId,
		);
	});
	it("denies original project revocation even after the agent moved to a project the caller can read", async () => {
		h.project.mockResolvedValue(null);
		expect(await getExecution("example-execution", actor)).toBeNull();
		expect(h.signed).not.toHaveBeenCalled();
	});
	it("does not return another deployment owner's result", async () => {
		h.lookup.mockResolvedValue({
			...scopeRow,
			deployment: { ...scopeRow.deployment, userId: "example-other" },
		});
		expect(await getExecution("example-execution", actor)).toBeNull();
	});
	it("refuses project-bound credentials reaching a different historical audience", async () => {
		expect(
			await canReadAgentExecution("example-execution", {
				...actor,
				boundProjectId: "example-project",
			}),
		).toBe(false);
	});
	it("returns a typed confirmed receipt and actual output", async () => {
		expect(await getExecution("example-execution", actor)).toMatchObject({
			executionId: "example-execution",
			workflowId: "example-workflow",
			admissionStatus: "CONFIRMED",
			output: { text: "Example" },
		});
	});
	it("observes a lost start acknowledgement without a DB run ID or a new start", async () => {
		execution.runId = null;
		execution.status = "PENDING";
		online();
		expect(await getExecution("example-execution", actor)).toMatchObject({
			status: "COMPLETED",
			runId: "example-run",
			admissionStatus: "CONFIRMED",
			executionStateSource: "temporal",
			lastRecordedStatus: "PENDING",
			output: { text: "Actual native output" },
		});
		expect(h.handle).toHaveBeenCalledWith("example-workflow", undefined);
		expect(h.handle).toHaveBeenLastCalledWith(
			"example-workflow",
			"example-run",
			{ followRuns: false },
		);
	});
	it("uses the closed business failure over a stale running projection and preserves archival data", async () => {
		execution.status = "RUNNING";
		execution.totalCost = "0.02";
		execution.steps = [{ stepNumber: 1, status: "COMPLETED" }];
		execution.output = {
			artifacts: [
				{
					id: "example-artifact",
					name: "Report",
					mimeType: "text/plain",
					storagePath: "example-org/reports/example.txt",
				},
				{
					id: "example-foreign",
					name: "Private",
					mimeType: "text/plain",
					storagePath: "example-other/reports/example.txt",
				},
			],
		};
		h.result.mockResolvedValue({
			executionId: "example-execution-uuid",
			status: "FAILED",
			error: "Goal not met",
			output: { text: "Partial" },
		});
		online();
		expect(await getExecution("example-execution", actor)).toMatchObject({
			status: "FAILED",
			error: "Goal not met",
			output: { text: "Partial" },
			tokenUsage: { totalCost: 0.02 },
			steps: [{ stepNumber: 1 }],
			artifacts: [
				{
					id: "example-artifact",
					url: "https://example.com/signed-artifact",
				},
			],
		});
		expect(h.signed).toHaveBeenCalledTimes(1);
	});
	it("does not expose results from a foreign admission memo", async () => {
		execution.runId = null;
		execution.status = "PENDING";
		h.describe.mockResolvedValue({
			type: "deploymentExecutionWorkflow",
			runId: "example-other-run",
			status: { name: "COMPLETED" },
			memo: { fabricAgentAdmission: { userId: "example-other" } },
		});
		online();
		expect(await getExecution("example-execution", actor)).toMatchObject({
			status: "UNKNOWN",
			nativeReadStatus: "IDENTITY_UNVERIFIED",
		});
		expect(h.result).not.toHaveBeenCalled();
	});
	it("returns no native output or signed artifacts when access is revoked during the read", async () => {
		online();
		h.scope
			.mockResolvedValueOnce({
				instance: {},
				projectId: "example-project",
			})
			.mockResolvedValue(null);
		expect(await getExecution("example-execution", actor)).toBeNull();
		expect(h.result).toHaveBeenCalledOnce();
		expect(h.signed).not.toHaveBeenCalled();
	});
	it("reports stale nonterminal state as unknown while Temporal is down", async () => {
		execution.status = "RUNNING";
		expect(await getExecution("example-execution", actor)).toMatchObject({
			status: "UNKNOWN",
			lastRecordedStatus: "RUNNING",
			nativeReadStatus: "UNAVAILABLE",
			executionStateSource: "database",
		});
	});
	it("labels terminal database results as archival when Temporal is unavailable", async () => {
		expect(await getExecution("example-execution", actor)).toMatchObject({
			status: "COMPLETED",
			nativeStateAvailable: false,
			nativeReadStatus: "UNAVAILABLE",
			executionStateSource: "database",
		});
	});
	it("requires declared read scope before reading either system", async () => {
		expect(
			await getExecution("example-execution", {
				...actor,
				scopes: ["agents:execute"],
			}),
		).toBeNull();
		expect(h.lookup).not.toHaveBeenCalled();
		expect(h.client).not.toHaveBeenCalled();
	});
	it("does not read native history for another organization", async () => {
		expect(
			await getExecution("example-execution", {
				...actor,
				organizationId: "example-other-org",
			}),
		).toBeNull();
		expect(h.client).not.toHaveBeenCalled();
	});
	it("revalidates after artifact signing before releasing any response", async () => {
		execution.output = {
			artifacts: [
				{
					id: "example-artifact",
					name: "Report",
					mimeType: "text/plain",
					storagePath: "example-org/reports/example.txt",
				},
			],
		};
		h.signed.mockImplementation(async () => {
			h.scope.mockResolvedValue(null);
			return "https://example.com/signed-artifact";
		});
		expect(await getExecution("example-execution", actor)).toBeNull();
		expect(h.signed).toHaveBeenCalledOnce();
	});
	it("stops streaming before releasing another chunk after access is revoked", async () => {
		let source!: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				source = controller;
			},
		});
		const reader = authorizeAgentExecutionStream(
			stream,
			"example-execution",
			actor,
		).getReader();
		source.enqueue(new TextEncoder().encode("Example"));
		expect((await reader.read()).value).toBeDefined();
		h.scope.mockResolvedValue(null);
		source.enqueue(new TextEncoder().encode("Private"));
		await expect(reader.read()).rejects.toThrow("Execution access revoked");
	});
});
