import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";
import { PmSyncDiffModal } from "../PmSyncDiffModal";

expect.extend(axeMatchers);

const defaultProps = {
	open: true,
	onOpenChange: () => {},
	pmToolName: "Fizzy",
	pmCurrent: {
		title: "Original PM title",
		description: "Original PM description",
	},
	fabricProposed: {
		title: "Fabric proposed title",
		description: "Fabric proposed description",
	},
	pmUrl: "https://example.test/ticket/1",
	onPushAnyway: () => {},
	onSkip: () => {},
};

describe("PmSyncDiffModal", () => {
	it("renders the modal heading, both diff columns, and the three actions", () => {
		render(<PmSyncDiffModal {...defaultProps} />);

		expect(
			screen.getByRole("dialog", { name: "PM ticket has changed" }),
		).toBeInTheDocument();
		expect(screen.getByText("PM CURRENT")).toBeInTheDocument();
		expect(screen.getByText("FABRIC PROPOSED")).toBeInTheDocument();
		expect(screen.getByText("Original PM title")).toBeInTheDocument();
		expect(screen.getByText("Fabric proposed title")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Push anyway" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Skip this one" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: /Open in Fizzy/ }),
		).toHaveAttribute("href", "https://example.test/ticket/1");
	});

	it("invokes onPushAnyway when the destructive action is clicked", async () => {
		const onPushAnyway = vi.fn();
		const user = userEvent.setup();
		render(
			<PmSyncDiffModal {...defaultProps} onPushAnyway={onPushAnyway} />,
		);

		await user.click(screen.getByRole("button", { name: "Push anyway" }));
		expect(onPushAnyway).toHaveBeenCalledTimes(1);
	});

	it("invokes onSkip and closes the modal when Skip is clicked", async () => {
		const onSkip = vi.fn();
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		render(
			<PmSyncDiffModal
				{...defaultProps}
				onSkip={onSkip}
				onOpenChange={onOpenChange}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Skip this one" }));
		expect(onSkip).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("disables actions while a push is in flight", () => {
		render(<PmSyncDiffModal {...defaultProps} isPushing />);

		expect(screen.getByRole("button", { name: "Pushing…" })).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Skip this one" }),
		).toBeDisabled();
	});

	it("does not render the external link when pmUrl uses a non-http scheme", () => {
		render(
			<PmSyncDiffModal
				{...defaultProps}
				pmUrl="javascript:alert('xss')"
			/>,
		);

		expect(
			screen.queryByRole("link", { name: /Open in/ }),
		).not.toBeInTheDocument();
		// Modal still functional — Push / Skip remain available.
		expect(
			screen.getByRole("button", { name: "Push anyway" }),
		).toBeInTheDocument();
	});

	it("has no serious or critical axe violations", async () => {
		const { baseElement } = render(<PmSyncDiffModal {...defaultProps} />);

		await waitFor(() =>
			expect(screen.getByRole("dialog")).toBeInTheDocument(),
		);

		const results = await axe(baseElement);
		expect(results).toHaveNoViolations();
	});
});
