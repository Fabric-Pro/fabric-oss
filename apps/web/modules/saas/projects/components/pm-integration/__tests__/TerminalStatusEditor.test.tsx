import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TerminalStatusEditor } from "../TerminalStatusEditor";

describe("TerminalStatusEditor", () => {
	it("adds a status and emits the new list", async () => {
		const onChange = vi.fn();
		render(
			<TerminalStatusEditor
				value={["Closed"]}
				onChange={onChange}
				onSuggest={vi.fn()}
				isSuggesting={false}
			/>,
		);
		await userEvent.type(
			screen.getByPlaceholderText(/add a status/i),
			"Done{enter}",
		);
		expect(onChange).toHaveBeenLastCalledWith(["Closed", "Done"]);
	});

	it("removes a status and emits the new list", async () => {
		const onChange = vi.fn();
		render(
			<TerminalStatusEditor
				value={["Closed", "Done"]}
				onChange={onChange}
				onSuggest={vi.fn()}
				isSuggesting={false}
			/>,
		);
		await userEvent.click(screen.getByLabelText(/remove Closed/i));
		expect(onChange).toHaveBeenLastCalledWith(["Done"]);
	});

	it("does not render the Suggest with AI button (temporarily removed)", () => {
		render(
			<TerminalStatusEditor
				value={[]}
				onChange={vi.fn()}
				onSuggest={vi.fn()}
				isSuggesting={false}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: /suggest with ai/i }),
		).not.toBeInTheDocument();
	});
});
