import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	frame: vi.fn(),
	bind: vi.fn(),
	get: vi.fn(),
	run: vi.fn(),
	history: vi.fn(),
}));
vi.mock("../tools/frame-context", async (importOriginal) => ({
	...(await importOriginal<typeof import("../tools/frame-context")>()),
	accessibleFrame: mocks.frame,
}));
vi.mock("@repo/api/modules/workflows/lib/workspace-workflow-commands", () => ({
	bindWorkspaceWorkflowCommand: mocks.bind,
	getWorkspaceWorkflowCommand: mocks.get,
	runWorkspaceWorkflowCommand: mocks.run,
	listWorkspaceWorkflowRunsCommand: mocks.history,
}));

import { FABRIC_WORKFLOW_TOOL_DEFINITIONS } from "@repo/temporal/fabric-workflow-tool-definitions";
import type { GatewaySession } from "../types";
import {
	handleBindWorkspaceWorkflow,
	handleGetWorkspaceWorkflow,
} from "../tools/page-workflows";

const session: GatewaySession = {
	sessionId: "session-1",
	userId: "owner-1",
	organizationId: "org-1",
	userName: "Example User",
	email: "user@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["workflows:write"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};
const args = { frameId: "workspace-1", workflowId: "workflow-1" };

beforeEach(() => {
	vi.resetAllMocks();
	mocks.frame.mockResolvedValue({ id: args.frameId, projectId: "project-1" });
	mocks.bind.mockResolvedValue({ action: "bind" });
	mocks.get.mockResolvedValue({ workflowId: args.workflowId });
});

describe("Workspace workflow gateway", () => {
	it("requires both frame and workflow write scopes for binding", async () => {
		const definition = FABRIC_WORKFLOW_TOOL_DEFINITIONS.find(
			(tool) => tool.name === "fabric_bind_workspace_workflow",
		);
		expect(definition).toMatchObject({
			scope: "workflows:write",
			confirm: "always",
		});
		const result = await handleBindWorkspaceWorkflow(args, session);
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text).reason).toBe(
			"insufficient_scope",
		);
		expect(mocks.bind).not.toHaveBeenCalled();
		expect(mocks.frame).not.toHaveBeenCalled();
	});
	it.each([
		{ scopes: ["*"] },
		{ scopes: ["workflows:write", "frames:write"] },
		{ scopes: ["mcp:write"] },
	])(
		"accepts sufficient frame scopes %j while retaining live command authorization",
		async ({ scopes }) => {
			await handleBindWorkspaceWorkflow(args, { ...session, scopes });
			expect(mocks.bind).toHaveBeenCalledWith(
				{
					userId: session.userId,
					organizationId: session.organizationId,
					projectRestrictionId: "project-1",
				},
				args,
				{
					userId: session.userId,
					emailSnapshot: session.email,
					nameSnapshot: session.userName,
				},
			);
		},
	);
	it("refuses a pinned caller's other project before invoking a command", async () => {
		const result = await handleGetWorkspaceWorkflow(args, {
			...session,
			pinnedProjectId: "other-project",
		});
		expect(result.isError).toBe(true);
		expect(mocks.get).not.toHaveBeenCalled();
	});
});
