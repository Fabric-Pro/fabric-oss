import { expect, it, vi } from "vitest";
import type { FabricHttpClient } from "../src/client.js";
import { WorkflowsResource } from "../src/resources/workflows.js";

it("uses organization-aware check routes without automatic mutation retries", async () => {
	const request = vi.fn();
	const get = vi.fn();
	const resource = new WorkflowsResource({
		request,
		get,
	} as unknown as FabricHttpClient);
	const options = { org: "example team" };
	const revision = "a".repeat(64);
	const input = {
		executionId: "example-run",
		nodeId: "draft",
		expectedRevision: revision,
		requiredPhrases: ["Next steps"],
		forbiddenPhrases: [],
	};
	await resource.listChecks("example/id", options);
	expect(get).toHaveBeenCalledWith(
		"/workflows/example%2Fid/checks?org=example+team",
	);
	await resource.inspectResult(
		"example/id",
		{ executionId: input.executionId, nodeId: input.nodeId },
		options,
	);
	expect(request).toHaveBeenLastCalledWith(
		"POST",
		"/workflows/example%2Fid/checks/inspect?org=example+team",
		{
			body: { executionId: input.executionId, nodeId: input.nodeId },
			retry: { maxRetries: 0 },
		},
	);
	await resource.previewCheck("example/id", input, options);
	expect(request).toHaveBeenLastCalledWith(
		"POST",
		"/workflows/example%2Fid/checks/preview?org=example+team",
		{ body: input, retry: { maxRetries: 0 } },
	);
	await resource.saveCheck(
		"example/id",
		{ ...input, name: "Delivery evidence" },
		options,
	);
	expect(request).toHaveBeenLastCalledWith(
		"POST",
		"/workflows/example%2Fid/checks/save?org=example+team",
		{
			body: { ...input, name: "Delivery evidence" },
			retry: { maxRetries: 0 },
		},
	);
	await resource.applyCheck(
		"example/id",
		{
			checkId: "example-check",
			expectedCaseRevision: revision,
			executionId: "example-candidate",
		},
		options,
	);
	expect(request.mock.calls.at(-1)?.[1]).toContain("/checks/apply?org=");
	await resource.removeCheck(
		"example/id",
		{ checkId: "example-check", expectedCaseRevision: revision },
		options,
	);
	expect(request.mock.calls.at(-1)?.[1]).toContain("/checks/remove?org=");
});
