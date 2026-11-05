import { expect, it, vi } from "vitest";
import type { FabricHttpClient } from "../src/client.js";
import { WorkflowsResource } from "../src/resources/workflows.js";

it("exposes starter and readiness operations with explicit organization context", async () => {
	const get = vi.fn(),
		request = vi.fn();
	const resource = new WorkflowsResource({
		get,
		request,
	} as unknown as FabricHttpClient);
	await resource.listStarters({ org: "example team" });
	expect(get).toHaveBeenLastCalledWith(
		"/workflows/starters?org=example+team",
	);
	await resource.createFromStarter(
		{ starterId: "action-plan", name: "Example plan" },
		{ org: "example-team" },
	);
	expect(request).toHaveBeenCalledWith(
		"POST",
		"/workflows/starters?org=example-team",
		{
			body: { starterId: "action-plan", name: "Example plan" },
			retry: { maxRetries: 0 },
		},
	);
	await resource.checkReadiness("example/id", { org: "example-team" });
	expect(get).toHaveBeenLastCalledWith(
		"/workflows/example%2Fid/readiness?org=example-team",
	);
});
