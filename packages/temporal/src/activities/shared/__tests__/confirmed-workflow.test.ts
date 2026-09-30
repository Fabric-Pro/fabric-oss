import { afterEach, describe, expect, it, vi } from "vitest";
import {
	withAgentToolRuntime,
	withApprovedAgentTool,
} from "../agent-tool-runtime";
import { executeApprovedWorkflow } from "../confirmed-workflow";

vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "https://fabric.example.com",
}));
vi.mock("../read-only-gate", () => ({
	guardToolWriteForReadOnly: async () => null,
}));
const input = {
	args: { workflowId: "workflow" },
	userId: "user",
	organizationId: "org",
};
const approval = {
	...input,
	configId: "builtin",
	originalName: "execute_workflow",
};
const runtime = {
	invoke: vi.fn(),
	projectScope: {
		projectId: "project",
		userId: "user",
		organizationId: "org",
	},
};
const confirmed = () =>
	withAgentToolRuntime(runtime, () =>
		withApprovedAgentTool(approval, () => executeApprovedWorkflow(input)),
	);

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
describe("confirmed workflow dispatch", () => {
	it("leaves ordinary unapproved requests in the existing UI flow", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		expect(await executeApprovedWorkflow(input)).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("sends the exact approved operation and project actor once", async () => {
		vi.stubEnv("AGENT_SERVICE_SECRET", "synthetic-service-token");
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				Response.json({ success: true, executionId: "execution" }),
			);
		vi.stubGlobal("fetch", fetchMock);
		expect(await confirmed()).toMatchObject({ success: true });
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
			new URL(
				"https://fabric.example.com/api/agents/fabric-ai/execute-workflow",
			),
			expect.objectContaining({
				body: JSON.stringify({
					workflowId: "workflow",
					organizationId: "org",
					serviceUserId: "user",
					projectId: "project",
				}),
			}),
		);
	});
	it("does not dispatch a different workflow under an existing approval", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await withAgentToolRuntime(runtime, () =>
			withApprovedAgentTool(approval, () =>
				executeApprovedWorkflow({
					...input,
					args: { workflowId: "other" },
				}),
			),
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("records a transport failure as unconfirmed without retry", async () => {
		vi.stubEnv("AGENT_SERVICE_SECRET", "synthetic-service-token");
		const fetchMock = vi
			.fn()
			.mockRejectedValue(new Error("Connection closed"));
		vi.stubGlobal("fetch", fetchMock);
		expect(await confirmed()).toMatchObject({ status: "unconfirmed" });
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
