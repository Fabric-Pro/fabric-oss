import { beforeEach, describe, expect, it, vi } from "vitest";
import { delegateWeaveImplementationActivity } from "../src/activities/weave/shuttle-execution";

describe("delegateWeaveImplementationActivity", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.restoreAllMocks();
		process.env = {
			...originalEnv,
			AGENT_SERVICE_SECRET: "secret",
			FABRIC_INTERNAL_URL: "http://fabric.local",
		};
	});

	it("posts local/workspace delegation requests to the internal weave coding-run bridge", async () => {
		const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue({
			ok: true,
			json: async () => ({
				executionKind: "coding_run",
				executionChannel: "LOCAL_AGENTS",
				provider: "KANBAN_LOCAL",
				codingRunId: "run_123",
				workflowId: "coding-run-run_123",
				status: "completed",
				pullRequestUrl: "https://github.com/acme/fabric/pull/42",
				summary: "Completed.",
			}),
		} as Response);

		const result = await delegateWeaveImplementationActivity({
			planId: "plan_123",
			prompt: "Implement the feature",
			category: "backend",
			modelOverride: "claude-sonnet-4-5",
			executionProvider: "KANBAN_LOCAL",
			userId: "user_123",
			organizationId: "org_123",
			weaveExecutionId: "weave_exec_123",
			timeoutMs: 1234,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"http://fabric.local/api/internal/weave-coding-run",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"Content-Type": "application/json",
					"X-Agent-Service-Token": "secret",
				}),
				body: JSON.stringify({
					planId: "plan_123",
					prompt: "Implement the feature",
					category: "backend",
					modelOverride: "claude-sonnet-4-5",
					executionProvider: "KANBAN_LOCAL",
					userId: "user_123",
					organizationId: "org_123",
					weaveExecutionId: "weave_exec_123",
					timeoutMs: 1234,
				}),
			}),
		);
		expect(result.provider).toBe("KANBAN_LOCAL");
		expect(result.codingRunId).toBe("run_123");
	});

	it("throws when the internal bridge responds with an error", async () => {
		vi.spyOn(global, "fetch").mockResolvedValue({
			ok: false,
			status: 500,
			json: async () => ({ error: "boom" }),
		} as Response);

		await expect(
			delegateWeaveImplementationActivity({
				planId: "plan_123",
				prompt: "Implement the feature",
				category: "backend",
				executionProvider: "KANBAN_LOCAL",
				userId: "user_123",
			}),
		).rejects.toThrow("boom");
	});
});
