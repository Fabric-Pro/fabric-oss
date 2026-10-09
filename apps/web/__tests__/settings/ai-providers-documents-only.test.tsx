/**
 * A provider designated "Use for Documents" that is not the default serves
 * only document search (Fizzy #2770): chat, agents and generation go to the
 * default provider, or to a ChatGPT plan. The card says so instead of a bare
 * "Embeddings" badge.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetStatus, mockSetEmbedding } = vi.hoisted(() => ({
	mockGetStatus: vi.fn(),
	mockSetEmbedding: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
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

function renderForm() {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
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
