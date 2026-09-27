/**
 * FR22 pre-fills "Also apply to" with the actions this prompt already serves.
 * When that read fails, the dialog used to say nothing — the selection was
 * just silently empty (Fizzy #2249). Editing the set must stay unblocked, so
 * this is a non-blocking, inline notice with its own retry, not a page-level
 * error state.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/SetAsDefaultDialogBoundActionsFailure.test.tsx
 */

import { SetAsDefaultDialog } from "@saas/prompts/components/SetAsDefaultDialog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bindSet, bindSetMany, listForPrompt } = vi.hoisted(() => ({
	bindSet: vi.fn(),
	bindSetMany: vi.fn(),
	listForPrompt: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			bindings: {
				set: (i: unknown) => bindSet(i),
				setMany: (i: unknown) => bindSetMany(i),
				listForPrompt: (i: unknown) => listForPrompt(i),
			},
			nominations: { create: vi.fn() },
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: "admin" } }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		isOrgContext: true,
	}),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({ isOrganizationAdmin: true }),
}));

function wrap(ui: React.ReactElement) {
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

const openDialog = () =>
	wrap(
		<SetAsDefaultDialog
			open
			onOpenChange={() => {}}
			promptName="Test prompt"
			promptVersionId="pv-1"
			promptId="p-1"
			initialDocumentType="GENERAL"
		/>,
	);

beforeEach(() => {
	bindSet.mockReset();
	bindSet.mockResolvedValue({ id: "binding-1" });
	bindSetMany.mockReset();
	listForPrompt.mockReset();
});

describe("SetAsDefaultDialog — bound-actions read failed", () => {
	it("announces pending bound actions and prevents submit until they load", async () => {
		// Arrange
		listForPrompt.mockReturnValue(new Promise(() => {}));

		// Act
		openDialog();

		// Assert
		expect(
			await screen.findByText(
				"Loading actions this prompt already serves…",
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^set as default$/i }),
		).toBeDisabled();
	});

	it("says the pre-fill could not run, without blocking the form", async () => {
		// Arrange
		listForPrompt.mockRejectedValue(new Error("network error"));

		// Act
		openDialog();

		// Assert
		const notice = await screen.findByRole("alert");
		expect(notice).toHaveTextContent(
			"Could not refresh the actions this prompt already serves. Your current selection is kept, but it may be incomplete.",
		);
		expect(notice).not.toHaveTextContent("network error");

		// Non-blocking: the rest of the form, including the multi-select
		// itself, is still usable.
		expect(
			screen.getByText(/optional\. the action selected above/i),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^set as default$/i }),
		).not.toBeDisabled();
	});

	it("keeps cached actions and explains an incomplete selection after refetch failure", async () => {
		// Arrange
		listForPrompt
			.mockResolvedValueOnce({
				actions: [
					{
						targetKey: "test_case_step_reviser",
						documentType: "GENERAL",
						storyKind: null,
					},
				],
			})
			.mockRejectedValueOnce(new Error("network error"));
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<SetAsDefaultDialog
					open
					onOpenChange={() => {}}
					promptName="Test prompt"
					promptVersionId="pv-1"
					promptId="p-1"
					initialDocumentType="GENERAL"
				/>
			</QueryClientProvider>,
		);
		await screen.findByText(/applies for 2 actions/i);

		// Act
		await client.refetchQueries({ queryKey: ["prompt-bound-actions"] });

		// Assert
		const notice = await screen.findByRole("alert");
		expect(notice).toHaveTextContent(
			"Your current selection is kept, but it may be incomplete.",
		);
		expect(screen.getByText(/applies for 2 actions/i)).toBeInTheDocument();
	});

	it("retries the bound-actions read from the notice", async () => {
		// Arrange
		listForPrompt.mockRejectedValueOnce(new Error("network error"));
		listForPrompt.mockResolvedValueOnce({
			actions: [
				{
					targetKey: "test_case_step_reviser",
					documentType: "GENERAL",
					storyKind: null,
				},
			],
		});
		const user = userEvent.setup();

		// Act
		openDialog();

		const notice = await screen.findByRole("alert");
		await user.click(
			within(notice).getByRole("button", { name: /try again/i }),
		);

		// Assert
		await waitFor(() =>
			expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
		);
		// The pre-fill now has something to work with.
		await waitFor(() =>
			expect(
				screen.getByText(/applies for 2 actions/i),
			).toBeInTheDocument(),
		);
	});

	it("merges late server actions with the action selected during a failed read", async () => {
		// Arrange
		listForPrompt.mockRejectedValueOnce(new Error("network error"));
		listForPrompt.mockResolvedValueOnce({
			actions: [
				{
					targetKey: "test_case_step_reviser",
					documentType: "GENERAL",
					storyKind: null,
				},
			],
		});
		const user = userEvent.setup();

		// Act
		openDialog();
		const notice = await screen.findByRole("alert");
		await user.click(
			screen.getByRole("checkbox", {
				name: "Project Document Generator — PRD",
			}),
		);
		await user.click(
			within(notice).getByRole("button", { name: /try again/i }),
		);

		// Assert
		await waitFor(() =>
			expect(
				screen.getByText(/applies for 3 actions/i),
			).toBeInTheDocument(),
		);
		expect(
			screen.getByRole("checkbox", {
				name: "Project Document Generator — PRD",
			}),
		).toBeChecked();
		expect(
			screen.getByRole("checkbox", { name: "Test Case Step Reviser" }),
		).toBeChecked();
	});

	it("pre-selects nothing when the read failed, rather than guessing", async () => {
		// Arrange
		listForPrompt.mockRejectedValue(new Error("network error"));
		const user = userEvent.setup();

		// Act
		openDialog();

		await screen.findByRole("alert");
		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		// Assert
		await waitFor(() => expect(bindSet).toHaveBeenCalledTimes(1));
		// The single-action endpoint, not the batch one — nothing was added
		// to the selection to batch.
		expect(bindSetMany).not.toHaveBeenCalled();
	});
});
