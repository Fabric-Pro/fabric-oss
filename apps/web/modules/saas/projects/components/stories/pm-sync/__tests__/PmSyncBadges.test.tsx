import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PmSyncConflictBadge } from "../PmSyncConflictBadge";
import {
	isPmTicketMissingError,
	PmSyncFailureBadge,
} from "../PmSyncFailureBadge";

describe("PmSyncConflictBadge", () => {
	it("renders the default conflict label", () => {
		render(<PmSyncConflictBadge />);

		const button = screen.getByRole("button", {
			name: "PM sync conflict — review",
		});
		expect(button).toBeInTheDocument();
		expect(button).toHaveTextContent("PM sync conflict");
	});

	it("includes the PM tool name in the aria-label when provided", () => {
		render(<PmSyncConflictBadge pmToolName="Azure DevOps" />);

		expect(
			screen.getByRole("button", {
				name: "PM sync conflict — review changes against Azure DevOps",
			}),
		).toBeInTheDocument();
	});

	it("invokes onClick when activated", async () => {
		const onClick = vi.fn();
		const user = userEvent.setup();
		render(<PmSyncConflictBadge onClick={onClick} />);

		await user.click(screen.getByRole("button"));

		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("stops click propagation so parent card click handlers do not fire", async () => {
		const onParentClick = vi.fn();
		const onBadgeClick = vi.fn();
		const user = userEvent.setup();
		render(
			// Mimic the StoryCard wrapper: a div with an onClick that opens
			// the feature drawer. The badge sits inside it.
			// biome-ignore lint/a11y/useKeyWithClickEvents: test fixture only
			<div onClick={onParentClick}>
				<PmSyncConflictBadge onClick={onBadgeClick} />
			</div>,
		);

		await user.click(
			screen.getByRole("button", { name: /PM sync conflict/ }),
		);

		expect(onBadgeClick).toHaveBeenCalledTimes(1);
		expect(onParentClick).not.toHaveBeenCalled();
	});
});

describe("PmSyncFailureBadge", () => {
	it("renders the default failure label", () => {
		const { container } = render(<PmSyncFailureBadge />);

		const button = screen.getByRole("button", {
			name: "PM sync failed — open error details",
		});
		expect(button).toBeInTheDocument();
		expect(button).toHaveTextContent("PM sync failed");
		expect(container.querySelector(".text-destructive")).not.toBeNull();
	});

	it("includes the PM tool name in the aria-label when provided", () => {
		render(<PmSyncFailureBadge pmToolName="Fizzy" />);

		expect(
			screen.getByRole("button", {
				name: "PM sync failed — open Fizzy sync error details",
			}),
		).toBeInTheDocument();
	});

	it("invokes onClick when activated", async () => {
		const onClick = vi.fn();
		const user = userEvent.setup();
		render(<PmSyncFailureBadge onClick={onClick} />);

		await user.click(screen.getByRole("button"));

		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("stops click propagation so parent card click handlers do not fire", async () => {
		const onParentClick = vi.fn();
		const onBadgeClick = vi.fn();
		const user = userEvent.setup();
		render(
			// biome-ignore lint/a11y/useKeyWithClickEvents: test fixture only
			<div onClick={onParentClick}>
				<PmSyncFailureBadge onClick={onBadgeClick} />
			</div>,
		);

		await user.click(
			screen.getByRole("button", { name: /PM sync failed/ }),
		);

		expect(onBadgeClick).toHaveBeenCalledTimes(1);
		expect(onParentClick).not.toHaveBeenCalled();
	});

	it("renders the same red badge for a deleted-card 404 (no separate 'missing' chip)", () => {
		// A deleted card is NOT a distinct chip — it shows the one "PM sync
		// failed" badge like any other failure; the 404 detail lives inside the
		// failure panel. `isPmTicketMissingError` still classifies it (below) to
		// drive the under-the-hood re-create on Retry.
		const { container } = render(<PmSyncFailureBadge pmToolName="Fizzy" />);

		const button = screen.getByRole("button", {
			name: "PM sync failed — open Fizzy sync error details",
		});
		expect(button).toHaveTextContent("PM sync failed");
		expect(container.querySelector(".text-destructive")).not.toBeNull();
		// No amber "missing" treatment exists anymore.
		expect(container.querySelector(".text-highlight")).toBeNull();
	});
});

describe("isPmTicketMissingError", () => {
	it("matches the humanized 'no longer exists' phrase and raw not-found shapes", () => {
		expect(
			isPmTicketMissingError(
				"The linked PM card no longer exists in the PM tool — it was deleted.",
			),
		).toBe(true);
		expect(
			isPmTicketMissingError(
				'Resource not found: {"status":404,"error":"Not Found"}',
			),
		).toBe(true);
		expect(isPmTicketMissingError("Work item 42 does not exist")).toBe(
			true,
		);
	});

	it("vetoes permission shapes (a permission error is not a deleted card)", () => {
		expect(
			isPmTicketMissingError("Work item not found: access denied (403)"),
		).toBe(false);
		expect(isPmTicketMissingError("401 Unauthorized")).toBe(false);
	});

	it("does not match generic failures or empty errors", () => {
		expect(isPmTicketMissingError("Connection refused")).toBe(false);
		expect(isPmTicketMissingError(null)).toBe(false);
		expect(isPmTicketMissingError(undefined)).toBe(false);
		expect(isPmTicketMissingError("")).toBe(false);
	});
});
