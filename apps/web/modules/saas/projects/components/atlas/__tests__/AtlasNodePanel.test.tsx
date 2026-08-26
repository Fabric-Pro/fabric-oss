/**
 * Component tests for `<AtlasNodePanel />` — the editable node card.
 *
 * Coverage (the Atlas-UX override affordances):
 *   - Renders the EFFECTIVE description + category chip + file path.
 *   - "Edited by you" badge + hint show when the description is a user override.
 *   - The pencil opens an inline editor prefilled with the effective text; Save
 *     calls `updateNode({ userDescription })` and closes the editor; "Reset to AI"
 *     calls `updateNode({ userDescription: null })`.
 *   - The header category chip is READ-ONLY (a visualization): it surfaces the
 *     category label and explains its meaning on hover/focus — never an editor.
 *   - The clock lazily loads + renders the override edit history.
 *
 * next-intl is stubbed globally (vitest.setup) to echo its key, so assertions use
 * the i18n key paths (e.g. "editSave", "editedByYou", "historyField.description").
 * orpc + the organization context are mocked so no network is touched.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const baseDetail = {
		key: "node-1",
		kind: "MODULE" as const,
		label: "Auth Module",
		filePath: "src/auth",
		language: "ts",
		parentKey: null,
		description: "Handles authentication and sessions.",
		category: "security",
		isUserCategory: false,
		technicalDescription: "Handles authentication and sessions.",
		businessDescription: null,
		userDescription: null as string | null,
		userCategory: null as string | null,
		isUserDescription: false,
		editable: true,
		documentation: null,
		contentPreview: null,
		metrics: { fileCount: 3 },
		layout: null,
		neighbors: [] as unknown[],
	};
	return {
		state: {
			detail: { ...baseDetail },
			history: [] as Array<Record<string, unknown>>,
			updateCalls: [] as Array<Record<string, unknown>>,
		},
		baseDetail,
	};
});

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		atlas: {
			node: {
				queryOptions: (o: { input: unknown }) => ({
					queryKey: ["cu", "node", o.input],
					queryFn: async () => h.state.detail,
				}),
				queryKey: (o: { input: unknown }) => ["cu", "node", o.input],
			},
			nodeHistory: {
				queryOptions: (o: { input: unknown }) => ({
					queryKey: ["cu", "nodeHistory", o.input],
					queryFn: async () => ({ history: h.state.history }),
				}),
				queryKey: (o: { input: unknown }) => [
					"cu",
					"nodeHistory",
					o.input,
				],
			},
			graph: { key: () => ["cu", "graph"] },
			describeNode: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => h.state.detail,
					...opts,
				}),
			},
			updateNode: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async (input: Record<string, unknown>) => {
						h.state.updateCalls.push(input);
						const next = { ...h.state.detail };
						if (input.userDescription !== undefined) {
							next.userDescription = input.userDescription as
								| string
								| null;
							next.isUserDescription =
								input.userDescription !== null;
							next.description =
								(input.userDescription as string | null) ??
								h.baseDetail.technicalDescription;
						}
						if (input.userCategory !== undefined) {
							next.userCategory = input.userCategory as
								| string
								| null;
							next.isUserCategory = input.userCategory !== null;
							next.category =
								(input.userCategory as string | null) ??
								"security";
						}
						h.state.detail = next;
						return next;
					},
					...opts,
				}),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
		loaded: true,
	}),
}));

import { AtlasNodePanel } from "../AtlasNodePanel";

function renderPanel() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const user = userEvent.setup();
	const utils = render(
		<QueryClientProvider client={queryClient}>
			<AtlasNodePanel
				projectId="proj-1"
				analysisId="analysis-1"
				mode="TECHNICAL"
				nodeKey="node-1"
				onClose={vi.fn()}
				onSelectNode={vi.fn()}
				onAskAi={vi.fn()}
			/>
		</QueryClientProvider>,
	);
	return { ...utils, user };
}

beforeEach(() => {
	h.state.detail = { ...h.baseDetail };
	h.state.history = [];
	h.state.updateCalls = [];
});

describe("AtlasNodePanel — display", () => {
	it("renders the effective description, category chip, and file path", async () => {
		renderPanel();

		expect(await screen.findByText("Auth Module")).toBeInTheDocument();
		expect(
			screen.getByText("Handles authentication and sessions."),
		).toBeInTheDocument();
		// Category "security" resolves to a known preset → echoed i18n key.
		expect(screen.getByText("security")).toBeInTheDocument();
		expect(screen.getByText(/src\/auth/)).toBeInTheDocument();
	});

	it("shows the 'Edited by you' badge + hint when the description is a user override", async () => {
		h.state.detail = {
			...h.baseDetail,
			isUserDescription: true,
			userDescription: "My own note.",
			description: "My own note.",
		};
		renderPanel();

		expect(await screen.findByText("My own note.")).toBeInTheDocument();
		expect(screen.getByText("editedByYou")).toBeInTheDocument();
		expect(screen.getByText("editedDescriptionHint")).toBeInTheDocument();
	});

	it("renders the category chip as read-only (no editor)", async () => {
		renderPanel();
		await screen.findByText("Auth Module");

		// Category is a visualization, not editable — there is no edit trigger
		// and no preset combobox to open.
		expect(
			screen.queryByRole("button", { name: "editCategory" }),
		).toBeNull();
		expect(screen.queryByRole("option")).toBeNull();
	});
});

describe("AtlasNodePanel — edit description", () => {
	it("opens an editor prefilled with the effective text and saves a user override", async () => {
		const { user } = renderPanel();
		await screen.findByText("Auth Module");

		await user.click(
			screen.getByRole("button", { name: "editDescription" }),
		);

		const textarea = await screen.findByRole("textbox", {
			name: "editDescription",
		});
		// Prefilled with the current effective description.
		expect(textarea).toHaveValue("Handles authentication and sessions.");

		await user.clear(textarea);
		await user.type(textarea, "Owns login + session lifecycle.");
		await user.click(screen.getByRole("button", { name: "editSave" }));

		await waitFor(() => {
			expect(h.state.updateCalls).toHaveLength(1);
		});
		expect(h.state.updateCalls[0]).toMatchObject({
			projectId: "proj-1",
			analysisId: "analysis-1",
			key: "node-1",
			userDescription: "Owns login + session lifecycle.",
		});
		// Editor closes on success.
		await waitFor(() => {
			expect(
				screen.queryByRole("textbox", { name: "editDescription" }),
			).toBeNull();
		});
	});

	it("'Reset to AI' clears the description override (userDescription: null)", async () => {
		h.state.detail = {
			...h.baseDetail,
			isUserDescription: true,
			userDescription: "My own note.",
			description: "My own note.",
		};
		const { user } = renderPanel();
		await screen.findByText("My own note.");

		await user.click(
			screen.getByRole("button", { name: "editDescription" }),
		);
		await user.click(screen.getByRole("button", { name: "editClear" }));

		await waitFor(() => {
			expect(h.state.updateCalls).toHaveLength(1);
		});
		expect(h.state.updateCalls[0]).toMatchObject({
			userDescription: null,
		});
	});
});

describe("AtlasNodePanel — edit history", () => {
	it("lazily loads + renders the override edit history on open", async () => {
		h.state.history = [
			{
				id: "edit-1",
				field: "description",
				oldValue: "Old text",
				newValue: "New text",
				editedByUserId: "u1",
				editedByName: "Ada Lovelace",
				createdAt: new Date().toISOString(),
			},
		];
		const { user } = renderPanel();
		await screen.findByText("Auth Module");

		await user.click(screen.getByRole("button", { name: "history" }));

		// The entry renders field · old → new · who.
		const oldText = await screen.findByText("Old text");
		expect(oldText).toBeInTheDocument();
		expect(screen.getByText("New text")).toBeInTheDocument();
		const popover = oldText.closest("li") as HTMLElement;
		expect(
			within(popover).getByText("historyField.description"),
		).toBeInTheDocument();
	});

	it("shows the empty state when there are no manual edits", async () => {
		const { user } = renderPanel();
		await screen.findByText("Auth Module");

		await user.click(screen.getByRole("button", { name: "history" }));

		expect(await screen.findByText("historyEmpty")).toBeInTheDocument();
	});
});
