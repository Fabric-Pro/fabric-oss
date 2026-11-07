import { expect, it, vi } from "vitest";
import type { FabricHttpClient } from "../src/client.js";
import { RunQualityResource } from "../src/resources/run-quality.js";

it("keeps explicit target and organization on all quality operations without retrying mutations", async () => {
	const http = { get: vi.fn(), post: vi.fn(), request: vi.fn() };
	const resource = new RunQualityResource(
		http as unknown as FabricHttpClient,
	);
	const target = { targetType: "AGENT" as const, targetId: "example/id" };
	const options = { org: "example team" };
	await resource.getPolicy(target, options);
	expect(http.get).toHaveBeenLastCalledWith(
		"/run-quality/policy?targetType=AGENT&targetId=example%2Fid&org=example+team",
	);
	const input = {
		...target,
		expectedRevision: 0,
		enabled: true,
		rules: [
			{
				id: "check",
				name: "Delivery",
				required: true,
				checks: { requiredPhrases: ["Ready"] },
			},
		],
	};
	await resource.configure(input, options);
	expect(http.request).toHaveBeenLastCalledWith(
		"PUT",
		"/run-quality/policy?org=example+team",
		{ body: input, retry: { maxRetries: 0 } },
	);
	await resource.list(target, { ...options, limit: 5, offset: 10 });
	expect(http.get).toHaveBeenLastCalledWith(
		"/run-quality/assessments?targetType=AGENT&targetId=example%2Fid&org=example+team&limit=5&offset=10",
	);
	const identity = { ...target, assessmentId: "assessment/id" };
	await resource.get(identity, options);
	expect(http.get).toHaveBeenLastCalledWith(
		"/run-quality/assessments/assessment%2Fid?targetType=AGENT&targetId=example%2Fid&org=example+team",
	);
	await resource.cancel(identity, options);
	expect(http.post).toHaveBeenLastCalledWith(
		"/run-quality/assessments/assessment%2Fid/cancel?org=example+team",
		target,
		{ retry: { maxRetries: 0 } },
	);
	await resource.compare(
		{ ...target, leftId: "left", rightId: "right" },
		options,
	);
	expect(http.post).toHaveBeenLastCalledWith(
		"/run-quality/compare?org=example+team",
		{ ...target, leftId: "left", rightId: "right" },
		{ retry: { maxRetries: 0 } },
	);
});
