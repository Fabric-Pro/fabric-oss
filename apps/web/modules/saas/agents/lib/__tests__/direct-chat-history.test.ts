import { describe, expect, it } from "vitest";
import {
	attachmentNamesMetadata,
	readAttachmentNames,
} from "../attachment-names";
import { loadedDirectMessages } from "../direct-chat-history";

const timestamp = "2026-01-01T00:00:00.000Z";

describe("the files a Direct question was sent with, after a reload", () => {
	it("lists the saved names under the question again", () => {
		const [question] = loadedDirectMessages([
			{
				id: "q-1",
				role: "user",
				content: "What is in these?",
				timestamp,
				metadata: {
					attachmentNames: ["a.png", "b.png"],
					executionId: "x",
				},
			},
		]);
		expect(question?.attachmentNames).toEqual(["a.png", "b.png"]);
	});

	it("reads no names for an answer or a question saved without any", () => {
		const loaded = loadedDirectMessages([
			{ id: "q-1", role: "user", content: "Hi", timestamp },
			{
				id: "a-1",
				role: "assistant",
				content: "Hello",
				timestamp,
				metadata: { attachmentNames: ["a.png"] },
			},
		]);
		expect(loaded.map((message) => message.attachmentNames)).toEqual([
			undefined,
			undefined,
		]);
	});

	it("saves only bounded, non-empty string names", () => {
		expect(
			attachmentNamesMetadata(["a.png", "", 3, "x".repeat(300)]),
		).toEqual({
			metadata: { attachmentNames: ["a.png", "x".repeat(255)] },
		});
		expect(attachmentNamesMetadata([])).toEqual({});
		expect(attachmentNamesMetadata(undefined)).toEqual({});
		expect(
			readAttachmentNames(
				Array.from({ length: 25 }, (_, i) => `${i}.png`),
			),
		).toHaveLength(20);
	});
});
