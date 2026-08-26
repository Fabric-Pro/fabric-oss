import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 7.6 — lighter render/a11y tests for the field-mapping picker
 * components. The order/filter logic lives in the pure helpers (tested heavily in
 * field-mapping-helpers.test.ts); here we assert the WCAG-mandatory keyboard
 * controls, their aria-labels + onChange wiring, the available-list search/toggle,
 * the example-ticket preview states, and the panel's provider states.
 *
 * dnd-kit pointer-drag does not work in jsdom, so drag ordering is covered by the
 * pure `reorderFields` test — here we exercise only the keyboard move-up/down path.
 */

const mocks = vi.hoisted(() => ({
	pmCapabilities: vi.fn(),
	enumerateFields: vi.fn(),
	previewTicketFields: vi.fn(),
	suggestFieldMapping: vi.fn(),
	onAddFields: vi.fn(),
	update: vi.fn(),
	readFieldMappingConfig: vi.fn(() => null as unknown),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => mocks.toastSuccess(...a),
		error: (...a: unknown[]) => mocks.toastError(...a),
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			update: (...a: unknown[]) => mocks.update(...a),
			stories: {
				pmCapabilities: (...a: unknown[]) => mocks.pmCapabilities(...a),
			},
			pm: {
				previewTicketFields: (...a: unknown[]) =>
					mocks.previewTicketFields(...a),
				suggestFieldMapping: (...a: unknown[]) =>
					mocks.suggestFieldMapping(...a),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: { queryKey: () => ["projects", "get"] },
			pm: {
				enumerateFields: {
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["enumerateFields", opts.input],
						queryFn: () => mocks.enumerateFields(),
					}),
				},
			},
		},
	},
}));

vi.mock("@repo/database/src/field-mapping-schema", () => ({
	ADO_FIELD_MAPPING_PROVIDER: "azure-devops",
	readFieldMappingConfig: (...a: unknown[]) =>
		mocks.readFieldMappingConfig(...a),
}));

import { AvailableFieldsList } from "../AvailableFieldsList";
import { ExampleTicketPreview } from "../ExampleTicketPreview";
import { FieldMappingPanel } from "../FieldMappingPanel";
import type {
	PmFieldCatalogEntry,
	SelectedField,
} from "../field-mapping-helpers";
import { SelectedFieldsList } from "../SelectedFieldsList";

