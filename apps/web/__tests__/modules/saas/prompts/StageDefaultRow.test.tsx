import { StageDefaultRow } from "@saas/prompts/components/StageDefaultRow";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// PromptCard pulls in tanstack-query, router, orpc client, image helpers,
// etc. — none of which we care about for row-level rendering. Stub it
// with a marker so the row test only verifies which branch was chosen.
vi.mock("@saas/prompts/components/PromptCard", () => ({
	PromptCard: ({ prompt }: { prompt: { id: string; name: string } }) => (
		<div data-testid="prompt-card">{prompt.name}</div>
	),
}));

function makePrompt(id: string, name: string) {
	return {
		id,
		key: `key-${id}`,
		name,
		description: null,
		scope: "SYSTEM" as const,
		category: null,
		tags: [],
		format: "MARKDOWN" as const,
		forkedFrom: null,
		_count: { versions: 3 },
		versions: [{ id: `ver-${id}`, version: 3, content: "" }],
		isPublic: true,
		usageCount: 0,
		lastUsedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

const samplePrompt = makePrompt("p1", "Feature Draft Generator");

describe("StageDefaultRow", () => {
	it("renders the PromptCard when a single binding is provided", () => {
		render(
			<StageDefaultRow
				documentType="DRAFT"
				label="Draft"
				bindings={[
					{
						prompt: samplePrompt,
						binding: {
							id: "b1",
							scope: "SYSTEM",
							versionId: "ver-p1",
							isDefault: true,
						},
					},
				]}
				onRefetch={vi.fn()}
				onPickDefault={vi.fn()}
			/>,
		);

		expect(screen.getByText("Draft")).toBeInTheDocument();
		expect(screen.getByTestId("prompt-card")).toHaveTextContent(
			"Feature Draft Generator",
		);
	});

	it("renders the empty-state CTA when bindings is empty", async () => {
		const onPickDefault = vi.fn();
		render(
			<StageDefaultRow
				documentType="ACTIVE_ANALYSIS"
				label="Active Analysis"
				bindings={[]}
				onRefetch={vi.fn()}
				onPickDefault={onPickDefault}
			/>,
		);

		expect(screen.getByText("Active Analysis")).toBeInTheDocument();
		expect(screen.queryByTestId("prompt-card")).not.toBeInTheDocument();
		const button = screen.getByRole("button", {
			name: /set default prompt for Active Analysis/i,
		});
		await userEvent.click(button);
		expect(onPickDefault).toHaveBeenCalledWith("ACTIVE_ANALYSIS");
	});

	it("renders multiple PromptCards when multiple bindings are provided", () => {
		const promptA = makePrompt("a", "Prompt A");
		const promptB = makePrompt("b", "Prompt B");
		render(
			<StageDefaultRow
				documentType="DRAFT"
				label="Draft"
				bindings={[
					{
						prompt: promptA,
						binding: {
							id: "ba",
							scope: "USER",
							versionId: "ver-a",
							isDefault: true,
						},
					},
					{
						prompt: promptB,
						binding: {
							id: "bb",
							scope: "SYSTEM",
							versionId: "ver-b",
							isDefault: false,
						},
					},
				]}
				onRefetch={vi.fn()}
				onPickDefault={vi.fn()}
			/>,
		);

		const cards = screen.getAllByTestId("prompt-card");
		expect(cards).toHaveLength(2);
		expect(cards[0]).toHaveTextContent("Prompt A");
		expect(cards[1]).toHaveTextContent("Prompt B");
	});
});
