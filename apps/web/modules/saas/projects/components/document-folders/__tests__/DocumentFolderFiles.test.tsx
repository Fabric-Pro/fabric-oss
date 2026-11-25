/**
 * @vitest-environment jsdom
 */

/**
 * The files of a document folder that need attention (Fizzy #2808).
 *
 * Pinned: an expandable list of the skipped and failed files the list
 * returns, each with its reason; how many more there are when the folder has
 * more than it returns; files someone removed from the context list
 * explained as left out until they change at the source.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentFolderFiles } from "../DocumentFolderFiles";

function attention(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		id: `file-${index}`,
		name: `Deck ${index}.key`,
		relativePath: `Decks/Deck ${index}.key`,
		status: "SKIPPED",
		skipCode: "UNSUPPORTED",
		failureCode: null,
	}));
}

const counts = {
	found: 40,
	imported: 20,
	skipped: 0,
	failed: 0,
	excluded: 0,
	inProgress: 0,
};

afterEach(() => {
	cleanup();
});

describe("DocumentFolderFiles", () => {
	it("renders nothing when no file needs attention", () => {
		const { container } = render(
			<DocumentFolderFiles
				provider="onedrive"
				attention={[]}
				counts={counts}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("expands to list each file with its reason", () => {
		render(
			<DocumentFolderFiles
				provider="onedrive"
				attention={[
					{
						id: "a",
						name: "Old.key",
						relativePath: "Archive/Old.key",
						status: "SKIPPED",
						skipCode: "UNSUPPORTED",
						failureCode: null,
					},
					{
						id: "b",
						name: "Scan.pdf",
						relativePath: "Scan.pdf",
						status: "SKIPPED",
						skipCode: "TOO_BIG",
						failureCode: null,
					},
					{
						id: "c",
						name: "Plan.docx",
						relativePath: "Plan.docx",
						status: "FAILED",
						skipCode: null,
						failureCode: "DOWNLOAD_FAILED",
					},
					{
						id: "d",
						name: "Notes.txt",
						relativePath: "Notes.txt",
						status: "SKIPPED",
						skipCode: "CAP_REACHED",
						failureCode: null,
					},
				]}
				counts={{ ...counts, skipped: 3, failed: 1 }}
			/>,
		);
		const toggle = screen.getByRole("button", {
			name: "Files that need attention (4)",
		});
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");

		expect(screen.getByText("Archive/Old.key")).toBeInTheDocument();
		expect(
			screen.getByText("This file type is not supported."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Larger than the upload limit for its type."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Could not be downloaded from OneDrive."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Outside the 500 most recently modified files."),
		).toBeInTheDocument();
	});

	it("says how many more there are than it lists", () => {
		render(
			<DocumentFolderFiles
				provider="sharepoint"
				attention={attention(10)}
				counts={{ ...counts, skipped: 57, failed: 3 }}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Files that need attention (60)",
			}),
		);
		expect(screen.getAllByRole("listitem")).toHaveLength(10);
		expect(
			screen.getByText("And 50 more skipped or failed files."),
		).toBeInTheDocument();
	});

	it("explains files left out because someone removed them from the context list", () => {
		render(
			<DocumentFolderFiles
				provider="sharepoint"
				attention={[]}
				counts={{ ...counts, excluded: 2 }}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Files that need attention (2)",
			}),
		);
		expect(
			screen.getByText(
				"2 files were removed from the context list, so they are left out. Each returns when it changes in SharePoint.",
			),
		).toBeInTheDocument();
	});
});

describe("DocumentFolderFiles — Google Drive", () => {
	it("says a file its owner keeps from download was not imported", () => {
		render(
			<DocumentFolderFiles
				provider="googledrive"
				attention={[
					{
						id: "locked",
						name: "Pricing.xlsx",
						relativePath: "Deals/Pricing.xlsx",
						status: "SKIPPED",
						skipCode: "NOT_DOWNLOADABLE",
						failureCode: null,
					},
				]}
				counts={{ ...counts, skipped: 1 }}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: /Files that need attention/ }),
		);
		expect(screen.getByText("Deals/Pricing.xlsx")).toBeInTheDocument();
		expect(
			screen.getByText("Its owner does not allow downloading it."),
		).toBeInTheDocument();
	});
});
