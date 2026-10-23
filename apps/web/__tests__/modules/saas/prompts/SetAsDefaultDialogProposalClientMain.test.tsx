/**
 * No personal default for the client proposal prompt (Fizzy #2801).
 *
 * The prompt bound to `proposal_client_main` is the whole of what a client
 * reads in a coordinated Proposal, so the bind procedure refuses a USER-scope
 * binding on it. The dialog must not offer that write:
 *
 *   - choosing the action hides "My prompts (just for me)" and moves the scope
 *     to the organization, so the submit writes, or proposes, an ORG default;
 *   - the same holds when the action rides along under "Also apply to" — the
 *     batch binds every action at one tier, so one refused action refuses all;
 *   - leaving the action gives the user back the tier they chose.
 */

import deMessages from "@repo/i18n/translations/de.json";
import enMessages from "@repo/i18n/translations/en.json";
import { PROPOSAL_CLIENT_MAIN_AGENT_KEY } from "@repo/utils/prompt-action-catalog";
import { SetAsDefaultDialog } from "@saas/prompts/components/SetAsDefaultDialog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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

const { bindSet, bindSetMany, listForPrompt, nominate, orgAdmin } = vi.hoisted(
	() => ({
		bindSet: vi.fn(),
		bindSetMany: vi.fn(),
		listForPrompt: vi.fn(),
		nominate: vi.fn(),
		orgAdmin: { current: true },
	}),
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			bindings: {
				set: (input: unknown) => bindSet(input),
				setMany: (input: unknown) => bindSetMany(input),
				listForPrompt: (input: unknown) => listForPrompt(input),
			},
			nominations: { create: (input: unknown) => nominate(input) },
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: null } }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		isOrgContext: true,
		basePath: "/app/example-org",
	}),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		isOrganizationAdmin: orgAdmin.current,
	}),
}));

const PERSONAL = /my prompts \(just for me\)/i;
const CLIENT_PROPOSAL = /^client proposal \(main\)$/i;

function openDialog(initialDocumentType?: string) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<SetAsDefaultDialog
				open
				onOpenChange={() => {}}
				promptName="Example proposal prompt"
				promptVersionId="pv-1"
				promptId="p-1"
				initialDocumentType={initialDocumentType}
			/>
		</QueryClientProvider>,
	);
}

async function pick(
	user: ReturnType<typeof userEvent.setup>,
	label: RegExp,
	option: RegExp,
) {
	await user.click(await screen.findByRole("combobox", { name: label }));
	await user.click(await screen.findByRole("option", { name: option }));
}

/** The scope options currently offered, by their visible names. */
async function scopeOptions(user: ReturnType<typeof userEvent.setup>) {
	await user.click(await screen.findByRole("combobox", { name: /scope/i }));
	const names = (await screen.findAllByRole("option")).map(
		(option) => option.textContent ?? "",
	);
	await user.keyboard("{Escape}");
	return names;
}

async function chooseClientProposal(user: ReturnType<typeof userEvent.setup>) {
	await waitFor(() => expect(listForPrompt).toHaveBeenCalledTimes(1));
	await pick(user, /agent/i, CLIENT_PROPOSAL);
	await pick(user, /document type/i, /^proposal$/i);
}

