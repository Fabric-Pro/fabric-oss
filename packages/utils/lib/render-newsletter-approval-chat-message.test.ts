import { describe, expect, it } from "vitest";
import { renderNewsletterApprovalChatMessage } from "./render-newsletter-approval-chat-message";

const base = {
	projectName: "Example Project",
	highlightCount: 3,
	link: "https://example.com/app/example-org/projects/p-1",
};

describe("renderNewsletterApprovalChatMessage", () => {
	it("names the project and links to the review screen", () => {
		const out = renderNewsletterApprovalChatMessage({
			...base,
			platform: "SLACK",
		});
		expect(out).toContain("Example Project");
		expect(out).toContain(base.link);
	});

	it("states how many highlights are waiting", () => {
		expect(
			renderNewsletterApprovalChatMessage({ ...base, platform: "TEAMS" }),
		).toContain("3");
	});

	it("uses Slack mrkdwn link syntax for Slack", () => {
		const out = renderNewsletterApprovalChatMessage({
			...base,
			platform: "SLACK",
		});
		expect(out).toContain(`<${base.link}|`);
	});

	it("uses a bare URL for Teams, which parses no markup", () => {
		const out = renderNewsletterApprovalChatMessage({
			...base,
			platform: "TEAMS",
		});
		expect(out).not.toContain("<http");
		expect(out).toContain(base.link);
	});

	it("singularises a single highlight", () => {
		const out = renderNewsletterApprovalChatMessage({
			...base,
			highlightCount: 1,
			platform: "TEAMS",
		});
		expect(out).toContain("1 highlight");
		expect(out).not.toContain("1 highlights");
	});
});
