import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SEVERITY_RUBRIC, type SeverityRubricEntry } from "../lib";
import { SeverityRubricEditor } from "../SeverityRubricEditor";

function renderEditor(
	rubric: ReadonlyArray<SeverityRubricEntry> = DEFAULT_SEVERITY_RUBRIC,
) {
	const onChange = vi.fn();
	render(<SeverityRubricEditor rubric={rubric} onChange={onChange} />);
	return { onChange };
}

describe("SeverityRubricEditor", () => {
	it("renders one editable row per severity band, seeded from defaults", () => {
		renderEditor();
		// Four bands present as labelled textareas.
		for (const label of [
			"Critical definition",
			"High definition",
			"Medium definition",
			"Low definition",
		]) {
			expect(screen.getByLabelText(label)).toBeInTheDocument();
		}
		// Seeded with the default text for that band.
		const critical = screen.getByLabelText(
			"Critical definition",
		) as HTMLTextAreaElement;
		expect(critical.value).toBe(DEFAULT_SEVERITY_RUBRIC[0].definition);
	});

	it("emits the full four-row rubric when a definition is edited", async () => {
		const user = userEvent.setup();
		const { onChange } = renderEditor();

		const medium = screen.getByLabelText("Medium definition");
		// Type one character; onChange fires per keystroke with the full array.
		await user.type(medium, "X");

		expect(onChange).toHaveBeenCalled();
		const lastCall = onChange.mock.calls.at(
			-1,
		)?.[0] as SeverityRubricEntry[];
		expect(lastCall).toHaveLength(4);
		expect(lastCall.map((r) => r.severity)).toEqual([
			"CRITICAL",
			"HIGH",
			"MEDIUM",
			"LOW",
		]);
		// The edited band carries the new trailing character.
		const editedMedium = lastCall.find((r) => r.severity === "MEDIUM");
		expect(editedMedium?.definition.endsWith("X")).toBe(true);
	});

	it("shows the (i) note that edits apply on the next scan", async () => {
		const user = userEvent.setup();
		renderEditor();
		await user.click(
			screen.getByRole("button", {
				name: /about the severity rubric/i,
			}),
		);
		expect(screen.getByText(/apply on the next scan/i)).toBeInTheDocument();
	});
});
