import { describe, expect, it } from "vitest";
import {
	diffMentionIds,
	extractDocumentMentionIds,
	extractMentionContextSnippet,
} from "../document-mentions";

describe("extractDocumentMentionIds", () => {
	it("returns [] for empty/null content", () => {
		expect(extractDocumentMentionIds("")).toEqual([]);
		expect(extractDocumentMentionIds(null)).toEqual([]);
		expect(extractDocumentMentionIds(undefined)).toEqual([]);
	});

	it("extracts ids from mention spans", () => {
		const html =
			'<p>Hi <span data-type="mention" data-id="u_1" data-mention-id="m_a">@Alice</span>!</p>';
		expect(extractDocumentMentionIds(html)).toEqual([
			{ userId: "u_1", anchorId: "m_a" },
		]);
	});

	it("dedupes by (userId, anchorId)", () => {
		const html = `
			<span data-type="mention" data-id="u_1" data-mention-id="m_a">@A</span>
			<span data-type="mention" data-id="u_1" data-mention-id="m_a">@A</span>
		`;
		expect(extractDocumentMentionIds(html)).toEqual([
			{ userId: "u_1", anchorId: "m_a" },
		]);
	});

	it("preserves multiple distinct mentions in document order", () => {
		const html = `
			<span data-type="mention" data-id="u_1" data-mention-id="m_a">@A</span>
			<span data-type="mention" data-id="u_2" data-mention-id="m_b">@B</span>
			<span data-type="mention" data-id="u_1" data-mention-id="m_c">@A</span>
		`;
		const result = extractDocumentMentionIds(html);
		expect(result).toHaveLength(3);
		expect(result.map((r) => r.userId)).toEqual(["u_1", "u_2", "u_1"]);
	});

	it("ignores spans missing data-id or data-mention-id", () => {
		const html = `
			<span data-type="mention" data-id="u_1">@A</span>
			<span data-type="mention" data-mention-id="m_b">@B</span>
			<span data-id="u_3" data-mention-id="m_c">@C</span>
		`;
		expect(extractDocumentMentionIds(html)).toEqual([]);
	});

	it("ignores non-mention spans with similar attributes", () => {
		const html =
			'<span data-type="codeblock" data-id="u_1" data-mention-id="m_a">@A</span>';
		expect(extractDocumentMentionIds(html)).toEqual([]);
	});
});

describe("diffMentionIds", () => {
	it("returns userIds present in next but not in prev (by userId, ignoring anchor changes)", () => {
		const prev = [{ userId: "u_1", anchorId: "m_a" }];
		const next = [
			{ userId: "u_1", anchorId: "m_a" },
			{ userId: "u_2", anchorId: "m_b" },
		];
		expect(diffMentionIds(prev, next)).toEqual([
			{ userId: "u_2", anchorId: "m_b" },
		]);
	});

	it("re-mentioning a user with a new anchor is NOT a new mention (avoid spam)", () => {
		const prev = [{ userId: "u_1", anchorId: "m_a" }];
		const next = [{ userId: "u_1", anchorId: "m_b" }];
		expect(diffMentionIds(prev, next)).toEqual([]);
	});

	it("returns first anchor when a user appears multiple times in next", () => {
		const next = [
			{ userId: "u_1", anchorId: "m_a" },
			{ userId: "u_1", anchorId: "m_b" },
		];
		expect(diffMentionIds([], next)).toEqual([
			{ userId: "u_1", anchorId: "m_a" },
		]);
	});
});

describe("extractMentionContextSnippet", () => {
	it("returns surrounding plain text trimmed to 280 chars", () => {
		const html = `<p>Hello <span data-type="mention" data-id="u_1" data-mention-id="m_a">@Alice</span>, please review the spec when you have a moment.</p>`;
		const snippet = extractMentionContextSnippet(html, "m_a");
		expect(snippet).toContain("Hello");
		expect(snippet).toContain("please review the spec");
		expect(snippet.length).toBeLessThanOrEqual(280);
	});

	it("returns empty string when anchor not found", () => {
		expect(extractMentionContextSnippet("<p>hi</p>", "m_zzz")).toBe("");
	});

	it("returns text around the anchor, not the document beginning", () => {
		const filler = "X ".repeat(400);
		const html = `<p>${filler}<span data-type="mention" data-id="u_1" data-mention-id="m_a">@Alice</span>, please review section three.</p>`;
		const snippet = extractMentionContextSnippet(html, "m_a");
		expect(snippet).toContain("@Alice");
		expect(snippet).toContain("please review section three");
		expect(snippet.length).toBeLessThanOrEqual(280);
	});
});
