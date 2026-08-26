import { describe, expect, it } from "vitest";
import { renderNewsletterChatMessage } from "./render-newsletter-chat-message";

const content = {
	headline: "March release",
	intro: "Two big features shipped.",
	highlights: [
		{ title: "Bulk export" },
		{ title: "Dark mode" },
		{ title: "Faster search" },
		{ title: "Webhooks" },
	],
};

describe("renderNewsletterChatMessage", () => {
	it("Slack: mrkdwn headline, bulleted highlights capped, link as <url|label>", () => {
		const { text } = renderNewsletterChatMessage(content, {
			platform: "SLACK",
			link: "https://x/app/projects/p?tab=release-notes",
			maxHighlights: 3,
		});
		expect(text).toContain("*March release*");
		expect(text).toContain("• Bulk export");
		expect(text).not.toContain("Webhooks"); // capped at 3
		expect(text).toContain("<https://x/app/projects/p?tab=release-notes|");
	});
	it("Teams: plain text (no mrkdwn asterisks), bare link", () => {
		const { text } = renderNewsletterChatMessage(content, {
			platform: "TEAMS",
			link: "https://x/rn",
			maxHighlights: 2,
		});
		expect(text).toContain("March release");
		expect(text).not.toContain("*March release*");
		expect(text).toContain("https://x/rn");
		expect(text).toContain("- Bulk export");
	});
	it("omits the link line when no link is given", () => {
		const { text } = renderNewsletterChatMessage(content, {
			platform: "SLACK",
		});
		expect(text).not.toContain("http");
	});
	it("handles empty highlights without throwing", () => {
		const { text } = renderNewsletterChatMessage(
			{ headline: "H", highlights: [] },
			{ platform: "TEAMS" },
		);
		expect(text).toContain("H");
	});
	it("truncates an over-long intro with an ellipsis, keeping the link (PO Q2: portion + link)", () => {
		const longIntro = "word ".repeat(80).trim(); // ~400 chars
		const { text } = renderNewsletterChatMessage(
			{ headline: "H", intro: longIntro, highlights: [] },
			{ platform: "SLACK", link: "https://x/rn" },
		);
		const introLine = text.split("\n")[1];
		expect(introLine.length).toBeLessThan(longIntro.length);
		expect(introLine.endsWith("…")).toBe(true);
		expect(text).toContain("<https://x/rn|"); // link survives truncation
	});
	it("truncates an over-long highlight title", () => {
		const longTitle = "x".repeat(300);
		const { text } = renderNewsletterChatMessage(
			{ headline: "H", highlights: [{ title: longTitle }] },
			{ platform: "TEAMS" },
		);
		expect(text).toContain("…");
		expect(text).not.toContain(longTitle); // full title never posted
	});
	it("leaves short intro and titles unchanged (no stray ellipsis)", () => {
		// maxHighlights:4 shows all 4 → no "…and N more" overflow either, so the
		// only way "…" appears is field truncation, which must NOT happen here.
		const { text } = renderNewsletterChatMessage(content, {
			platform: "TEAMS",
			maxHighlights: 4,
		});
		expect(text).toContain("Two big features shipped.");
		expect(text).toContain("- Webhooks");
		expect(text).not.toContain("…");
	});
});
