import { beforeEach, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	create: vi.fn(),
	check: vi.fn(),
}));
vi.mock("@repo/api/modules/workflows/lib/workflow-authoring", () => ({
	listWorkflowStarters: m.list,
	createWorkflowFromStarter: m.create,
	checkWorkflowReadiness: m.check,
}));

import { WorkflowCommandError } from "@repo/api/modules/workflows/lib/workflow-command-context";
import { createWorkflowAuthoringTools } from "../tools/workflow-authoring-tools";

const family = createWorkflowAuthoringTools();
const session = {
	userId: "example-user",
	organizationId: "example-org",
	credential: "api-key",
	scopes: ["workflows:read", "workflows:write"],
} as GatewaySession;
beforeEach(() => {
	vi.clearAllMocks();
	m.list.mockResolvedValue([]);
	m.create.mockResolvedValue({ workflow: { id: "example-workflow" } });
	m.check.mockResolvedValue({ ready: true });
});
it("propagates current actor and confirms only draft creation", async () => {
	expect(family.scopes.fabric_create_workflow_from_starter.scope).toBe(
		"workflows:write",
	);
	await family.handlers.get("fabric_create_workflow_from_starter")!(
		{ starterId: "action-plan" },
		session,
	);
	expect(m.create).toHaveBeenCalledWith(
		{ userId: "example-user", organizationId: "example-org" },
		{ starterId: "action-plan" },
	);
	expect(
		family.definitions.find(
			(t) => t.name === "fabric_create_workflow_from_starter",
		)?.annotations?.readOnlyHint,
	).toBe(false);
});
it.each([
	{ scopes: [] },
	{ scopes: ["mcp:*"] },
	{ organizationId: null },
	{ projectId: "example-project" },
	{ pinnedProjectId: "example-project" },
	{ pageProjectId: "example-project" },
	{ credential: "service" },
])("fails closed for constrained credentials %j", async (patch) => {
	const result = await family.handlers.get("fabric_list_workflow_starters")!(
		{},
		{ ...session, ...patch } as GatewaySession,
	);
	expect(result.isError).toBe(true);
	expect(m.list).not.toHaveBeenCalled();
});
it("rejects client authority overrides", async () => {
	const r = await family.handlers.get("fabric_check_workflow_readiness")!(
		{ id: "example-workflow", organizationId: "other-org" },
		session,
	);
	expect(r.isError).toBe(true);
	expect(m.check).not.toHaveBeenCalled();
});
it("preserves current permission refusal with wildcard scopes", async () => {
	m.check.mockRejectedValue(
		new WorkflowCommandError("FORBIDDEN", "Current permission required"),
	);
	const r = await family.handlers.get("fabric_check_workflow_readiness")!(
		{ id: "example-workflow" },
		{ ...session, scopes: ["*"] },
	);
	expect(r.isError).toBe(true);
	expect(JSON.stringify(r)).toContain("FORBIDDEN");
});
