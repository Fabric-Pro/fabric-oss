/**
 * ContextSourceDetailsDialog — the Context tab's only edit surface for a
 * source's type label and AI instructions.
 *
 * Pins the overwrite protection the dialog now carries: every save sends the
 * values it opened with as `expected`, a CONFLICT keeps the user's text and
 * shows the other version instead of closing on a silent overwrite, and the
 * next save is checked against the version the user has now seen. Also pins
 * the "last edited" line: shown with the editor's name when the project
 * member list knows them, with the date alone when it does not, and not at
 * all for a source nobody has edited.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMetadata = vi.fn();
const listMembers = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				updateMetadata: (...args: unknown[]) => updateMetadata(...args),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					queryKey: (args: { input: unknown }) => [
						"projects.contexts.list",
						args.input,
					],
				},
			},
			members: {
				list: {
					queryOptions: (args: { input: unknown }) => ({
						queryKey: ["projects.members.list", args.input],
						queryFn: () => listMembers(args.input),
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org-1" }),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => toastSuccess(...a),
		error: (...a: unknown[]) => toastError(...a),
	},
}));

// Echo interpolation values so assertions can see the name, date and the
// other version's text, which the global echo mock drops.
vi.mock("next-intl", () => {
	const t = (key: string, values?: Record<string, unknown>) =>
		values ? `${key} ${JSON.stringify(values)}` : key;
	t.raw = (key: string) => key;
	return {
		useTranslations: () => t,
		useFormatter: () => ({
			dateTime: (date: Date) => date.toISOString().slice(0, 10),
		}),
	};
});

import { ContextSourceDetailsDialog } from "../ContextSourceDetailsDialog";

type DialogProps = React.ComponentProps<typeof ContextSourceDetailsDialog>;

const LIST_KEY = [
	"projects.contexts.list",
	{ projectId: "proj-1", organizationId: "org-1" },
];

function renderDialog(overrides: Partial<DialogProps> = {}) {
	const onOpenChange = vi.fn();
	const queryClient = new QueryClient({
		defaultOptions: {
			mutations: { retry: false },
			queries: { retry: false },
		},
	});
	const element = (props: Partial<DialogProps>) => (
		<QueryClientProvider client={queryClient}>
			<ContextSourceDetailsDialog
				open
				onOpenChange={onOpenChange}
				projectId="proj-1"
				contextId="ctx-1"
				sourceName="Weekly sync"
				initialSourceType="Client Chat"
				initialAiInstructions={null}
				{...props}
			/>
		</QueryClientProvider>
	);
	const view = render(element(overrides));
	return {
		onOpenChange,
		queryClient,
		/** Re-render with new props, as a caller feeding live list values does. */
		rerenderWith: (props: Partial<DialogProps>) =>
			view.rerender(element({ ...overrides, ...props })),
	};
}

beforeEach(() => {
	updateMetadata.mockReset();
	listMembers.mockReset();
	toastSuccess.mockReset();
	toastError.mockReset();
	updateMetadata.mockResolvedValue({ contextId: "ctx-1" });
	listMembers.mockResolvedValue({ members: [] });
});

