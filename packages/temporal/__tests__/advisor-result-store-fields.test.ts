import { describe, expect, it } from "vitest";
import { advisorResultStoreFields } from "../src/workflows/orchestrator/advisor-result-store";

describe("Advisor store workflow metadata", () => {
	it.each([
		{},
		{ conversationId: "example-conversation" },
		{ turnId: "example-turn" },
	])("preserves the old non-chat input for %j", (input) => {
		expect(
			advisorResultStoreFields(
				input,
				"example-execution",
				0,
				"code_tree",
			),
		).toEqual({});
	});
	it("builds equal keys from equal inputs and distinct keys from distinct ordinals", () => {
		const input = {
			conversationId: "example-conversation",
			turnId: "example-turn",
		};
		const first = advisorResultStoreFields(
			input,
			"example-execution",
			0,
			"code_tree",
		);
		expect(first).toEqual({
			advisorResultStore: {
				...input,
				toolName: "code_tree",
				sourceKey: "example-execution:0",
			},
		});
		expect(
			advisorResultStoreFields(
				input,
				"example-execution",
				0,
				"code_tree",
			),
		).toEqual(first);
		expect(
			advisorResultStoreFields(
				input,
				"example-execution",
				1,
				"code_tree",
			),
		).not.toEqual(first);
	});
});
