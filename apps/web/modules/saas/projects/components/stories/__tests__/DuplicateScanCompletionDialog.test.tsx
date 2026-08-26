/**
 * Behavior tests for the duplicate-scan completion dialog.
 *
 * Covers both content variants (duplicates found vs none), the
 * "View Duplicates" / "Done" / Escape close paths, the blocked backdrop
 * click, initial-focus placement, the null-result guard, and an axe
 * accessibility smoke check.
 *
 * next-intl is globally key-mocked in vitest.setup.ts, so translated
 * strings surface as their keys (e.g. "scanCompleteTitle"); buttons are
 * queried by their aria-label keys because `aria-label` is the accessible
 * name.
 */

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";
import {
	DuplicateScanCompletionDialog,
	type DuplicateScanCompletionDialogProps,
} from "../DuplicateScanCompletionDialog";

expect.extend(axeMatchers);

// The variant and headline count are driven by `flaggedItems` — the number of
// distinct items currently flagged (the same set the roadmap "Possible
// duplicates" filter shows) — NOT this run's confirmed pair count. Deliberate
// contract change: the modal headline must always equal what "View Duplicates"
// reveals, even on a re-scan that confirms nothing new.
const FOUND_RESULT = {
	flaggedItems: 3,
	scanned: 12,
	candidates: 5,
	verifierFailures: 0,
};
const ZERO_RESULT = {
	flaggedItems: 0,
	scanned: 12,
	candidates: 4,
	verifierFailures: 0,
};
// Every candidate pair failed verification — a wholesale AI outage, not a clean
// scan. `flaggedItems` is a stale count from a prior scan and must NOT surface.
const INCOMPLETE_RESULT = {
	flaggedItems: 3,
	scanned: 12,
	candidates: 6,
	verifierFailures: 6,
};
// Some pairs verified, some failed: the found count is real but partial.
const PARTIAL_RESULT = {
	flaggedItems: 3,
	scanned: 12,
	candidates: 6,
	verifierFailures: 2,
};

function renderDialog(props?: Partial<DuplicateScanCompletionDialogProps>) {
	const onOpenChange = vi.fn();
	const onViewDuplicates = vi.fn();
	const view = render(
		<DuplicateScanCompletionDialog
			open
			onOpenChange={onOpenChange}
			result={FOUND_RESULT}
			onViewDuplicates={onViewDuplicates}
			{...props}
		/>,
	);
	return { onOpenChange, onViewDuplicates, view };
}

// Radix attaches its outside-pointerdown listener one macrotask after the
// content mounts (so the interaction that opened the dialog cannot
// immediately dismiss it). Flush that macrotask deterministically before
// and after outside interactions — a zero-delay queue drain, not a wait.
async function flushMacrotasks() {
	await act(async () => {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
	});
}

describe("DuplicateScanCompletionDialog — found variant", () => {
	it("renders the title, count line, tagged confirmation, both actions and the X close", () => {
		renderDialog();

		expect(screen.getByText("scanCompleteTitle")).toBeInTheDocument();
		expect(screen.getByText("scanCompleteItems")).toBeInTheDocument();
		expect(screen.getByText("scanCompleteTagged")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "viewDuplicatesAria" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "doneAria" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Close" }),
		).toBeInTheDocument();
	});

	it("invokes onViewDuplicates and closes when View Duplicates is clicked", async () => {
		const user = userEvent.setup();
		const { onOpenChange, onViewDuplicates } = renderDialog();

		await user.click(
			screen.getByRole("button", { name: "viewDuplicatesAria" }),
		);

		expect(onViewDuplicates).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("closes without applying the filter when Done is clicked", async () => {
		const user = userEvent.setup();
		const { onOpenChange, onViewDuplicates } = renderDialog();

		await user.click(screen.getByRole("button", { name: "doneAria" }));

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onViewDuplicates).not.toHaveBeenCalled();
	});

	it("closes without applying the filter on Escape", async () => {
		const user = userEvent.setup();
		const { onOpenChange, onViewDuplicates } = renderDialog();

		await user.keyboard("{Escape}");

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onViewDuplicates).not.toHaveBeenCalled();
	});

	it("stays open when the backdrop is clicked", async () => {
		const { onOpenChange } = renderDialog();
		await flushMacrotasks();

		fireEvent.pointerDown(document.body);
		fireEvent.click(document.body);
		await flushMacrotasks();

		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("places initial focus on the View Duplicates button", async () => {
		renderDialog();

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "viewDuplicatesAria" }),
			).toHaveFocus();
		});
	});

	it("has no obvious accessibility violations and an accessible dialog name", async () => {
		renderDialog();

		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveAccessibleName();
		expect(await axe(document.body)).toHaveNoViolations();
	});

	it("announces the tagged confirmation as part of the dialog description", () => {
		renderDialog();

		const dialog = screen.getByRole("dialog");
		expect(dialog).toHaveAccessibleDescription(
			expect.stringContaining("scanCompleteTagged"),
		);
	});

	it("returns focus to the previously focused element when closed", async () => {
		const user = userEvent.setup();

		function Harness() {
			const [open, setOpen] = useState(false);
			return (
				<div>
					<button type="button" onClick={() => setOpen(true)}>
						opener
					</button>
					<DuplicateScanCompletionDialog
						open={open}
						onOpenChange={setOpen}
						result={FOUND_RESULT}
						onViewDuplicates={vi.fn()}
					/>
				</div>
			);
		}
		render(<Harness />);

		// Clicking focuses the opener button, then opens the dialog.
		await user.click(screen.getByRole("button", { name: "opener" }));
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "viewDuplicatesAria" }),
			).toHaveFocus();
		});

		await user.click(screen.getByRole("button", { name: "doneAria" }));

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "opener" }),
			).toHaveFocus();
		});
	});
});

