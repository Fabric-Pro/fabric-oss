/**
 * "Checking your upload. This takes a moment." (Fizzy #2878 follow-up). An
 * upload whose browser never reached storage, or whose tab was closed, stays
 * RECEIVING and the line used to say this for hours with no way out. When the
 * viewer may discard the upload, the line offers it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { InstructionsSnapshot } from "../../../lib/instructions-snapshot";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

import { InstructionsCheckingStatus } from "../InstructionsCheckingStatus";

function snapshot(over: Partial<InstructionsSnapshot> = {}) {
	return {
		id: "snap_1",
		version: 4,
		status: "RECEIVING",
		source: "UPLOAD",
		fileCount: 10,
		excludedCount: 0,
		createdAt: "2026-10-03T10:00:00.000Z",
		...over,
	} as InstructionsSnapshot;
}

describe("InstructionsCheckingStatus", () => {
	it("says the upload is being checked", () => {
		render(
			<InstructionsCheckingStatus
				checking={snapshot()}
				publishing={false}
			/>,
		);

		expect(
			screen.getByText("Checking your upload. This takes a moment."),
		).toBeInTheDocument();
	});

	it("offers to discard the upload when the viewer may, and discards it when pressed", async () => {
		const user = userEvent.setup();
		const onDiscard = vi.fn();
		render(
			<InstructionsCheckingStatus
				checking={snapshot()}
				publishing={false}
				onDiscard={onDiscard}
			/>,
		);

		await user.click(
			screen.getByRole("button", { name: "Discard this upload" }),
		);

		expect(onDiscard).toHaveBeenCalledTimes(1);
	});

	it("is not offered a discard when the viewer may not", () => {
		render(
			<InstructionsCheckingStatus
				checking={snapshot()}
				publishing={false}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "Discard this upload" }),
		).not.toBeInTheDocument();
	});

	it("waits for a discard that is in flight rather than offering a second", () => {
		render(
			<InstructionsCheckingStatus
				checking={snapshot()}
				publishing={false}
				onDiscard={vi.fn()}
				discarding
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Discard this upload" }),
		).toBeDisabled();
	});

	it("offers nothing while the tab only waits for the pointer to move", () => {
		render(
			<InstructionsCheckingStatus
				checking={null}
				publishing
				onDiscard={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "Discard this upload" }),
		).not.toBeInTheDocument();
	});
});
