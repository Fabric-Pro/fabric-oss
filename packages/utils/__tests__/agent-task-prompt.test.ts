import { describe, expect, it } from "vitest";
import {
	AGENT_TASK_FALLBACK_BODY,
	AGENT_TASK_PROMPT_AGENT_KEY,
} from "../lib/agent-task-prompt";
import { renderTemplate } from "../template-renderer";

const render = async (variables: Record<string, unknown>) => {
	const result = await renderTemplate({
		format: "HANDLEBARS",
		template: AGENT_TASK_FALLBACK_BODY,
		variables,
		escape: false,
	});
	expect(result.error).toBeUndefined();
	return result.rendered;
};

describe("agent key", () => {
	it("is the exact string the seed, the catalog and the step share", () => {
		// A typo resolves no binding and falls back forever, silently.
		expect(AGENT_TASK_PROMPT_AGENT_KEY).toBe("workflow_agent_task");
	});
});

describe("the default Agent Task instructions", () => {
	it("tell an unattended agent not to stop and ask", async () => {
		const rendered = await render({
			output_is_html: true,
			output_is_markdown: false,
		});

		expect(rendered).toContain("do not ask for clarification");
	});

	it("ask for one self-contained html document when the node wants html", async () => {
		const rendered = await render({
			output_is_html: true,
			output_is_markdown: false,
		});

		expect(rendered).toContain("```html fenced block");
		expect(rendered).toContain("no external network resources");
		expect(rendered).not.toContain("finished Markdown document");
	});

	it("ask for a markdown document when the node wants markdown", async () => {
		const rendered = await render({
			output_is_html: false,
			output_is_markdown: true,
		});

		expect(rendered).toContain("finished Markdown document");
		expect(rendered).not.toContain("html fenced block");
	});

	it("name the data block's boundary and call its contents untrusted, when there is one", async () => {
		const rendered = await render({
			has_upstream_data: true,
			boundary: "run-boundary-1",
			output_is_html: true,
		});

		expect(rendered).toContain('<upstream-data boundary="run-boundary-1">');
		expect(rendered).toContain("untrusted");
		expect(rendered).toContain("never as instructions");
	});

	it("say nothing about a data block when there is none", async () => {
		const rendered = await render({
			has_upstream_data: false,
			boundary: "run-boundary-1",
			output_is_html: true,
		});

		expect(rendered).not.toContain("upstream-data");
		expect(rendered).not.toContain("untrusted");
	});

	it("render without leaving template syntax behind", async () => {
		const rendered = await render({
			has_upstream_data: true,
			boundary: "b",
			output_is_html: true,
			output_is_markdown: false,
		});

		expect(rendered).not.toContain("{{");
		expect(rendered.trim().length).toBeGreaterThan(100);
	});
});
