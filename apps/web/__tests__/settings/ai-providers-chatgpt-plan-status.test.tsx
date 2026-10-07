/**
 * The status banner of Account settings → AI Providers once the member's own
 * ChatGPT plan serves their work in this organization (Fizzy #2770): it
 * counts the plan first, and the API provider as the one for everything else;
 * with no API provider it says only the plan is set up instead of "No AI
 * Provider Configured".
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetStatus } = vi.hoisted(() => ({ mockGetStatus: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			resolution: { getStatus: mockGetStatus },
			providers: {
				testConnection: vi.fn(),
				testSavedConnection: vi.fn(),
				upsert: vi.fn(),
				setDefault: vi.fn(),
				setEmbedding: vi.fn(),
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

vi.mock("next-intl", () => ({
	useTranslations:
		(namespace: string) =>
		(key: string, values?: Record<string, string>) => {
			let node: unknown = en;
			for (const segment of `${namespace}.${key}`.split(".")) {
				node =
					typeof node === "object" && node !== null
						? Reflect.get(node, segment)
						: undefined;
			}
			return String(node).replace(
				/\{(\w+)\}/g,
				(_match, name: string) => values?.[name] ?? name,
			);
		},
}));

import { AiProvidersSettingsForm } from "../../modules/saas/settings/components/AiProvidersSettingsForm";

const copy = en.settings.chatgptPlan.providerStatus;

function renderForm(chatgptPlan: { organizationName: string } | null) {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<AiProvidersSettingsForm chatgptPlan={chatgptPlan} />
		</QueryClientProvider>,
	);
}

const CONFIGURED = {
	isConfigured: true,
	message: "Using Anthropic as AI provider",
	configuredProviders: [
		{
			provider: "ANTHROPIC_DIRECT",
			displayName: "Anthropic",
			isDefault: true,
			isEmbeddingProvider: false,
		},
	],
	embeddingProvider: null,
	embeddingModel: null,
};

const UNCONFIGURED = {
	isConfigured: false,
	message: "",
	configuredProviders: [],
	embeddingProvider: null,
	embeddingModel: null,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("AI Providers status banner with a ChatGPT plan", () => {
	it("names the plan first and the API provider as the one for everything else", async () => {
		mockGetStatus.mockResolvedValue(CONFIGURED);
		renderForm({ organizationName: "Example Org" });
		const note = await screen.findByTestId("chatgpt-plan-provider-note");
		expect(note).toHaveTextContent(copy.chip);
		expect(note).toHaveTextContent(
			"Your own AI work in Example Org runs on your ChatGPT plan.",
		);
		expect(note).toHaveTextContent(copy.everythingElse);
		expect(screen.getByText("AI Providers Configured")).toBeInTheDocument();
		expect(
			screen.getByText("Using Anthropic as AI provider"),
		).toBeInTheDocument();
	});

	it("says only the plan is set up instead of no provider at all", async () => {
		mockGetStatus.mockResolvedValue(UNCONFIGURED);
		renderForm({ organizationName: "Example Org" });
		const notice = await screen.findByTestId("chatgpt-plan-only-notice");
		expect(notice).toHaveTextContent(copy.onlyTitle);
		expect(notice).toHaveTextContent(
			"Background jobs and document search need an AI provider",
		);
		expect(screen.queryByText("No AI Provider Configured")).toBeNull();
	});

	it("keeps both banners as they were without a plan", async () => {
		mockGetStatus.mockResolvedValue(UNCONFIGURED);
		renderForm(null);
		expect(
			await screen.findByText("No AI Provider Configured"),
		).toBeInTheDocument();
		expect(screen.queryByTestId("chatgpt-plan-only-notice")).toBeNull();
	});
});
