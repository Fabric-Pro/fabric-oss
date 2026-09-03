import { describe, expect, it } from "vitest";
import {
	computeHuddleContentHash,
	extractMentionUserIds,
	quipHtmlToMarkdown,
	replaceMentions,
} from "../../src/slack/huddle-canvas";

describe("quipHtmlToMarkdown", () => {
	it("preserves headings, action-item bullets, timestamps, and inline bold/italic", () => {
		const html = [
			"<h1>Huddle Summary</h1>",
			"<p><strong>10:02 AM</strong> Kicked off the sync.</p>",
			"<h2>Action items</h2>",
			"<ul>",
			"<li>Ship the <em>migration</em> by Friday</li>",
			"<li>Reconnect Slack scopes</li>",
			"</ul>",
		].join("");

		const md = quipHtmlToMarkdown(html);

		expect(md).toContain("# Huddle Summary");
		expect(md).toContain("## Action items");
		// timestamp survives as plain text
		expect(md).toContain("10:02 AM");
		// inline bold + italic preserved
		expect(md).toContain("**10:02 AM**");
		expect(md).toContain("_migration_");
		// action items as bullets
		expect(md).toContain("- Ship the _migration_ by Friday");
		expect(md).toContain("- Reconnect Slack scopes");
	});

	it("numbers ordered list items sequentially", () => {
		const html = "<ol><li>First</li><li>Second</li><li>Third</li></ol>";
		const md = quipHtmlToMarkdown(html);
		expect(md).toContain("1. First");
		expect(md).toContain("2. Second");
		expect(md).toContain("3. Third");
	});

	it("decodes HTML entities", () => {
		const html = "<p>Design &amp; review &lt;notes&gt;</p>";
		expect(quipHtmlToMarkdown(html)).toContain("Design & review <notes>");
	});

	it("returns empty string for empty / whitespace-only input (drives skip path)", () => {
		expect(quipHtmlToMarkdown("")).toBe("");
		expect(quipHtmlToMarkdown(null)).toBe("");
		expect(quipHtmlToMarkdown(undefined)).toBe("");
		expect(quipHtmlToMarkdown("   <p>  </p>\n<div></div>  ")).toBe("");
	});

	it("collapses excessive blank lines", () => {
		const html = "<p>A</p><br><br><br><br><p>B</p>";
		const md = quipHtmlToMarkdown(html);
		expect(md).not.toMatch(/\n{3,}/);
		expect(md).toContain("A");
		expect(md).toContain("B");
	});
});

describe("extractMentionUserIds / replaceMentions", () => {
	it("extracts both bracketed and bare user-id mention tokens", () => {
		const text = "Sync with <@U12345> and @U67890ABC about the plan";
		expect(extractMentionUserIds(text).sort()).toEqual([
			"U12345",
			"U67890ABC",
		]);
	});

	it("resolves mentions to display names and degrades unknown ids gracefully", () => {
		const text = "Owner: <@U12345>, reviewer: <@U99999>";
		const names = new Map([["U12345", "ada"]]);
		const resolved = replaceMentions(text, names);
		expect(resolved).toContain("@ada");
		// unknown id falls back to @<id>, never throws
		expect(resolved).toContain("@U99999");
	});

	it("handles bracketed mentions with a display-name suffix", () => {
		const text = "Hi <@U12345|ada>!";
		expect(extractMentionUserIds(text)).toEqual(["U12345"]);
		expect(replaceMentions(text, new Map([["U12345", "ada"]]))).toBe(
			"Hi @ada!",
		);
	});

	it("resolves mention ids up to the redos-bound cap (12 chars) without truncation", () => {
		const id = "U0123456789"; // 11 chars — within real Slack id length and the new bound
		const text = `Assigned to <@${id}|ada>`;
		expect(extractMentionUserIds(text)).toEqual([id]);
		expect(replaceMentions(text, new Map([[id, "ada"]]))).toBe(
			"Assigned to @ada",
		);
	});
});

describe("computeHuddleContentHash", () => {
	it("is stable for identical content and differs for changed content", () => {
		const a = computeHuddleContentHash("# Notes\n- item one");
		const b = computeHuddleContentHash("# Notes\n- item one");
		const c = computeHuddleContentHash("# Notes\n- item one\n- item two");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	it("normalizes trailing whitespace / line endings so trivial re-renders don't churn", () => {
		const a = computeHuddleContentHash("# Notes\n- item");
		const b = computeHuddleContentHash("# Notes\r\n- item\n");
		expect(a).toBe(b);
	});

	it("empty body hashes differently from populated body (empty→populated transition)", () => {
		const empty = computeHuddleContentHash("");
		const populated = computeHuddleContentHash("# Huddle\n- decision");
		expect(empty).not.toBe(populated);
	});
});
