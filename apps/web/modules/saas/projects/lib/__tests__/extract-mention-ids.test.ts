import { describe, expect, it } from "vitest";
import { extractMentionIdsFromHtml } from "../extract-mention-ids";

describe("extractMentionIdsFromHtml", () => {
	it("returns empty for null/empty/undefined input", () => {
		expect(extractMentionIdsFromHtml(null)).toEqual([]);
		expect(extractMentionIdsFromHtml(undefined)).toEqual([]);
		expect(extractMentionIdsFromHtml("")).toEqual([]);
	});

	it("extracts unique mention ids from html", () => {
		const html =
			`<p>Hello <span data-type="mention" data-id="user_a" data-label="Alice" class="mention">@Alice</span>` +
			` and <span data-type="mention" data-id="user_b" data-label="Bob" class="mention">@Bob</span>` +
			` and again <span data-type="mention" data-id="user_a" data-label="Alice" class="mention">@Alice</span></p>`;
		expect(extractMentionIdsFromHtml(html)).toEqual(["user_a", "user_b"]);
	});

	it("ignores spans without data-type=mention", () => {
		const html = `<span data-id="not_mention">x</span>`;
		expect(extractMentionIdsFromHtml(html)).toEqual([]);
	});
});