describe("SetAsDefaultDialog — client proposal prompt (Fizzy #2801)", () => {
	beforeEach(() => {
		bindSet.mockReset();
		bindSet.mockResolvedValue({ id: "binding-1" });
		bindSetMany.mockReset();
		bindSetMany.mockResolvedValue({ count: 2 });
		listForPrompt.mockReset();
		listForPrompt.mockResolvedValue({ actions: [] });
		nominate.mockReset();
		nominate.mockResolvedValue({ id: "nom-1" });
		orgAdmin.current = true;
	});

	it("still offers a personal default for any other action", async () => {
		// Negative control: the refusal is about one action, not the dialog.
		const user = userEvent.setup();
		openDialog();
		await waitFor(() => expect(listForPrompt).toHaveBeenCalledTimes(1));

		expect(
			await screen.findByRole("combobox", { name: /scope/i }),
		).toHaveTextContent(PERSONAL);
		expect(await scopeOptions(user)).toEqual(
			expect.arrayContaining([expect.stringMatching(PERSONAL)]),
		);
		expect(
			screen.queryByTestId("set-default-personal-refused"),
		).not.toBeInTheDocument();
	});

	it("withholds the personal tier and writes an organization default", async () => {
		const user = userEvent.setup();
		openDialog();
		await chooseClientProposal(user);

		expect(
			screen.getByRole("combobox", { name: /scope/i }),
		).toHaveTextContent(/organization \(for all members\)/i);
		const options = await scopeOptions(user);
		expect(options).not.toEqual(
			expect.arrayContaining([expect.stringMatching(PERSONAL)]),
		);
		expect(options).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/organization/i),
				expect.stringMatching(/system/i),
			]),
		);
		expect(
			screen.getByTestId("set-default-personal-refused"),
		).toHaveTextContent(/cannot be a personal default/i);

		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		await waitFor(() => expect(bindSet).toHaveBeenCalledTimes(1));
		expect(bindSet).toHaveBeenCalledWith(
			expect.objectContaining({
				targetKey: PROPOSAL_CLIENT_MAIN_AGENT_KEY,
				documentType: "PROPOSAL",
				scope: "ORG",
				organizationId: "org-1",
			}),
		);
	});

	it("proposes it to the organization for a member who cannot set it", async () => {
		orgAdmin.current = false;
		const user = userEvent.setup();
		openDialog();
		await chooseClientProposal(user);

		await user.click(
			screen.getByRole("button", { name: /^propose as default$/i }),
		);

		await waitFor(() => expect(nominate).toHaveBeenCalledTimes(1));
		expect(nominate).toHaveBeenCalledWith(
			expect.objectContaining({
				targetScope: "ORG",
				organizationId: "org-1",
				targets: [
					expect.objectContaining({
						targetKey: PROPOSAL_CLIENT_MAIN_AGENT_KEY,
						documentType: "PROPOSAL",
					}),
				],
			}),
		);
		expect(bindSet).not.toHaveBeenCalled();
	});

	it("refuses the personal tier when the action rides along under Also apply to", async () => {
		// The prompt already serves the client proposal action, so the
		// dialog pre-fills it alongside whatever action is chosen above.
		listForPrompt.mockResolvedValue({
			actions: [
				{
					targetKey: PROPOSAL_CLIENT_MAIN_AGENT_KEY,
					documentType: "PROPOSAL",
					storyKind: null,
				},
			],
		});
		const user = userEvent.setup();
		openDialog();
		await waitFor(() => expect(listForPrompt).toHaveBeenCalledTimes(1));
		await pick(user, /agent/i, /^document generator$/i);
		await pick(user, /document type/i, /^prd$/i);

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: /scope/i }),
			).toHaveTextContent(/organization \(for all members\)/i),
		);
		expect(
			screen.getByTestId("set-default-personal-refused"),
		).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		await waitFor(() => expect(bindSetMany).toHaveBeenCalledTimes(1));
		const input = bindSetMany.mock.calls[0][0];
		expect(input.scope).toBe("ORG");
		expect(input.organizationId).toBe("org-1");
		expect(input.targets).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					targetKey: PROPOSAL_CLIENT_MAIN_AGENT_KEY,
				}),
				expect.objectContaining({
					targetKey: "document_generator",
					documentType: "PRD",
				}),
			]),
		);
		expect(bindSet).not.toHaveBeenCalled();
	});

	it("gives the personal tier back when the user leaves the action", async () => {
		const user = userEvent.setup();
		openDialog();
		await chooseClientProposal(user);

		await pick(user, /agent/i, /^document generator$/i);

		expect(
			screen.getByRole("combobox", { name: /scope/i }),
		).toHaveTextContent(PERSONAL);
		expect(
			screen.queryByTestId("set-default-personal-refused"),
		).not.toBeInTheDocument();
	});
});

