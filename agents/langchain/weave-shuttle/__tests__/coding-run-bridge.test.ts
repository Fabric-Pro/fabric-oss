import { beforeEach, describe, expect, it, vi } from "vitest";

import { startWeaveCodingRunAndWait } from "../src/lib/coding-run-bridge";

describe("startWeaveCodingRunAndWait", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.restoreAllMocks();
		process.env = {
			...originalEnv,
			AGENT_SERVICE_SECRET: "secret",
			FABRIC_INTERNAL_URL: "http://fabric.local",
		};
	});

	it("calls the internal Fabric coding-run bridge endpoint", async () => {
		const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue({
			ok: true,
			json: async () => ({
				codingRunId: "run_123",
				workflowId: "coding-run-run_123",
				status: "completed",
				pullRequestUrl: "https://github.com/acme/fabric/pull/42",
				summary: "Completed.",
			}),
		} as Response);

		const result = await startWeaveCodingRunAndWait({
			planId: "plan_123",
			prompt: "Implement the feature",
			category: "backend",
			userId: "user_123",
			organizationId: "org_123",
			timeoutMs: 1000,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"http://fabric.local/api/internal/weave-coding-run",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"X-Agent-Service-Token": "secret",
				}),
			}),
		);
		expect(result.status).toBe("completed");
	});

	it("throws when the internal bridge responds with an error", async () => {
		vi.spyOn(global, "fetch").mockResolvedValue({
			ok: false,
			status: 500,
			json: async () => ({ error: "boom" }),
		} as Response);

		await expect(
			startWeaveCodingRunAndWait({
				planId: "plan_123",
				prompt: "Implement the feature",
				category: "backend",
				userId: "user_123",
				organizationId: "org_123",
			}),
		).rejects.toThrow("boom");
	});
});
