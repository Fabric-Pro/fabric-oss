/**
 * The create dialog's prompt field for a Proposal behind the
 * `PROPOSAL_ARTIFACT` rollout gate (Fizzy #2801).
 *
 * A coordinated Proposal writes its Main document from the client proposal
 * prompt bound in the library and ignores any prompt a request names, so the
 * dialog must not offer a choice the run never honours: for a Proposal with
 * the gate on the selector gives way to a read-only "from the library" field,
 * and the create call carries no prompt. Every other type, and a Proposal
 * with the gate off, keep the selector. When the server refuses the create
 * because nothing is bound to that prompt, the dialog says so in the reader's
 * locale (Fizzy #2946), names who can bind one, and links to Client proposal
 * (Main) in the Prompt Library.
 *
 * `next-intl` echoes keys, so copy is asserted by key.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

import de from "../../../../../../../packages/i18n/translations/de.json";
import en from "../../../../../../../packages/i18n/translations/en.json";

const {
	getAiConfigStatus,
	createDocument,
	availablePrompts,
	getRecipientBrand,
	flags,
	push,
} = vi.hoisted(() => ({
	getAiConfigStatus: vi.fn(),
	createDocument: vi.fn(),
	availablePrompts: vi.fn(),
	getRecipientBrand: vi.fn(),
	flags: { proposalArtifact: false },
	push: vi.fn(),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string) => key;
		t.raw = (key: string) => key;
		return t;
	},
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push,
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
	}),
}));

vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => false,
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "PROPOSAL_ARTIFACT" ? flags.proposalArtifact : false,
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "example-user" } }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			resolution: {
				getStatus: (input: unknown) => getAiConfigStatus(input),
			},
		},
		prompts: { bindings: { set: vi.fn() } },
		projects: {
			recipientBrand: {
				get: (input: unknown) => getRecipientBrand(input),
			},
			contexts: { createUploadUrl: vi.fn(), processFile: vi.fn() },
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		organizations: {
			companyContext: {
				noticeState: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: [
							"organizations.companyContext.noticeState",
							input,
						],
						queryFn: () => ({ state: "hidden" }),
					}),
				},
			},
		},
		projects: {
			documents: {
				create: {
					mutationOptions: () => ({
						mutationFn: (input: unknown) => createDocument(input),
					}),
				},
				list: {
					queryKey: ({ input }: { input: unknown }) => [
						"projects.documents.list",
						input,
					],
				},
			},
		},
		prompts: {
			agents: {
				available: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["prompts.agents.available", input],
						queryFn: () => availablePrompts(input),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		loading: vi.fn(() => "toast-id-1"),
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
	},
}));

import { toast } from "sonner";
import { CreateDocumentDialog } from "../CreateDocumentDialog";

function renderDialog() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<CreateDocumentDialog
				projectId="project-1"
				open
				onOpenChange={vi.fn()}
			/>
		</QueryClientProvider>,
	);
}

type User = ReturnType<typeof userEvent.setup>;

async function pickType(user: User, name: RegExp) {
	await user.click(screen.getByRole("combobox", { name: /typeLabel/i }));
	await user.click(await screen.findByRole("option", { name }));
}

const promptSelector = () =>
	screen.queryByRole("combobox", { name: /promptLabel/i });
const libraryField = () => screen.queryByTestId("proposal-library-prompt");

/** Two prompts for every type, so a non-default can be picked on purpose. */
function offerTwoPrompts() {
	availablePrompts.mockImplementation((input: { documentType: string }) => ({
		prompts: [
			{
				id: `p-${input.documentType}-default`,
				name: `${input.documentType} default`,
				scope: "SYSTEM",
				isDefault: true,
			},
			{
				id: `p-${input.documentType}-alt`,
				name: `${input.documentType} alternative`,
				scope: "ORG",
				isDefault: false,
			},
		],
	}));
}

