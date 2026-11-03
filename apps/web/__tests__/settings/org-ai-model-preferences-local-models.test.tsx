import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListAvailable, mockGetTaskDefaults, mockGetOrg, mockGetStatus } =
	vi.hoisted(() => ({
		mockListAvailable: vi.fn(),
		mockGetTaskDefaults: vi.fn(),
		mockGetOrg: vi.fn(),
		mockGetStatus: vi.fn(),
	}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			models: { listAvailable: mockListAvailable },
			preferences: {
				getTaskDefaults: mockGetTaskDefaults,
				getOrg: mockGetOrg,
				setOrg: vi.fn(),
				deleteOrg: vi.fn(),
			},
			resolution: { getStatus: mockGetStatus },
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationSlug: "example-org",
		isOrgContext: true,
	}),
}));

vi.mock("@saas/shared/components/SettingsItem", () => ({
	SettingsItem: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
}));

vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OrgAiModelPreferencesForm } from "../../modules/saas/settings/components/OrgAiModelPreferencesForm";

// An Anthropic-only organization: no model serves EMBEDDING.
const anthropicOnly = {
	configuredProviders: [
		{
			id: "anthropic-config",
			provider: "ANTHROPIC_DIRECT",
			displayName: "Anthropic",
			isDefault: true,
			priority: 10,
			enabledProviders: [],
			source: "org_config",
		},
	],
	defaultProvider: "ANTHROPIC_DIRECT",
	providerIds: ["ANTHROPIC_DIRECT"],
	models: [],
	modelsByProvider: {},
	modelsByGatewayAndProvider: {},
};

// A row with nothing to choose says so and links to the providers.
const NO_MODELS = /No models available|noModelsAvailable/;

function renderForm() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<OrgAiModelPreferencesForm />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	mockListAvailable.mockResolvedValue(anthropicOnly);
	mockGetTaskDefaults.mockResolvedValue([]);
	mockGetOrg.mockResolvedValue([]);
});

describe("organization AI model preferences — local models", () => {
	it("shows each locally served task's model on its row, and only those", async () => {
		mockGetStatus.mockResolvedValue({
			localModels: {
				embedding: { model: "qwen3-embedding:4b", provider: "Ollama" },
				decision: null,
				image: { model: "flux.2-klein-4b", provider: "LocalAI" },
			},
		});

		renderForm();

		const embedding = await screen.findByTestId("local-model-EMBEDDING");
		expect(embedding).toHaveTextContent("qwen3-embedding:4b");
		expect(embedding).toHaveTextContent("via local Ollama (dev)");
		const image = screen.getByTestId("local-model-IMAGE");
		expect(image).toHaveTextContent("flux.2-klein-4b");
		expect(image).toHaveTextContent("via local LocalAI (dev)");
		expect(
			screen.queryByTestId("local-model-DECISION"),
		).not.toBeInTheDocument();
		expect(
			within(screen.getByTestId("ai-models-embeddings")).queryByText(
				NO_MODELS,
			),
		).not.toBeInTheDocument();
		expect(
			within(screen.getByTestId("ai-models-row-IMAGE")).queryByText(
				NO_MODELS,
			),
		).not.toBeInTheDocument();
	});

	it("keeps the provider hints when no local model is on", async () => {
		mockGetStatus.mockResolvedValue({
			localModels: { embedding: null, decision: null, image: null },
		});

		renderForm();

		const embedding = await screen.findByTestId("ai-models-embeddings");
		expect(
			within(embedding).getAllByText(NO_MODELS).length,
		).toBeGreaterThan(0);
		expect(
			within(screen.getByTestId("ai-models-row-IMAGE")).getAllByText(
				NO_MODELS,
			).length,
		).toBeGreaterThan(0);
		expect(
			screen.queryByTestId("local-model-EMBEDDING"),
		).not.toBeInTheDocument();
	});
});
