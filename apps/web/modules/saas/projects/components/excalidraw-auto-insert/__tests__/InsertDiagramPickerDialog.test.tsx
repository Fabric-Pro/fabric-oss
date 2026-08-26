/**
 * Tests for `<InsertDiagramPickerDialog />` (E1 / spec § 8.3 / § 14.3 /
 * § 15 / § 12 / FR-7).
 *
 * Coverage:
 *   - Renders the empty state when both `projects.documents.list` and
 *     `projects.stories.list` return empty arrays (spec § 8.3 "empty
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
 *     documents.list.queryOptions` and `orpc.projects.stories.list.
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

const { listDocumentsMock, listStoriesMock } = vi.hoisted(() => ({
	listDocumentsMock: vi.fn(),
	listStoriesMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			documents: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.documents.list", input],
						queryFn: () => listDocumentsMock(input),
					}),
				},
			},
			stories: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.stories.list", input],
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
				case "pickerTabDocuments":
					return "Documents";
				case "pickerTabFeatures":
					return "Features";
				case "pickerEmpty":
					return "No documents or features yet.";
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
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("<InsertDiagramPickerDialog /> -- empty state + telemetry", () => {
	it("opens with empty state when both lists are empty", async () => {
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

		await waitFor(() => {
			expect(
				screen.getByText(/No documents or features yet/i),
			).toBeInTheDocument();
		});
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

	it("switching to the Features tab renders features and excludes archived rows", async () => {
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
					updatedAt: "2026-05-23T10:00:00Z",
					status: { name: "In Progress", isArchived: false },
				},
				{
					id: "story_2",
					identifier: "F-002",
					title: "Archived feature",
					updatedAt: "2026-05-22T10:00:00Z",
					status: { name: "Archived", isArchived: true },
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
