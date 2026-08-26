import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PmSyncOutageRollup } from "../PmSyncOutageRollup";

const baseProps = {
	pmToolName: "Fizzy",
	count: 3,
	items: [
		{ id: "s1", itemType: "story" as const },
		{ id: "s2", itemType: "story" as const },
		{ id: "s3", itemType: "story" as const },
	],
	onRetryAll: () => {},
};

describe("PmSyncOutageRollup", () => {
	it("renders the unreachable summary with plural ticket copy", () => {
		render(<PmSyncOutageRollup {...baseProps} />);

		expect(
			screen.getByText("Fizzy unreachable — 3 tickets affected"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Retry all" }),
		).toBeInTheDocument();
	});

	it("uses singular ticket copy when count is 1", () => {
		render(
			<PmSyncOutageRollup
				{...baseProps}
				count={1}
				items={[{ id: "only", itemType: "story" }]}
			/>,
		);

		expect(
			screen.getByText("Fizzy unreachable — 1 ticket affected"),
		).toBeInTheDocument();
	});

	it("renders the optional error class when provided", () => {
		render(<PmSyncOutageRollup {...baseProps} errorClass="PmAuthError" />);

		expect(screen.getByText("PmAuthError")).toBeInTheDocument();
	});

	it("toggles details expansion and exposes per-item open buttons", async () => {
		const onOpenItem = vi.fn();
		const user = userEvent.setup();
		render(
			<PmSyncOutageRollup
				{...baseProps}
				details={[
					{
						id: "s1",
						itemType: "story",
						identifier: "F-101",
						title: "First",
					},
					{
						id: "f1",
						itemType: "feature",
						identifier: "F-102",
						title: "Second",
					},
				]}
				onOpenItem={onOpenItem}
			/>,
		);

		const detailsToggle = screen.getByRole("button", { name: /Details/i });
		expect(detailsToggle).toHaveAttribute("aria-expanded", "false");

		await user.click(detailsToggle);
		expect(detailsToggle).toHaveAttribute("aria-expanded", "true");

		const openButtons = screen.getAllByRole("button", { name: "Open" });
		await user.click(openButtons[0]);
		expect(onOpenItem).toHaveBeenCalledWith({
			id: "s1",
			itemType: "story",
		});

		await user.click(openButtons[1]);
		expect(onOpenItem).toHaveBeenCalledWith({
			id: "f1",
			itemType: "feature",
		});
	});

	it("invokes onRetryAll and disables the button while retrying", async () => {
		const onRetryAll = vi.fn();
		const user = userEvent.setup();
		const { rerender } = render(
			<PmSyncOutageRollup {...baseProps} onRetryAll={onRetryAll} />,
		);

		await user.click(screen.getByRole("button", { name: "Retry all" }));
		expect(onRetryAll).toHaveBeenCalledTimes(1);

		rerender(
			<PmSyncOutageRollup
				{...baseProps}
				onRetryAll={onRetryAll}
				isRetrying
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Retrying…" }),
		).toBeDisabled();
	});
});
