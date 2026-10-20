/**
 * The setup wizard's generation step behind the `PROPOSAL_ARTIFACT` gate
 * (Fizzy #2946).
 *
 * Where the Proposal artifact is on, a Proposal is written from the library's
 * Client proposal (Main) prompt: its row shows where the prompt comes from
 * instead of a selector (so no "Bind as Default" at the legacy slot), keeps its
 * custom instructions, and the batch names no prompt for it. "Apply First
 * Prompt to All" skips the Proposal row as source and target. A Proposal the
 * server skips because nothing is bound to Client proposal (Main) is reported
 * in the reader's locale with a link to the Prompt Library, both when the rest
 * of the batch runs and when every document was skipped. With the gate off the
 * step is as before.
 *
 * `next-intl` echoes keys (global mock), so copy is asserted by key.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { flags, batchGenerate, embedContexts, recommendations, push } =
	vi.hoisted(() => ({
		flags: { proposalArtifact: false },
		batchGenerate: vi.fn(),
		embedContexts: vi.fn(),
		recommendations: vi.fn(),
		push: vi.fn(),
	}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "PROPOSAL_ARTIFACT" ? flags.proposalArtifact : false,
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push,
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/app/example-org/projects/new",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@saas/organizations/hooks", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
	}),
	useContextPath: (path: string) => `/app/example-org/${path}`,
}));

vi.mock("@saas/settings/hooks/use-settings-return-url", () => ({
	useSettingsReturnUrl: () => (url: string) => url,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			resolution: {
				getStatus: async () => ({ isConfigured: true }),
			},
		},
		projects: { documents: { get: vi.fn() } },
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			documentRecommendations: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.documentRecommendations", input],
					queryFn: () => recommendations(input),
				}),
			},
			documents: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.documents.list", input],
						// Any existing document would skip the selection UI.
						queryFn: async () => ({ documents: [] }),
					}),
					queryKey: ({ input }: { input: unknown }) => [
						"projects.documents.list",
						input,
					],
				},
				batchGenerate: {
					mutationOptions: (opts: {
						onSuccess?: (data: unknown) => void;
						onError?: (error: unknown) => void;
					}) => ({
						mutationFn: (input: unknown) => batchGenerate(input),
						onSuccess: opts.onSuccess,
						onError: opts.onError,
					}),
				},
			},
			contexts: {
				embed: {
					mutationOptions: (opts: Record<string, unknown>) => ({
						mutationFn: (input: unknown) => embedContexts(input),
						...opts,
					}),
				},
			},
		},
	},
}));

vi.mock("canvas-confetti", () => ({ default: vi.fn() }));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("@saas/projects/components/DocumentsList", () => ({
	DocumentsList: () => <div data-testid="documents-list-stub" />,
}));

vi.mock("@saas/projects/components/PausedBatchNotice", () => ({
	PausedBatchNotice: () => null,
}));

// The real selector loads prompts over oRPC; this one names its document type
// and lets a test pick a prompt for it.
vi.mock("@saas/prompts/components/PromptSelector", () => ({
	PromptSelector: ({
		documentType,
		onValueChange,
		showBindAction,
	}: {
		documentType?: string;
		onValueChange: (promptId: string | undefined) => void;
		showBindAction?: boolean;
	}) => (
		<div data-testid={`prompt-selector-${documentType}`}>
			<button
				type="button"
				onClick={() => onValueChange(`prompt-${documentType}`)}
			>
				{`pick ${documentType}`}
			</button>
			{showBindAction ? <span>Bind as Default</span> : null}
		</div>
	),
}));

import { DocumentGenerationStep } from "@saas/projects/components/wizard/DocumentGenerationStep";
import { toast } from "sonner";

const CATALOG_HREF =
	"/app/example-org/prompts/catalog?action=proposal_client_main%3APROPOSAL%3AANY";

const PROMPT_NOT_BOUND_SKIP = {
	type: "PROPOSAL",
	reasonKey: "documents.proposal-prompt-not-bound",
	message: "server english",
};

async function renderStep(selectedDocumentIds: string[]) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<DocumentGenerationStep
				projectId="project-1"
				selectedDocumentIds={selectedDocumentIds}
				onComplete={vi.fn()}
			/>
		</QueryClientProvider>,
	);
	// The rows are rebuilt when recommendations arrive, which would drop a
	// prompt picked before then; let them settle first.
	await waitFor(() => expect(recommendations).toHaveBeenCalled());
	await waitFor(() =>
		expect(
			screen.queryByText("Loading recommendations..."),
		).not.toBeInTheDocument(),
	);
}

const libraryField = () => screen.queryByTestId("proposal-library-prompt");
const selector = (type: string) =>
	screen.queryByTestId(`prompt-selector-${type}`);
const applyButton = () =>
	screen.getByRole("button", { name: "Apply First Prompt to All" });

type User = ReturnType<typeof userEvent.setup>;

async function pick(user: User, type: string) {
	await user.click(
		within(selector(type) as HTMLElement).getByRole("button", {
			name: `pick ${type}`,
		}),
	);
}

async function generate(user: User) {
	await user.click(
		screen.getByRole("button", { name: /Generate Documents/ }),
	);
	await waitFor(() => expect(batchGenerate).toHaveBeenCalledTimes(1));
	return batchGenerate.mock.calls[0][0] as {
		documents: Array<Record<string, unknown>>;
	};
}

const entryFor = (
	payload: { documents: Array<Record<string, unknown>> },
	type: string,
) => payload.documents.find((doc) => doc.type === type);

describe("DocumentGenerationStep — Proposal prompt behind the Proposal artifact gate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		flags.proposalArtifact = false;
		recommendations.mockResolvedValue({ recommendations: [] });
		embedContexts.mockResolvedValue({});
		batchGenerate.mockResolvedValue({ documents: [], skipped: [] });
		// The step logs a failed start; keep the output quiet.
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows the library prompt for a Proposal and the selector for a PRD with the gate on", async () => {
		flags.proposalArtifact = true;
		await renderStep(["PRD", "PROPOSAL"]);

		expect(selector("PRD")).toBeInTheDocument();
		expect(selector("PROPOSAL")).not.toBeInTheDocument();
		const field = libraryField();
		expect(field).toHaveTextContent("AI Prompt Template");
		expect(field).toHaveTextContent("libraryPrompt");
		expect(field).toHaveTextContent("libraryPromptHint");
		// "Bind as Default" only on the PRD's selector.
		expect(screen.getAllByText("Bind as Default")).toHaveLength(1);
		// Custom instructions stay on both rows.
		expect(
			screen.getAllByPlaceholderText(
				"Add any specific requirements or focus areas...",
			),
		).toHaveLength(2);
	});

	it("sends no prompt for a Proposal but keeps its instructions with the gate on", async () => {
		flags.proposalArtifact = true;
		const user = userEvent.setup();
		await renderStep(["PRD", "PROPOSAL"]);

		await pick(user, "PRD");
		const [, proposalInstructions] = screen.getAllByPlaceholderText(
			"Add any specific requirements or focus areas...",
		);
		await user.type(proposalInstructions, "Lead with the rollout plan");
		const payload = await generate(user);

		expect(entryFor(payload, "PRD")).toMatchObject({
			promptId: "prompt-PRD",
		});
		const proposal = entryFor(payload, "PROPOSAL");
		expect(proposal).toMatchObject({
			prompt: "Lead with the rollout plan",
		});
		expect(proposal).not.toHaveProperty("promptId");
	});

	it("applies the PRD row's prompt to the other non-Proposal rows only when the Proposal is listed first", async () => {
		flags.proposalArtifact = true;
		const user = userEvent.setup();
		await renderStep(["PROPOSAL", "PRD", "ARCHITECTURE"]);

		// The Proposal row chooses no prompt, so the PRD row is the source;
		// with nothing picked there the action is unavailable.
		expect(applyButton()).toBeDisabled();
		await pick(user, "PRD");
		expect(applyButton()).toBeEnabled();

		await user.click(applyButton());
		const payload = await generate(user);

		expect(entryFor(payload, "PRD")).toMatchObject({
			promptId: "prompt-PRD",
		});
		expect(entryFor(payload, "ARCHITECTURE")).toMatchObject({
			promptId: "prompt-PRD",
		});
		expect(entryFor(payload, "PROPOSAL")).not.toHaveProperty("promptId");
	});

	it("keeps two selectors and today's payload with the gate off", async () => {
		const user = userEvent.setup();
		await renderStep(["PROPOSAL", "PRD"]);

		expect(libraryField()).not.toBeInTheDocument();
		expect(selector("PROPOSAL")).toBeInTheDocument();
		expect(selector("PRD")).toBeInTheDocument();
		expect(screen.getAllByText("Bind as Default")).toHaveLength(2);

		// The source is the first row, as before.
		await pick(user, "PRD");
		expect(applyButton()).toBeDisabled();
		await pick(user, "PROPOSAL");
		await user.click(applyButton());
		const payload = await generate(user);

		expect(entryFor(payload, "PROPOSAL")).toMatchObject({
			promptId: "prompt-PROPOSAL",
		});
		expect(entryFor(payload, "PRD")).toMatchObject({
			promptId: "prompt-PROPOSAL",
		});
	});

	it("names a skipped Proposal in the reader's locale with a link to the Prompt Library", async () => {
		flags.proposalArtifact = true;
		batchGenerate.mockResolvedValue({
			documents: [],
			skipped: [PROMPT_NOT_BOUND_SKIP],
		});
		const user = userEvent.setup();
		await renderStep(["PRD", "PROPOSAL"]);

		await generate(user);

		await waitFor(() =>
			expect(toast.warning).toHaveBeenCalledWith(
				"PROPOSAL was not generated",
				expect.objectContaining({
					description: "promptNotBound",
					action: expect.objectContaining({ label: "openCatalog" }),
				}),
			),
		);
		expect(toast.warning).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ description: "server english" }),
		);

		const options = vi.mocked(toast.warning).mock.calls[0][1] as {
			action: { onClick: () => void };
		};
		options.action.onClick();
		expect(push).toHaveBeenCalledWith(CATALOG_HREF);
	});

	it("keeps the server's message for any other skip reason", async () => {
		flags.proposalArtifact = true;
		batchGenerate.mockResolvedValue({
			documents: [],
			skipped: [
				{
					type: "ARCHITECTURE",
					reasonKey: "documents.generate-architecture.no-source",
					message: "Add a source first",
				},
			],
		});
		const user = userEvent.setup();
		await renderStep(["PRD", "ARCHITECTURE"]);

		await generate(user);

		await waitFor(() =>
			expect(toast.warning).toHaveBeenCalledWith(
				"ARCHITECTURE was not generated",
				{ description: "Add a source first" },
			),
		);
	});

	it("names the skipped Proposal when every document was skipped", async () => {
		flags.proposalArtifact = true;
		batchGenerate.mockRejectedValue(
			Object.assign(new Error("server english"), {
				code: "PRECONDITION_FAILED",
				data: { gate: null, skipped: [PROMPT_NOT_BOUND_SKIP] },
			}),
		);
		const user = userEvent.setup();
		await renderStep(["PROPOSAL"]);

		await generate(user);

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"PROPOSAL was not generated",
				expect.objectContaining({
					description: "promptNotBound",
					action: expect.objectContaining({ label: "openCatalog" }),
				}),
			),
		);
		expect(toast.error).not.toHaveBeenCalledWith(
			"Failed to start generation: server english",
		);
	});

	it("keeps the generic failure when no skip maps", async () => {
		flags.proposalArtifact = true;
		batchGenerate.mockRejectedValue(
			Object.assign(new Error("Add a source first"), {
				code: "PRECONDITION_FAILED",
				data: {
					gate: null,
					skipped: [
						{
							type: "ARCHITECTURE",
							reasonKey:
								"documents.generate-architecture.no-source",
							message: "Add a source first",
						},
					],
				},
			}),
		);
		const user = userEvent.setup();
		await renderStep(["ARCHITECTURE"]);

		await generate(user);

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"Failed to start generation: Add a source first",
			),
		);
		expect(toast.error).toHaveBeenCalledTimes(1);
	});
});