function renderWithClient(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

// =============================================================================
// SelectedFieldsList — keyboard reorder a11y (WCAG 2.1 AA)
// =============================================================================

describe("SelectedFieldsList (keyboard reorder + a11y)", () => {
	const fields: SelectedField[] = [
		{ id: "Custom.A", displayName: "Alpha" },
		{ id: "Custom.B", displayName: "Beta" },
		{ id: "Custom.C", displayName: "Gamma" },
	];

	it("renders keyboard move controls with descriptive aria-labels", () => {
		renderWithClient(
			<SelectedFieldsList fields={fields} onChange={vi.fn()} />,
		);
		expect(
			screen.getByRole("button", { name: "Move Beta up" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Move Beta down" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Remove Beta" }),
		).toBeTruthy();
		// Drag handle also carries an aria-label (drag is an enhancement).
		expect(
			screen.getByRole("button", { name: "Drag to reorder Beta" }),
		).toBeTruthy();
	});

	it("disables move-up on the first row and move-down on the last row", () => {
		renderWithClient(
			<SelectedFieldsList fields={fields} onChange={vi.fn()} />,
		);
		expect(
			(
				screen.getByRole("button", {
					name: "Move Alpha up",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			(
				screen.getByRole("button", {
					name: "Move Gamma down",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("moving Beta up reorders via onChange", () => {
		const onChange = vi.fn();
		renderWithClient(
			<SelectedFieldsList fields={fields} onChange={onChange} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Move Beta up" }));
		expect(onChange).toHaveBeenCalledWith([
			{ id: "Custom.B", displayName: "Beta" },
			{ id: "Custom.A", displayName: "Alpha" },
			{ id: "Custom.C", displayName: "Gamma" },
		]);
	});

	it("removing a field drops it from the selection", () => {
		const onChange = vi.fn();
		renderWithClient(
			<SelectedFieldsList fields={fields} onChange={onChange} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove Alpha" }));
		expect(onChange).toHaveBeenCalledWith([
			{ id: "Custom.B", displayName: "Beta" },
			{ id: "Custom.C", displayName: "Gamma" },
		]);
	});

	it("renders an empty-state hint when nothing is selected", () => {
		renderWithClient(<SelectedFieldsList fields={[]} onChange={vi.fn()} />);
		expect(screen.getByText(/No fields selected yet/i)).toBeTruthy();
	});
});

// =============================================================================
// AvailableFieldsList — search, plumbing toggle, manual add
// =============================================================================

describe("AvailableFieldsList", () => {
	const catalog: PmFieldCatalogEntry[] = [
		{
			referenceName: "System.Description",
			name: "Description",
			isPlumbing: false,
		},
		{
			referenceName: "Custom.BusinessRules",
			name: "Business Rules",
			isPlumbing: false,
		},
		{ referenceName: "Custom.LSReset", name: "LS Reset", isPlumbing: true },
	];

	const baseProps = {
		catalog,
		selected: [] as SelectedField[],
		onRefresh: vi.fn(),
		isRefreshing: false,
		lastRefreshedAt: null,
	};

	it("filters by referenceName as well as friendly name", () => {
		renderWithClient(
			<AvailableFieldsList {...baseProps} onAdd={vi.fn()} />,
		);
		const search = screen.getByPlaceholderText(
			/Search by name or identifier/i,
		);
		fireEvent.change(search, { target: { value: "businessrules" } });
		expect(
			screen.getByRole("button", { name: "Add Business Rules" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Add Description" }),
		).toBeNull();
	});

	it("hides plumbing by default and reveals it via Show all fields", () => {
		renderWithClient(
			<AvailableFieldsList {...baseProps} onAdd={vi.fn()} />,
		);
		expect(
			screen.queryByRole("button", { name: "Add LS Reset" }),
		).toBeNull();
		fireEvent.click(screen.getByLabelText("Show all fields"));
		expect(
			screen.getByRole("button", { name: "Add LS Reset" }),
		).toBeTruthy();
	});

	it("adds a catalog-present field by identifier with its friendly name", () => {
		const onAdd = vi.fn();
		renderWithClient(<AvailableFieldsList {...baseProps} onAdd={onAdd} />);
		fireEvent.change(screen.getByLabelText("Add field by identifier"), {
			target: { value: "Custom.BusinessRules" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(onAdd).toHaveBeenCalledWith({
			id: "Custom.BusinessRules",
			displayName: "Business Rules",
		});
	});

	it("adds a catalog-absent identifier using the identifier as the label", () => {
		const onAdd = vi.fn();
		renderWithClient(<AvailableFieldsList {...baseProps} onAdd={onAdd} />);
		fireEvent.change(screen.getByLabelText("Add field by identifier"), {
			target: { value: "Custom.Unlisted" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(onAdd).toHaveBeenCalledWith({
			id: "Custom.Unlisted",
			displayName: "Custom.Unlisted",
		});
	});
});

// =============================================================================
// ExampleTicketPreview — values / empty affordance / ticket-not-found
// =============================================================================

describe("ExampleTicketPreview", () => {
	const catalog: PmFieldCatalogEntry[] = [
		{
			referenceName: "Custom.BusinessRules",
			name: "Business Rules",
			isPlumbing: false,
		},
	];
	const selected: SelectedField[] = [
		{ id: "Custom.BusinessRules", displayName: "Business Rules" },
	];

	// The block now leads with "suggest" (rank fields from a sampled ticket) and
	// keeps the original per-field preview as "Preview selected", so the label and
	// button copy moved deliberately — the assertions below are unchanged.
	function enterTicket(value: string) {
		fireEvent.change(screen.getByLabelText(/Start from a real ticket/i), {
			target: { value },
		});
	}

	function submitTicket(value: string) {
		enterTicket(value);
		fireEvent.click(
			screen.getByRole("button", { name: "Preview selected" }),
		);
	}

	function suggestFromTicket(value: string) {
		enterTicket(value);
		fireEvent.click(screen.getByRole("button", { name: "Suggest fields" }));
	}

	it("renders live field values on submit", async () => {
		mocks.previewTicketFields.mockResolvedValue({
			fields: [
				{
					id: "Custom.BusinessRules",
					displayName: "Custom.BusinessRules",
					value: "Follow the rules",
					isEmpty: false,
					renderedPreview: "Follow the rules",
				},
			],
		});
		renderWithClient(
			<ExampleTicketPreview
				projectId="p1"
				catalog={catalog}
				selected={selected}
				onAddFields={mocks.onAddFields}
			/>,
		);
		submitTicket("1234");
		await waitFor(() =>
			expect(screen.getByText("has content")).toBeTruthy(),
		);
		expect(mocks.previewTicketFields).toHaveBeenCalledWith({
			projectId: "p1",
			workItemId: "1234",
			fieldIds: ["Custom.BusinessRules"],
		});
	});

	it("shows an (empty) affordance for a blank field", async () => {
		mocks.previewTicketFields.mockResolvedValue({
			fields: [
				{
					id: "Custom.BusinessRules",
					displayName: "Custom.BusinessRules",
					value: null,
					isEmpty: true,
					renderedPreview: "",
				},
			],
		});
		renderWithClient(
			<ExampleTicketPreview
				projectId="p1"
				catalog={catalog}
				selected={selected}
				onAddFields={mocks.onAddFields}
			/>,
		);
		submitTicket("1234");
		await waitFor(() => expect(screen.getByText("(empty)")).toBeTruthy());
	});

	// --- suggestion flow: rank fields from one sampled ticket ---------------

	// Shape mirrors the form-driven activity: a heading the admin can see, and
	// the control type the process template declares.
	const suggestion = (over: Partial<Record<string, unknown>> = {}) => ({
		id: "Custom.BusinessRules",
		label: "++ Story Details (Analysis) ++",
		controlType: "HtmlFieldControl",
		isContentControl: true,
		populatedOnExample: true,
		charCount: 240,
		examplePreview: "Follow the rules",
		score: 1,
		...over,
	});

	it("ranks suggested fields with their supporting evidence", async () => {
		mocks.suggestFieldMapping.mockResolvedValue({
			workItemType: "User Story",
			source: "form",
			suggestions: [suggestion()],
		});
		renderWithClient(
			<ExampleTicketPreview
				projectId="p1"
				catalog={catalog}
				selected={[]}
				onAddFields={mocks.onAddFields}
			/>,
		);
		suggestFromTicket("1234");

		await waitFor(() =>
			expect(screen.getByText(/240 chars on this ticket/i)).toBeTruthy(),
		);
		// The heading shown is the one on the ADO form, not the catalogued name.
		expect(screen.getByText("++ Story Details (Analysis) ++")).toBeTruthy();
		expect(mocks.suggestFieldMapping).toHaveBeenCalledWith({
			projectId: "p1",
			exampleWorkItemId: "1234",
		});
	});

	it("adds a single suggestion under its on-form heading", async () => {
		mocks.suggestFieldMapping.mockResolvedValue({
			workItemType: "User Story",
			source: "form",
			suggestions: [suggestion()],
		});
		renderWithClient(
			<ExampleTicketPreview
				projectId="p1"
				catalog={catalog}
				selected={[]}
				onAddFields={mocks.onAddFields}
			/>,
		);
		suggestFromTicket("1234");

		const add = await screen.findByRole("button", {
			name: /Add \+\+ Story Details \(Analysis\) \+\+ to the mapping/i,
		});
		fireEvent.click(add);
		// displayName becomes the `## heading` in the composed content, so the
		// form label is the right thing to carry through.
		expect(mocks.onAddFields).toHaveBeenCalledWith([
			{
				id: "Custom.BusinessRules",
				displayName: "++ Story Details (Analysis) ++",
			},
		]);
	});

	it("bulk-adds only confident suggestions, skipping weak ones", async () => {
		mocks.suggestFieldMapping.mockResolvedValue({
			workItemType: "User Story",
			source: "form",
			suggestions: [
				suggestion(),
				// A body field the form declares, but empty on this ticket.
				suggestion({
					id: "Custom.Placeholder",
					label: "++ Story Details (Outgoing) ++ (OLD - Do Not Use)",
					populatedOnExample: false,
					charCount: 0,
					examplePreview: "",
				}),
				// On the form and populated, but not a rich-text body.
				suggestion({
					id: "Custom.DesignState",
					label: "Design State",
					controlType: "FieldControl",
					isContentControl: false,
					charCount: 8,
				}),
			],
		});
		renderWithClient(
			<ExampleTicketPreview
				projectId="p1"
				catalog={catalog}
				selected={[]}
				onAddFields={mocks.onAddFields}
			/>,
		);
		suggestFromTicket("1234");

		const bulk = await screen.findByRole("button", {
			name: /Add 1 suggested/i,
		});
		fireEvent.click(bulk);
		expect(mocks.onAddFields).toHaveBeenCalledWith([
			{
				id: "Custom.BusinessRules",
				displayName: "++ Story Details (Analysis) ++",
			},
		]);
	});

	it("marks an already-selected suggestion as added rather than addable", async () => {
		mocks.suggestFieldMapping.mockResolvedValue({
			workItemType: "User Story",
			source: "form",
			suggestions: [suggestion()],
		});
		renderWithClient(
			<ExampleTicketPreview
				projectId="p1"
				catalog={catalog}
				selected={selected}
				onAddFields={mocks.onAddFields}
			/>,
		);
		suggestFromTicket("1234");

		await waitFor(() => expect(screen.getByText("Added")).toBeTruthy());
		expect(
			screen.queryByRole("button", {
				name: /Add \+\+ Story Details \(Analysis\) \+\+ to the mapping/i,
			}),
		).toBeNull();
	});

	it("filters suggestions by text visible in the ticket, not just names", async () => {
		mocks.suggestFieldMapping.mockResolvedValue({
			workItemType: "User Story",
			source: "form",
			suggestions: [
				suggestion(),
				suggestion({
					id: "Custom.DesignCriteria",
					label: "++ Story Details (Design) ++",
					examplePreview: "Widget alignment must follow the grid.",
				}),
			],
		});
		renderWithClient(
			<ExampleTicketPreview
				projectId="p1"
				catalog={catalog}
				selected={[]}
				onAddFields={mocks.onAddFields}
			/>,
		);
		suggestFromTicket("1234");
		await screen.findByText("++ Story Details (Analysis) ++");

		// Searching the VALUE is the point: an admin recognises the text on the
		// work item long before they recognise a reference name.
		fireEvent.change(screen.getByLabelText(/Filter suggested fields/i), {
			target: { value: "widget alignment" },
		});

		expect(screen.getByText("++ Story Details (Design) ++")).toBeTruthy();
		expect(screen.queryByText("++ Story Details (Analysis) ++")).toBeNull();
	});

	it("says when a process exposes no form and ranking fell back", async () => {
		mocks.suggestFieldMapping.mockResolvedValue({
			workItemType: "User Story",
			source: "values",
			suggestions: [suggestion({ label: "Custom.BusinessRules" })],
		});
		renderWithClient(
			<ExampleTicketPreview
				projectId="p1"
				catalog={catalog}
				selected={[]}
				onAddFields={mocks.onAddFields}
			/>,
		);
		suggestFromTicket("1234");

		await waitFor(() =>
			expect(screen.getByText(/no form definition/i)).toBeTruthy(),
		);
	});

	it("submits the primary suggest action on Enter", async () => {
		mocks.suggestFieldMapping.mockResolvedValue({
			workItemType: "User Story",
			source: "form",
			suggestions: [suggestion()],
		});
		renderWithClient(
			<ExampleTicketPreview
				projectId="p1"
				catalog={catalog}
				selected={[]}
				onAddFields={mocks.onAddFields}
			/>,
		);
		enterTicket("1234");
		fireEvent.keyDown(screen.getByLabelText(/Start from a real ticket/i), {
			key: "Enter",
		});

		await waitFor(() =>
			expect(mocks.suggestFieldMapping).toHaveBeenCalled(),
		);
		expect(mocks.previewTicketFields).not.toHaveBeenCalled();
	});

	it("flags a suggestion that is empty on the entered ticket", async () => {
		mocks.suggestFieldMapping.mockResolvedValue({
			workItemType: "User Story",
			source: "form",
			suggestions: [
				suggestion({ populatedOnExample: false, examplePreview: "" }),
			],
		});
		renderWithClient(
			<ExampleTicketPreview
				projectId="p1"
				catalog={catalog}
				selected={[]}
				onAddFields={mocks.onAddFields}
			/>,
		);
		suggestFromTicket("1234");

		await waitFor(() =>
			expect(screen.getByText(/empty on this ticket/i)).toBeTruthy(),
		);
	});

	it("surfaces a ticket-not-found error inline", async () => {
		mocks.previewTicketFields.mockRejectedValue({ code: "NOT_FOUND" });
		renderWithClient(
			<ExampleTicketPreview
				projectId="p1"
				catalog={catalog}
				selected={selected}
				onAddFields={mocks.onAddFields}
			/>,
		);
		submitTicket("9999");
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/Couldn't load ticket #9999/i);
	});
});

// =============================================================================
// FieldMappingPanel — provider states
// =============================================================================

describe("FieldMappingPanel (provider states)", () => {
	const baseProject = {
		id: "p1",
		name: "Demo",
		organizationId: null,
		projectManagementAdditionalContext: null,
	};

	it("renders the no-PM-tool hint when no tool is connected", () => {
		renderWithClient(<FieldMappingPanel project={baseProject} />);
		expect(
			screen.getByText(
				/Connect a project management tool in the card above/i,
			),
		).toBeTruthy();
		// No capabilities query fires while disconnected.
		expect(mocks.pmCapabilities).not.toHaveBeenCalled();
	});

	it("renders the unsupported placeholder for a non-ADO provider", async () => {
		mocks.pmCapabilities.mockResolvedValue({ detectedType: "jira" });
		renderWithClient(
			<FieldMappingPanel
				project={{
					...baseProject,
					projectManagementMcpConfigId: "cfg-1",
				}}
			/>,
		);
		await waitFor(() =>
			expect(
				screen.getByText(/Custom field mapping isn't available for/i),
			).toBeTruthy(),
		);
		const card = screen
			.getByText(/Custom field mapping isn't available for/i)
			.closest("div") as HTMLElement;
		expect(within(card).getByText("Jira")).toBeTruthy();
		// Never enumerates fields for a non-ADO tool.
		expect(mocks.enumerateFields).not.toHaveBeenCalled();
	});

	it("surfaces a failed capability probe instead of blaming the connection", async () => {
		mocks.pmCapabilities.mockRejectedValue(
			new Error("Output validation failed"),
		);

		renderWithClient(
			<FieldMappingPanel
				project={{
					...baseProject,
					projectManagementMcpConfigId: "cfg-1",
				}}
			/>,
		);

		// A failing probe used to fall through to the "reopen the card above to
		// reconnect" copy, which sends the admin to fix a connection that is
		// fine. Show what actually broke, with a retry.
		await waitFor(() =>
			expect(screen.getByText("Output validation failed")).toBeTruthy(),
		);
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
		expect(screen.queryByText(/Reopen the card above/i)).toBeNull();
	});

	it("does not enumerate the field catalog on page load", async () => {
		mocks.readFieldMappingConfig.mockReturnValue(null);
		mocks.pmCapabilities.mockResolvedValue({
			detectedType: "azure-devops",
		});
		mocks.enumerateFields.mockResolvedValue({ fields: [] });

		renderWithClient(
			<FieldMappingPanel
				project={{
					...baseProject,
					projectManagementMcpConfigId: "cfg-1",
				}}
			/>,
		);

		// Enumeration walks every work item type on the project — several MCP
		// round-trips. Suggestions come from the example ticket instead, so this
		// must not fire until the admin asks to browse.
		await screen.findByRole("button", { name: "Browse all fields" });
		expect(mocks.enumerateFields).not.toHaveBeenCalled();
	});

	it("keeps saving available before the catalog is ever loaded", async () => {
		mocks.readFieldMappingConfig.mockReturnValue({
			provider: "azure-devops",
			fields: [
				{ id: "Custom.BusinessRules", displayName: "Business Rules" },
			],
		});
		mocks.pmCapabilities.mockResolvedValue({
			detectedType: "azure-devops",
		});

		renderWithClient(
			<FieldMappingPanel
				project={{
					...baseProject,
					projectManagementMcpConfigId: "cfg-1",
					projectManagementAdditionalContext: { fieldMapping: {} },
				}}
			/>,
		);

		// A selection built purely from suggestions must still be savable.
		expect(
			await screen.findByRole("button", { name: "Save mapping" }),
		).toBeTruthy();
		expect(mocks.enumerateFields).not.toHaveBeenCalled();
	});

	it("enumerates the catalog only when asked to browse", async () => {
		mocks.readFieldMappingConfig.mockReturnValue(null);
		mocks.pmCapabilities.mockResolvedValue({
			detectedType: "azure-devops",
		});
		mocks.enumerateFields.mockResolvedValue({
			fields: [
				{
					referenceName: "Custom.BusinessRules",
					name: "Business Rules",
					isPlumbing: false,
				},
			],
		});

		renderWithClient(
			<FieldMappingPanel
				project={{
					...baseProject,
					projectManagementMcpConfigId: "cfg-1",
				}}
			/>,
		);

		fireEvent.click(
			await screen.findByRole("button", { name: "Browse all fields" }),
		);

		await waitFor(() => expect(mocks.enumerateFields).toHaveBeenCalled());
		expect(
			await screen.findByPlaceholderText(/Search by name or identifier/i),
		).toBeTruthy();
	});

	it("warns (non-blocking) when the selection exceeds the soft cap", async () => {
		// Persisted config seeds the working selection with 16 fields (> SOFT_CAP).
		const overCapFields = Array.from({ length: 16 }, (_, i) => ({
			id: `Custom.Field${i}`,
			displayName: `Field ${i}`,
		}));
		mocks.readFieldMappingConfig.mockReturnValue({
			provider: "azure-devops",
			fields: overCapFields,
		});
		mocks.pmCapabilities.mockResolvedValue({
			detectedType: "azure-devops",
		});
		mocks.enumerateFields.mockResolvedValue({
			fields: overCapFields.map((f) => ({
				referenceName: f.id,
				name: f.displayName,
				isPlumbing: false,
			})),
		});

		renderWithClient(
			<FieldMappingPanel
				project={{
					...baseProject,
					projectManagementMcpConfigId: "cfg-1",
					projectManagementAdditionalContext: { fieldMapping: {} },
				}}
			/>,
		);

		// Inline soft-cap warning documents the ~2 MiB limit rationale; it does
		// NOT block saving (the Save button stays present).
		expect(
			await screen.findByText(/recommend keeping this under 15/i),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Save mapping" }),
		).toBeTruthy();
	});
});
