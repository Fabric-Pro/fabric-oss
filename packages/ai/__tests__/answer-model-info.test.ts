import { describe, expect, it } from "vitest";
import {
	answerModelInfo,
	answerModelInfoSchema,
} from "../lib/answer-model-info";

describe("public served-model identity", () => {
	it("serializes only public fields from a final API handoff snapshot", () => {
		const snapshot = {
			modelString: "example-served",
			canonicalName: "Example Served",
			provider: "OPENAI_DIRECT",
			configId: "private-config",
			routeHash: "private-route",
		};
		expect(answerModelInfo(snapshot)).toEqual({
			id: "example-served",
			canonicalName: "Example Served",
			provider: "OPENAI_DIRECT",
			viaPlan: false,
		});
	});

	it.each([
		undefined,
		{},
		{ id: "example" },
		{ id: "", viaPlan: false },
		{ id: "example", viaPlan: "false" },
	])("rejects unknown or malformed identity %j", (value) => {
		expect(answerModelInfoSchema.safeParse(value).success).toBe(false);
	});

	it("keeps explicit plan provenance without exposing the source", () => {
		expect(
			answerModelInfo({
				modelString: "example-plan",
				planSource: { accountId: "private-account" },
			}),
		).toEqual({ id: "example-plan", viaPlan: true });
	});
});
