import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { WorkflowTemplateField } from "../config-fields/WorkflowTemplateField";

it("inserts a stable output token at the selection and retains surrounding text", async () => {
	function Harness() {
		const [value, setValue] = useState("Before old after");
		return (
			<>
				<label htmlFor="prompt">Prompt</label>
				<WorkflowTemplateField
					id="prompt"
					multiline
					value={value}
					onChange={setValue}
					options={[
						{
							label: "text",
							category: "Summary",
							value: "{{$summary.text}}",
						},
					]}
				/>
			</>
		);
	}
	render(<Harness />);
	const input = screen.getByRole("textbox", {
		name: "Prompt",
	}) as HTMLTextAreaElement;
	input.focus();
	input.setSelectionRange(7, 10);
	fireEvent.click(screen.getByRole("button", { name: "Insert output" }));
	fireEvent.click(screen.getByRole("button", { name: /Summary · text/ }));
	await waitFor(() =>
		expect(input).toHaveValue("Before {{$summary.text}} after"),
	);
});
