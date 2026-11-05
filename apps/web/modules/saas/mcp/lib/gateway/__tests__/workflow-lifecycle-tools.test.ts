import { beforeEach, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({
	versions: vi.fn(),
	get: vi.fn(),
	configure: vi.fn(),
	change: vi.fn(),
}));
vi.mock("@repo/api/modules/workflows/lib/workflow-lifecycle-commands", () => ({
	listWorkflowVersionsCommand: m.versions,
	getWorkflowScheduleCommand: m.get,
	configureWorkflowScheduleCommand: m.configure,
	changeWorkflowLifecycleCommand: m.change,
}));

import { WorkflowCommandError } from "@repo/api/modules/workflows/lib/workflow-command-context";
import { createWorkflowLifecycleTools } from "../tools/workflow-lifecycle-tools";

const family = createWorkflowLifecycleTools();
const handler = (name: string) => {
	const value = family.handlers.get(name);
	if (!value) throw new Error("Missing handler");
	return value;
};
const session = {
	userId: "example-user",
	organizationId: "example-org",
	credential: "api-key",
	scopes: ["workflows:read", "workflows:write"],
} as GatewaySession;
beforeEach(() => {
	vi.clearAllMocks();
	m.get.mockResolvedValue({ state: "inactive" });
});
it.each([
	{ scopes: [] },
	{ scopes: ["mcp:*"] },
	{ organizationId: null },
	{ projectId: "example-project" },
	{ pinnedProjectId: "example-project" },
	{ pageProjectId: "example-project" },
	{ credential: "service" },
])(
	"refuses constrained credentials before loading a workflow %j",
	async (patch) => {
		expect(
			(
				await handler("fabric_get_workflow_schedule")(
					{ workflowId: "example-workflow" },
					{ ...session, ...patch } as GatewaySession,
				)
			).isError,
		).toBe(true);
		expect(m.get).not.toHaveBeenCalled();
	},
);
it("does not accept client authority fields", async () => {
	expect(
		(
			await handler("fabric_get_workflow_schedule")(
				{ workflowId: "example-workflow", organizationId: "other-org" },
				session,
			)
		).isError,
	).toBe(true);
	expect(m.get).not.toHaveBeenCalled();
});
it("passes current actor and exact schedule draft to the shared command", async () => {
	await handler("fabric_configure_workflow_schedule")(
		{ workflowId: "example-workflow", cron: "0 9 * * 1" },
		session,
	);
	expect(m.configure).toHaveBeenCalledWith(
		{ userId: session.userId, organizationId: session.organizationId },
		{ workflowId: "example-workflow", cron: "0 9 * * 1", timezone: "UTC" },
	);
	expect(
		family.definitions.find(
			(d) => d.name === "fabric_configure_workflow_schedule",
		)?._meta?.["fabric/confirm"],
	).toBe(true);
});
it("preserves current permission failures even for wildcard keys", async () => {
	m.get.mockRejectedValue(
		new WorkflowCommandError("FORBIDDEN", "Current permission required"),
	);
	const result = await handler("fabric_get_workflow_schedule")(
		{ workflowId: "example-workflow" },
		{ ...session, scopes: ["*"] },
	);
	expect(result.isError).toBe(true);
	expect(JSON.stringify(result)).toContain("FORBIDDEN");
});
it("advertises optional defaults and a destructive rollback honestly", () => {
	const versions = family.definitions.find(
		(d) => d.name === "fabric_list_workflow_versions",
	);
	const schedule = family.definitions.find(
		(d) => d.name === "fabric_configure_workflow_schedule",
	);
	expect(versions?.inputSchema.required).toEqual(["workflowId"]);
	expect(schedule?.inputSchema.required).toEqual(["workflowId", "cron"]);
	expect(
		family.definitions.find((d) => d.name === "fabric_rollback_workflow")
			?.annotations?.destructiveHint,
	).toBe(true);
});
