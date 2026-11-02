import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { VisualDataPrepStudio } from "../VisualDataPrepStudio";

it("only explicit creation actions create workflows and unavailable controls are disabled", () => {
	const create = vi.fn();
	render(
		<VisualDataPrepStudio
			connectionsHref="/connections"
			onCreateWorkflow={create}
		/>,
	);
	for (const button of screen.getAllByRole("button")) {
		if (
			/new workflow/i.test(
				button.textContent || button.getAttribute("aria-label") || "",
			)
		) {
			continue;
		}
		fireEvent.click(button);
		expect(create).not.toHaveBeenCalled();
	}
	for (const name of [
		"Run all",
		"Run history",
		"Undo",
		"Redo",
		"Fit view",
		"Zoom in",
		"Zoom out",
		"Auto layout",
		"Favorite workflow",
		"More options",
		"Workspace files",
		"Catalog and Lakebase",
		"Schedule workflow",
		"Export or share workflow",
	]) {
		expect(screen.getByRole("button", { name })).toBeDisabled();
		expect(screen.getByRole("button", { name })).toHaveAttribute(
			"aria-description",
			"Coming soon",
		);
	}
	fireEvent.click(
		screen.getByRole("button", { name: "Create new workflow tab" }),
	);
	expect(create).toHaveBeenCalledOnce();
});
