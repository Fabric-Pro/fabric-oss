import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	args: [] as unknown[],
	graph: {
		stream: vi.fn(async function* (_input: unknown, _config: unknown) {}),
	},
}));
vi.mock("@repo/agent-core", async (original) => ({
	...(await original<Record<string, unknown>>()),
	createUnifiedServer: (...args: unknown[]) => {
		h.args = args;
		return { app: {}, start: vi.fn() };
	},
}));
vi.mock("../agent.js", () => ({ predictiveStateUpdatesGraph: h.graph }));
import "../unified-server";
it("seeds incoming reasoning turns into the platform graph input", async () => {
	const reasoningByTurn = {
		"1": { text: "Earlier", durationMs: 1, startedAt: 1, completedAt: 2 },
	};
	const executor = h.args[4] as (
		input: Record<string, unknown>,
	) => AsyncGenerator<unknown>;
	for await (const _event of executor({
		messages: [
			{ role: "user", content: "Continue" },
			{
				role: "assistant",
				content: "",
				toolCalls: [
					{
						id: "first",
						type: "function",
						function: { name: "create_view", arguments: "{}" },
					},
				],
			},
			{ role: "tool", toolCallId: "first", content: "Done" },
		],
		state: { reasoningByTurn },
	})) {
	}
	expect(h.graph.stream.mock.calls[0]?.[0]).toMatchObject({
		reasoningByTurn,
	});
	for (const invalid of [null, [], new Date(), "invalid"]) {
		for await (const _event of executor({
			messages: [],
			state: { reasoningByTurn: invalid },
		})) {
		}
		expect(h.graph.stream.mock.calls.at(-1)?.[0]).not.toHaveProperty(
			"reasoningByTurn",
			invalid,
		);
	}
});

it("drops the regenerated turn from the graph seed while keeping earlier turns", async () => {
	const earlier = {
		text: "earlier",
		durationMs: 1,
		startedAt: 1,
		completedAt: 2,
	};
	const executor = h.args[4] as (
		input: Record<string, unknown>,
	) => AsyncGenerator<unknown>;
	for await (const _event of executor({
		messages: [
			{ role: "user", content: "First" },
			{ role: "assistant", content: "Answer" },
			{ role: "user", content: "Regenerate this" },
		],
		state: {
			reasoningByTurn: { "1": earlier, "2": { ...earlier, text: "old" } },
		},
	})) {
	}
	expect((h.graph.stream.mock.calls.at(-1) as unknown[])[0]).toMatchObject({
		reasoningByTurn: { "1": earlier },
	});
	expect(
		(
			(h.graph.stream.mock.calls.at(-1) as unknown[])[0] as {
				reasoningByTurn: object;
			}
		).reasoningByTurn,
	).not.toHaveProperty("2");
});