describe("ContextSourceDetailsDialog — overwrite protection", () => {
	it("sends the values it opened with as expected", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog();

		const type = screen.getByLabelText("typeLabel");
		await user.clear(type);
		await user.type(type, "Architect Chat");
		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() => expect(updateMetadata).toHaveBeenCalledTimes(1));
		expect(updateMetadata).toHaveBeenCalledWith({
			contextId: "ctx-1",
			projectId: "proj-1",
			organizationId: "org-1",
			sourceType: "Architect Chat",
			aiInstructions: null,
			expected: { sourceType: "Client Chat", aiInstructions: null },
		});
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});

	it("keeps the user's text on CONFLICT, shows the other version, and saves against it next", async () => {
		const user = userEvent.setup();
		updateMetadata.mockRejectedValueOnce(
			Object.assign(new Error("changed elsewhere"), {
				code: "CONFLICT",
				data: {
					current: {
						sourceType: "SDK Docs",
						aiInstructions: "Their guidance",
					},
				},
			}),
		);
		const { onOpenChange } = renderDialog();

		const type = screen.getByLabelText("typeLabel");
		await user.clear(type);
		await user.type(type, "Architect Chat");
		await user.click(screen.getByRole("button", { name: "save" }));

		const alert = await screen.findByTestId(
			"context-source-details-conflict",
		);
		expect(alert).toHaveTextContent("SDK Docs");
		expect(alert).toHaveTextContent("Their guidance");
		expect(screen.getByLabelText("typeLabel")).toHaveValue(
			"Architect Chat",
		);
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		expect(toastError).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() => expect(updateMetadata).toHaveBeenCalledTimes(2));
		expect(updateMetadata.mock.calls[1][0]).toMatchObject({
			sourceType: "Architect Chat",
			expected: {
				sourceType: "SDK Docs",
				aiInstructions: "Their guidance",
			},
		});
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});

	it("keeps the user's typing when the list refetches new values while open, and warns instead", async () => {
		// The link card feeds this dialog live list values, and the list
		// refetches while the dialog is open (polling during a crawl, window
		// focus). Someone else's save arriving that way must not overwrite the
		// fields — it must be shown, and become the baseline.
		const user = userEvent.setup();
		const { rerenderWith } = renderDialog();

		const type = screen.getByLabelText("typeLabel");
		await user.clear(type);
		await user.type(type, "Architect Chat");

		rerenderWith({
			initialSourceType: "SDK Docs",
			initialAiInstructions: "Their guidance",
		});

		expect(screen.getByLabelText("typeLabel")).toHaveValue(
			"Architect Chat",
		);
		const alert = await screen.findByTestId(
			"context-source-details-conflict",
		);
		expect(alert).toHaveTextContent("SDK Docs");
		expect(alert).toHaveTextContent("Their guidance");

		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() => expect(updateMetadata).toHaveBeenCalledTimes(1));
		expect(updateMetadata.mock.calls[0][0]).toMatchObject({
			sourceType: "Architect Chat",
			expected: {
				sourceType: "SDK Docs",
				aiInstructions: "Their guidance",
			},
		});
	});

	it("keeps the warning up through a refetch that brings the same values", async () => {
		const user = userEvent.setup();
		updateMetadata.mockRejectedValueOnce(
			Object.assign(new Error("changed elsewhere"), {
				code: "CONFLICT",
				data: {
					current: { sourceType: "SDK Docs", aiInstructions: null },
				},
			}),
		);
		const { rerenderWith } = renderDialog();

		await user.type(screen.getByLabelText("instructionsLabel"), "Mine");
		await user.click(screen.getByRole("button", { name: "save" }));
		await screen.findByTestId("context-source-details-conflict");

		// The CONFLICT invalidated the list; its refetch now delivers the
		// stored values the notice already shows.
		rerenderWith({ initialSourceType: "SDK Docs" });

		expect(
			screen.getByTestId("context-source-details-conflict"),
		).toHaveTextContent("SDK Docs");
		expect(screen.getByLabelText("instructionsLabel")).toHaveValue("Mine");
	});

	it("fills from the current values again when reopened", async () => {
		const user = userEvent.setup();
		const { rerenderWith } = renderDialog();

		await user.clear(screen.getByLabelText("typeLabel"));
		await user.type(screen.getByLabelText("typeLabel"), "Draft");

		rerenderWith({ open: false });
		rerenderWith({ open: true, initialSourceType: "SDK Docs" });

		expect(screen.getByLabelText("typeLabel")).toHaveValue("SDK Docs");
		expect(
			screen.queryByTestId("context-source-details-conflict"),
		).not.toBeInTheDocument();
	});

	it("writes the saved values into the list cache so a quick reopen starts from them", async () => {
		const user = userEvent.setup();
		updateMetadata.mockResolvedValue({
			contextId: "ctx-1",
			sourceType: "Architect Chat",
			aiInstructions: null,
			metadataUpdatedAt: new Date("2026-09-22T10:00:00Z"),
			metadataUpdatedByUserId: "user-1",
		});
		const { queryClient } = renderDialog();
		queryClient.setQueryData(LIST_KEY, {
			contexts: [
				{
					id: "ctx-1",
					sourceType: "Client Chat",
					aiInstructions: null,
				},
				{ id: "ctx-2", sourceType: "QA Thread", aiInstructions: null },
			],
			total: 2,
			hasMore: false,
		});

		await user.clear(screen.getByLabelText("typeLabel"));
		await user.type(screen.getByLabelText("typeLabel"), "Architect Chat");
		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() =>
			expect(
				(
					queryClient.getQueryData(LIST_KEY) as {
						contexts: Array<Record<string, unknown>>;
					}
				).contexts[0],
			).toMatchObject({
				id: "ctx-1",
				sourceType: "Architect Chat",
				metadataUpdatedByUserId: "user-1",
			}),
		);
		expect(
			(
				queryClient.getQueryData(LIST_KEY) as {
					contexts: Array<Record<string, unknown>>;
				}
			).contexts[1],
		).toMatchObject({ id: "ctx-2", sourceType: "QA Thread" });
	});

	it("refetches the list on CONFLICT", async () => {
		const user = userEvent.setup();
		updateMetadata.mockRejectedValueOnce(
			Object.assign(new Error("changed elsewhere"), {
				code: "CONFLICT",
				data: {
					current: { sourceType: "SDK Docs", aiInstructions: null },
				},
			}),
		);
		const { queryClient } = renderDialog();
		queryClient.setQueryData(LIST_KEY, { contexts: [], total: 0 });

		await user.click(screen.getByRole("button", { name: "save" }));
		await screen.findByTestId("context-source-details-conflict");

		expect(queryClient.getQueryState(LIST_KEY)?.isInvalidated).toBe(true);
	});

	it("still reports any other failure as an error toast", async () => {
		const user = userEvent.setup();
		updateMetadata.mockRejectedValueOnce(new Error("Network down"));
		renderDialog();

		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith("Network down"),
		);
		expect(
			screen.queryByTestId("context-source-details-conflict"),
		).not.toBeInTheDocument();
	});
});

