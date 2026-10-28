import { describe, expect, it } from "vitest";
import { readPersistedModel } from "../direct-chat-history";
import { parseOrchestratorStreamEvent } from "../orchestrator-stream-protocol";

const model = {
	id: "example-served",
	canonicalName: "example-served",
	provider: "OPENAI_CHATGPT_PLAN",
	viaPlan: true,
};
describe("served answer model", () => {
	it("preserves the served model in Advisor completion events", () => {
		expect(
			parseOrchestratorStreamEvent({ type: "completed", model }),
		).toMatchObject({ model });
	});
	it("restores a saved execution model including plan provenance", () => {
		expect(
			readPersistedModel(JSON.parse(JSON.stringify({ model }))),
		).toMatchObject(model);
	});
	it.each([
		undefined,
		null,
		[],
		{ id: 42 },
		{ id: "" },
		{ id: "example", viaPlan: "yes" },
		{ id: "example", provider: {} },
	])("ignores malformed or missing saved model %j", (value) => {
		expect(readPersistedModel({ model: value })).toBeUndefined();
	});
});
