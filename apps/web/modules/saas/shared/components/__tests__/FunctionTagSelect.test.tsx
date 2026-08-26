import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { type FunctionTagValue, FunctionTagSelect } from "../FunctionTagSelect";

/**
 * Stateful harness so `onChange` actually feeds `value` back into the
 * component — a bare `vi.fn()` never re-renders, so no chip would ever appear.
 * The optional spy lets a test assert the emitted value too.
 */
function StatefulSelect({
	onChange,
	initial = [],
}: {
	onChange?: (next: FunctionTagValue[]) => void;
	initial?: FunctionTagValue[];
}) {
	const [value, setValue] = useState<FunctionTagValue[]>(initial);
	return (
		<FunctionTagSelect
			value={value}
			onChange={(next) => {
				setValue(next);
				onChange?.(next);
			}}
			aria-label="tags"
		/>
	);
}

describe("FunctionTagSelect", () => {
	it("shows a placeholder when empty and lists all 8 options on open", () => {
		render(
			<FunctionTagSelect
				value={[]}
				onChange={() => {}}
				aria-label="tags"
			/>,
		);
		expect(screen.getByText("Select function tags")).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText("tags"));
		expect(screen.getByText("Product Owner")).toBeInTheDocument();
		expect(screen.getByText("Designer")).toBeInTheDocument();
		expect(screen.getByText("Stakeholder")).toBeInTheDocument();
		// 8 options total (Stage-1's 7 + the PO-added Designer)
		expect(screen.getAllByRole("option")).toHaveLength(8);
	});

	it("adds a tag on select and renders it as a chip", () => {
		const onChange = vi.fn();
		render(<StatefulSelect onChange={onChange} />);
		fireEvent.click(screen.getByLabelText("tags"));
		// Scope to the dropdown option: once selected the trigger also holds a
		// "Developer" chip, so a bare getByText would be ambiguous.
		fireEvent.click(screen.getByRole("option", { name: "Developer" }));
		expect(onChange).toHaveBeenCalledWith(["DEVELOPER"]);
		// Chip + its remove control now render inside the trigger.
		const trigger = screen.getByLabelText("tags");
		expect(within(trigger).getByText("Developer")).toBeInTheDocument();
		expect(screen.getByLabelText("Remove Developer")).toBeInTheDocument();
	});

	it("toggles a selected tag off when re-selected", () => {
		const onChange = vi.fn();
		render(
			<FunctionTagSelect
				value={["DEVELOPER"]}
				onChange={onChange}
				aria-label="tags"
			/>,
		);
		fireEvent.click(screen.getByLabelText("tags"));
		// Target the dropdown option, not the "Developer" chip in the trigger.
		fireEvent.click(screen.getByRole("option", { name: "Developer" }));
		expect(onChange).toHaveBeenCalledWith([]);
	});

	it("removes a tag via its chip remove button", () => {
		const onChange = vi.fn();
		render(
			<FunctionTagSelect
				value={["DEVELOPER"]}
				onChange={onChange}
				aria-label="tags"
			/>,
		);
		fireEvent.click(screen.getByLabelText("Remove Developer"));
		expect(onChange).toHaveBeenCalledWith([]);
	});

	it("does not open when disabled", () => {
		render(
			<FunctionTagSelect
				value={[]}
				onChange={() => {}}
				disabled
				aria-label="tags"
			/>,
		);
		fireEvent.click(screen.getByLabelText("tags"));
		expect(screen.queryByText("Developer")).not.toBeInTheDocument();
	});
});
