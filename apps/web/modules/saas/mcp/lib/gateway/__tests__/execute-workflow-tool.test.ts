/**
 * `fabric_execute_workflow` and `fabric_get_workflow_execution`.
 *
 * The execute tool used to start a workflow type that is not registered, under
 * an id it invented, with no execution row behind it; the run never began and
 * the "executionId" it handed back was a string the status tool could not
 * find. The start now goes through the same command the builder's Run button
 * uses (`startWorkflowExecutionCommand`, covered in
 * `packages/api/modules/workflows/lib/__tests__/workflow-commands.test.ts`),
 * and these pin what the tool makes of its outcomes: the id it returns is the
 * row's, an unconfirmed start is a normal result that says not to call again,
 * and every refusal is an error result written for a person.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/execute-workflow-tool
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	startWorkflowExecutionCommand: vi.fn(),
	getWorkflowExecutionCommand: vi.fn(),
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({}));

vi.mock("@repo/api/modules/workflows/lib/workflow-execution-commands", () => ({
	startWorkflowExecutionCommand: mocks.startWorkflowExecutionCommand,
	listWorkflowRunsCommand: vi.fn(),
}));

vi.mock("@repo/api/modules/workflows/lib/workflow-read-commands", () => ({
	getWorkflowExecutionCommand: mocks.getWorkflowExecutionCommand,
}));

import { WorkflowCommandError } from "@repo/api/modules/workflows/lib/workflow-command-context";
import { executePlatformTool } from "../platform-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-1",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "personal-key",
	scopes: ["*"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

/** Parse the JSON payload a platform tool packs into its text content block. */
function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

const EXECUTION = { id: "exec-1", status: "PENDING" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.startWorkflowExecutionCommand.mockResolvedValue({
		status: "started",
		execution: EXECUTION,
		temporalWorkflowId: "workflow-execution-exec-1",
		workflowName: "Nightly digest",
	});
});

describe("fabric_execute_workflow", () => {
	it("starts the run for the session's user in the session's organization, with the inputs", async () => {
		await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1", inputs: { day: "monday" } },
			session,
		);

		expect(mocks.startWorkflowExecutionCommand).toHaveBeenCalledWith(
			{ userId: "user-1", organizationId: "org-1" },
			{
				workflowId: "wf-1",
				triggerData: { day: "monday" },
				requirePublished: true,
				source: "mcp-gateway",
			},
		);
	});

	it("returns the execution row's id — the one the status tool can find", async () => {
		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			session,
		);

		expect(result.isError).toBeFalsy();
		const body = payload(result);
		expect(body.executionId).toBe("exec-1");
		expect(body.status).toBe("RUNNING");
		expect(body.executionId).not.toMatch(/^mcp-wf-/);
	});

	it("runs a published scheduled workflow: the trigger type is not part of the rule", async () => {
		// The command is asked for a published workflow and nothing about its
		// trigger; the tool never reads the trigger type.
		await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-scheduled" },
			session,
		);

		const [, input] = mocks.startWorkflowExecutionCommand.mock.calls[0];
		expect(input).toMatchObject({ requirePublished: true });
		expect(input).not.toHaveProperty("triggerType");
	});

	it("reports a failed start as an error naming the reason", async () => {
		mocks.startWorkflowExecutionCommand.mockResolvedValue({
			status: "failed",
			execution: EXECUTION,
			temporalWorkflowId: null,
			workflowName: "Nightly digest",
			message: "connection refused",
		});

		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/connection refused/);
	});

	it("returns a non-error unconfirmed result naming the execution to poll when the start cannot be confirmed either way", async () => {
		mocks.startWorkflowExecutionCommand.mockResolvedValue({
			status: "unconfirmed",
			execution: EXECUTION,
			temporalWorkflowId: "workflow-execution-exec-1",
			workflowName: "Nightly digest",
			message:
				"The workflow engine did not confirm whether execution exec-1 started.",
		});

		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			session,
		);

		// Not an error: agents retry errors, and a retry is a second run.
		expect(result.isError).toBeFalsy();
		const body = payload(result);
		expect(body.status).toBe("unconfirmed");
		expect(body.executionId).toBe("exec-1");
		expect(body.message).toMatch(/exec-1/);
		expect(body.message).toMatch(/fabric_get_workflow_execution/);
		expect(body.message).toMatch(/do not call this tool again/i);
	});

	it.each([
		["NOT_FOUND", "Workflow not found"],
		[
			"BAD_REQUEST",
			"Workflow is DRAFT; only a published workflow can be run",
		],
		[
			"FORBIDDEN",
			"You do not have permission to run workflows in this organization",
		],
		[
			"TOO_MANY_REQUESTS",
			"This workspace already has 25 workflow executions running",
		],
	] as const)(
		"answers a %s refusal as an error result",
		async (code, message) => {
			mocks.startWorkflowExecutionCommand.mockRejectedValue(
				new WorkflowCommandError(code, message),
			);

			const result = await executePlatformTool(
				"fabric_execute_workflow",
				{ workflowId: "wf-1" },
				session,
			);

			expect(result.isError).toBe(true);
			expect(payload(result).error).toBe(message);
		},
	);

	it("refuses a session with no organization instead of skipping the permission check — there is no personal arm", async () => {
		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			{ ...session, organizationId: null },
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/organization/);
		expect(mocks.startWorkflowExecutionCommand).not.toHaveBeenCalled();
	});

	it("refuses a call without a workflow id", async () => {
		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{},
			session,
		);

		expect(result.isError).toBe(true);
		expect(mocks.startWorkflowExecutionCommand).not.toHaveBeenCalled();
	});

	it("is held to workflows:run, not to the read or write scopes", async () => {
		const result = await executePlatformTool(
			"fabric_execute_workflow",
			{ workflowId: "wf-1" },
			{ ...session, scopes: ["workflows:read", "workflows:write"] },
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/workflows:run/);
		expect(mocks.startWorkflowExecutionCommand).not.toHaveBeenCalled();
	});
});

describe("fabric_get_workflow_execution", () => {
	it("finds the row the execute tool returned, with the page a run published", async () => {
		mocks.getWorkflowExecutionCommand.mockResolvedValue({
			id: "exec-1",
			workflowId: "wf-1",
			status: "COMPLETED",
			startedAt: new Date("2026-08-08T00:00:00Z"),
			completedAt: new Date("2026-08-08T00:01:00Z"),
			output: { "publish-frame": { frameId: "frame-1" } },
			error: null,
			duration: 60_000,
		});

		const result = await executePlatformTool(
			"fabric_get_workflow_execution",
			{ executionId: "exec-1" },
			session,
		);

		expect(mocks.getWorkflowExecutionCommand).toHaveBeenCalledWith(
			{ userId: "user-1", organizationId: "org-1" },
			"exec-1",
		);
		expect(payload(result)).toEqual(
			expect.objectContaining({
				id: "exec-1",
				status: "COMPLETED",
				frameId: "frame-1",
			}),
		);
	});

	it("answers the command's refusal as an error result, as for another organization's run", async () => {
		mocks.getWorkflowExecutionCommand.mockRejectedValue(
			new WorkflowCommandError("NOT_FOUND", "Execution not found"),
		);

		const result = await executePlatformTool(
			"fabric_get_workflow_execution",
			{ executionId: "exec-other" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe("Execution not found");
	});

	it("refuses a call without an execution id", async () => {
		const result = await executePlatformTool(
			"fabric_get_workflow_execution",
			{},
			session,
		);

		expect(result.isError).toBe(true);
		expect(mocks.getWorkflowExecutionCommand).not.toHaveBeenCalled();
	});
});
