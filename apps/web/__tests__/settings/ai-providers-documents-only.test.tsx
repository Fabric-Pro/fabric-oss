/**
 * A provider designated "Use for Documents" that is not the default serves
 * only document search (Fizzy #2770): chat, agents and generation go to the
 * default provider, or to a ChatGPT plan. The card says so instead of a bare
 * "Embeddings" badge.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockImpact, mockGetStatus, mockSetEmbedding } = vi.hoisted(() => ({
	mockImpact: vi.fn(),
	mockGetStatus: vi.fn(),
	mockSetEmbedding: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			embeddings: { changeImpact: mockImpact },
			resolution: { getStatus: mockGetStatus },
			providers: {
				testConnection: vi.fn(),
				testSavedConnection: vi.fn(),
				upsert: vi.fn(),
				setDefault: vi.fn(),
				setEmbedding: mockSetEmbedding,
				delete: vi.fn(),
				getConfig: vi.fn(),
				updateEnabled: vi.fn(),
			},
		},
	},
}));

vi.mock("@saas/settings/hooks/use-return-to-redirect", () => ({
	useReturnToRedirect: () => ({ triggerReturn: vi.fn() }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationName: "Example Org",
		isOrgContext: true,
	}),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OrgAiProvidersSettingsForm } from "../../modules/saas/settings/components/OrgAiProvidersSettingsForm";

function renderForm(
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
	return render(
		<QueryClientProvider client={client}>
			<OrgAiProvidersSettingsForm />
		</QueryClientProvider>,
	);
}

const status = (embeddingIsDefault: boolean) => ({
	isConfigured: true,
	message: "configured",
	configuredProviders: [
		{
			provider: "OPENAI_DIRECT",
			displayName: "OpenAI",
			isDefault: embeddingIsDefault,
			isEmbeddingProvider: true,
		},
		...(embeddingIsDefault
			? []
			: [
					{
						provider: "ANTHROPIC_DIRECT",
						displayName: "Anthropic",
						isDefault: true,
						isEmbeddingProvider: false,
					},
				]),
	],
	embeddingProvider: "OPENAI_DIRECT",
	organizationEmbedding: {
		provider: "OPENAI_DIRECT",
		model: null,
		identity: "OPENAI_DIRECT:example-embedding",
		source: "documents_provider",
	},
	embeddingModel: null,
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("Use for Documents designation", () => {
	it("marks a provider used only for documents as such", async () => {
		mockGetStatus.mockResolvedValue(status(false));
		renderForm();
		expect(await screen.findByText("Documents only")).toBeInTheDocument();
		expect(screen.queryByText("Embeddings")).toBeNull();
	});

	it("keeps the plain Embeddings badge on the default provider", async () => {
		mockGetStatus.mockResolvedValue(status(true));
		renderForm();
		expect(await screen.findByText("Embeddings")).toBeInTheDocument();
		expect(screen.queryByText("Documents only")).toBeNull();
	});
});

describe("Embeddings only", () => {
	const embeddingsOnlyStatus = {
		...status(false),
		configuredProviders: status(false).configuredProviders.map((p) =>
			p.provider === "OPENAI_DIRECT"
				? { ...p, purpose: "EMBEDDINGS_ONLY" }
				: { ...p, purpose: "ALL" },
		),
	};

	it("badges an embeddings-only key and offers no Set Default for it", async () => {
		mockGetStatus.mockResolvedValue(embeddingsOnlyStatus);
		renderForm();
		expect(await screen.findByText("badge")).toBeInTheDocument();
		expect(screen.queryByText("Documents only")).toBeNull();
		const switches = screen.getAllByRole("switch");
		expect(switches).toHaveLength(1);
		expect(switches[0]).toBeChecked();
		// The only Set Default offered would be for a provider that is neither
		// default nor embeddings-only; here there is none.
		expect(screen.queryByText("Set Default")).toBeNull();
	});

	it("restricts the documents provider through setEmbedding with a purpose", async () => {
		mockGetStatus.mockResolvedValue({
			...status(false),
			configuredProviders: status(false).configuredProviders.map((p) => ({
				...p,
				purpose: "ALL",
			})),
		});
		mockSetEmbedding.mockResolvedValue({ success: true });
		renderForm();

		const toggle = await screen.findByRole("switch");
		expect(toggle).not.toBeChecked();
		fireEvent.click(toggle);

		await waitFor(() =>
			expect(mockSetEmbedding).toHaveBeenCalledWith({
				provider: "OPENAI_DIRECT",
				purpose: "EMBEDDINGS_ONLY",
				organizationId: "org-1",
			}),
		);
	});
});

it.each(["company", "project", "empty", "unavailable"] as const)(
	"checks indexed content before moving documents off the resolved default (%s)",
	async (kind) => {
		const empty = kind === "empty";
		if (kind === "unavailable") {
			mockImpact.mockRejectedValue(
				new Error("Example count unavailable"),
			);
		} else {
			mockImpact.mockResolvedValue({
				companyContext: {
					indexedWithCurrentModel: kind === "company" ? 2 : 0,
					total: 5,
				},
				projectContent: { indexed: kind === "project" ? 7 : 0 },
			});
		}

		mockSetEmbedding.mockResolvedValue({ success: true });
		mockGetStatus.mockResolvedValue({
			...status(false),
			embeddingProvider: null,
			organizationEmbedding: {
				provider: "ANTHROPIC_DIRECT",
				model: null,
				identity: "ANTHROPIC_DIRECT:example-embedding",
				source: "default_provider",
			},
			resolvedEmbeddingProvider: "ANTHROPIC_DIRECT",
			configuredProviders: status(false).configuredProviders.map((p) => ({
				...p,
				isEmbeddingProvider: false,
				purpose: "ALL",
			})),
		});
		renderForm();
		const card = (await screen.findAllByText("OpenAI"))[0].closest(
			"div.relative",
		) as HTMLElement;
		await waitFor(() =>
			expect(
				within(card).getByRole("button", { name: /Use for Documents/ }),
			).not.toBeDisabled(),
		);
		fireEvent.click(
			within(card).getByRole("button", { name: /Use for Documents/ }),
		);
		if (!empty) {
			const dialog = await screen.findByRole("alertdialog");
			if (kind === "unavailable") {
				expect(within(dialog).getByRole("alert")).toHaveTextContent(
					"embeddingsImpactUnavailable",
				);
			}
			expect(mockSetEmbedding).not.toHaveBeenCalled();
			const confirm = within(dialog).getByRole("button", {
				name: "embeddingsChangeConfirm",
			});
			expect(confirm).toBeDisabled();
			fireEvent.change(
				within(dialog).getByRole("textbox", {
					name: "embeddingsConfirmationLabel",
				}),
				{ target: { value: "embeddingsConfirmationWord" } },
			);
			fireEvent.click(confirm);
		}
		await waitFor(() =>
			expect(mockSetEmbedding).toHaveBeenCalledWith({
				provider: "OPENAI_DIRECT",
				organizationId: "org-1",
			}),
		);
		expect(mockImpact).toHaveBeenCalledWith({ organizationId: "org-1" });
		if (empty) {
			expect(screen.queryByRole("alertdialog")).toBeNull();
		}
	},
);

it("invalidates cached embedding defaults and available models after Use for Documents", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
	const keys = ["aiTaskDefaults", "aiAvailableModels", "aiOrgPreferences"];
	for (const key of keys) {
		client.setQueryData([key, "org-1"], [{ provider: "ANTHROPIC_DIRECT" }]);
	}
	mockGetStatus.mockResolvedValue({
		...status(false),
		configuredProviders: status(false).configuredProviders.map((p) => ({
			...p,
			isEmbeddingProvider: false,
		})),
		embeddingProvider: null,
		organizationEmbedding: {
			provider: "ANTHROPIC_DIRECT",
			model: null,
			identity: "ANTHROPIC_DIRECT:example-embedding",
			source: "default_provider",
		},
	});
	mockImpact.mockResolvedValue({
		companyContext: { indexedWithCurrentModel: 0, total: 0 },
		projectContent: { indexed: 0 },
	});
	mockSetEmbedding.mockResolvedValue({ success: true });
	renderForm(client);
	const trigger = await screen.findByRole("button", {
		name: /Use for Documents/,
	});
	fireEvent.click(trigger);
	await waitFor(() => expect(mockSetEmbedding).toHaveBeenCalled());
	await waitFor(() => {
		for (const key of keys) {
			expect(client.getQueryState([key, "org-1"])?.isInvalidated).toBe(
				true,
			);
		}
	});
});

it("confirms a same-model provider change using the organization identity despite the viewer's personal key", async () => {
	mockGetStatus.mockResolvedValue({
		...status(false),
		configuredProviders: status(false).configuredProviders.map((p) => ({
			...p,
			isEmbeddingProvider: false,
		})),
		embeddingProvider: null,
		resolvedEmbeddingProvider: "OPENAI_DIRECT",
		resolvedEmbeddingSource: "user",
		organizationEmbedding: {
			provider: "VERCEL_GATEWAY",
			model: {
				canonicalName: "text-embedding-3-small",
				modelString: "openai/text-embedding-3-small",
			},
			identity: "VERCEL_GATEWAY:openai/text-embedding-3-small",
			source: "documents_provider",
		},
	});
	mockImpact.mockResolvedValue({
		companyContext: { indexedWithCurrentModel: 2, total: 2 },
		projectContent: { indexed: 0 },
	});
	renderForm();
	fireEvent.click(
		await screen.findByRole("button", { name: /Use for Documents/ }),
	);
	expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
	expect(mockSetEmbedding).not.toHaveBeenCalled();
});

it.each([
	["VERCEL_GATEWAY", "Vercel AI Gateway"],
	["OPENAI_DIRECT", "OpenAI"],
	["AZURE_AI_FOUNDRY", "Azure AI Foundry"],
])(
	"keeps stored documents actions separate from resolved display (%s)",
	async (provider, displayName) => {
		mockGetStatus.mockResolvedValue({
			...status(true),
			configuredProviders: [
				{
					provider,
					displayName,
					isDefault: true,
					isEmbeddingProvider: false,
					purpose: "ALL",
				},
			],
			organizationEmbedding: {
				...status(true).organizationEmbedding,
				provider,
				identity: `${provider}:example-embedding`,
				source: "default_provider",
			},
		});
		renderForm();
		const heading = await screen.findByRole("heading", {
			name: displayName,
		});
		const card = heading.closest("div.relative") as HTMLElement;
		expect(await within(card).findByText("Embeddings")).toBeInTheDocument();
		expect(screen.getByText("Document Search:")).toBeInTheDocument();
		expect(within(card).queryByRole("switch")).toBeNull();
		expect(
			within(card).getByRole("button", { name: /Use for Documents/ }),
		).toBeEnabled();
	},
);

it("does not offer the destructive embeddings-only action on an unflagged Anthropic default", async () => {
	mockGetStatus.mockResolvedValue({
		...status(true),
		configuredProviders: [
			{
				provider: "ANTHROPIC_DIRECT",
				displayName: "Anthropic",
				isDefault: true,
				isEmbeddingProvider: false,
				purpose: "ALL",
			},
		],
		organizationEmbedding: {
			...status(true).organizationEmbedding,
			provider: "ANTHROPIC_DIRECT",
			identity: "ANTHROPIC_DIRECT:example-embedding",
			source: "default_provider",
		},
	});
	renderForm();
	const heading = await screen.findByRole("heading", { name: "Anthropic" });
	const card = heading.closest("div.relative") as HTMLElement;
	expect(await within(card).findByText("Embeddings")).toBeInTheDocument();
	expect(within(card).queryByRole("switch")).toBeNull();
});

it("returns focus to Use for Documents after a Safari-style unfocused click and count check", async () => {
	let resolveImpact!: (value: unknown) => void;
	mockImpact.mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveImpact = resolve;
			}),
	);
	mockGetStatus.mockResolvedValue({
		...status(false),
		configuredProviders: status(false).configuredProviders.map((p) => ({
			...p,
			isEmbeddingProvider: false,
		})),
		organizationEmbedding: {
			...status(false).organizationEmbedding,
			provider: "ANTHROPIC_DIRECT",
			identity: "ANTHROPIC_DIRECT:example-embedding",
			source: "default_provider",
		},
	});
	renderForm();
	const card = (
		await screen.findByRole("heading", { name: "OpenAI" })
	).closest("div.relative") as HTMLElement;
	const trigger = await within(card).findByRole("button", {
		name: /Use for Documents/,
	});
	(document.activeElement as HTMLElement)?.blur();
	expect(document.body).toHaveFocus();
	fireEvent.click(trigger);
	await waitFor(() => expect(trigger).toBeDisabled());
	resolveImpact({
		companyContext: { indexedWithCurrentModel: 1, total: 1 },
		projectContent: { indexed: 0 },
	});
	const dialog = await screen.findByRole("alertdialog");
	fireEvent.click(
		within(dialog).getByRole("button", { name: "embeddingsChangeCancel" }),
	);
	await waitFor(() => expect(trigger).toHaveFocus());
});
