/**
 * The plan access token an agent gets from the exchange (Fizzy #2939) sits in
 * the run's `configurable.ai_api_key`. It must never leave the agent in what
 * it streams: graph state and node updates do not carry configurable values,
 * and LangGraph copies configurable values into run metadata only when the key
 * does not look like a credential. These agents run without a checkpointer, so
 * nothing is persisted either. This pins the streamed half.
 */
import { Annotation, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

const TOKEN = "plan-access-token-must-stay-in-memory";

describe("the plan token is not streamed", () => {
	it("appears in no chunk of updates, values or debug streams", async () => {
		const State = Annotation.Root({ note: Annotation<string> });
		const graph = new StateGraph(State)
			.addNode("work", (_state, config) => ({
				// The node can read the token, as the model factory does.
				note: config.configurable?.ai_api_key ? "had a key" : "no key",
			}))
			.addEdge("__start__", "work")
			.compile();

		const chunks: unknown[] = [];
		const stream = await graph.stream(
			{ note: "" },
			{
				configurable: {
					ai_api_key: TOKEN,
					ai_provider: "OPENAI_CHATGPT_PLAN",
				},
				streamMode: ["updates", "values", "debug"],
			},
		);
		for await (const chunk of stream) {
			chunks.push(chunk);
		}

		const serialized = JSON.stringify(chunks);
		expect(serialized).toContain("had a key");
		expect(serialized).not.toContain(TOKEN);
	});
});
