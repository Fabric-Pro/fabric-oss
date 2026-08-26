/**
 * Settings ▸ Environments — editing a deployment target.
 *
 * `environments.update` shipped with create and delete and never got a form, so
 * fixing a typo in a base URL meant deleting the target and adding it back — which
 * mints a NEW id, and the QA policy references environments *by id*. The
 * destructive workaround was the only way to do a non-destructive thing.
 *
 * What these pin: the edit is per-row (an unsaved edit must not follow the user),
 * it sends what the procedure accepts and nothing it does not, and a viewer
 * without edit rights is not offered it.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();
const useMutationMock = vi.fn();
const createMutate = vi.fn();
const updateMutate = vi.fn();
const deleteMutate = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useMutation: (...args: unknown[]) => useMutationMock(...args),
	useQueryClient: () => ({
		invalidateQueries: vi.fn(),
		setQueryData: vi.fn(),
	}),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
	toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() },
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			environments: {
				list: {
					queryOptions: (opts: unknown) => opts,
					key: () => ["environments"],
				},
				// The redacted credential summaries the row's key affordance
				// reads. Mocked because the component queries it unconditionally;
				// the credential FORM has its own tests.
				credentials: {
					list: {
						queryOptions: (opts: unknown) => opts,
						key: () => ["environment-credentials"],
					},
					set: {
						mutationOptions: (opts: unknown) => ({
							...(opts as object),
							__key: "setCredential",
						}),
					},
				},
				// Tagged, not discriminated by call order: useMutation runs
				// again on every re-render, so a call-index scheme silently
				// maps every mutation to the last one after the first render.
				create: {
					mutationOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "create",
					}),
				},
				update: {
					mutationOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "update",
					}),
				},
				delete: {
					mutationOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "delete",
					}),
				},
			},
			qaSettings: { get: { key: () => ["qa-settings"] } },
		},
	},
}));

import { ProjectEnvironmentsSettings } from "../ProjectEnvironmentsSettings";

const ENVIRONMENTS = [
	{
		id: "e1",
		type: "STAGING",
		name: "Staging",
		baseUrl: "https://staging.example.com",
	},
	{
		id: "e2",
		type: "PRODUCTION",
		name: "Live",
		baseUrl: "https://example.com",
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	useQueryMock.mockReturnValue({
		data: ENVIRONMENTS,
		isLoading: false,
		isError: false,
	});
	useMutationMock.mockImplementation((opts: { __key?: string }) => ({
		mutate:
			opts?.__key === "create"
				? createMutate
				: opts?.__key === "update"
					? updateMutate
					: deleteMutate,
		isPending: false,
	}));
});

describe("ProjectEnvironmentsSettings — editing a target", () => {
	it("offers an edit affordance per row", () => {
		render(<ProjectEnvironmentsSettings projectId="p1" canEdit />);

		expect(
			screen.getByRole("button", { name: "Edit Staging" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Edit Live" }),
		).toBeInTheDocument();
	});

	it("edits one row at a time, so a draft cannot follow the user", async () => {
		render(<ProjectEnvironmentsSettings projectId="p1" canEdit />);

		await userEvent.click(
			screen.getByRole("button", { name: "Edit Staging" }),
		);

		expect(screen.getByLabelText("Name for Staging")).toBeInTheDocument();
		// The other row stays read-only rather than opening its own draft.
		expect(
			screen.queryByLabelText("Name for Live"),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Edit Live" }),
		).toBeInTheDocument();
	});

	it("seeds the draft from the row instead of an empty form", async () => {
		// An edit form that opens blank invites someone to save a target with the
		// fields they did not mean to change wiped.
		render(<ProjectEnvironmentsSettings projectId="p1" canEdit />);

		await userEvent.click(
			screen.getByRole("button", { name: "Edit Staging" }),
		);

		expect(screen.getByLabelText("Name for Staging")).toHaveValue(
			"Staging",
		);
		expect(screen.getByLabelText("Base URL for Staging")).toHaveValue(
			"https://staging.example.com",
		);
	});

	it("sends the environment id, so the target keeps its identity", async () => {
		// The whole reason this form exists: delete-and-recreate mints a new id,
		// and the QA policy references environments BY id.
		render(<ProjectEnvironmentsSettings projectId="p1" canEdit />);

		await userEvent.click(
			screen.getByRole("button", { name: "Edit Staging" }),
		);
		await userEvent.clear(screen.getByLabelText("Base URL for Staging"));
		await userEvent.type(
			screen.getByLabelText("Base URL for Staging"),
			"https://stg.example.com",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Save Staging" }),
		);

		expect(updateMutate).toHaveBeenCalledWith({
			projectId: "p1",
			environmentId: "e1",
			type: "STAGING",
			name: "Staging",
			baseUrl: "https://stg.example.com",
		});
	});

	it("trims before sending, so a stray space cannot become the name", async () => {
		render(<ProjectEnvironmentsSettings projectId="p1" canEdit />);

		await userEvent.click(
			screen.getByRole("button", { name: "Edit Staging" }),
		);
		await userEvent.type(screen.getByLabelText("Name for Staging"), "   ");
		await userEvent.click(
			screen.getByRole("button", { name: "Save Staging" }),
		);

		expect(updateMutate).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Staging" }),
		);
	});

	it("refuses to save a blank name or URL", async () => {
		// The procedure rejects these anyway; refusing here means the user finds
		// out before spending a round trip on it.
		render(<ProjectEnvironmentsSettings projectId="p1" canEdit />);

		await userEvent.click(
			screen.getByRole("button", { name: "Edit Staging" }),
		);
		await userEvent.clear(screen.getByLabelText("Name for Staging"));

		expect(
			screen.getByRole("button", { name: "Save Staging" }),
		).toBeDisabled();
	});

	it("abandons the draft on cancel without touching the server", async () => {
		render(<ProjectEnvironmentsSettings projectId="p1" canEdit />);

		await userEvent.click(
			screen.getByRole("button", { name: "Edit Staging" }),
		);
		await userEvent.clear(screen.getByLabelText("Name for Staging"));
		await userEvent.type(
			screen.getByLabelText("Name for Staging"),
			"Wrong",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Cancel editing Staging" }),
		);

		expect(updateMutate).not.toHaveBeenCalled();
		// Back to the read-only row, with the original name — the abandoned
		// draft left nothing behind.
		expect(screen.queryByLabelText("Name for Staging")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Edit Staging" }),
		).toBeInTheDocument();
	});

	it("puts focus in the first field, not on the body", async () => {
		// Clicking Edit unmounts the button that had focus. Without an explicit
		// hand-off the browser drops focus to <body> and a keyboard user is
		// stranded mid-task — the same defect just fixed on the findings list.
		render(<ProjectEnvironmentsSettings projectId="p1" canEdit />);

		await userEvent.click(
			screen.getByRole("button", { name: "Edit Staging" }),
		);

		expect(document.activeElement).toBe(
			screen.getByLabelText("Name for Staging"),
		);
	});

	it("hands focus back to the row's Edit button on cancel", async () => {
		render(<ProjectEnvironmentsSettings projectId="p1" canEdit />);

		await userEvent.click(
			screen.getByRole("button", { name: "Edit Staging" }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Cancel editing Staging" }),
		);

		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Edit Staging" }),
		);
	});

	it("discards a draft whose row was removed elsewhere, and says so", async () => {
		// Another session deletes the row mid-edit. Previously the edit row and
		// the unsaved draft simply vanished on refetch with no feedback, and
		// `editing` lingered as an id pointing at nothing.
		const { rerender } = render(
			<ProjectEnvironmentsSettings projectId="p1" canEdit />,
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Edit Staging" }),
		);
		expect(screen.getByLabelText("Name for Staging")).toBeInTheDocument();

		useQueryMock.mockReturnValue({
			data: [ENVIRONMENTS[1]],
			isLoading: false,
			isError: false,
		});
		rerender(<ProjectEnvironmentsSettings projectId="p1" canEdit />);

		expect(screen.queryByLabelText("Name for Staging")).toBeNull();
		expect(toastError).toHaveBeenCalledWith(
			expect.stringContaining("removed elsewhere"),
		);
	});

	it("does not offer editing to someone who cannot edit", () => {
		render(<ProjectEnvironmentsSettings projectId="p1" canEdit={false} />);

		expect(
			screen.queryByRole("button", { name: "Edit Staging" }),
		).not.toBeInTheDocument();
	});
});
