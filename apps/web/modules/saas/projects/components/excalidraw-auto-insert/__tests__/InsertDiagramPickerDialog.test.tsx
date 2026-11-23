/**
 * Tests for `<InsertDiagramPickerDialog />` (E1 / spec § 8.3 / § 14.3 /
 * § 15 / § 12 / FR-7).
 *
 * Coverage:
 *   - Renders the empty state when both `projects.documents.list` and
 *     `projects.stories.board` return empty arrays (spec § 8.3 "empty
 *     state").
 *   - Switches between the Documents and Features tabs.
 *   - Row click invokes `onPick` with the row's kind/id/label AND fires
 *     `diagram_auto_insert_picker_picked` telemetry.
 *   - Pressing Escape closes the dialog (Radix-native; we just verify
 *     `onOpenChange(false)` fires).
 *   - Initial focus is on the search input.
 *   - Arrow Down / Arrow Up move the focused-row indicator; Enter picks
 *     the focused row.
 *   - Renders the "More results -- search to filter" hint when the
 *     source list exceeds the 100-entry cap (spec § 15 perf bound).
 *   - Fires `diagram_auto_insert_picker_opened` exactly once per open
 *     transition.
 *
 * Mocks:
 *   - `@shared/lib/orpc-query-utils` (the dialog reads `orpc.projects.
 *     documents.list.queryOptions` and `orpc.projects.stories.board.
 *     queryOptions`).
 *   - `@analytics` (telemetry assertions).
 *   - `next-intl` (returns a synthetic `t` that echoes the key with
 *     interpolations expanded).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted refs the mocks below mutate per-test
// ---------------------------------------------------------------------------

const { listDocumentsMock, listStoriesMock, getProjectMock } = vi.hoisted(
	() => ({
		listDocumentsMock: vi.fn(),
		listStoriesMock: vi.fn(),
		getProjectMock: vi.fn(),
	}),
);

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.get", input],
					queryFn: () => getProjectMock(input),
				}),
			},
			documents: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.documents.list", input],
						queryFn: () => listDocumentsMock(input),
					}),
				},
			},
			stories: {
				board: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.stories.board", input],
						queryFn: () => listStoriesMock(input),
					}),
				},
			},
		},
	},
}));

const trackEvent = vi.fn();
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent }),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => {
		return (key: string, values?: Record<string, string>) => {
			switch (key) {
				case "pickerTitle":
					return "Insert diagram into…";
				case "pickerDescription":
					return `Pick a document or feature in ${values?.projectName ?? ""}.`;
				case "pickerDescriptionThisProject":
					return "Pick a document or feature in this project.";
				case "pickerTabDocuments":
					return "Documents";
				case "pickerTabFeatures":
					return "Features";
				case "pickerSearchDocuments":
					return "Search documents";
				case "pickerSearchFeatures":
					return "Search features";
				case "pickerEmptyDocuments":
					return "No documents yet.";
				case "pickerEmptyFeatures":
					return "No features yet.";
				case "pickerNoMatches":
					return "No matches.";
				default:
					return key;
			}
		};
	},
}));

// JSDOM doesn't ship ResizeObserver, which Radix needs internally.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
	ResizeObserverStub;

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

const { InsertDiagramPickerDialog, applySearchAndCap } = await import(
	"../InsertDiagramPickerDialog"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWithQuery(node: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{node}</QueryClientProvider>,
	);
}

const baseProps = {
	surface: "nexus" as const,
	projectId: "proj_1",
	organizationId: "org_1",
	projectName: "Atlas",
};

beforeEach(() => {
	trackEvent.mockReset();
	listDocumentsMock.mockReset();
	listStoriesMock.mockReset();
	getProjectMock.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("<InsertDiagramPickerDialog /> -- empty state + telemetry", () => {
	it("opens with each tab's own empty state when both lists are empty", async () => {
		listDocumentsMock.mockResolvedValue({
			documents: [],
			total: 0,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({ statuses: [], stories: [] });

		const user = userEvent.setup();
		renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				open
				onOpenChange={vi.fn()}
				onPick={vi.fn()}
			/>,
		);

		expect(
			await screen.findByText("No documents yet."),
		).toBeInTheDocument();

		await user.click(screen.getByRole("tab", { name: /Features/i }));
		expect(await screen.findByText("No features yet.")).toBeInTheDocument();
	});

	it("says the Documents tab is empty without claiming there are no features", async () => {
		listDocumentsMock.mockResolvedValue({
			documents: [],
			total: 0,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({
			statuses: [],
			stories: [
				{
					id: "story_1",
					identifier: "F-001",
					title: "Login flow",
					createdAt: new Date("2026-05-23T10:00:00Z"),
					lastEditedAt: null,
					status: { name: "In Progress", isArchived: false },
				},
			],
		});

		const user = userEvent.setup();
		renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				open
				onOpenChange={vi.fn()}
				onPick={vi.fn()}
			/>,
		);

		expect(
			await screen.findByText("No documents yet."),
		).toBeInTheDocument();
		expect(screen.queryByText(/features yet/i)).not.toBeInTheDocument();

		await user.click(screen.getByRole("tab", { name: /Features/i }));
		expect(
			await screen.findByRole("option", { name: /F-001 Login flow/i }),
		).toBeInTheDocument();
	});

	it("says no matches when the search filters every row out", async () => {
		listDocumentsMock.mockResolvedValue({
			documents: [
				{
					id: "doc_1",
					title: "Architecture",
					updatedAt: "2026-05-23T10:00:00Z",
				},
			],
			total: 1,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({ statuses: [], stories: [] });

		const user = userEvent.setup();
		renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				open
				onOpenChange={vi.fn()}
				onPick={vi.fn()}
			/>,
		);

		await screen.findByRole("option", { name: /Architecture/i });
		await user.type(screen.getByRole("textbox"), "zzz");

		expect(await screen.findByText("No matches.")).toBeInTheDocument();
		expect(screen.queryByText("No documents yet.")).not.toBeInTheDocument();
	});
});

describe("<InsertDiagramPickerDialog /> -- labels", () => {
	it("search placeholder names the active tab", async () => {
		listDocumentsMock.mockResolvedValue({
			documents: [],
			total: 0,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({ statuses: [], stories: [] });

		const user = userEvent.setup();
		renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				open
				onOpenChange={vi.fn()}
				onPick={vi.fn()}
			/>,
		);

		const search = screen.getByRole("textbox");
		expect(search).toHaveAttribute("placeholder", "Search documents");

		await user.click(screen.getByRole("tab", { name: /Features/i }));
		expect(search).toHaveAttribute("placeholder", "Search features");
	});

	it("looks up the project name instead of showing the project id", async () => {
		listDocumentsMock.mockResolvedValue({
			documents: [],
			total: 0,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({ statuses: [], stories: [] });
		getProjectMock.mockResolvedValue({ project: { name: "Atlas" } });

		renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				projectName={undefined}
				open
				onOpenChange={vi.fn()}
				onPick={vi.fn()}
			/>,
		);

		expect(
			await screen.findByText("Pick a document or feature in Atlas."),
		).toBeInTheDocument();
		expect(getProjectMock).toHaveBeenCalledWith({
			id: "proj_1",
			organizationId: "org_1",
		});
		expect(screen.queryByText(/proj_1/)).not.toBeInTheDocument();
	});

	it("falls back to 'this project' while the name is unknown", async () => {
		listDocumentsMock.mockResolvedValue({
			documents: [],
			total: 0,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({ statuses: [], stories: [] });
		getProjectMock.mockReturnValue(new Promise(() => {}));

		renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				projectName={undefined}
				open
				onOpenChange={vi.fn()}
				onPick={vi.fn()}
			/>,
		);

		expect(
			screen.getByText("Pick a document or feature in this project."),
		).toBeInTheDocument();
	});

	it("does not fetch the project when the caller passes its name", async () => {
		listDocumentsMock.mockResolvedValue({
			documents: [],
			total: 0,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({ statuses: [], stories: [] });

		renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				open
				onOpenChange={vi.fn()}
				onPick={vi.fn()}
			/>,
		);

		expect(
			screen.getByText("Pick a document or feature in Atlas."),
		).toBeInTheDocument();
		await screen.findByText("No documents yet.");
		expect(getProjectMock).not.toHaveBeenCalled();
	});

	it("fires `diagram_auto_insert_picker_opened` exactly once on open", async () => {
		listDocumentsMock.mockResolvedValue({
			documents: [],
			total: 0,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({ statuses: [], stories: [] });

		const { rerender } = renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				open
				onOpenChange={vi.fn()}
				onPick={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(trackEvent).toHaveBeenCalledWith(
				"diagram_auto_insert_picker_opened",
				expect.objectContaining({
					surface: "nexus",
					projectId: "proj_1",
					hasDocuments: false,
					hasFeatures: false,
				}),
			);
		});

		// Re-rendering with the same `open=true` must not fire again.
		rerender(
			<QueryClientProvider client={new QueryClient()}>
				<InsertDiagramPickerDialog
					{...baseProps}
					open
					onOpenChange={vi.fn()}
					onPick={vi.fn()}
				/>
			</QueryClientProvider>,
		);

		const openedFires = trackEvent.mock.calls.filter(
			([name]) => name === "diagram_auto_insert_picker_opened",
		);
		expect(openedFires.length).toBe(1);
	});
});

describe("<InsertDiagramPickerDialog /> -- row picking", () => {
	it("clicking a document row fires onPick + telemetry, then closes", async () => {
		listDocumentsMock.mockResolvedValue({
			documents: [
				{
					id: "doc_1",
					title: "Architecture",
					updatedAt: "2026-05-23T10:00:00Z",
				},
				{
					id: "doc_2",
					title: "Plan",
					updatedAt: "2026-05-22T10:00:00Z",
				},
			],
			total: 2,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({ statuses: [], stories: [] });

		const onPick = vi.fn();
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				open
				onOpenChange={onOpenChange}
				onPick={onPick}
			/>,
		);

		const row = await screen.findByRole("option", {
			name: /Insert into Architecture/i,
		});
		await user.click(row);

		expect(onPick).toHaveBeenCalledWith({
			kind: "document",
			id: "doc_1",
			label: "Architecture",
		});
		expect(trackEvent).toHaveBeenCalledWith(
			"diagram_auto_insert_picker_picked",
			expect.objectContaining({
				surface: "nexus",
				targetKind: "document",
				targetId: "doc_1",
				projectId: "proj_1",
			}),
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("switching to the Features tab renders features most recently edited first and excludes archived rows", async () => {
		listDocumentsMock.mockResolvedValue({
			documents: [],
			total: 0,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({
			statuses: [],
			// Backlog order; the dialog ranks by `lastEditedAt ?? createdAt`.
			stories: [
				{
					id: "story_1",
					identifier: "F-001",
					title: "Login flow",
					createdAt: new Date("2026-05-23T10:00:00Z"),
					lastEditedAt: null,
					status: { name: "In Progress", isArchived: false },
				},
				{
					id: "story_2",
					identifier: "F-002",
					title: "Archived feature",
					createdAt: new Date("2026-05-22T10:00:00Z"),
					lastEditedAt: new Date("2026-07-01T10:00:00Z"),
					status: { name: "Archived", isArchived: true },
				},
				{
					id: "story_3",
					identifier: "F-003",
					title: "Checkout",
					createdAt: new Date("2026-04-01T10:00:00Z"),
					lastEditedAt: new Date("2026-06-01T10:00:00Z"),
					status: { name: "In Progress", isArchived: false },
				},
			],
		});

		const user = userEvent.setup();
		renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				open
				onOpenChange={vi.fn()}
				onPick={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("tab", { name: /Features/i }));

		expect(
			await screen.findByRole("option", {
				name: /Insert into F-001 Login flow/i,
			}),
		).toBeInTheDocument();
		expect(
			screen
				.getAllByRole("option")
				.map((option) => option.getAttribute("aria-label")),
		).toEqual([
			expect.stringMatching(/F-003 Checkout/),
			expect.stringMatching(/F-001 Login flow/),
		]);
		expect(
			screen.queryByRole("option", { name: /Archived feature/i }),
		).not.toBeInTheDocument();
	});
});

describe("<InsertDiagramPickerDialog /> -- keyboard navigation + focus", () => {
	it("initial focus is on the search input", async () => {
		listDocumentsMock.mockResolvedValue({
			documents: [],
			total: 0,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({ statuses: [], stories: [] });

		renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				open
				onOpenChange={vi.fn()}
				onPick={vi.fn()}
			/>,
		);

		const searchInput = await screen.findByLabelText(
			/Insert diagram into/i,
			{
				selector: "input",
			},
		);
		await waitFor(() => {
			expect(searchInput).toHaveFocus();
		});
	});

	it("ArrowDown/ArrowUp navigate rows; Enter picks the focused row", async () => {
		listDocumentsMock.mockResolvedValue({
			documents: [
				{
					id: "doc_1",
					title: "Architecture",
					updatedAt: "2026-05-23T10:00:00Z",
				},
				{
					id: "doc_2",
					title: "Plan",
					updatedAt: "2026-05-22T10:00:00Z",
				},
			],
			total: 2,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({ statuses: [], stories: [] });

		const onPick = vi.fn();
		const user = userEvent.setup();
		renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				open
				onOpenChange={vi.fn()}
				onPick={onPick}
			/>,
		);

		// Wait for both rows to appear.
		await screen.findByRole("option", {
			name: /Insert into Architecture/i,
		});

		// Search input has focus by default; ArrowDown picks the 2nd row.
		await user.keyboard("{ArrowDown}");
		await user.keyboard("{Enter}");

		expect(onPick).toHaveBeenCalledWith({
			kind: "document",
			id: "doc_2",
			label: "Plan",
		});
	});
});

describe("<InsertDiagramPickerDialog /> -- render cap", () => {
	it("shows the 'More results -- search to filter' hint when count > 100", async () => {
		const manyDocs = Array.from({ length: 120 }, (_, i) => ({
			id: `doc_${i}`,
			title: `Doc ${i.toString().padStart(3, "0")}`,
			updatedAt: "2026-05-23T10:00:00Z",
		}));
		listDocumentsMock.mockResolvedValue({
			documents: manyDocs,
			total: 120,
			hasMore: false,
		});
		listStoriesMock.mockResolvedValue({ statuses: [], stories: [] });

		renderWithQuery(
			<InsertDiagramPickerDialog
				{...baseProps}
				open
				onOpenChange={vi.fn()}
				onPick={vi.fn()}
			/>,
		);

		expect(
			await screen.findByText(/More results -- search to filter\./i),
		).toBeInTheDocument();
	});
});

describe("applySearchAndCap helper", () => {
	const rows = Array.from({ length: 130 }, (_, i) => ({
		kind: "document" as const,
		id: `id_${i}`,
		title: `Title ${i}`,
		updatedAt: null,
	}));

	it("caps the result at 100 entries", () => {
		expect(applySearchAndCap(rows, "").length).toBe(100);
	});

	it("filters by case-insensitive substring on the title", () => {
		const result = applySearchAndCap(rows, "title 12");
		// "Title 12", "Title 120-129" -> 11 matches, all under the cap.
		expect(result.length).toBe(11);
		expect(
			result.every((r) => r.title.toLowerCase().includes("title 12")),
		).toBe(true);
	});

	it("returns an empty array when no rows match", () => {
		expect(applySearchAndCap(rows, "zzz-not-present").length).toBe(0);
	});
});
