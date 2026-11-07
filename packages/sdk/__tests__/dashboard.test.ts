import { expect, it, vi } from "vitest";
import type { FabricHttpClient } from "../src/client.js";
import { DashboardResource } from "../src/resources/dashboard.js";

it("keeps organization context and never retries feedback mutations", async () => {
	const http = { get: vi.fn(), request: vi.fn() };
	const resource = new DashboardResource(http as unknown as FabricHttpClient);
	const options = { org: "example team" };
	await resource.listCuratedFeedback(options);
	expect(http.get).toHaveBeenCalledWith(
		"/dashboard/curated-feedback?org=example+team",
	);
	const input = { cardKey: "review:run-1", action: "click" as const };
	await resource.recordCuratedFeedback(input, options);
	expect(http.request).toHaveBeenCalledWith(
		"POST",
		"/dashboard/curated-feedback?org=example+team",
		{ body: input, retry: { maxRetries: 0 } },
	);
});
