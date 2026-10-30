import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ retrieve: vi.fn() }));
vi.mock("@repo/database", () => ({}));
vi.mock("@temporalio/activity", () => ({
	log: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/activities/orchestrator/turn-dispatch", () => ({
	startTurnHeartbeat: () => () => {},
	runWithTurnDispatch: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@repo/rag", async () => ({
	...(await import(
		"@repo/rag/lib/project-contexts/project-context-passages"
	)),
	retrieveProjectContexts: h.retrieve,
	contextMetaHeader: () => "",
}));

import { retrieveProjectContextsActivity } from "../src/activities/project-metadata";

it("keeps Advisor passage retrieval and its default serialized budget", async () => {
	h.retrieve.mockResolvedValue([
		{
			id: "example-source",
			type: "TEXT",
			score: 1,
			content: "whole document",
			matchedPassages: [
				{ content: "matched detail".repeat(2000), score: 1 },
			],
		},
	]);
	const result = await retrieveProjectContextsActivity(
		"detail",
		"example-project",
		"example-user",
		"example-org",
	);
	expect(h.retrieve).toHaveBeenCalledWith(
		expect.objectContaining({
			includeMatchedPassages: true,
			diversify: true,
			skipRerank: true,
		}),
	);
	expect(result.context).toContain(
		'fabric_get_project_source({"source":"example-source"})',
	);
	expect(result.context).toContain("matched detail");
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});
