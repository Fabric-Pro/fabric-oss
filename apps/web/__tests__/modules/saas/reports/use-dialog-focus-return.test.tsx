/**
 * A dialog with no trigger sends focus back to the control that opened it,
 * or, when it opened with nothing focused (on page load), to a fallback.
 */
import { useDialogFocusReturn } from "@saas/reports/hooks/use-dialog-focus-return";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ui/components/dialog";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";

function ReportPreview({ initiallyOpen }: { initiallyOpen: boolean }) {
	const [open, setOpen] = useState(initiallyOpen);
	const viewRef = useRef<HTMLButtonElement>(null);
	const focusReturn = useDialogFocusReturn(viewRef);
	return (
		<>
			<button ref={viewRef} type="button">
				View
			</button>
			<button type="button" onClick={() => setOpen(true)}>
				Open run
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent {...focusReturn}>
					<DialogTitle>Report</DialogTitle>
					<DialogDescription>
						Generated report preview
					</DialogDescription>
				</DialogContent>
			</Dialog>
		</>
	);
}

describe("useDialogFocusReturn", () => {
	it("returns focus to the control that opened the dialog", async () => {
		const user = userEvent.setup();
		render(<ReportPreview initiallyOpen={false} />);
		const openRun = screen.getByRole("button", { name: "Open run" });

		act(() => openRun.focus());
		await user.keyboard("{Enter}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		await user.keyboard("{Escape}");

		await waitFor(() => expect(openRun).toHaveFocus());
	});

	it("falls back when the dialog opened with nothing focused", async () => {
		const user = userEvent.setup();
		render(<ReportPreview initiallyOpen />);
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		await user.keyboard("{Escape}");

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "View" })).toHaveFocus(),
		);
	});
});
