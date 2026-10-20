import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	invoke: undefined as
		| undefined
		| ((
				input: Record<string, unknown>,
		  ) => Promise<Record<string, unknown>>),
	graphInvoke: vi.fn(),
	transform: undefined as
		| undefined
		| ((output: Record<string, unknown>) => {
				response: string;
				error?: string;
		  }),
}));
vi.mock("@repo/agent-core/unified-server", async (original) => ({
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
	projectDocumentGeneratorGraph: { invoke: h.graphInvoke },
}));
import "../unified-server";
describe("A2A output", () => {
	it("reports a terminal graph failure", () => {
		expect(
			h.transform?.({
				error: "Provider failure detail",
				document: "",
				streamingContent: "",
				textResponse:
					"Unable to generate the document. Please try again.",
			}),
		).toMatchObject({
			error: "Unable to generate the document. Please try again.",
		});
	});
	it("keeps a usable answer completed", () => {
		expect(
			h.transform?.({
				document: "Generated document",
				streamingContent: "Generated document",
				textResponse: "Generated document",
				error: undefined,
			})?.error,
		).toBeUndefined();
	});
});

it("uses the assistant failure text even when the input document survives", async () => {
	h.graphInvoke.mockResolvedValueOnce({
		document: "Original input document",
		error: "Raw failure detail",
		messages: [
			{
				role: "assistant",
				content: "Please try generating the document again.",
			},
		],
	});
	const output = await h.invoke?.({
		messages: [{ role: "user", content: "Update this document" }],
		document: "Original input document",
	});
	expect(h.transform?.(output ?? {})).toMatchObject({
		error: "Please try generating the document again.",
	});
});
