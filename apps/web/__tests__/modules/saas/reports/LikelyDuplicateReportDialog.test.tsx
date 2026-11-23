/**
 * The duplicate warning opens after a check, not from a trigger, so Radix
 * alone would leave focus on the page when it closes. Closing it returns
 * focus to the control that asked to create the report.
 */
import { LikelyDuplicateReportDialog } from "@saas/reports/components/LikelyDuplicateReportDialog";
import type { LikelyDuplicateReport } from "@saas/reports/hooks/use-likely-duplicate-guard";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

const DUPLICATE: LikelyDuplicateReport = {
	id: "example-report",
	name: "My Custom report",
	templateName: "Custom report",
	status: "ACTIVE",
	isActive: true,
	ownedByCaller: true,
	createdAt: "2026-11-20T05:00:00.000Z",
	lastRunAt: null,
	sameTitle: true,
	samePrompt: false,
};

function GenerateWithWarning() {
	const [duplicates, setDuplicates] = useState<
		LikelyDuplicateReport[] | null
	>(null);
	return (
		<>
			<button type="button" onClick={() => setDuplicates([DUPLICATE])}>
				Generate report
			</button>
			<LikelyDuplicateReportDialog
				duplicates={duplicates}
				reportTemplatesPath="/app/example-org/report-templates"
				continueLabel="Generate anyway"
				onCancel={() => setDuplicates(null)}
				onContinue={() => setDuplicates(null)}
			/>
		</>
	);
}

async function openWarning() {
	const user = userEvent.setup();
	render(<GenerateWithWarning />);
	const generate = screen.getByRole("button", { name: "Generate report" });

	act(() => generate.focus());
	await user.keyboard("{Enter}");

	return { user, generate, dialog: screen.getByRole("alertdialog") };
}

describe("LikelyDuplicateReportDialog focus", () => {
	it("returns focus to the opener when Cancel is pressed", async () => {
		const { user, generate, dialog } = await openWarning();
		const cancel = within(dialog).getByRole("button", { name: "Cancel" });

		act(() => cancel.focus());
		await user.keyboard("{Enter}");

		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		await waitFor(() => expect(generate).toHaveFocus());
	});

	it("returns focus to the opener when Escape closes it", async () => {
		const { user, generate } = await openWarning();

		await user.keyboard("{Escape}");

		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		await waitFor(() => expect(generate).toHaveFocus());
	});
});
