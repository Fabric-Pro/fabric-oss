import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatWelcome } from "../ChatWelcome";

afterEach(cleanup);

const suggestions = [
	{
		label: "Capabilities",
		value: "Show me what Example Analyst can help with",
		icon: <span aria-hidden="true">+</span>,
	},
	{
		label: "Best input",
		description: "Explain how to prepare a detailed analysis request",
		value: "Help me prepare an analysis request",
		icon: <span aria-hidden="true">+</span>,
	},
];

describe("ChatWelcome flat starters", () => {
	it("lets full descriptions wrap within full-width divider rows", () => {
		render(
			<ChatWelcome
				categories={[]}
				suggestions={suggestions}
				onSuggestionClick={vi.fn()}
			/>,
		);
		expect(screen.getByRole("list")).toHaveClass(
			"w-full",
			"divide-y",
			"border-b",
		);
		for (const suggestion of suggestions) {
			const description = suggestion.description ?? suggestion.value;
			const button = screen.getByRole("button", {
				name: `${suggestion.label} — ${description}`,
			});
			expect(button).toHaveClass("min-w-0");
			expect(button.closest("li")).toHaveClass("min-w-0");
			const text = screen.getByText(description, { exact: false });
			expect(text).toHaveClass("whitespace-normal", "break-words");
			expect(text).not.toHaveClass("truncate");
		}
	});

	it.each(suggestions)(
		"selects the exact prompt for $label without submitting the composer",
		(suggestion) => {
			const onSuggestionClick = vi.fn();
			const onSubmit = vi.fn();
			render(
				<form onSubmit={onSubmit}>
					<ChatWelcome
						categories={[]}
						suggestions={suggestions}
						onSuggestionClick={onSuggestionClick}
						composer={
							<textarea
								aria-label="Draft"
								defaultValue="Existing draft"
							/>
						}
					/>
				</form>,
			);
			expect(onSuggestionClick).not.toHaveBeenCalled();
			fireEvent.click(
				screen.getByRole("button", {
					name: `${suggestion.label} — ${suggestion.description ?? suggestion.value}`,
				}),
			);
			expect(onSuggestionClick).toHaveBeenCalledExactlyOnceWith(
				suggestion.value,
			);
			expect(onSubmit).not.toHaveBeenCalled();
			expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue(
				"Existing draft",
			);
		},
	);
});
