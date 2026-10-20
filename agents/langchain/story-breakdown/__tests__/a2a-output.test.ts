import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	graphInvoke: vi.fn(),
	invoke: undefined as
		| undefined
		| ((
				input: Record<string, unknown>,
		  ) => Promise<Record<string, unknown>>),
	transform: undefined as
		| undefined
		| ((output: Record<string, unknown>) => {
				response: string;
				error?: string;
		  }),
}));
vi.mock("@repo/agent-core", async (original) => ({
	...(await original<Record<string, unknown>>()),
	createUnifiedServer: (
		_config: unknown,
		invoke: typeof h.invoke,
		transform: typeof h.transform,
	) => {
		h.invoke = invoke;
		h.transform = transform;
		return { app: {}, start: () => {} };
	},
}));
vi.mock("../agent.js", () => ({
	storyBreakdownGraph: { invoke: h.graphInvoke },
}));
import "../unified-server";
describe("A2A output", () => {
	it("reports a terminal graph failure", () => {
		expect(
			h.transform?.({
				error: "Unable to generate stories",
				failureText: "Unable to generate stories",
				document: "",
				messages: [
					{ role: "user", content: "Break down this PRD" },
					{
						role: "assistant",
						content: "Unable to generate stories",
					},
				],
			}),
		).toMatchObject({ error: "Unable to generate stories" });
	});
	it("keeps a usable answer completed", () => {
		expect(
			h.transform?.({
				document: "Generated stories",
				messages: [],
				error: undefined,
			})?.error,
		).toBeUndefined();
	});
});

it("prefers the trailing assistant explanation returned by invoke", async () => {
	h.graphInvoke.mockResolvedValueOnce({
		error: "Provider failure detail",
		messages: [
			new HumanMessage("Process this request"),
			new AIMessage("Please try a smaller request."),
		],
	});
	const output = await h.invoke?.({
		messages: [{ role: "user", content: "Process this request" }],
	});
	expect(output).toHaveProperty(
		"failureText",
		"Please try a smaller request.",
	);
	expect(output?.messages).toEqual([
		{ role: "user", content: "Process this request" },
		{ role: "assistant", content: "Please try a smaller request." },
	]);
	expect(h.transform?.(output ?? {})).toMatchObject({
		error: "Please try a smaller request.",
	});
});

it("does not treat a trailing human correction as a friendly failure", async () => {
	h.graphInvoke.mockResolvedValueOnce({
		error: "Provider failure detail",
		messages: [
			new HumanMessage("Process this request"),
			new HumanMessage("Correct the tool arguments"),
		],
	});
	const output = await h.invoke?.({
		messages: [{ role: "user", content: "Process this request" }],
	});
	expect(output).toHaveProperty("failureText", undefined);
	expect(output?.messages).toEqual([
		{ role: "user", content: "Process this request" },
		{ role: "user", content: "Correct the tool arguments" },
	]);
	expect(h.transform?.(output ?? {})).toMatchObject({
		error: "Provider failure detail",
	});
});

it("leaves failureText unset on a successful run", async () => {
	h.graphInvoke.mockResolvedValueOnce({
		messages: [
			new HumanMessage("Process this request"),
			new AIMessage("Here is the result."),
		],
	});
	const output = await h.invoke?.({
		messages: [{ role: "user", content: "Process this request" }],
	});
	expect(output).toHaveProperty("failureText", undefined);
});