describe("DuplicateScanCompletionDialog — zero variant", () => {
	it("renders the no-duplicates copy with Done only", () => {
		renderDialog({ result: ZERO_RESULT });

		expect(screen.getByText("scanNoneTitle")).toBeInTheDocument();
		expect(screen.getByText("scanNoneDescription")).toBeInTheDocument();
		expect(screen.getByText("scanNoneTagged")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "doneAria" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "viewDuplicatesAria" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("viewDuplicates")).not.toBeInTheDocument();
	});

	it("places initial focus on the Done button", async () => {
		renderDialog({ result: ZERO_RESULT });

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "doneAria" }),
			).toHaveFocus();
		});
	});
});

describe("DuplicateScanCompletionDialog — verification-incomplete variant", () => {
	it("leads with the couldn't-finish copy and offers Scan again, not View Duplicates", () => {
		renderDialog({ result: INCOMPLETE_RESULT, onRetry: vi.fn() });

		expect(screen.getByText("scanIncompleteTitle")).toBeInTheDocument();
		expect(
			screen.getByText("scanIncompleteDescription"),
		).toBeInTheDocument();
		expect(screen.getByText("scanIncompleteUnchanged")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "scanAgainAria" }),
		).toBeInTheDocument();
		// A stale flagged count must NOT be presented as this scan's result.
		expect(screen.queryByText("scanCompleteItems")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "viewDuplicatesAria" }),
		).not.toBeInTheDocument();
	});

	it("invokes onRetry and closes when Scan again is clicked", async () => {
		const user = userEvent.setup();
		const onRetry = vi.fn();
		const { onOpenChange } = renderDialog({
			result: INCOMPLETE_RESULT,
			onRetry,
		});

		await user.click(screen.getByRole("button", { name: "scanAgainAria" }));

		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("places initial focus on Scan again", async () => {
		renderDialog({ result: INCOMPLETE_RESULT, onRetry: vi.fn() });

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "scanAgainAria" }),
			).toHaveFocus();
		});
	});

	it("falls back to Done-only when no retry handler is provided", () => {
		renderDialog({ result: INCOMPLETE_RESULT });

		expect(screen.getByText("scanIncompleteTitle")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "scanAgainAria" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "doneAria" }),
		).toBeInTheDocument();
	});
});

describe("DuplicateScanCompletionDialog — partial-failure warning", () => {
	it("keeps the found variant but adds the retry warning line", () => {
		renderDialog({ result: PARTIAL_RESULT });

		// Still the found variant — most pairs verified.
		expect(screen.getByText("scanCompleteTitle")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "viewDuplicatesAria" }),
		).toBeInTheDocument();
		// ...plus an honest heads-up that some pairs weren't checked.
		expect(screen.getByText("scanPartialWarning")).toBeInTheDocument();
	});

	it("does not show the warning on a fully successful scan", () => {
		renderDialog({ result: FOUND_RESULT });

		expect(
			screen.queryByText("scanPartialWarning"),
		).not.toBeInTheDocument();
	});
});

describe("DuplicateScanCompletionDialog — result guard", () => {
	it("renders nothing while no scan result exists", () => {
		const { view } = renderDialog({ result: null });

		expect(view.container).toBeEmptyDOMElement();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
