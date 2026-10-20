/**
 * Binding one prompt to several actions from the dialog (FR19).
 *
 * Two things worth pinning. The common case must keep using the single-bind
 * endpoint, so adding this feature does not quietly route every existing bind
 * through a transaction. And the action the user came to bind is always
 * included — unticking it should not be a way to bind nothing.
 */

import { PromptBindingManager } from "@saas/prompts/components/PromptBindingManager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The prompt actions offered depend on the Proposal artifact gate (Fizzy
// #2946), read through `useFeatureFlag`, which throws without a provider.
const flags = vi.hoisted(() => ({ proposalArtifact: false }));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "PROPOSAL_ARTIFACT" ? flags.proposalArtifact : false,
}));

const { getById, bindSet, bindSetMany } = vi.hoisted(() => ({
	getById: vi.fn(),
	bindSet: vi.fn(),
	bindSetMany: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			get: { byId: (i: unknown) => getById(i) },
			bindings: {
				set: (i: unknown) => bindSet(i),
				setMany: (i: unknown) => bindSetMany(i),
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: null } }),
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

/** Open the dialog and choose the one document type a GENERAL-only agent has. */
async function openAndPickGeneral() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: /set as default/i }));
	await user.click(
		await screen.findByRole("combobox", { name: /document type/i }),
	);
	await user.click(screen.getByRole("option", { name: /general/i }));
	return user;
}

describe("PromptBindingManager — binding to several actions", () => {
	beforeEach(() => {
		getById.mockReset();
		bindSet.mockReset();
		bindSetMany.mockReset();
		getById.mockResolvedValue({
			id: "prompt-1",
			format: "HANDLEBARS",
			versions: [{ id: "pv-1", version: 1, content: "body" }],
		});
		bindSet.mockResolvedValue({ id: "binding-1" });
		bindSetMany.mockResolvedValue({ bound: 2 });
	});

	it("uses the single-bind endpoint when only one action is chosen", async () => {
		wrap(
			<PromptBindingManager
				promptId="prompt-1"
				promptName="Test prompt"
				promptScope="USER"
				promptKey="test_case_drafter"
			/>,
		);

		const user = await openAndPickGeneral();
		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		expect(bindSet).toHaveBeenCalledTimes(1);
		expect(bindSetMany).not.toHaveBeenCalled();
	});

	it("offers other actions to apply the same prompt to", async () => {
		wrap(
			<PromptBindingManager
				promptId="prompt-1"
				promptName="Test prompt"
				promptScope="USER"
				promptKey="test_case_drafter"
			/>,
		);

		await openAndPickGeneral();

		expect(await screen.findByText(/also apply to/i)).toBeInTheDocument();
		// Another agent's action is on offer...
		expect(screen.getByText("Test Case Step Reviser")).toBeInTheDocument();
		// ...and the one already selected is not repeated as a tick-box.
		const checkboxLabels = screen
			.getAllByRole("checkbox")
			.map((c) => c.closest("label")?.textContent ?? "");
		expect(checkboxLabels).not.toContain("Test Case Drafter");
	});

	it("sends every chosen action in one batch, primary included", async () => {
		wrap(
			<PromptBindingManager
				promptId="prompt-1"
				promptName="Test prompt"
				promptScope="USER"
				promptKey="test_case_drafter"
			/>,
		);

		const user = await openAndPickGeneral();
		await user.click(screen.getByText("Test Case Step Reviser"));
		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		expect(bindSet).not.toHaveBeenCalled();
		expect(bindSetMany).toHaveBeenCalledWith(
			expect.objectContaining({
				promptVersionId: "pv-1",
				targets: expect.arrayContaining([
					expect.objectContaining({
						targetKey: "test_case_drafter",
					}),
					expect.objectContaining({
						targetKey: "test_case_step_reviser",
					}),
				]),
			}),
		);
		expect(bindSetMany.mock.calls[0][0].targets).toHaveLength(2);
	});
});

describe("PromptBindingManager — the Proposal artifact gate (Fizzy #2946)", () => {
	const renderForLegacyAgent = () =>
		wrap(
			<PromptBindingManager
				promptId="prompt-1"
				promptName="Test prompt"
				promptScope="ORG"
				promptKey="project_document_generator"
				organizationId="org-1"
			/>,
		);

	async function openDocumentTypes() {
		const user = userEvent.setup();
		await user.click(
			screen.getByRole("button", { name: /set as default/i }),
		);
		await user.click(
			await screen.findByRole("combobox", { name: /document type/i }),
		);
		const names = screen
			.getAllByRole("option")
			.map((option) => option.textContent ?? "");
		return { user, names };
	}

	beforeEach(() => {
		getById.mockReset();
		bindSet.mockReset();
		bindSetMany.mockReset();
		vi.mocked(toast.error).mockClear();
		getById.mockResolvedValue({
			id: "prompt-1",
			format: "HANDLEBARS",
			versions: [{ id: "pv-1", version: 1, content: "body" }],
		});
		bindSet.mockResolvedValue({ id: "binding-1" });
		flags.proposalArtifact = true;
	});
	afterEach(() => {
		flags.proposalArtifact = false;
	});

	it("does not offer Proposal for the legacy agent, or the legacy actions under Also apply to, and says why", async () => {
		renderForLegacyAgent();
		const { user, names } = await openDocumentTypes();

		expect(names).not.toContain("Proposal");
		expect(names).toContain("PRD");
		await user.click(screen.getByRole("option", { name: /^prd$/i }));

		expect(
			screen.getByTestId("prompt-binding-superseded-note"),
		).toHaveTextContent("dialogNote");
		expect(await screen.findByText(/also apply to/i)).toBeInTheDocument();
		expect(
			screen.queryByText("Project Document Generator — Proposal"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Document Generator — Proposal"),
		).not.toBeInTheDocument();
		expect(
			screen.getByText("Client proposal (Main) — Proposal"),
		).toBeInTheDocument();
	});

	it("shows the server's superseded-action refusal in the reader's locale", async () => {
		bindSet.mockRejectedValue(
			Object.assign(new Error("server english"), {
				code: "BAD_REQUEST",
				data: { code: "PROPOSAL_ACTION_SUPERSEDED" },
			}),
		);
		renderForLegacyAgent();
		const { user } = await openDocumentTypes();
		await user.click(screen.getByRole("option", { name: /^prd$/i }));
		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		await vi.waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"Failed to bind prompt",
				expect.objectContaining({
					description: "actionSuperseded",
					action: expect.objectContaining({ label: "openCatalog" }),
				}),
			),
		);
	});

	it("offers Proposal as today with the gate off", async () => {
		flags.proposalArtifact = false;
		renderForLegacyAgent();
		const { names } = await openDocumentTypes();

		expect(names).toContain("Proposal");
		expect(
			screen.queryByTestId("prompt-binding-superseded-note"),
		).not.toBeInTheDocument();
	});
});
