/**
 * The select trigger's hover tooltip. The tooltip is the trigger's `title`,
 * which is also its accessible description, so it must not outlive the hover
 * and keep naming a value that has since changed.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { describe, expect, it } from "vitest";

function ProjectSelect({ value }: { value: string }) {
	return (
		<Select value={value}>
			<SelectTrigger aria-label="Project">
				<SelectValue placeholder="Pick a project" />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="alpha">Alpha project</SelectItem>
				<SelectItem value="beta">Beta project</SelectItem>
			</SelectContent>
		</Select>
	);
}

describe("SelectTrigger", () => {
	it("shows the selected value as a tooltip only while hovered", async () => {
		const { rerender } = render(<ProjectSelect value="alpha" />);
		const trigger = screen.getByRole("combobox", { name: "Project" });

		await userEvent.hover(trigger);
		expect(trigger).toHaveAttribute("title", "Alpha project");

		await userEvent.unhover(trigger);
		expect(trigger).not.toHaveAccessibleDescription("Alpha project");

		rerender(<ProjectSelect value="beta" />);
		expect(trigger).toHaveTextContent("Beta project");
		expect(trigger).not.toHaveAccessibleDescription("Alpha project");

		await userEvent.hover(trigger);
		expect(trigger).toHaveAttribute("title", "Beta project");
	});
});
