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

it.each([8, 15])(
	"selects by score then renders in document order at cap %s",
	async (maxPassageChars) => {
		h.retrieve.mockResolvedValue([
			{
				id: "example-source",
				type: "TEXT",
				score: 1,
				content: "fallback",
				matchedPassages: [
					{ content: "early", score: 0.8 },
					{ content: "M".repeat(20), score: 0.1 },
					{ content: "decision", score: 1 },
				],
			},
		]);
		const result = await retrieveProjectContextsActivity(
			"detail",
			"example-project",
			"example-user",
			"example-org",
			undefined,
			{ maxPassageChars },
		);
		expect(result.context).toContain(
			maxPassageChars === 8 ? "decision" : "early\n\ndecision",
		);
		if (maxPassageChars === 8) {
			expect(result.context).not.toContain("early");
		}
	},
);

it.each([false, true])(
	"skips an incomplete lower-ranked passage and includes a fitting successor: %s",
	async (includeShorter) => {
		const top = "Decision approved";
		h.retrieve.mockResolvedValue([
			{
				id: "example-source",
				type: "TEXT",
				score: 1,
				content: "fallback",
				matchedPassages: [
					{
						content: "Earlier proposal must be replaced",
						score: 0.8,
					},
					...(includeShorter ? [{ content: "OK", score: 0.5 }] : []),
					{ content: top, score: 1 },
				],
			},
		]);
		const result = await retrieveProjectContextsActivity(
			"detail",
			"example-project",
			"example-user",
			"example-org",
			undefined,
			{ maxPassageChars: 24 },
		);
		expect(result.context).toContain(top);
		expect(result.context).not.toContain("Earli");
		expect(
			result.context.endsWith(includeShorter ? `OK\n\n${top}` : top),
		).toBe(true);
	},
);

it("can still truncate the highest-scoring passage alone", async () => {
	h.retrieve.mockResolvedValue([
		{
			id: "example-source",
			type: "TEXT",
			score: 1,
			content: "fallback",
			matchedPassages: [
				{ content: "earlier proposal", score: 0.5 },
				{ content: "Decision approved", score: 1 },
			],
		},
	]);
	const result = await retrieveProjectContextsActivity(
		"detail",
		"example-project",
		"example-user",
		"example-org",
		undefined,
		{ maxPassageChars: 5 },
	);
	expect(result.context.endsWith("Decis")).toBe(true);
});
