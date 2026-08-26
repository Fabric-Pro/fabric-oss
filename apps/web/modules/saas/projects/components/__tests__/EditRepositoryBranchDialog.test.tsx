import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateBranchFn = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			repositoryIntegrations: {
				updateBranch: (...args: unknown[]) => updateBranchFn(...args),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => toastSuccess(...a),
		error: (...a: unknown[]) => toastError(...a),
	},
}));

import { EditRepositoryBranchDialog } from "../EditRepositoryBranchDialog";

const integration = {
	id: "int-1",
	repositoryOwner: "acme",
	repositoryName: "app",
	defaultBranch: "develop",
	provider: "GITHUB",
};

function renderDialog(
	overrides: Partial<
		React.ComponentProps<typeof EditRepositoryBranchDialog>
	> = {},
) {
	const onOpenChange = vi.fn();
	const onSaved = vi.fn();
	const queryClient = new QueryClient({
		defaultOptions: {
			mutations: { retry: false },
			queries: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={queryClient}>
			<EditRepositoryBranchDialog
				open
				onOpenChange={onOpenChange}
				integration={integration}
				projectId="proj-1"
				organizationId={null}
				onSaved={onSaved}
				{...overrides}
			/>
		</QueryClientProvider>,
	);
	return { onOpenChange, onSaved };
}

/** ORPCError-shaped rejection: both an Error and carrying `data.code`. */
function orpcError(code: string) {
	return Object.assign(new Error(code), { data: { code } });
}

beforeEach(() => {
	updateBranchFn.mockReset();
	toastSuccess.mockReset();
	toastError.mockReset();
	updateBranchFn.mockResolvedValue({
		integration: { id: "int-1", defaultBranch: "main" },
	});
});

describe("EditRepositoryBranchDialog", () => {
	it("pre-populates the input with the current defaultBranch", () => {
		renderDialog();
		expect(screen.getByLabelText(/monitored branch/i)).toHaveValue(
			"develop",
		);
	});

	it("disables Save when the branch is unchanged and re-enables after an edit", async () => {
		const user = userEvent.setup();
		renderDialog();
		const save = screen.getByRole("button", { name: /^save$/i });
		expect(save).toBeDisabled();
		await user.clear(screen.getByLabelText(/monitored branch/i));
		await user.type(
			screen.getByLabelText(/monitored branch/i),
			"feature/x",
		);
		expect(save).toBeEnabled();
	});

	it("disables Save when the branch is emptied", async () => {
		const user = userEvent.setup();
		renderDialog();
		await user.clear(screen.getByLabelText(/monitored branch/i));
		expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
	});

	it("calls updateBranch with the trimmed branch + ids on Save", async () => {
		const user = userEvent.setup();
		const { onSaved, onOpenChange } = renderDialog();
		await user.clear(screen.getByLabelText(/monitored branch/i));
		await user.type(screen.getByLabelText(/monitored branch/i), "release ");
		await user.click(screen.getByRole("button", { name: /^save$/i }));
		await waitFor(() => expect(updateBranchFn).toHaveBeenCalledTimes(1));
		expect(updateBranchFn).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				organizationId: null,
				integrationId: "int-1",
				branch: "release",
			}),
		);
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(toastSuccess).toHaveBeenCalled();
	});

	it("maps BRANCH_NOT_FOUND to an inline error and keeps the dialog open", async () => {
		const user = userEvent.setup();
		updateBranchFn.mockRejectedValue(orpcError("BRANCH_NOT_FOUND"));
		const { onOpenChange } = renderDialog();
		await user.clear(screen.getByLabelText(/monitored branch/i));
		await user.type(screen.getByLabelText(/monitored branch/i), "nope");
		await user.click(screen.getByRole("button", { name: /^save$/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/wasn't found/i,
		);
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		expect(toastError).not.toHaveBeenCalled();
	});

	it("keeps Save disabled after a BRANCH_NOT_FOUND error until the branch is edited", async () => {
		const user = userEvent.setup();
		updateBranchFn.mockRejectedValue(orpcError("BRANCH_NOT_FOUND"));
		renderDialog();
		await user.clear(screen.getByLabelText(/monitored branch/i));
		await user.type(screen.getByLabelText(/monitored branch/i), "nope");
		await user.click(screen.getByRole("button", { name: /^save$/i }));
		await screen.findByRole("alert");
		expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
		await user.type(screen.getByLabelText(/monitored branch/i), "r");
		expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
	});

	it("maps expired/disconnected credentials to a 'use Reconnect' inline notice", async () => {
		const user = userEvent.setup();
		updateBranchFn.mockRejectedValue(
			orpcError("REPOSITORY_CREDENTIALS_EXPIRED"),
		);
		renderDialog();
		await user.clear(screen.getByLabelText(/monitored branch/i));
		await user.type(screen.getByLabelText(/monitored branch/i), "main");
		await user.click(screen.getByRole("button", { name: /^save$/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/reconnect/i,
		);
	});

	it("maps REPOSITORY_UNREACHABLE to a toast (no inline error)", async () => {
		const user = userEvent.setup();
		updateBranchFn.mockRejectedValue(orpcError("REPOSITORY_UNREACHABLE"));
		renderDialog();
		await user.clear(screen.getByLabelText(/monitored branch/i));
		await user.type(screen.getByLabelText(/monitored branch/i), "main");
		await user.click(screen.getByRole("button", { name: /^save$/i }));
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith(
				expect.stringMatching(/couldn't reach/i),
			),
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("maps REPOSITORY_DISCONNECTED to a 'use Reconnect' inline notice", async () => {
		const user = userEvent.setup();
		updateBranchFn.mockRejectedValue(orpcError("REPOSITORY_DISCONNECTED"));
		renderDialog();
		await user.clear(screen.getByLabelText(/monitored branch/i));
		await user.type(screen.getByLabelText(/monitored branch/i), "main");
		await user.click(screen.getByRole("button", { name: /^save$/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/reconnect/i,
		);
	});

	it("falls back to a toast for an unknown error with no data.code", async () => {
		const user = userEvent.setup();
		updateBranchFn.mockRejectedValue(new Error("server exploded"));
		renderDialog();
		await user.clear(screen.getByLabelText(/monitored branch/i));
		await user.type(screen.getByLabelText(/monitored branch/i), "main");
		await user.click(screen.getByRole("button", { name: /^save$/i }));
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith(
				expect.stringMatching(/server exploded/),
			),
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
