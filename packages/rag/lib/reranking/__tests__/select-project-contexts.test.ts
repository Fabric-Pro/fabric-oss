import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../index", () => ({ rerankContexts: vi.fn() }));

import { rerankContexts } from "../index";
import { selectProjectContexts } from "../select-project-contexts";

const contexts = ["a", "b", "c"].map((id) => ({
	id,
	type: "TEXT",
	content: `body-${id}`,
	score: 1,
}));
const hits = [
	{ contextId: "a", content: "a1" },
	{ contextId: "b", content: "b1" },
	{ contextId: "b", content: "b2" },
	{ contextId: "b", content: "b3" },
];
const options = { contexts, hits, query: "query", enabled: true, limit: 2 };
beforeEach(() => vi.clearAllMocks());
it("scores all matching chunks and body fallbacks, choosing the best chunk while returning bodies", async () => {
	vi.mocked(rerankContexts).mockImplementation(async (input) => {
		expect(input.topK).toBe(5);
		expect(input.contexts.map((c) => c.content)).toEqual([
			"a1",
			"b1",
			"b2",
			"b3",
			"body-c",
		]);
		return {
			contexts: input.contexts.map((c) => ({
				...c,
				score: c.content === "b3" ? 10 : 1,
			})),
			stats: { model: "test" },
		} as never;
	});
	const result = await selectProjectContexts(options);
	expect(result.map((c) => c.id)).toEqual(["b", "a"]);
	expect(result.map((c) => c.content)).toEqual(["body-b", "body-a"]);
});
it.each(["skipped", "fallback-passthrough"])(
	"caps %s in search order",
	async (model) => {
		vi.mocked(rerankContexts).mockResolvedValue({
			contexts: [...contexts].reverse(),
			stats: { model },
		} as never);
		expect(await selectProjectContexts(options)).toEqual(
			contexts.slice(0, 2),
		);
	},
);
it("caps disabled retrieval without a provider call", async () => {
	expect(await selectProjectContexts({ ...options, enabled: false })).toEqual(
		contexts.slice(0, 2),
	);
	expect(rerankContexts).not.toHaveBeenCalled();
});
it("caps thrown provider failures", async () => {
	vi.mocked(rerankContexts).mockRejectedValue(new Error("unavailable"));
	expect(await selectProjectContexts(options)).toEqual(contexts.slice(0, 2));
});
