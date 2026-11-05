import { beforeEach, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({
	inspect: vi.fn(),
	save: vi.fn(),
	list: vi.fn(),
	preview: vi.fn(),
	apply: vi.fn(),
	remove: vi.fn(),
}));
vi.mock("@repo/api/modules/workflows/lib/workflow-result-checks", () => ({
	inspectWorkflowResult: m.inspect,
	saveWorkflowCheck: m.save,
	listWorkflowChecks: m.list,
	previewWorkflowCheck: m.preview,
	applyWorkflowCheck: m.apply,
	removeWorkflowCheck: m.remove,
}));

import { WorkflowCommandError } from "@repo/api/modules/workflows/lib/workflow-command-context";
import { createWorkflowResultCheckTools } from "../tools/workflow-result-check-tools";

const family = createWorkflowResultCheckTools();
const session = {
	userId: "example-user",
	organizationId: "example-org",
	credential: "api-key",
	scopes: ["workflows:read", "workflows:write"],
} as GatewaySession;
const handler = (name: string) => {
	const value = family.handlers.get(name);
	if (!value) {
		throw Error("Missing handler");
	}
	return value;
};
beforeEach(() => {
	vi.clearAllMocks();
	m.list.mockResolvedValue({ cases: [] });
});
it.each([
	{ scopes: [] },
	{ scopes: ["mcp:*"] },
	{ organizationId: null },
	{ projectId: "example-project" },
	{ pinnedProjectId: "example-project" },
	{ pageProjectId: "example-project" },
	{ credential: "service" },
])("refuses constrained credentials %j", async (patch) => {
	expect(
		(
			await handler("fabric_list_workflow_checks")(
				{ workflowId: "example-workflow" },
				{ ...session, ...patch } as GatewaySession,
			)
		).isError,
	).toBe(true);
	expect(m.list).not.toHaveBeenCalled();
});
it("propagates current actor without accepting authority overrides", async () => {
	await handler("fabric_list_workflow_checks")(
		{ workflowId: "example-workflow" },
		session,
	);
	expect(m.list).toHaveBeenCalledWith(
		{ userId: session.userId, organizationId: session.organizationId },
		{ workflowId: "example-workflow" },
	);
	m.list.mockClear();
	expect(
		(
			await handler("fabric_list_workflow_checks")(
				{ workflowId: "example-workflow", organizationId: "other" },
				session,
			)
		).isError,
	).toBe(true);
	expect(m.list).not.toHaveBeenCalled();
});
it("requires explicit confirmation only for writes and marks removal destructive", () => {
	expect(
		family.definitions.find((d) => d.name === "fabric_save_workflow_check")
			?._meta?.["fabric/confirm"],
	).toBe(true);
	expect(
		family.definitions.find(
			(d) => d.name === "fabric_remove_workflow_check",
		)?.annotations?.destructiveHint,
	).toBe(true);
	expect(
		family.definitions.find(
			(d) => d.name === "fabric_preview_workflow_check",
		)?.annotations?.readOnlyHint,
	).toBe(true);
});
it("preserves live permission refusal even for wildcard credentials", async () => {
	m.list.mockRejectedValueOnce(
		new WorkflowCommandError("FORBIDDEN", "Current permission required"),
	);
	const result = await handler("fabric_list_workflow_checks")(
		{ workflowId: "example-workflow" },
		{ ...session, scopes: ["*"] },
	);
	expect(result.isError).toBe(true);
	expect(JSON.stringify(result)).toContain("FORBIDDEN");
});
it("requires read scope as well as write scope before saving answer-derived checks", async () => {
	const result = await handler("fabric_save_workflow_check")(
		{},
		{ ...session, scopes: ["workflows:write"] },
	);
	expect(result.isError).toBe(true);
	expect(JSON.stringify(result)).toContain("INSUFFICIENT_SCOPE");
	expect(m.save).not.toHaveBeenCalled();
});
