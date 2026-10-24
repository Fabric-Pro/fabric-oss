import type { LangGraphExecutor } from "@repo/agent-core/unified-server";
import { beforeEach, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
	invoke: vi.fn().mockResolvedValue({ messages: [] }),
	stream: vi.fn().mockImplementation(async function* () {}),
	run: undefined as LangGraphExecutor | undefined,
	streamRun: undefined as
		| ((input: Record<string, unknown>) => AsyncIterable<unknown>)
		| undefined,
}));
vi.mock("@repo/agent-core/unified-server", () => ({
	createUnifiedServer: (...args: unknown[]) => {
		captured.run = args[1] as typeof captured.run;
		captured.streamRun = args[4] as typeof captured.streamRun;
		return { app: {}, start: vi.fn() };
	},
}));
vi.mock("../agent.js", () => ({
	projectDocumentGeneratorGraph: {
		invoke: captured.invoke,
		stream: captured.stream,
	},
}));
import "../unified-server";

beforeEach(() => vi.clearAllMocks());

it.each([
	["invoke", true],
	["invoke", false],
	["invoke", undefined],
	["stream", true],
	["stream", false],
	["stream", undefined],
] as const)(
	"%s forwards the prompt and explicit methodology opt-out (flag=%s)",
	async (mode, flag) => {
		const input = {
			messages: [],
			state: {
				systemPrompt: "Clean Spec",
				...(flag === undefined
					? {}
					: { suppressFabricMethodology: flag }),
			},
		};
		if (mode === "invoke") {
			await captured.run?.(input);
		} else {
			for await (const _event of captured.streamRun?.(input) ?? []) {
				// The graph stub produces no events.
			}
		}
		const graphCall = mode === "invoke" ? captured.invoke : captured.stream;
		expect(graphCall.mock.calls.at(-1)?.[0]).toMatchObject({
			systemPrompt: "Clean Spec",
			suppressFabricMethodology: flag === true,
		});
	},
);
