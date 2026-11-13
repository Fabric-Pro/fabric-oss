/**
 * The Coding Instructions sets panel: the sets with their repositories, a
 * repository no set covers, create and edit with the chosen repositories, a
 * refusal shown in the dialog, delete only after a confirmation and never
 * for the default set, and nothing to change for a reader. Every identifier
 * is synthetic. (`useTranslations` echoes keys in tests.)
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	listSets: vi.fn(),
	createSet: vi.fn(),
	updateSet: vi.fn(),
	deleteSet: vi.fn(),
	confirm: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { success: m.toastSuccess, error: m.toastError, info: vi.fn() },
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: m.confirm }),
}));
vi.mock("@shared/lib/orpc-query-utils", () => {
	const mutation = (fn: (input: unknown) => unknown) => ({
		mutationOptions: () => ({ mutationFn: (input: unknown) => fn(input) }),
	});
	return {
		orpc: {
			projects: {
				instructions: {
					listSets: {
						queryOptions: (options: { input: unknown }) => ({
							queryKey: ["listSets", options.input],
							queryFn: () => m.listSets(options.input),
						}),
						key: () => ["listSets"],
					},
					createSet: mutation((i) => m.createSet(i)),
					updateSet: mutation((i) => m.updateSet(i)),
					deleteSet: mutation((i) => m.deleteSet(i)),
				},
			},
		},
	};
});

import { InstructionSetsPanel } from "../InstructionSetsPanel";

const DEFAULT_SET = {
	id: "set-default",
	name: "Default",
	slug: "default",
	isDefault: true,
	repositoryIntegrationIds: ["int-web"],
	folder: "",
	excludedFolders: ["instructions/mobile-apps/"],
	createdAt: "2026-11-11T10:00:00.000Z",
	updatedAt: "2026-11-11T10:00:00.000Z",
};
const MOBILE_SET = {
	...DEFAULT_SET,
	id: "set-mobile",
	name: "Mobile apps",
	slug: "mobile-apps",
	isDefault: false,
	repositoryIntegrationIds: [],
	folder: "instructions/mobile-apps/",
	excludedFolders: [],
};
const REPOSITORIES = [
	{
		id: "int-web",
		name: "example-org/web",
		provider: "GITHUB",
		roleTag: null,
	},
	{
		id: "int-ios",
		name: "example-org/ios",
		provider: "GITHUB",
		roleTag: null,
	},
];

function renderPanel(canEdit = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<InstructionSetsPanel projectId="proj-1" canEdit={canEdit} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	m.listSets.mockResolvedValue({
		sets: [DEFAULT_SET, MOBILE_SET],
		codeRepositories: REPOSITORIES,
	});
});

describe("InstructionSetsPanel", () => {
	it("lists each set with its repositories and names a repository no set covers", async () => {
		renderPanel();

		const rows = await screen.findAllByRole("listitem");
		expect(within(rows[0]).getByText("Default")).toBeInTheDocument();
		expect(
			within(rows[0]).getByText("example-org/web"),
		).toBeInTheDocument();
		expect(within(rows[0]).getByText("rootFolder")).toBeInTheDocument();
		expect(within(rows[1]).getByText("Mobile apps")).toBeInTheDocument();
		expect(
			within(rows[1]).getByText("instructions/mobile-apps/"),
		).toBeInTheDocument();
		expect(within(rows[1]).getByText("noRepositories")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("uncovered");
	});

	it("offers no changes to a reader", async () => {
		renderPanel(false);

		await screen.findByText("Mobile apps");
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("creates a set with the chosen repositories", async () => {
		const user = userEvent.setup();
		m.createSet.mockResolvedValue({ set: MOBILE_SET });
		renderPanel();

		await user.click(await screen.findByRole("button", { name: "new" }));
		const dialog = await screen.findByRole("dialog");
		await user.type(within(dialog).getByLabelText("name"), "Mobile apps");
		await user.click(within(dialog).getByLabelText("example-org/ios"));
		await user.click(
			within(dialog).getByRole("button", { name: "create" }),
		);

		await waitFor(() =>
			expect(m.createSet).toHaveBeenCalledWith({
				projectId: "proj-1",
				name: "Mobile apps",
				repositoryIntegrationIds: ["int-ios"],
			}),
		);
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("keeps the dialog open with the server's refusal", async () => {
		const user = userEvent.setup();
		m.createSet.mockRejectedValue(
			new Error('This project already has a set named "web".'),
		);
		renderPanel();

		await user.click(await screen.findByRole("button", { name: "new" }));
		const dialog = await screen.findByRole("dialog");
		await user.type(within(dialog).getByLabelText("name"), "Web");
		await user.click(
			within(dialog).getByRole("button", { name: "create" }),
		);

		expect(await within(dialog).findByRole("alert")).toHaveTextContent(
			'already has a set named "web"',
		);
	});

	it("edits a set's repositories, starting from the current ones", async () => {
		const user = userEvent.setup();
		m.updateSet.mockResolvedValue({ set: DEFAULT_SET });
		renderPanel();

		const edits = await screen.findAllByRole("button", {
			name: "editLabel",
		});
		await user.click(edits[0]);
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByLabelText("example-org/web")).toBeChecked();
		await user.click(within(dialog).getByLabelText("example-org/ios"));
		await user.click(within(dialog).getByRole("button", { name: "save" }));

		await waitFor(() =>
			expect(m.updateSet).toHaveBeenCalledWith({
				projectId: "proj-1",
				setId: "set-default",
				name: "Default",
				repositoryIntegrationIds: ["int-web", "int-ios"],
			}),
		);
	});

	it("deletes only after a confirmation, and never offers it for the default set", async () => {
		const user = userEvent.setup();
		m.deleteSet.mockResolvedValue({ id: "set-mobile", deleted: true });
		renderPanel();

		const deletes = await screen.findAllByRole("button", {
			name: "deleteLabel",
		});
		expect(deletes).toHaveLength(1);
		await user.click(deletes[0]);

		expect(m.deleteSet).not.toHaveBeenCalled();
		const options = m.confirm.mock.calls[0]?.[0];
		expect(options).toMatchObject({ destructive: true });
		await options.onConfirm();
		expect(m.deleteSet).toHaveBeenCalledWith({
			projectId: "proj-1",
			setId: "set-mobile",
		});
	});
});
