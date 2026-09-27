/**
 * Fizzy #2249: a failed `get.byId` read used to render the same "Prompt not
 * found" copy as an absent prompt, with a Back button hard-coded to the
 * personal-context path — wrong for both reasons in an organization.
 *
 * NOT_FOUND covers both an absent id and a prompt outside the caller's tenant
 * on purpose (the lookup is tenant-filtered, so disclosing which would leak
 * tenancy); FORBIDDEN (`requireInputOrgPermission`, not a member of the
 * prompt's organization) is the same underlying fact told a different way and
 * gets the identical copy. Every other error means the read failed, not that
 * the prompt is inaccessible, and gets a retry instead.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/PromptDetails.test.tsx
 */

import { ORPCError } from "@orpc/client";
import { PromptDetails } from "@saas/prompts/components/PromptDetails";
import {
	onlineManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
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

	it("keeps a paused initial read loading and resumes it on reconnect", async () => {
		// Arrange
		getById.mockResolvedValue(basePrompt);
		onlineManager.setOnline(false);

		try {
			// Act
			wrap(<PromptDetails promptId="p-1" />);

			// Assert
			expect(screen.queryByText("Test Case Drafter Prompt")).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();
			onlineManager.setOnline(true);
			await screen.findByText("Test Case Drafter Prompt");
		} finally {
			onlineManager.setOnline(true);
		}
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

	it("retries a proxy HTML response even when its rewrapped code is NOT_FOUND", async () => {
		// Arrange
		const error = Object.assign(new ORPCError("NOT_FOUND"), {
			data: { responseText: "<html>gateway error</html>" },
		});
		getById.mockRejectedValue(error);

		// Act
		wrap(<PromptDetails promptId="p-1" />);

		// Assert
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not load this prompt.");
	});

	it("retries an empty proxy 404 marked as non-oRPC", async () => {
		// Arrange
		const error = Object.assign(new ORPCError("NOT_FOUND"), {
			data: { isNonOrpcResponse: true, responseText: "" },
		});
		getById.mockRejectedValue(error);

		// Act
		wrap(<PromptDetails promptId="p-1" />);

		// Assert
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not load this prompt.");
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

	it("says the same thing for FORBIDDEN as for NOT_FOUND, with no dead-end retry", async () => {
		// `requireInputOrgPermission` throws FORBIDDEN when the caller is not
		// a member of the prompt's organization — a different code for the
		// same fact NOT_FOUND already covers honestly: this prompt is not
		// something you can see. Retrying either can never succeed.
		getById.mockRejectedValue(new ORPCError("FORBIDDEN"));

		wrap(<PromptDetails promptId="p-1" />);

		await screen.findByText(
			/does not exist, or you do not have access to it/i,
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Try again" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Back to Prompts" }),
		).toBeInTheDocument();
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

	it("rechecks failed bindings at save and warns with the fresh shared actions", async () => {
		// Arrange
		listForPrompt
			.mockRejectedValueOnce(new Error("network error"))
			.mockResolvedValueOnce({
				actions: [
					{
						targetKey: "specs",
						documentType: "PRD",
						storyKind: null,
					},
					{
						targetKey: "architecture",
						documentType: "ARCHITECTURE",
						storyKind: null,
					},
				],
			});
		const user = userEvent.setup();
		wrap(<PromptDetails promptId="p-1" />);
		await screen.findByText("Test Case Drafter Prompt");
		await user.click(screen.getByRole("button", { name: "Edit" }));
		const contentBox = await screen.findByLabelText("Prompt content");
		await user.clear(contentBox);
		await user.type(contentBox, "Edited content");

		// Act
		await user.click(screen.getByRole("button", { name: "Save changes" }));

		// Assert
		await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
		expect(confirmMock.mock.calls[0][0].title).toMatch(
			/used by several actions/i,
		);
		expect(listForPrompt).toHaveBeenCalledTimes(2);
	});

	it("uses three fresh bindings after a binding changes before editing", async () => {
		// Arrange
		listForPrompt
			.mockResolvedValueOnce({
				actions: [
					{
						targetKey: "specs",
						documentType: "PRD",
						storyKind: null,
					},
				],
			})
			.mockResolvedValueOnce({
				actions: [
					{
						targetKey: "specs",
						documentType: "PRD",
						storyKind: null,
					},
					{
						targetKey: "architecture",
						documentType: "ARCHITECTURE",
						storyKind: null,
					},
					{
						targetKey: "test_case_drafter",
						documentType: "GENERAL",
						storyKind: null,
					},
				],
			});
		const user = userEvent.setup();
		wrap(<PromptDetails promptId="p-1" />);
		await screen.findByText("Test Case Drafter Prompt");
		await waitFor(() => expect(listForPrompt).toHaveBeenCalledTimes(1));
		await user.click(screen.getByRole("button", { name: "Edit" }));
		const contentBox = await screen.findByLabelText("Prompt content");
		await user.clear(contentBox);
		await user.type(contentBox, "Edited after binding");

		// Act
		await user.click(screen.getByRole("button", { name: "Save changes" }));

		// Assert
		await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
		expect(confirmMock.mock.calls[0][0].message).toContain("all 3");
		expect(listForPrompt).toHaveBeenCalledTimes(2);
	});

	it("uses a fresh shared-actions guard while the initial read is pending", async () => {
		// Arrange
		const pendingBindings = new Promise<{
			actions: Array<{
				targetKey: string;
				documentType: string;
				storyKind: null;
			}>;
		}>(() => {});
		const sharedActions = {
			actions: [
				{ targetKey: "specs", documentType: "PRD", storyKind: null },
				{
					targetKey: "architecture",
					documentType: "ARCHITECTURE",
					storyKind: null,
				},
			],
		};
		listForPrompt
			.mockReturnValueOnce(pendingBindings)
			.mockResolvedValueOnce(sharedActions);
		const user = userEvent.setup();

		wrap(<PromptDetails promptId="p-1" />);

		await screen.findByText("Test Case Drafter Prompt");
		await user.click(screen.getByRole("button", { name: "Edit" }));

		const contentBox = await screen.findByLabelText("Prompt content");
		await user.clear(contentBox);
		await user.type(contentBox, "Edited before load");

		// Act
		await user.click(screen.getByRole("button", { name: "Save changes" }));

		// Assert
		expect(
			screen.getByText(
				"Checking which actions use this prompt before save.",
			),
		).toBeInTheDocument();
		await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
		expect(confirmMock.mock.calls[0][0].title).toMatch(
			/used by several actions/i,
		);
		expect(listForPrompt).toHaveBeenCalledTimes(2);
		await confirmMock.mock.calls[0][0].onConfirm();
		await waitFor(() => expect(updatePrompt).toHaveBeenCalledTimes(1));
		expect(updatePrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "p-1",
				content: "Edited before load",
			}),
		);
	});

	it("retries a failed bound-actions read from the prompt read view", async () => {
		// Arrange
		listForPrompt
			.mockRejectedValueOnce(new Error("network error"))
			.mockResolvedValueOnce({ actions: [] });
		const user = userEvent.setup();
		wrap(<PromptDetails promptId="p-1" />);

		// Act
		const alert = await screen.findByRole("alert");
		await user.click(
			within(alert).getByRole("button", { name: "Try again" }),
		);

		// Assert
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		expect(listForPrompt).toHaveBeenCalledTimes(2);
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

describe("PromptDetails — a failed background refetch keeps the loaded prompt", () => {
	beforeEach(() => {
		getById.mockReset();
		getById.mockResolvedValue(basePrompt);
		listForPrompt.mockReset();
		listForPrompt.mockResolvedValue({ actions: [] });
		confirmMock.mockReset();
	});

	it("does not replace the editor, or its unsaved text, when a refetch fails", async () => {
		const user = userEvent.setup();
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<PromptDetails promptId="p-1" />
			</QueryClientProvider>,
		);

		await screen.findByText("Test Case Drafter Prompt");
		await user.click(screen.getByRole("button", { name: "Edit" }));
		const contentBox = await screen.findByLabelText("Prompt content");
		await user.clear(contentBox);
		await user.type(contentBox, "Unsaved edit");

		// A window refocus after the prompt went stale refetches it; this one
		// hits a network blip. The prompt on screen is still the right one.
		getById.mockRejectedValue(new TypeError("Failed to fetch"));
		await client.refetchQueries({ queryKey: ["prompts.get.byId"] });
		await waitFor(() => expect(getById).toHaveBeenCalledTimes(2));

		expect(screen.queryByText("Could not load this prompt.")).toBeNull();
		expect(screen.getByLabelText("Prompt content")).toHaveValue(
			"Unsaved edit",
		);
	});
});
