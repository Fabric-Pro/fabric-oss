import { describe, expect, it } from "vitest";
import {
	PAGE_ASK_FALLBACK_BODY,
	PAGE_ASK_PROMPT_AGENT_KEY,
} from "../lib/page-ask-prompt";
import { renderTemplate } from "../template-renderer";

const render = async (variables: Record<string, unknown>) => {
	const result = await renderTemplate({
		format: "HANDLEBARS",
		template: PAGE_ASK_FALLBACK_BODY,
		variables,
		escape: false,
	});
	expect(result.error).toBeUndefined();
	return result.rendered;
};

describe("agent key", () => {
	it("is the exact string the seed, the catalog and the service share", () => {
		// A typo resolves no binding and falls back forever, silently.
		expect(PAGE_ASK_PROMPT_AGENT_KEY).toBe("page_ask");
	});
});

describe("the default page-ask instructions", () => {
	it("tell the model it has no tools and must not claim to have acted", async () => {
		const rendered = await render({ format_is_text: true });

		expect(rendered).toContain("You have no tools");
		expect(rendered).toContain("Never say that you have done something");
	});

	it("ask for a single JSON value when the page wants json", async () => {
		const rendered = await render({ format_is_json: true });

		expect(rendered).toContain("one valid JSON value and nothing else");
		expect(rendered).not.toContain("Reply in Markdown");
		expect(rendered).not.toContain("plain text");
	});

	it("ask for Markdown when the page wants markdown", async () => {
		const rendered = await render({ format_is_markdown: true });

		expect(rendered).toContain("Reply in Markdown");
		expect(rendered).not.toContain("valid JSON");
	});

	it("ask for plain text when the page wants text", async () => {
		const rendered = await render({ format_is_text: true });

		expect(rendered).toContain("plain text, without Markdown");
		expect(rendered).not.toContain("valid JSON");
	});
});
