import { describe, expect, it, vi } from "vitest";
import type { FabricHttpClient } from "../src/client.js";
import { AgentPreviewsResource } from "../src/resources/agent-previews.js";

describe("draft preview SDK", () => {
	it("preserves frozen request identity and explicitly pins reads and cancellation", async () => {
		const post = vi.fn().mockResolvedValue({});
		const get = vi.fn().mockResolvedValue({});
		const resource = new AgentPreviewsResource({
			post,
			get,
		} as unknown as FabricHttpClient);
		const request = {
			draft: { instructions: "Use project context" },
			userMessage: "Summarize",
			idempotencyKey: "455efcf1-4317-4c4b-a5c0-6d67f77bf012",
		};
		await resource.start(request, { org: "example-org" });
		await resource.get("example/workflow", {
			org: "example-org",
			runId: "example-run",
		});
		await resource.cancel("example/workflow", {
			org: "example-org",
			runId: "example-run",
		});
		expect(post).toHaveBeenNthCalledWith(
			1,
			"/agent-previews?org=example-org",
			request,
			{ retry: { maxRetries: 0 } },
		);
		expect(get).toHaveBeenCalledWith(
			"/agent-previews/example%2Fworkflow?org=example-org&runId=example-run",
		);
		expect(post).toHaveBeenNthCalledWith(
			2,
			"/agent-previews/example%2Fworkflow/cancel?org=example-org&runId=example-run",
			{},
			{ retry: { maxRetries: 0 } },
		);
	});
});
