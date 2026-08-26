import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FindingsBulkBar } from "../FindingsBulkBar";

// Radix DropdownMenu/AlertDialog need these jsdom shims.
beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.setPointerCapture ??= () => {};
	HTMLElement.prototype.releasePointerCapture ??= () => {};
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

describe("FindingsBulkBar", () => {
	it("renders nothing when no findings are selected", () => {
		const { container } = render(
			<FindingsBulkBar
				selectedCount={0}
				isApplying={false}
				onApply={vi.fn()}
				onClear={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the selected count and a labelled region", () => {
		render(
			<FindingsBulkBar
				selectedCount={3}
				isApplying={false}
				onApply={vi.fn()}
				onClear={vi.fn()}
			/>,
		);
		expect(
			screen.getByRole("region", {
				name: /bulk actions for selected findings/i,
			}),
		).toBeInTheDocument();
		expect(screen.getByText("3")).toBeInTheDocument();
		expect(screen.getByText(/selected/i)).toBeInTheDocument();
	});

	it("confirms before marking resolved, then applies the status change", async () => {
		const user = userEvent.setup();
		const onApply = vi.fn();
		render(
			<FindingsBulkBar
				selectedCount={2}
				isApplying={false}
				onApply={onApply}
				onClear={vi.fn()}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: /mark resolved/i }),
		);
		// A confirm dialog appears — nothing applied yet.
		expect(onApply).not.toHaveBeenCalled();
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(/mark 2 findings resolved/i);

		await user.click(
			screen.getByRole("button", { name: /^mark resolved$/i }),
		);
		expect(onApply).toHaveBeenCalledWith({ status: "RESOLVED" });
	});

	it("confirms and applies a severity change from the dropdown", async () => {
		const user = userEvent.setup();
		const onApply = vi.fn();
		render(
			<FindingsBulkBar
				selectedCount={5}
				isApplying={false}
				onApply={onApply}
				onClear={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /set severity/i }));
		// Pick "High" from the menu.
		await user.click(await screen.findByRole("menuitem", { name: "High" }));
		// Confirm dialog, then apply.
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(/change severity of 5 findings/i);
		await user.click(
			screen.getByRole("button", { name: /change severity/i }),
		);
		expect(onApply).toHaveBeenCalledWith({ severity: "HIGH" });
	});

	it("clears the selection via the clear button", async () => {
		const user = userEvent.setup();
		const onClear = vi.fn();
		render(
			<FindingsBulkBar
				selectedCount={1}
				isApplying={false}
				onApply={vi.fn()}
				onClear={onClear}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: /clear selection/i }),
		);
		expect(onClear).toHaveBeenCalledTimes(1);
	});
});
