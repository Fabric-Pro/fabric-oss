import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const wf = readFileSync(
	join(__dirname, "../generate-and-send-newsletter.ts"),
	"utf8",
);
const idx = readFileSync(join(__dirname, "../../activities/index.ts"), "utf8");

describe("chat delivery wiring", () => {
	it("gates the new delivery behind the patch marker", () => {
		expect(wf).toContain('patched("newsletter-chat-delivery-2026-07-08")');
	});
	it("invokes the chat activity", () => {
		expect(wf).toContain("sendNewsletterChatMessagesActivity(");
	});
	it("keeps the legacy NO_SUBSCRIBERS branch verbatim", () => {
		expect(wf).toContain('skipReason: "NO_SUBSCRIBERS"');
	});
	it("registers the chat activity in the top-level named export block", () => {
		expect(idx).toContain("sendNewsletterChatMessagesActivity");
	});
});