describe("CreateDocumentDialog — Proposal prompt behind the Proposal artifact gate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		flags.proposalArtifact = false;
		getRecipientBrand.mockResolvedValue({
			version: 2,
			canEdit: true,
			recipientBrand: {
				name: "Example Client",
				website: null,
				colors: ["#123456"],
				logoUrl: null,
			},
		});
		getAiConfigStatus.mockResolvedValue({ isConfigured: true });
		availablePrompts.mockResolvedValue({ prompts: [] });
		createDocument.mockResolvedValue({
			document: { id: "doc-1" },
			generation: null,
			displacedActive: false,
			suppliedTextOutcome: null,
		});
	});

	it("shows the library prompt instead of the selector for a Proposal with the gate on", async () => {
		flags.proposalArtifact = true;
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");

		await pickType(user, /Project Proposal/);

		expect(promptSelector()).not.toBeInTheDocument();
		const field = libraryField();
		expect(field).toHaveTextContent("promptLabel");
		expect(field).toHaveTextContent("libraryPrompt");
		expect(field).toHaveTextContent("libraryPromptHint");
		// Nothing to choose, so nothing is asked for the Proposal type.
		expect(availablePrompts).not.toHaveBeenCalledWith(
			expect.objectContaining({ documentType: "PROPOSAL" }),
		);
	});

	it("creates the Proposal with no prompt, even after one was picked for another type", async () => {
		flags.proposalArtifact = true;
		offerTwoPrompts();
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");

		// A deliberate pick for the starting type, then a switch to Proposal.
		await user.click(
			screen.getByRole("combobox", { name: /promptLabel/i }),
		);
		await user.click(
			await screen.findByRole("option", { name: /GENERAL alternative/ }),
		);
		await pickType(user, /Project Proposal/);
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		await waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
		const input = createDocument.mock.calls[0][0];
		expect(input).toMatchObject({ type: "PROPOSAL", generateWithAi: true });
		expect(input).toMatchObject({
			proposalBranding: "CLIENT",
			recipientBrandVersion: 2,
		});
		expect(input).not.toHaveProperty("promptId");
		expect(input).not.toHaveProperty("promptVersionId");
	});

	it("keeps per-run instructions for a Proposal with the gate on", async () => {
		// The free-text instructions still steer the run; only the prompt is
		// the library's.
		flags.proposalArtifact = true;
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");
		await pickType(user, /Project Proposal/);

		await user.type(
			screen.getByLabelText("instructionsLabel"),
			"Lead with the rollout plan",
		);
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		await waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
		expect(createDocument.mock.calls[0][0]).toMatchObject({
			type: "PROPOSAL",
			prompt: "Lead with the rollout plan",
		});
	});

	it("keeps the selector for a Proposal with the gate off", async () => {
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");

		await pickType(user, /Project Proposal/);

		expect(promptSelector()).toBeInTheDocument();
		expect(libraryField()).not.toBeInTheDocument();
		await waitFor(() =>
			expect(availablePrompts).toHaveBeenCalledWith(
				expect.objectContaining({ documentType: "PROPOSAL" }),
			),
		);
	});

	it("keeps the selector for a Business Case with the gate on", async () => {
		flags.proposalArtifact = true;
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");

		await pickType(user, /Business Case/);

		expect(promptSelector()).toBeInTheDocument();
		expect(libraryField()).not.toBeInTheDocument();
	});

	it("brings the selector back when the type moves off Proposal", async () => {
		flags.proposalArtifact = true;
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");

		await pickType(user, /Project Proposal/);
		expect(promptSelector()).not.toBeInTheDocument();

		await pickType(user, /Technical Architecture/);

		expect(promptSelector()).toBeInTheDocument();
		expect(libraryField()).not.toBeInTheDocument();
	});

	it("says why, in the reader's locale, when the server refuses a Proposal whose client prompt is not bound", async () => {
		// The refusal names who can bind Client proposal (Main) and links
		// there; the generic failure would hide it, and the server's English
		// would not follow the reader's locale.
		flags.proposalArtifact = true;
		const refusal =
			'No prompt is bound to the "Client proposal (Main)" action, so this Proposal cannot be generated. An organization admin can bind one in the Prompt Library under Project Documents.';
		createDocument.mockRejectedValue(
			Object.assign(new Error(refusal), {
				code: "PRECONDITION_FAILED",
				data: { code: "PROPOSAL_PROMPT_NOT_BOUND" },
			}),
		);
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");
		await pickType(user, /Project Proposal/);

		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"promptNotBound",
				expect.objectContaining({
					id: "toast-id-1",
					action: expect.objectContaining({ label: "openCatalog" }),
				}),
			),
		);
		expect(toast.error).not.toHaveBeenCalledWith(
			"createFailed",
			expect.anything(),
		);
		expect(toast.error).not.toHaveBeenCalledWith(
			refusal,
			expect.anything(),
		);

		// The action opens Client proposal (Main) in the Prompt Library.
		const options = vi
			.mocked(toast.error)
			.mock.calls.find(
				([message]) => message === "promptNotBound",
			)?.[1] as { action?: { onClick?: () => void } } | undefined;
		options?.action?.onClick?.();
		expect(push).toHaveBeenCalledWith(
			"/app/example-org/prompts/catalog?action=proposal_client_main%3APROPOSAL%3AANY",
		);
	});

	it("keeps the generic failure for any other refusal", async () => {
		flags.proposalArtifact = true;
		createDocument.mockRejectedValue(
			Object.assign(new Error("Some internal precondition detail"), {
				code: "PRECONDITION_FAILED",
				data: { code: "SOMETHING_ELSE" },
			}),
		);
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");
		await pickType(user, /Project Proposal/);

		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("createFailed", {
				id: "toast-id-1",
			}),
		);
		expect(toast.error).not.toHaveBeenCalledWith(
			"Some internal precondition detail",
			expect.anything(),
		);
	});

	it("shows neither when generation is off", async () => {
		flags.proposalArtifact = true;
		getAiConfigStatus.mockResolvedValue({ isConfigured: false });
		const user = userEvent.setup();
		renderDialog();
		await screen.findByTestId("ai-unavailable-notice");

		await pickType(user, /Project Proposal/);

		expect(promptSelector()).not.toBeInTheDocument();
		expect(libraryField()).not.toBeInTheDocument();
	});

	it("requires a saved client palette unless company colors are explicitly chosen", async () => {
		flags.proposalArtifact = true;
		getRecipientBrand.mockResolvedValue({
			version: 0,
			canEdit: true,
			recipientBrand: null,
		});
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");
		await pickType(user, /Project Proposal/);
		expect(await screen.findByText("clientRequired")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /submitWithAi/i }),
		).toBeDisabled();
		await user.click(screen.getByRole("radio", { name: "companyColors" }));
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));
		await waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
		expect(createDocument.mock.calls[0][0]).toMatchObject({
			proposalBranding: "COMPANY",
		});
		expect(createDocument.mock.calls[0][0]).not.toHaveProperty(
			"recipientBrandVersion",
		);
	});

	it("keeps branding choices labelled for keyboard and screen-reader users", async () => {
		flags.proposalArtifact = true;
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");
		await pickType(user, /Project Proposal/);
		await screen.findByText("#123456");
		const result = await axe(screen.getByRole("dialog"), {
			rules: { "color-contrast": { enabled: false } },
		});
		expect(result.violations).toEqual([]);
		expect(
			screen.getByRole("radio", { name: "clientColors" }),
		).toBeChecked();
	});

	it("requires saving or discarding inline client edits before creating", async () => {
		flags.proposalArtifact = true;
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");
		await pickType(user, /Project Proposal/);
		await user.click(await screen.findByRole("button", { name: "review" }));
		await user.type(
			await screen.findByLabelText("name", { exact: true }),
			" changed",
		);
		expect(
			screen.getByRole("button", { name: /submitWithAi/i }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "close", exact: true }),
		).toBeDisabled();
		expect(screen.getByText("saveClientEdits")).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "discard", exact: true }),
		);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /submitWithAi/i }),
			).toBeEnabled(),
		);
	});

	it("keeps an imported proposal file's appearance instead of offering a palette change", async () => {
		flags.proposalArtifact = true;
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");
		await pickType(user, /Project Proposal/);
		await screen.findByText("#123456");
		const input = screen.getByTestId("source-file-input");
		await user.upload(
			input,
			new File(["%PDF-1.7 example"], "example-proposal.pdf", {
				type: "application/pdf",
			}),
		);
		expect(
			screen.queryByRole("radiogroup", { name: "palette" }),
		).not.toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "submit", exact: true }),
		);
		await waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
		expect(createDocument.mock.calls[0][0]).not.toHaveProperty(
			"proposalBranding",
		);
		expect(createDocument.mock.calls[0][0]).not.toHaveProperty(
			"recipientBrandVersion",
		);
	});

	it("keeps a failed brand read actionable and never assumes client colors", async () => {
		flags.proposalArtifact = true;
		getRecipientBrand.mockRejectedValue(
			new Error("private storage detail"),
		);
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");
		await pickType(user, /Project Proposal/);
		expect(await screen.findByText("loadFailed")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /submitWithAi/i }),
		).toBeDisabled();
		expect(
			screen.queryByText("private storage detail"),
		).not.toBeInTheDocument();
		getRecipientBrand.mockResolvedValue({
			version: 3,
			canEdit: true,
			recipientBrand: {
				name: "Example Client",
				colors: ["#123456"],
				logoUrl: null,
			},
		});
		await user.click(screen.getByRole("button", { name: "retry" }));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /submitWithAi/i }),
			).toBeEnabled(),
		);
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));
		await waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
		expect(createDocument.mock.calls[0][0]).toMatchObject({
			proposalBranding: "CLIENT",
			recipientBrandVersion: 3,
		});
	});

	it("keeps the draft and refreshes changed branding before another create", async () => {
		flags.proposalArtifact = true;
		createDocument.mockRejectedValueOnce(
			Object.assign(new Error("private conflict detail"), {
				code: "CONFLICT",
				data: { code: "RECIPIENT_BRAND_CHANGED" },
			}),
		);
		const user = userEvent.setup();
		renderDialog();
		await screen.findByRole("checkbox");
		await pickType(user, /Project Proposal/);
		await screen.findByText("#123456");
		getRecipientBrand.mockResolvedValue({
			version: 3,
			canEdit: true,
			recipientBrand: {
				name: "Example Client",
				colors: ["#654321"],
				logoUrl: null,
			},
		});
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));
		expect(await screen.findByText("#654321")).toBeInTheDocument();
		expect(toast.error).toHaveBeenCalledWith("changed", {
			id: "toast-id-1",
		});
		expect(push).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: /submitWithAi/i }));
		await waitFor(() => expect(createDocument).toHaveBeenCalledTimes(2));
		expect(createDocument.mock.calls[1][0]).toMatchObject({
			proposalBranding: "CLIENT",
			recipientBrandVersion: 3,
		});
	});
});

describe("projects.proposalArtifactEntry copy", () => {
	it("has every key, non-empty, in both locales", () => {
		const enKeys = en.projects.proposalArtifactEntry as Record<
			string,
			unknown
		>;
		const deKeys = de.projects.proposalArtifactEntry as Record<
			string,
			unknown
		>;
		for (const [key, value] of Object.entries(enKeys)) {
			expect(value, `en ${key}`).toEqual(expect.stringMatching(/\S/));
			expect(deKeys[key], `de ${key}`).toEqual(
				expect.stringMatching(/\S/),
			);
		}
		expect(Object.keys(deKeys).sort()).toEqual(Object.keys(enKeys).sort());
		expect(enKeys.libraryPrompt).toBe(
			"Client proposal prompt from the library",
		);
	});
});