describe("ContextSourceDetailsDialog — last edited", () => {
	it("names the editor and the date when the member list knows them", async () => {
		listMembers.mockResolvedValue({
			members: [{ userId: "user-2", user: { name: "Dana Example" } }],
		});
		renderDialog({
			initialMetadataUpdatedAt: "2026-09-20T08:00:00.000Z",
			initialMetadataUpdatedByUserId: "user-2",
		});

		await waitFor(() =>
			expect(
				screen.getByTestId("context-source-last-edited"),
			).toHaveTextContent("lastEditedBy"),
		);
		const line = screen.getByTestId("context-source-last-edited");
		expect(line).toHaveTextContent("Dana Example");
		expect(line).toHaveTextContent("2026-09-20");
		expect(listMembers).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
		});
	});

	it("shows the date alone when the editor is not a listed member", async () => {
		renderDialog({
			initialMetadataUpdatedAt: "2026-09-20T08:00:00.000Z",
			initialMetadataUpdatedByUserId: "user-9",
		});

		await waitFor(() => expect(listMembers).toHaveBeenCalled());
		const line = screen.getByTestId("context-source-last-edited");
		expect(line).toHaveTextContent("lastEdited");
		expect(line).not.toHaveTextContent("lastEditedBy");
		expect(line).toHaveTextContent("2026-09-20");
	});

	it("shows nothing, and looks nobody up, for a source nobody has edited", () => {
		renderDialog();

		expect(
			screen.queryByTestId("context-source-last-edited"),
		).not.toBeInTheDocument();
		expect(listMembers).not.toHaveBeenCalled();
	});
});
