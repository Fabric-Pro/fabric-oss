import { expect, it, vi } from "vitest";
import type { FabricHttpClient } from "../src/client.js";
import { WorkflowsResource } from "../src/resources/workflows.js";

it("uses bounded organization-aware lifecycle requests without automatic mutation retries", async () => {
	const request = vi.fn();
	const get = vi.fn();
	const r = new WorkflowsResource({
		request,
		get,
	} as unknown as FabricHttpClient);
	const options = { org: "example team" };
	await r.publish("example/id", { changelog: "Reviewed" }, options);
	expect(request).toHaveBeenLastCalledWith(
		"POST",
		"/workflows/example%2Fid/publish?org=example+team",
		{ body: { changelog: "Reviewed" }, retry: { maxRetries: 0 } },
	);
	for (const action of ["pause", "resume", "unpublish"] as const) {
		await r[action]("example-workflow", options);
		expect(request).toHaveBeenLastCalledWith(
			"POST",
			`/workflows/example-workflow/${action}?org=example+team`,
			{ body: {}, retry: { maxRetries: 0 } },
		);
	}
	await r.rollback("example-workflow", 2, options);
	expect(request).toHaveBeenLastCalledWith(
		"POST",
		"/workflows/example-workflow/rollback?org=example+team",
		{ body: { targetVersion: 2 }, retry: { maxRetries: 0 } },
	);
	await r.configureSchedule(
		"example-workflow",
		{ cron: "0 9 * * 1" },
		options,
	);
	expect(request).toHaveBeenLastCalledWith(
		"PUT",
		"/workflows/example-workflow/schedule?org=example+team",
		{ body: { cron: "0 9 * * 1" }, retry: { maxRetries: 0 } },
	);
	await r.getSchedule("example-workflow", options);
	expect(get).toHaveBeenLastCalledWith(
		"/workflows/example-workflow/schedule?org=example+team",
	);
	await r.listVersions("example-workflow", {
		...options,
		limit: 10,
		offset: 20,
	});
	expect(get).toHaveBeenLastCalledWith(
		"/workflows/example-workflow/versions?org=example+team&limit=10&offset=20",
	);
});
