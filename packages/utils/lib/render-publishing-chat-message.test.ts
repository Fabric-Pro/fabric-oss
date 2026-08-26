import { describe, expect, it } from "vitest";
import { renderPublishingChatMessage } from "./render-publishing-chat-message";

const topics = [
	{ title: "How we cut cold-start latency", angle: "engineering deep dive" },
	{ title: "What shipped in August", angle: null },
];

describe("renderPublishingChatMessage", () => {
	it("leads with the project name and lists each topic", () => {
		const { text } = renderPublishingChatMessage(
			{ projectName: "Example Project", topics },
			{ platform: "SLACK" },
		);
		expect(text).toContain("Example Project");
		expect(text).toContain("How we cut cold-start latency");
		expect(text).toContain("What shipped in August");
	});

	it("appends the angle only when there is one", () => {
		const { text } = renderPublishingChatMessage(
			{ projectName: "Example Project", topics },
			{ platform: "SLACK" },
		);
		const lines = text.split("\n");
		const withAngle = lines.find((l) => l.includes("cold-start"));
		const withoutAngle = lines.find((l) => l.includes("shipped in August"));
		expect(withAngle).toContain("engineering deep dive");
		expect(withoutAngle).not.toContain("—");
	});

	it("caps the list and says how many were withheld", () => {
		const many = Array.from({ length: 9 }, (_, i) => ({
			title: `Topic ${i}`,
			angle: null,
		}));
		const { text } = renderPublishingChatMessage(
			{ projectName: "Example Project", topics: many },
			{ platform: "SLACK", maxTopics: 5 },
		);
		expect(text).toContain("Topic 4");
		expect(text).not.toContain("Topic 5");
		expect(text).toContain("4 more");
	});

	it("truncates a long title at a word boundary with an ellipsis", () => {
		const long = `${"word ".repeat(60)}end`;
		const { text } = renderPublishingChatMessage(
			{ projectName: "Example Project", topics: [{ title: long }] },
			{ platform: "SLACK" },
		);
		expect(text).toContain("…");
		expect(text).not.toContain("end");
	});

	it("uses Slack link syntax on Slack and plain text on Teams", () => {
		const slack = renderPublishingChatMessage(
			{ projectName: "Example Project", topics },
			{ platform: "SLACK", link: "https://example.com/p" },
		).text;
		const teams = renderPublishingChatMessage(
			{ projectName: "Example Project", topics },
			{ platform: "TEAMS", link: "https://example.com/p" },
		).text;
		expect(slack).toContain("<https://example.com/p|");
		expect(teams).toContain("https://example.com/p");
		expect(teams).not.toContain("<https://");
	});

	it("omits the link block entirely when no link is given", () => {
		const { text } = renderPublishingChatMessage(
			{ projectName: "Example Project", topics },
			{ platform: "TEAMS" },
		);
		expect(text).not.toContain("http");
	});

	// Raised by the adversarial panel on PR #2933. Topic titles are LLM-generated
	// from a corpus that includes messages ingested from the very Slack channels
	// this broadcast posts into, so a title is attacker-influenceable text
	// arriving in a room under a trusted identity.
	it("escapes Slack control characters in a topic title", () => {
		const { text } = renderPublishingChatMessage(
			{
				projectName: "Example Project",
				topics: [
					{ title: "<!channel> ship it & <https://example.com|x>" },
				],
			},
			{ platform: "SLACK" },
		);
		// The whole-room mention and the link syntax must not survive as markup.
		expect(text).not.toContain("<!channel>");
		expect(text).not.toContain("<https://example.com|x>");
		expect(text).toContain("&lt;!channel&gt;");
		expect(text).toContain("&amp;");
	});

	it("escapes the project name too", () => {
		const { text } = renderPublishingChatMessage(
			{ projectName: "<!here> Acme", topics: [] },
			{ platform: "SLACK" },
		);
		expect(text).not.toContain("<!here>");
	});

	// The renderer's OWN scaffolding must stay live, or the escaping would have
	// been bought by turning every message into plain text.
	it("leaves its own bold and link scaffolding unescaped on Slack", () => {
		const { text } = renderPublishingChatMessage(
			{ projectName: "Example Project", topics },
			{ platform: "SLACK", link: "https://example.com/p" },
		);
		expect(text).toContain("*New publishing ideas for Example Project*");
		expect(text).toContain("<https://example.com/p|Review them in Fabric>");
	});

	// Teams posts with contentType "text", which is not markup — escaping there
	// would surface a literal &amp; to the reader.
	it("does NOT escape on Teams", () => {
		const { text } = renderPublishingChatMessage(
			{
				projectName: "Example Project",
				topics: [{ title: "ship it & <tag>" }],
			},
			{ platform: "TEAMS" },
		);
		expect(text).toContain("ship it & <tag>");
		expect(text).not.toContain("&amp;");
	});

	// The activity treats an empty topic list as a whole-run skip and never calls
	// this function with one. Asserted anyway, because "the caller currently never
	// does X" is a property of today's caller and not of this function, and the
	// failure it would otherwise produce — a broadcast announcing ideas and listing
	// none — is one that reaches a shared channel.
	it("renders no bullet block for an empty topic list", () => {
		const { text } = renderPublishingChatMessage(
			{ projectName: "Example Project", topics: [] },
			{ platform: "SLACK" },
		);
		expect(text).toContain("Example Project");
		expect(text).not.toContain("•");
	});
});