describe("SetAsDefaultDialog — the Proposal artifact gate (Fizzy #2946)", () => {
	// With the gate on, Client proposal (Main) writes Proposals, so the legacy
	// Proposal actions are neither offered nor submitted from this dialog.
	const LEGACY = {
		targetKey: "project_document_generator",
		documentType: "PROPOSAL",
		storyKind: null,
	};
	const DRAFTER = {
		targetKey: "test_case_drafter",
		documentType: "GENERAL",
		storyKind: null,
	};
	const note = () => screen.queryByTestId("set-default-superseded-note");

	async function documentTypeOptions(
		user: ReturnType<typeof userEvent.setup>,
	) {
		await user.click(
			await screen.findByRole("combobox", { name: /document type/i }),
		);
		const names = (await screen.findAllByRole("option")).map(
			(option) => option.textContent ?? "",
		);
		await user.keyboard("{Escape}");
		return names;
	}

	beforeEach(() => {
		bindSet.mockReset();
		bindSet.mockResolvedValue({ id: "binding-1" });
		bindSetMany.mockReset();
		bindSetMany.mockResolvedValue({ count: 2 });
		listForPrompt.mockReset();
		listForPrompt.mockResolvedValue({ actions: [] });
		nominate.mockReset();
		orgAdmin.current = true;
		vi.mocked(toast.error).mockClear();
		flags.proposalArtifact = true;
	});
	afterEach(() => {
		flags.proposalArtifact = false;
	});

	it("does not offer Proposal for the legacy agent, and says why", async () => {
		const user = userEvent.setup();
		openDialog();
		await waitFor(() => expect(listForPrompt).toHaveBeenCalledTimes(1));

		const options = await documentTypeOptions(user);
		expect(options).not.toContain("Proposal");
		expect(options).toContain("PRD");
		expect(note()).toHaveTextContent("dialogNote");
	});

	it("does not offer the legacy Proposal actions under Also apply to", async () => {
		const user = userEvent.setup();
		openDialog();
		await waitFor(() => expect(listForPrompt).toHaveBeenCalledTimes(1));
		await pick(user, /document type/i, /^prd$/i);

		expect(
			await screen.findByRole("group", { name: /also apply to/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", {
				name: "Project Document Generator — Proposal",
			}),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", {
				name: "Document Generator — Proposal",
			}),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", {
				name: "Client proposal (Main) — Proposal",
			}),
		).toBeInTheDocument();
	});

	it("drops a pre-filled legacy Proposal action instead of submitting it", async () => {
		listForPrompt.mockResolvedValue({ actions: [LEGACY, DRAFTER] });
		const user = userEvent.setup();
		openDialog();
		await waitFor(() => expect(listForPrompt).toHaveBeenCalledTimes(1));
		await pick(user, /document type/i, /^prd$/i);

		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		await waitFor(() => expect(bindSetMany).toHaveBeenCalledTimes(1));
		const { targets } = bindSetMany.mock.calls[0][0];
		expect(targets).toEqual([
			expect.objectContaining({
				targetKey: "project_document_generator",
				documentType: "PRD",
			}),
			expect.objectContaining({ targetKey: "test_case_drafter" }),
		]);
		expect(targets).not.toContainEqual(
			expect.objectContaining({
				targetKey: "project_document_generator",
				documentType: "PROPOSAL",
			}),
		);
		expect(note()).toHaveTextContent("dialogNote");
	});

	it("treats a Proposal carried in from a filter tab as no choice", async () => {
		openDialog("PROPOSAL");
		await waitFor(() => expect(listForPrompt).toHaveBeenCalledTimes(1));

		expect(note()).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^set as default$/i }),
		).toBeDisabled();
		expect(bindSet).not.toHaveBeenCalled();
	});

	it("shows the server's superseded-action refusal in the reader's locale, with the catalog link", async () => {
		bindSet.mockRejectedValue(
			Object.assign(new Error("server english"), {
				code: "BAD_REQUEST",
				data: { code: "PROPOSAL_ACTION_SUPERSEDED" },
			}),
		);
		const user = userEvent.setup();
		openDialog();
		await waitFor(() => expect(listForPrompt).toHaveBeenCalledTimes(1));
		await pick(user, /document type/i, /^prd$/i);
		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"Failed to set as default",
				expect.objectContaining({
					description: "actionSuperseded",
					action: expect.objectContaining({ label: "openCatalog" }),
				}),
			),
		);
		expect(toast.error).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ description: "server english" }),
		);
	});

	it("offers and pre-fills the legacy Proposal action as today with the gate off", async () => {
		flags.proposalArtifact = false;
		listForPrompt.mockResolvedValue({ actions: [LEGACY] });
		const user = userEvent.setup();
		openDialog();
		await waitFor(() => expect(listForPrompt).toHaveBeenCalledTimes(1));

		expect(await documentTypeOptions(user)).toContain("Proposal");
		await pick(user, /document type/i, /^prd$/i);
		await user.click(
			screen.getByRole("button", { name: /^set as default$/i }),
		);

		await waitFor(() => expect(bindSetMany).toHaveBeenCalledTimes(1));
		expect(bindSetMany.mock.calls[0][0].targets).toContainEqual(
			expect.objectContaining({
				targetKey: "project_document_generator",
				documentType: "PROPOSAL",
			}),
		);
		expect(note()).not.toBeInTheDocument();
	});
});

