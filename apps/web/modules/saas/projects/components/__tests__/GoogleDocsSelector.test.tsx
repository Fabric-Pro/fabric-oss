/**
 * Component tests for GoogleDocsSelector.
 *
 * Tests folder navigation, file selection, view modes (list/grid),
 * preview panel, keyboard navigation, and back button.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next-intl is mocked globally in apps/web/vitest.setup.ts.

// Mock fetch globally
const mockFetch = vi.fn();

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";

function toolsResponse(tools: string[]) {
	return {
		ok: true,
		json: async () => ({ tools }),
	};
}

function filesResponse(files: Array<Record<string, unknown>>) {
	return {
		ok: true,
		json: async () => ({ result: files }),
	};
}

import { GoogleDocsSelector, parseFilesResult } from "../GoogleDocsSelector";

describe("GoogleDocsSelector", () => {
	const defaultProps = {
		open: true,
		onOpenChange: vi.fn(),
		configId: "config-1",
		organizationId: "org-1" as string | null | undefined,
		initialSelectedIds: [] as string[],
		onConfirm: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		// Vitest 4: vi.clearAllMocks() clears call history but does NOT drain a
		// mock's leftover mockResolvedValueOnce queue (it did in v3). A test that
		// queues more once-responses than it consumes would otherwise leak them
		// into the next test's mount fetch. mockReset() drains the once-queue.
		mockFetch.mockReset();
		global.fetch = mockFetch;
		// jsdom doesn't implement scrollIntoView
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function setupDefaultResponses(files: Array<Record<string, unknown>> = []) {
		mockFetch
			.mockResolvedValueOnce(toolsResponse(["list_files"]))
			.mockResolvedValueOnce(filesResponse(files));
	}

	it("renders folder items with folder icon", async () => {
		setupDefaultResponses([
			{ id: "folder-1", name: "Projects", mimeType: FOLDER_MIME },
			{ id: "f1", name: "Doc 1", mimeType: DOC_MIME },
		]);

		render(<GoogleDocsSelector {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByText("Projects")).toBeInTheDocument();
			expect(screen.getByText("Folder")).toBeInTheDocument();
			expect(screen.getByText("Doc 1")).toBeInTheDocument();
		});
	});

	it("navigates into folder on click and updates breadcrumbs", async () => {
		const user = userEvent.setup();

		// Initial load: tools + root files
		mockFetch
			.mockResolvedValueOnce(toolsResponse(["list_files"]))
			.mockResolvedValueOnce(
				filesResponse([
					{
						id: "folder-1",
						name: "My Folder",
						mimeType: FOLDER_MIME,
					},
				]),
			);

		render(<GoogleDocsSelector {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByText("My Folder")).toBeInTheDocument();
		});

		// Prepare response for folder navigation
		mockFetch.mockResolvedValueOnce(
			filesResponse([
				{
					id: "f1",
					name: "Nested Doc",
					mimeType: DOC_MIME,
				},
			]),
		);

		// Click the folder
		const folderButton = screen.getByText("My Folder");
		await user.click(folderButton);

		// Breadcrumbs should show both levels
		await waitFor(() => {
			expect(screen.getByText("My Folder")).toBeInTheDocument();
		});

		// The new fetch for folder contents should have been triggered
		// with folderId parameter
		const lastFetchCall =
			mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
		const body = JSON.parse(lastFetchCall[1].body);
		expect(body.params?.folderId).toBe("folder-1");
	});

	it("folders are NOT selectable (no checkbox)", async () => {
		setupDefaultResponses([
			{ id: "folder-1", name: "A Folder", mimeType: FOLDER_MIME },
			{ id: "f1", name: "A File", mimeType: DOC_MIME },
		]);

		render(<GoogleDocsSelector {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByText("A Folder")).toBeInTheDocument();
			expect(screen.getByText("A File")).toBeInTheDocument();
		});

		// Folder row should not have a checkbox
		const checkboxes = screen.getAllByRole("checkbox");
		expect(checkboxes).toHaveLength(1); // Only the file's checkbox
	});

	it("folders appear before files in the list", async () => {
		setupDefaultResponses([
			{
				id: "f1",
				name: "ZZZ File",
				mimeType: DOC_MIME,
				modifiedTime: "2024-01-01",
			},
			{
				id: "folder-1",
				name: "AAA Folder",
				mimeType: FOLDER_MIME,
			},
		]);

		render(<GoogleDocsSelector {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByText("AAA Folder")).toBeInTheDocument();
			expect(screen.getByText("ZZZ File")).toBeInTheDocument();
		});

		// The folder "button" element should appear before the file "button"
		const allButtons = screen
			.getAllByRole("button")
			.filter(
				(b) =>
					b.textContent?.includes("AAA Folder") ||
					b.textContent?.includes("ZZZ File"),
			);
		// Folder should be first
		expect(allButtons[0].textContent).toContain("AAA Folder");
	});

	it("onConfirm includes folderId and folderName from current folder", async () => {
		const user = userEvent.setup();

		// Root: one folder
		mockFetch
			.mockResolvedValueOnce(toolsResponse(["list_files"]))
			.mockResolvedValueOnce(
				filesResponse([
					{
						id: "folder-1",
						name: "Target Folder",
						mimeType: FOLDER_MIME,
					},
				]),
			);

		render(<GoogleDocsSelector {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByText("Target Folder")).toBeInTheDocument();
		});

		// Navigate into folder
		mockFetch.mockResolvedValueOnce(
			filesResponse([
				{
					id: "f1",
					name: "Inner Doc",
					mimeType: DOC_MIME,
					modifiedTime: "2024-06-01",
				},
			]),
		);

		await user.click(screen.getByText("Target Folder"));

		await waitFor(() => {
			expect(screen.getByText("Inner Doc")).toBeInTheDocument();
		});

		// Select the file
		const checkbox = screen.getByRole("checkbox");
		await user.click(checkbox);

		// Click confirm
		const addButton = screen.getByRole("button", {
			name: /Add 1 File/,
		});
		await user.click(addButton);

		expect(defaultProps.onConfirm).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					fileId: "f1",
					title: "Inner Doc",
					folderId: "folder-1",
					folderName: "Target Folder",
					modifiedTime: "2024-06-01",
				}),
			]),
		);
	});

	it("resets state on dialog open", async () => {
		setupDefaultResponses([
			{ id: "f1", name: "Root File", mimeType: DOC_MIME },
		]);

		// First render with open=false
		const { rerender } = render(
			<GoogleDocsSelector {...defaultProps} open={false} />,
		);

		// Open the dialog
		mockFetch
			.mockResolvedValueOnce(toolsResponse(["list_files"]))
			.mockResolvedValueOnce(
				filesResponse([
					{ id: "f1", name: "Root File", mimeType: DOC_MIME },
				]),
			);

		rerender(<GoogleDocsSelector {...defaultProps} open={true} />);

		await waitFor(() => {
			expect(screen.getByText("Root File")).toBeInTheDocument();
		});

		// At root level, back button should not be visible
		expect(
			screen.queryByLabelText("Go back to parent folder"),
		).not.toBeInTheDocument();
	});

	it("shows folders even when Docs Only filter is active", async () => {
		setupDefaultResponses([
			{ id: "folder-1", name: "Visible Folder", mimeType: FOLDER_MIME },
			{
				id: "f1",
				name: "Doc File",
				mimeType: DOC_MIME,
			},
			{
				id: "f2",
				name: "Unknown File",
				mimeType: "application/octet-stream",
			},
		]);

		render(<GoogleDocsSelector {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByText("Visible Folder")).toBeInTheDocument();
			expect(screen.getByText("Doc File")).toBeInTheDocument();
		});

		// Unknown MIME type should be filtered out by "Docs Only"
		expect(screen.queryByText("Unknown File")).not.toBeInTheDocument();
	});

	it("falls back to listResources when no list tool found", async () => {
		// Tools response with no list/search tools
		mockFetch
			.mockResolvedValueOnce(toolsResponse(["get_document", "read_file"]))
			// listResources fallback response
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					result: {
						resources: [
							{
								uri: "gdrive:///abc123",
								name: "Resource File",
								mimeType:
									"application/vnd.google-apps.document",
							},
						],
					},
				}),
			});

		render(<GoogleDocsSelector {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByText("Resource File")).toBeInTheDocument();
		});
	});

	it("disables Add button when no files selected", async () => {
		setupDefaultResponses([
			{ id: "f1", name: "A File", mimeType: DOC_MIME },
		]);

		render(<GoogleDocsSelector {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByText("A File")).toBeInTheDocument();
		});

		const addButton = screen.getByRole("button", { name: /Add 0 File/ });
		expect(addButton).toBeDisabled();
	});

	// ── View mode toggle ──────────────────────────────────────────────────

	describe("View mode toggle", () => {
		it("renders list view by default", async () => {
			setupDefaultResponses([
				{ id: "f1", name: "Test File", mimeType: DOC_MIME },
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Test File")).toBeInTheDocument();
			});

			// List view button should be present
			expect(screen.getByLabelText("List view")).toBeInTheDocument();

			// No grid items (role="option") should exist in list view
			expect(screen.queryAllByRole("option")).toHaveLength(0);
		});

		it("switches to grid view on toggle click", async () => {
			const user = userEvent.setup();

			setupDefaultResponses([
				{ id: "f1", name: "Grid File", mimeType: DOC_MIME },
				{
					id: "folder-1",
					name: "Grid Folder",
					mimeType: FOLDER_MIME,
				},
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Grid File")).toBeInTheDocument();
			});

			// Click grid view button
			await user.click(screen.getByLabelText("Grid view"));

			// Grid items (role="option") should now exist for files
			expect(screen.queryAllByRole("option").length).toBeGreaterThan(0);

			// Files and folders still visible
			expect(screen.getByText("Grid File")).toBeInTheDocument();
			expect(screen.getByText("Grid Folder")).toBeInTheDocument();
		});

		it("switches back to list view", async () => {
			const user = userEvent.setup();

			setupDefaultResponses([
				{ id: "f1", name: "Toggle File", mimeType: DOC_MIME },
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Toggle File")).toBeInTheDocument();
			});

			// Switch to grid then back
			await user.click(screen.getByLabelText("Grid view"));
			expect(screen.queryAllByRole("option").length).toBeGreaterThan(0);

			await user.click(screen.getByLabelText("List view"));
			expect(screen.queryAllByRole("option")).toHaveLength(0);
		});

		it("grid view shows checkboxes on file cards", async () => {
			const user = userEvent.setup();

			setupDefaultResponses([
				{ id: "f1", name: "Checkable", mimeType: DOC_MIME },
				{ id: "f2", name: "Also Checkable", mimeType: SHEET_MIME },
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Checkable")).toBeInTheDocument();
			});

			await user.click(screen.getByLabelText("Grid view"));

			// Checkboxes should exist for both files
			const checkboxes = screen.getAllByRole("checkbox");
			expect(checkboxes).toHaveLength(2);
		});

		it("grid view folders navigate on click", async () => {
			const user = userEvent.setup();

			mockFetch
				.mockResolvedValueOnce(toolsResponse(["list_files"]))
				.mockResolvedValueOnce(
					filesResponse([
						{
							id: "folder-1",
							name: "Grid Nav Folder",
							mimeType: FOLDER_MIME,
						},
					]),
				);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Grid Nav Folder")).toBeInTheDocument();
			});

			// Switch to grid view
			await user.click(screen.getByLabelText("Grid view"));

			// Prepare folder contents
			mockFetch.mockResolvedValueOnce(
				filesResponse([
					{
						id: "f1",
						name: "Inside Grid Folder",
						mimeType: DOC_MIME,
					},
				]),
			);

			// Click the folder card
			await user.click(screen.getByText("Grid Nav Folder"));

			await waitFor(() => {
				expect(
					screen.getByText("Inside Grid Folder"),
				).toBeInTheDocument();
			});

			// Breadcrumbs should show the folder
			expect(screen.getByText("Grid Nav Folder")).toBeInTheDocument();
		});
	});

	// ── File preview panel ─────────────────────────────────────────────────

	describe("File preview panel", () => {
		it("no preview panel by default", async () => {
			setupDefaultResponses([
				{ id: "f1", name: "Some File", mimeType: DOC_MIME },
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Some File")).toBeInTheDocument();
			});

			expect(screen.queryByText("File Details")).not.toBeInTheDocument();
		});

		it("shows preview panel when file is clicked", async () => {
			const user = userEvent.setup();

			setupDefaultResponses([
				{
					id: "f1",
					name: "Preview Me",
					mimeType: DOC_MIME,
					modifiedTime: "2024-12-01",
				},
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Preview Me")).toBeInTheDocument();
			});

			// Click file name to open preview (list view button)
			const fileButtons = screen
				.getAllByRole("button")
				.filter((b) => b.textContent?.includes("Preview Me"));
			await user.click(fileButtons[0]);

			// Preview panel should show file details
			await waitFor(() => {
				expect(screen.getByText("File Details")).toBeInTheDocument();
			});

			// File name in preview
			const previewHeadings = screen.getAllByText("Preview Me");
			expect(previewHeadings.length).toBeGreaterThanOrEqual(2); // list + preview

			// Type badge
			expect(
				screen.getAllByText("Google Doc").length,
			).toBeGreaterThanOrEqual(1);
		});

		it("preview panel has Select/Deselect button", async () => {
			const user = userEvent.setup();

			setupDefaultResponses([
				{ id: "f1", name: "Select Test", mimeType: DOC_MIME },
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Select Test")).toBeInTheDocument();
			});

			// Open preview
			const fileButtons = screen
				.getAllByRole("button")
				.filter((b) => b.textContent?.includes("Select Test"));
			await user.click(fileButtons[0]);

			await waitFor(() => {
				expect(screen.getByText("File Details")).toBeInTheDocument();
			});

			// Click Select button in preview
			const selectButton = screen.getByRole("button", {
				name: "Select",
			});
			await user.click(selectButton);

			// Button should now say Deselect
			await waitFor(() => {
				expect(
					screen.getByRole("button", { name: "Deselect" }),
				).toBeInTheDocument();
			});
		});

		it("preview panel shows Open in Google Drive link when URL available", async () => {
			const user = userEvent.setup();

			setupDefaultResponses([
				{
					id: "f1",
					name: "Linked File",
					mimeType: DOC_MIME,
					webViewLink: "https://docs.google.com/doc/1",
				},
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Linked File")).toBeInTheDocument();
			});

			// Open preview
			const fileButtons = screen
				.getAllByRole("button")
				.filter((b) => b.textContent?.includes("Linked File"));
			await user.click(fileButtons[0]);

			await waitFor(() => {
				expect(screen.getByText("File Details")).toBeInTheDocument();
			});

			// External link should be visible
			expect(
				screen.getByText("Open in Google Drive"),
			).toBeInTheDocument();
		});

		it("preview panel closes on X button", async () => {
			const user = userEvent.setup();

			setupDefaultResponses([
				{ id: "f1", name: "Closeable", mimeType: DOC_MIME },
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Closeable")).toBeInTheDocument();
			});

			// Open preview
			const fileButtons = screen
				.getAllByRole("button")
				.filter((b) => b.textContent?.includes("Closeable"));
			await user.click(fileButtons[0]);

			await waitFor(() => {
				expect(screen.getByText("File Details")).toBeInTheDocument();
			});

			// Click close button
			const closeButton = screen.getByLabelText("Close preview");
			await user.click(closeButton);

			await waitFor(() => {
				expect(
					screen.queryByText("File Details"),
				).not.toBeInTheDocument();
			});
		});

		it("preview panel updates when different file clicked", async () => {
			const user = userEvent.setup();

			setupDefaultResponses([
				{ id: "f1", name: "First File", mimeType: DOC_MIME },
				{ id: "f2", name: "Second File", mimeType: SHEET_MIME },
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("First File")).toBeInTheDocument();
				expect(screen.getByText("Second File")).toBeInTheDocument();
			});

			// Click first file
			const firstFileButtons = screen
				.getAllByRole("button")
				.filter((b) => b.textContent?.includes("First File"));
			await user.click(firstFileButtons[0]);

			await waitFor(() => {
				expect(screen.getByText("File Details")).toBeInTheDocument();
			});

			// Preview should show Google Doc type
			expect(
				screen.getAllByText("Google Doc").length,
			).toBeGreaterThanOrEqual(1);

			// Click second file
			const secondFileButtons = screen
				.getAllByRole("button")
				.filter((b) => b.textContent?.includes("Second File"));
			await user.click(secondFileButtons[0]);

			// Preview should now show Google Sheet type
			await waitFor(() => {
				expect(
					screen.getAllByText("Google Sheet").length,
				).toBeGreaterThanOrEqual(1);
			});
		});
	});

	// ── Back button navigation ─────────────────────────────────────────────

	describe("Back button navigation", () => {
		it("no back button at root level", async () => {
			setupDefaultResponses([
				{ id: "f1", name: "Root Item", mimeType: DOC_MIME },
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Root Item")).toBeInTheDocument();
			});

			expect(
				screen.queryByLabelText("Go back to parent folder"),
			).not.toBeInTheDocument();
		});

		it("back button appears after navigating into a folder", async () => {
			const user = userEvent.setup();

			mockFetch
				.mockResolvedValueOnce(toolsResponse(["list_files"]))
				.mockResolvedValueOnce(
					filesResponse([
						{
							id: "folder-1",
							name: "Sub Folder",
							mimeType: FOLDER_MIME,
						},
					]),
				);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Sub Folder")).toBeInTheDocument();
			});

			// Navigate into folder
			mockFetch.mockResolvedValueOnce(
				filesResponse([
					{ id: "f1", name: "Sub File", mimeType: DOC_MIME },
				]),
			);
			await user.click(screen.getByText("Sub Folder"));

			await waitFor(() => {
				expect(screen.getByText("Sub File")).toBeInTheDocument();
			});

			// Back button should be visible
			expect(
				screen.getByLabelText("Go back to parent folder"),
			).toBeInTheDocument();
		});

		it("back button navigates to parent folder", async () => {
			const user = userEvent.setup();

			mockFetch
				.mockResolvedValueOnce(toolsResponse(["list_files"]))
				.mockResolvedValueOnce(
					filesResponse([
						{
							id: "folder-1",
							name: "Parent",
							mimeType: FOLDER_MIME,
						},
					]),
				);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Parent")).toBeInTheDocument();
			});

			// Navigate into folder
			mockFetch.mockResolvedValueOnce(
				filesResponse([
					{ id: "f1", name: "Child File", mimeType: DOC_MIME },
				]),
			);
			await user.click(screen.getByText("Parent"));

			await waitFor(() => {
				expect(screen.getByText("Child File")).toBeInTheDocument();
			});

			// Click back — should return to root
			mockFetch.mockResolvedValueOnce(
				filesResponse([
					{
						id: "folder-1",
						name: "Parent",
						mimeType: FOLDER_MIME,
					},
				]),
			);
			await user.click(screen.getByLabelText("Go back to parent folder"));

			await waitFor(() => {
				expect(screen.getByText("Parent")).toBeInTheDocument();
			});

			// Back button should be gone (we're at root)
			expect(
				screen.queryByLabelText("Go back to parent folder"),
			).not.toBeInTheDocument();
		});
	});

	// ── Keyboard navigation ────────────────────────────────────────────────

	describe("Keyboard navigation", () => {
		it("ArrowDown moves focus to first item", async () => {
			setupDefaultResponses([
				{ id: "f1", name: "Key File", mimeType: DOC_MIME },
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Key File")).toBeInTheDocument();
			});

			const fileList = screen.getByLabelText("File list");
			fireEvent.keyDown(fileList, { key: "ArrowDown" });

			// The file item should now have the focused data attribute
			const focusedItem = fileList.querySelector('[data-file-index="0"]');
			expect(focusedItem).not.toBeNull();
		});

		it("Enter on a focused folder navigates into it", async () => {
			mockFetch
				.mockResolvedValueOnce(toolsResponse(["list_files"]))
				.mockResolvedValueOnce(
					filesResponse([
						{
							id: "folder-1",
							name: "Enter Folder",
							mimeType: FOLDER_MIME,
						},
					]),
				);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Enter Folder")).toBeInTheDocument();
			});

			// Prepare folder contents
			mockFetch.mockResolvedValueOnce(
				filesResponse([
					{
						id: "f1",
						name: "Folder Content",
						mimeType: DOC_MIME,
					},
				]),
			);

			const fileList = screen.getByLabelText("File list");

			// ArrowDown to focus the folder, then Enter to navigate
			fireEvent.keyDown(fileList, { key: "ArrowDown" });
			fireEvent.keyDown(fileList, { key: "Enter" });

			await waitFor(() => {
				expect(screen.getByText("Folder Content")).toBeInTheDocument();
			});
		});

		it("Enter on a focused file toggles selection", async () => {
			setupDefaultResponses([
				{ id: "f1", name: "Enter File", mimeType: DOC_MIME },
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Enter File")).toBeInTheDocument();
			});

			const fileList = screen.getByLabelText("File list");

			// ArrowDown to focus, then Enter to select
			fireEvent.keyDown(fileList, { key: "ArrowDown" });
			fireEvent.keyDown(fileList, { key: "Enter" });

			// File should now be selected
			await waitFor(() => {
				const addButton = screen.getByRole("button", {
					name: /Add 1 File/,
				});
				expect(addButton).not.toBeDisabled();
			});
		});

		it("Space toggles file selection", async () => {
			setupDefaultResponses([
				{ id: "f1", name: "Space File", mimeType: DOC_MIME },
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Space File")).toBeInTheDocument();
			});

			const fileList = screen.getByLabelText("File list");

			// ArrowDown to focus, then Space to select
			fireEvent.keyDown(fileList, { key: "ArrowDown" });
			fireEvent.keyDown(fileList, { key: " " });

			await waitFor(() => {
				const addButton = screen.getByRole("button", {
					name: /Add 1 File/,
				});
				expect(addButton).not.toBeDisabled();
			});

			// Space again to deselect
			fireEvent.keyDown(fileList, { key: " " });

			await waitFor(() => {
				const addButton = screen.getByRole("button", {
					name: /Add 0 File/,
				});
				expect(addButton).toBeDisabled();
			});
		});

		it("Escape closes preview panel", async () => {
			const user = userEvent.setup();

			setupDefaultResponses([
				{ id: "f1", name: "Escape File", mimeType: DOC_MIME },
			]);

			render(<GoogleDocsSelector {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText("Escape File")).toBeInTheDocument();
			});

			// Open preview by clicking file
			const fileButtons = screen
				.getAllByRole("button")
				.filter((b) => b.textContent?.includes("Escape File"));
			await user.click(fileButtons[0]);

			await waitFor(() => {
				expect(screen.getByText("File Details")).toBeInTheDocument();
			});

			// Press Escape on file list
			const fileList = screen.getByLabelText("File list");
			fireEvent.keyDown(fileList, { key: "Escape" });

			await waitFor(() => {
				expect(
					screen.queryByText("File Details"),
				).not.toBeInTheDocument();
			});
		});
	});
});

// ── parseFilesResult unit tests ────────────────────────────────────────────

describe("parseFilesResult", () => {
	it("parses JSON array of file objects", () => {
		const result = [
			{
				id: "f1",
				name: "Doc 1",
				mimeType: "application/vnd.google-apps.document",
			},
			{
				id: "f2",
				name: "Sheet 1",
				mimeType: "application/vnd.google-apps.spreadsheet",
			},
		];
		const parsed = parseFilesResult(result);
		expect(parsed).toHaveLength(2);
		expect(parsed[0].id).toBe("f1");
		expect(parsed[0].title).toBe("Doc 1");
	});

	it("parses plain text format from official Google Drive MCP server", () => {
		const text =
			"Found 2 file(s):\nMy Document (application/vnd.google-apps.document)\nBudget (application/vnd.google-apps.spreadsheet)";
		const parsed = parseFilesResult(text);
		expect(parsed).toHaveLength(2);
		expect(parsed[0].title).toBe("My Document");
		expect(parsed[0].mimeType).toBe("application/vnd.google-apps.document");
		expect(parsed[1].title).toBe("Budget");
		expect(parsed[1].mimeType).toBe(
			"application/vnd.google-apps.spreadsheet",
		);
	});

	it("handles text with no matching files", () => {
		const text = "Found 0 file(s):";
		const parsed = parseFilesResult(text);
		expect(parsed).toHaveLength(0);
	});

	it("parses MCP content array format (pre-unwrapped by API)", () => {
		// The API's parseMcpResult() unwraps { content: [...] } before passing to frontend
		// So parseFilesResult receives the already-parsed JSON array
		const result = [{ id: "f1", name: "Wrapped", mimeType: "text/plain" }];
		const parsed = parseFilesResult(result);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].title).toBe("Wrapped");
	});

	it("parses { files: [...] } wrapper format", () => {
		const result = {
			files: [{ id: "f1", name: "In Files", mimeType: "text/markdown" }],
		};
		const parsed = parseFilesResult(result);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].title).toBe("In Files");
		expect(parsed[0].mimeType).toBe("text/markdown");
	});
});
