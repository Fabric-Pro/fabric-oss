import { TemplatePromptPreview } from "@saas/reports/components/TemplatePromptPreview";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const fabricConfig = { defaultSystemPrompt: "Template system prompt" };

describe("TemplatePromptPreview", () => {
	it("shows the template's system prompt with no defaults in the way", () => {
		render(
			<TemplatePromptPreview
				definition={{}}
				fabricConfig={fabricConfig}
			/>,
		);

		expect(screen.getByText("Template system prompt")).toBeInTheDocument();
		expect(screen.queryByText(/default prompts/)).not.toBeInTheDocument();
	});

	it("shows a default system prompt in the template's place, and says so", () => {
		render(
			<TemplatePromptPreview
				definition={{}}
				fabricConfig={fabricConfig}
				promptDefaults={{ systemPrompt: "Default system prompt" }}
			/>,
		);

		expect(screen.getByText("Default system prompt")).toBeInTheDocument();
		expect(
			screen.queryByText("Template system prompt"),
		).not.toBeInTheDocument();
		expect(screen.getByText(/default prompts/)).toBeInTheDocument();
	});
});