describe("SetAsDefaultDialog — where a Proposal's diagrams come from (Fizzy #2946)", () => {
	// The global next-intl mock renders the key itself.
	const note = () => screen.queryByTestId("set-default-diagrams-note");

	beforeEach(() => {
		bindSet.mockReset();
		bindSetMany.mockReset();
		listForPrompt.mockReset();
		listForPrompt.mockResolvedValue({ actions: [] });
		nominate.mockReset();
		orgAdmin.current = true;
	});

	it("says Fabric adds the diagrams when binding Client proposal (Main)", async () => {
		const user = userEvent.setup();
		openDialog();
		await chooseClientProposal(user);

		expect(note()).toHaveTextContent("diagramsNote");
	});

	it("says so when Client proposal (Main) rides along under Also apply to", async () => {
		listForPrompt.mockResolvedValue({
			actions: [
				{
					targetKey: PROPOSAL_CLIENT_MAIN_AGENT_KEY,
					documentType: "PROPOSAL",
					storyKind: null,
				},
			],
		});
		const user = userEvent.setup();
		openDialog();
		await waitFor(() => expect(listForPrompt).toHaveBeenCalledTimes(1));
		await pick(user, /agent/i, /^document generator$/i);
		await pick(user, /document type/i, /^prd$/i);

		await waitFor(() => expect(note()).toBeInTheDocument());
	});

	it("says nothing for any other action, and stops once it is left", async () => {
		const user = userEvent.setup();
		openDialog();
		await waitFor(() => expect(listForPrompt).toHaveBeenCalledTimes(1));
		expect(note()).not.toBeInTheDocument();

		await chooseClientProposal(user);
		expect(note()).toBeInTheDocument();
		await pick(user, /agent/i, /^document generator$/i);
		expect(note()).not.toBeInTheDocument();
	});

	it("has the note in English and German", () => {
		expect(
			enMessages.projects.proposalArtifact.promptBinding.diagramsNote,
		).toBe(
			"Diagrams are added by Fabric after generation; a section that already has its own diagram is left alone.",
		);
		const german =
			deMessages.projects.proposalArtifact.promptBinding.diagramsNote;
		expect(german).toMatch(/Diagramm/);
		expect(german).not.toBe(
			enMessages.projects.proposalArtifact.promptBinding.diagramsNote,
		);
	});
});
