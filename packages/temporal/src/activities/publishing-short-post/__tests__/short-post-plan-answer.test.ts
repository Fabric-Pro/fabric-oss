/**
 * A short post answered on a ChatGPT plan (Fizzy #2770). The plan's models
 * answer the optional fields they leave unused with `null`; the plan's
 * structured-output repair must turn that answer into one this schema accepts,
 * without the schema itself being loosened.
 */

import { dropDisallowedNulls } from "@repo/ai/lib/chatgpt-plan/structured-output";
import { zodSchema } from "ai";
import { describe, expect, it } from "vitest";
import { PublishingShortPostSchema } from "../build-short-post-prompt";

const planAnswer = {
	options: [
		{ label: "Direct", text: "We shipped it.", estimatedCharacters: 14 },
		{
			label: "Story",
			text: "Here is how it began.",
			estimatedCharacters: 21,
		},
		{
			label: "Question",
			text: "Ever wondered why?",
			estimatedCharacters: 18,
		},
	],
	hashtags: null,
	inputsNeeded: null,
	safetyNote: null,
};

describe("short post answered on a ChatGPT plan", () => {
	it("is refused as the plan sent it", () => {
		expect(PublishingShortPostSchema.safeParse(planAnswer).success).toBe(
			false,
		);
	});

	it("is accepted once the plan's nulls are mapped back to absent", async () => {
		const jsonSchema = await zodSchema(PublishingShortPostSchema)
			.jsonSchema;
		const parsed = PublishingShortPostSchema.safeParse(
			dropDisallowedNulls(planAnswer, jsonSchema),
		);
		expect(parsed.success).toBe(true);
		expect(parsed.data).toMatchObject({
			hashtags: [],
			inputsNeeded: [],
			safetyNote: null,
		});
	});
});
