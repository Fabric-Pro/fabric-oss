/**
 * The dialog that reports what adding the organization template did: how
 * many files the new version holds from it, and every file left out with a
 * reason a person can read.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);
// The dialog renders a result it is handed; the hook beside it is what reads
// and writes, and nothing here calls it.
vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: {} }));

import { TemplateResultDialog } from "../OrganizationTemplate";

describe("TemplateResultDialog", () => {
	it("says how many files were added and lists each skipped file with its reason", () => {
		render(
			<TemplateResultDialog
				result={{
					snapshotId: "snap_new",
					version: 8,
					added: 2,
					skipped: [
						{ path: "CLAUDE.md", reason: "exists" },
						{ path: "tasks/notes.md", reason: "excluded" },
						{ path: ".env", reason: "secret_name" },
					],
				}}
				onOpenChange={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(/^2 files were added as version 8\./),
		).toBeInTheDocument();
		expect(screen.getByText("3 files left out")).toBeInTheDocument();
		const rows = screen.getAllByRole("listitem");
		expect(rows).toHaveLength(3);
		expect(
			within(rows[0] as HTMLElement).getByText(
				"The project already has this file",
			),
		).toBeInTheDocument();
		expect(
			within(rows[1] as HTMLElement).getByText(
				"The project's ignore rules leave it out",
			),
		).toBeInTheDocument();
		expect(
			within(rows[2] as HTMLElement).getByText(
				"Looks like a credential file",
			),
		).toBeInTheDocument();
	});

	it("says nothing changed when the project already had every file", () => {
		render(
			<TemplateResultDialog
				result={{
					snapshotId: null,
					version: null,
					added: 0,
					skipped: [{ path: "CLAUDE.md", reason: "exists" }],
				}}
				onOpenChange={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(
				"This project already has every file the template could add, so nothing was changed.",
			),
		).toBeInTheDocument();
		expect(screen.getByText("1 file left out")).toBeInTheDocument();
	});

	it("is closed when there is no result, and closes from Done", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		const { rerender } = render(
			<TemplateResultDialog result={null} onOpenChange={onOpenChange} />,
		);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		rerender(
			<TemplateResultDialog
				result={{
					snapshotId: "snap_new",
					version: 2,
					added: 1,
					skipped: [],
				}}
				onOpenChange={onOpenChange}
			/>,
		);
		expect(
			screen.getByText(/^1 file was added as version 2\./),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Done" }));

		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
