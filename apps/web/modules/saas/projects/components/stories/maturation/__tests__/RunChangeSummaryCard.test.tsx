/**
 * RunChangeSummaryCard — "Changes from this run" review card.
 *
 * Renders the latest run's change bullets with two soft actions: "Looks good"
 * (client-side dismiss persisted per run version in localStorage) and "Revert
 * this run" (confirm → onRevert). Dismiss is keyed by `${storyId}:${version}`,
 * so a NEW run (new version) resurfaces a fresh card. next-intl is globally
 * key-mocked in vitest.setup.ts (labels === keys).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunChangeSummaryCard } from "../RunChangeSummaryCard";

const latestRun = {
	version: 5,
	changeSummary: [
		"Must Haves — restricted MFA methods to email and SMS",
		"Out of Scope — removed hardware-token support",
	],
	createdAt: new Date("2026-06-22"),
};

function renderCard(
	overrides: Partial<Parameters<typeof RunChangeSummaryCard>[0]> = {},
) {
	const onRevert = vi.fn();
	const utils = render(
		<RunChangeSummaryCard
			storyId="s1"
			latestRun={latestRun}
			onRevert={onRevert}
			isReverting={false}
			{...overrides}
		/>,
	);
	return { ...utils, onRevert };
}

beforeEach(() => {
	window.localStorage.clear();
});
afterEach(() => {
	vi.clearAllMocks();
});

describe("RunChangeSummaryCard", () => {
	it("renders the run's change bullets under the heading", () => {
		renderCard();
		expect(screen.getByText("heading")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Must Haves — restricted MFA methods to email and SMS",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("Out of Scope — removed hardware-token support"),
		).toBeInTheDocument();
	});

	it('"Looks good" dismisses the card and persists the dismissal per run version', async () => {
		const user = userEvent.setup();
		const { unmount } = renderCard();

		await user.click(screen.getByRole("button", { name: "looksGood" }));
		expect(screen.queryByText("heading")).not.toBeInTheDocument();
		expect(
			window.localStorage.getItem(
				"maturation:run-summary-dismissed:s1:5",
			),
		).toBe("1");

		// Re-mounting the same run stays dismissed.
		unmount();
		renderCard();
		expect(screen.queryByText("heading")).not.toBeInTheDocument();
	});

	it("resurfaces for a NEW run version even after a prior dismissal", async () => {
		const user = userEvent.setup();
		const { unmount } = renderCard();
		await user.click(screen.getByRole("button", { name: "looksGood" }));
		unmount();

		// A new run (version 6) → fresh card.
		renderCard({ latestRun: { ...latestRun, version: 6 } });
		expect(screen.getByText("heading")).toBeInTheDocument();
	});

	it('"Revert this run" opens a confirm dialog and calls onRevert on confirm', async () => {
		const user = userEvent.setup();
		const { onRevert } = renderCard();

		await user.click(screen.getByRole("button", { name: "revert" }));
		// Confirm dialog surfaces.
		expect(await screen.findByText("confirmTitle")).toBeInTheDocument();
		expect(onRevert).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "confirmAction" }));
		expect(onRevert).toHaveBeenCalledTimes(1);
	});

	it("cancelling the confirm dialog does not revert", async () => {
		const user = userEvent.setup();
		const { onRevert } = renderCard();

		await user.click(screen.getByRole("button", { name: "revert" }));
		await screen.findByText("confirmTitle");
		await user.click(screen.getByRole("button", { name: "confirmCancel" }));

		expect(onRevert).not.toHaveBeenCalled();
		// Card is still visible (not dismissed by cancelling a revert).
		expect(screen.getByText("heading")).toBeInTheDocument();
	});
});
