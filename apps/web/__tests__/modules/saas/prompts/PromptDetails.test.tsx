/**
 * Fizzy #2249: a failed `get.byId` read used to render the same "Prompt not
 * found" copy as an absent prompt, with a Back button hard-coded to the
 * personal-context path — wrong for both reasons in an organization.
 *
 * NOT_FOUND covers both an absent id and a prompt outside the caller's tenant
 * on purpose (the lookup is tenant-filtered, so disclosing which would leak
 * tenancy); every other error means the read failed, not that the prompt is
 * gone, and gets a retry instead.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/PromptDetails.test.tsx
 */

import { ORPCError } from "@orpc/client";
import { PromptDetails } from "@saas/prompts/components/PromptDetails";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getById, listForPrompt, updatePrompt, createVersion, confirmMock } =
	vi.hoisted(() => ({
		getById: vi.fn(),
		listForPrompt: vi.fn(),
		updatePrompt: vi.fn(),
		createVersion: vi.fn(),
		confirmMock: vi.fn(),
	}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			get: {
				byId: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["prompts.get.byId", input],
						queryFn: () => getById(input),
					}),
					queryKey: ({ input }: { input: unknown }) => [
						"prompts.get.byId",
						input,
					],
				},
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			bindings: { listForPrompt: (i: unknown) => listForPrompt(i) },
			update: (i: unknown) => updatePrompt(i),
			version: { create: (i: unknown) => createVersion(i) },
			fork: { fork: vi.fn() },
		},
	},
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: "member" } }),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({ isOrganizationAdmin: false }),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push }),
	useSearchParams: () => new URLSearchParams(),
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

const basePrompt = {
	id: "p-1",
	name: "Test Case Drafter Prompt",
	description: undefined,
	scope: "USER",
	format: "PLAIN_TEXT",
	category: undefined,
	tags: [],
	isPublic: true,
	userId: "user-1",
	key: undefined,
	createdAt: "2026-01-01T00:00:00.000Z",
	versions: [
		{
			id: "ver-1",
			version: 1,
			content: "Original content",
			createdAt: "2026-01-01T00:00:00.000Z",
		},
	],
};

describe("PromptDetails — load failure vs not found", () => {
	beforeEach(() => {
		getById.mockReset();
		listForPrompt.mockReset();
		listForPrompt.mockResolvedValue({ actions: [] });
		updatePrompt.mockReset();
		createVersion.mockReset();
		confirmMock.mockReset();
		push.mockClear();
	});

	it("shows a retry state for a transport/500 failure, not a not-found dead end", async () => {
		getById.mockRejectedValue(new Error("upstream 500"));

		wrap(<PromptDetails promptId="p-1" />);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not load this prompt.");
		expect(screen.queryByText(/prompt not found/i)).not.toBeInTheDocument();
		expect(
			screen.queryByText(
				/does not exist, or you do not have access to it/i,
			),
		).not.toBeInTheDocument();

		expect(
			screen.getByRole("button", { name: "Back to Prompts" }),
		).toBeInTheDocument();
		expect(
			within(alert).getByRole("button", { name: "Try again" }),
		).toBeInTheDocument();
	});

	it("retries the read when Try again is clicked", async () => {
		getById
			.mockRejectedValueOnce(new Error("upstream 500"))
			.mockResolvedValueOnce(basePrompt);
		const user = userEvent.setup();

		wrap(<PromptDetails promptId="p-1" />);

		const alert = await screen.findByRole("alert");
		await user.click(
			within(alert).getByRole("button", { name: "Try again" }),
		);

		await screen.findByText("Test Case Drafter Prompt");
		expect(getById).toHaveBeenCalledTimes(2);
	});

	it("says the prompt does not exist or is inaccessible on NOT_FOUND, with no retry", async () => {
		getById.mockRejectedValue(new ORPCError("NOT_FOUND"));

		wrap(<PromptDetails promptId="p-1" />);

		await screen.findByText(
			/does not exist, or you do not have access to it/i,
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Try again" }),
		).not.toBeInTheDocument();
	});

	it("sends Back to Prompts through the organization's path, not the personal one", async () => {
		getById.mockRejectedValue(new ORPCError("NOT_FOUND"));
		const user = userEvent.setup();

		wrap(
			<PromptDetails
				promptId="p-1"
				organizationId="org-1"
				organizationSlug="acme"
			/>,
		);

		const back = await screen.findByRole("button", {
			name: "Back to Prompts",
		});
		await user.click(back);

		expect(push).toHaveBeenCalledWith("/app/acme/prompts");
	});
});

describe("PromptDetails — saving over an unknown bound-actions read", () => {
	beforeEach(() => {
		getById.mockReset();
		getById.mockResolvedValue(basePrompt);
		listForPrompt.mockReset();
		updatePrompt.mockReset();
		updatePrompt.mockResolvedValue({ id: "p-1" });
		createVersion.mockReset();
		createVersion.mockResolvedValue({ id: "ver-2" });
		confirmMock.mockReset();
		push.mockClear();
	});

	it("confirms honestly when the bound-actions read failed and content changed", async () => {
		listForPrompt.mockRejectedValue(new Error("network error"));
		const user = userEvent.setup();

		wrap(<PromptDetails promptId="p-1" />);

		await screen.findByText("Test Case Drafter Prompt");
		// Let the bound-actions query settle into its error state before
		// editing — the check under test reads that state at save time.
		await waitFor(() => expect(listForPrompt).toHaveBeenCalled());
		await user.click(screen.getByRole("button", { name: "Edit" }));

		const contentBox = await screen.findByLabelText("Prompt content");
		await user.clear(contentBox);
		await user.type(contentBox, "Edited content");

		await user.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
		const options = confirmMock.mock.calls[0][0];
		expect(options.title).toMatch(
			/could not check which actions use this prompt/i,
		);
		expect(options.message).toMatch(/saving may change it/i);
		// Editing stays unblocked: the confirmation is what stands between the
		// user and the save, not the failed read itself.
		expect(updatePrompt).not.toHaveBeenCalled();

		// Confirming goes through and reaches the server, same as any other save.
		await options.onConfirm();
		// Content and metadata save in one `prompts.update` call (Fizzy #2250).
		await waitFor(() => expect(updatePrompt).toHaveBeenCalledTimes(1));
		expect(updatePrompt).toHaveBeenCalledWith(
			expect.objectContaining({ id: "p-1", content: "Edited content" }),
		);
		expect(createVersion).not.toHaveBeenCalled();
	});

	it("does not warn at all when only metadata changes, even if the bound-actions read failed", async () => {
		listForPrompt.mockRejectedValue(new Error("network error"));
		const user = userEvent.setup();

		wrap(<PromptDetails promptId="p-1" />);

		await screen.findByText("Test Case Drafter Prompt");
		await user.click(screen.getByRole("button", { name: "Edit" }));

		// Rename only — the content stays untouched, so nothing an agent
		// reads changed.
		await user.click(screen.getByRole("button", { name: "Details" }));
		const nameInput = await screen.findByLabelText("Name");
		await user.type(nameInput, " v2");

		await user.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(updatePrompt).toHaveBeenCalledTimes(1));
		expect(confirmMock).not.toHaveBeenCalled();
	});
});
