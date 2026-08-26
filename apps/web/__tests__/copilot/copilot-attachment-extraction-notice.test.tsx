/**
 * U6 — the attachment chip telling the user what was actually read (R8, R9, R10, R12).
 *
 * These are the acceptance examples' "the attachment UI shows…" half. The hook
 * carries the outcome onto the record (see
 * `copilot-document-upload-extraction-outcome.test.ts`); this is where it turns
 * into something a person can see.
 *
 * Why assert on the `sr-only` text rather than driving the tooltip
 * ----------------------------------------------------------------
 * The notice lives in a `<Tooltip>`, matching the chip's existing `error`
 * field, and a tooltip only opens on hover/focus. The chip mirrors every line
 * into an `sr-only` span precisely so the disclosure is not hover-gated for
 * screen readers — so the same span is both the accessibility guarantee and the
 * stable assertion surface. Asserting it also means these tests keep working if
 * the tooltip's presentation changes.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: (_ns?: string) => (k: string) => k,
}));

import { CopilotSidebarAttachments } from "@saas/shared/components/copilot/CopilotSidebarAttachments";
import type { AttachedFile } from "@saas/shared/components/copilot/use-copilot-document-upload";

const XLSX_MIME =
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function chip(extraction: AttachedFile["extraction"]): AttachedFile {
	return {
		id: "f1",
		file: new File([], "budget.xlsx", { type: XLSX_MIME }),
		name: "budget.xlsx",
		type: XLSX_MIME,
		size: 1024,
		documentId: "doc-1",
		status: "ready",
		extraction,
	};
}

function renderChip(extraction: AttachedFile["extraction"]) {
	return render(
		<CopilotSidebarAttachments
			files={[chip(extraction)]}
			onRemove={vi.fn()}
		/>,
	);
}

describe("CopilotSidebarAttachments — extraction notice", () => {
	it("surfaces a truncation notice naming the omitted rows", () => {
		// AE2 / R8. "The attachment UI shows that the file was truncated."
		renderChip({
			status: "truncated",
			reason: "budget",
			omittedRowCount: 1240,
			truncatedSheetNames: ["Q4"],
			sheets: [
				{ name: "Q3", hidden: false },
				{ name: "Q4", hidden: false },
			],
		});

		expect(
			screen.getByText(/Only part of this file was read/i),
		).toBeTruthy();
		expect(screen.getByText(/1,240 rows omitted/i)).toBeTruthy();
		expect(screen.getByText(/Sheets not fully read: Q4/i)).toBeTruthy();
	});

	it("counts characters, not rows, for text cut by the client-side budget", () => {
		// R3 / AE1. A `.md` file has no rows and no sheets. Reporting "rows
		// omitted" here would name a unit the file does not have, and the branch
		// that used to read `omittedRowCount` unconditionally would have thrown.
		renderChip({
			status: "truncated",
			reason: "budget",
			omittedCharCount: 5_000,
			sheets: [],
		});

		expect(
			screen.getByText(/Only part of this file was read/i),
		).toBeTruthy();
		expect(screen.getByText(/5,000 characters omitted/i)).toBeTruthy();
		expect(screen.queryByText(/rows omitted/i)).toBeNull();
		expect(screen.queryByText(/Sheets not fully read/i)).toBeNull();
	});

	it("still says something useful when a truncation carries no counts", () => {
		// A producer that reports truncation without a count is degraded, not
		// broken — the user still needs to know the file was cut. The sentence
		// drops the scale rather than rendering "undefined".
		renderChip({ status: "truncated", sheets: [] });

		expect(
			screen.getByText(/Only part of this file was read\./i),
		).toBeTruthy();
	});

	it("surfaces a no-readable-text warning for a chart-only workbook", () => {
		// AE5 / R9. "The user is warned that the file carries no text the AI can
		// read" — as opposed to a silent, empty, green attachment.
		renderChip({
			status: "empty",
			sheets: [{ name: "Charts", hidden: false }],
		});

		expect(
			screen.getByText(/carries no text the assistant can read/i),
		).toBeTruthy();
	});

	it("lists both sheets and marks the hidden one", () => {
		// AE6 / R10. Extraction is not WYSIWYG. This is the line that stops a
		// third-party workbook's hidden tab from reaching the tenant knowledge
		// base without the user ever seeing it named.
		renderChip({
			status: "extracted",
			sheets: [
				{ name: "Summary", hidden: false },
				{ name: "Internal Notes", hidden: true },
			],
		});

		expect(
			screen.getByText(
				/Sheets read: Summary, Internal Notes \(hidden\)/i,
			),
		).toBeTruthy();
		expect(
			screen.getByText(
				/Hidden sheets are included in what the assistant reads/i,
			),
		).toBeTruthy();
	});

	it("marks a chip carrying a hidden sheet rather than leaving it a plain green check", () => {
		// A hidden sheet is the disclosure R10 exists for, so it earns the amber
		// marker on its own — a notice reachable only by hovering a green check
		// would not deliver it.
		const { container } = renderChip({
			status: "extracted",
			sheets: [
				{ name: "Summary", hidden: false },
				{ name: "Internal", hidden: true },
			],
		});

		expect(container.querySelector(".border-highlight\\/40")).toBeTruthy();
		expect(container.querySelector(".border-secondary\\/40")).toBeNull();
	});

	it("shows the server's reason for a file that couldn't be read", () => {
		// R12. The reason is rendered server-side — only it knows whether the
		// cause was a refused container, an inflation ceiling, or a dead pipeline.
		renderChip({
			status: "failed",
			reason: `"budget.xlsx" couldn't be read — it's likely password-protected. You may want to attach a copy without protection.`,
		});

		expect(screen.getByText(/likely password-protected/i)).toBeTruthy();
	});

	it("leaves a clean single-sheet workbook looking clean", () => {
		// The notice must stay proportionate: a fully-read visible workbook keeps
		// the green check, and only gains the sheet list.
		const { container } = renderChip({
			status: "extracted",
			sheets: [{ name: "Summary", hidden: false }],
		});

		expect(screen.getByText(/Sheets read: Summary/i)).toBeTruthy();
		expect(container.querySelector(".border-secondary\\/40")).toBeTruthy();
		expect(container.querySelector(".border-highlight\\/40")).toBeNull();
	});

	it("says nothing when extraction was skipped", () => {
		// The already-processed early return. Nothing was attempted, so warning
		// about it would be an invention.
		const { container } = renderChip({ status: "skipped" });

		expect(container.querySelector(".sr-only")).toBeNull();
		expect(container.querySelector(".border-secondary\\/40")).toBeTruthy();
	});

	it("says nothing for a client-read text attachment", () => {
		// No outcome at all — text files never reach the server extractor.
		const { container } = render(
			<CopilotSidebarAttachments
				files={[
					{
						...chip(undefined),
						name: "notes.txt",
						type: "text/plain",
					},
				]}
				onRemove={vi.fn()}
			/>,
		);

		expect(container.querySelector(".sr-only")).toBeNull();
	});
});
