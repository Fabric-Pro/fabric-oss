/**
 * The ChatGPT plan tab writes its per-task models into the same preferences
 * table, and the catalog seeds task defaults for OPENAI_CHATGPT_PLAN
 * (Fizzy #2770 F4/F5). The API form must never present either as the task's
 * API model.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { mockListAvailable, mockGetTaskDefaults, mockGetOrg, mockSetOrg } =
	vi.hoisted(() => ({
		mockListAvailable: vi.fn(),
		mockGetTaskDefaults: vi.fn(),
		mockGetOrg: vi.fn(),
		mockSetOrg: vi.fn(),
	}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			models: { listAvailable: mockListAvailable },
			preferences: {
				getTaskDefaults: mockGetTaskDefaults,
				getOrg: mockGetOrg,
				setOrg: mockSetOrg,
				deleteOrg: vi.fn(),
			},
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

const generalModelsResponse = {
	configuredProviders: [
		{
			id: "openai-config",
			provider: "OPENAI_DIRECT",
			displayName: "OpenAI",
			isDefault: true,
			priority: 10,
			enabledProviders: [],
			source: "org_config",
		},
		{
			id: "vercel-config",
			provider: "VERCEL_GATEWAY",
			displayName: "Vercel AI Gateway",
			isDefault: false,
			priority: 5,
			enabledProviders: [],
			source: "org_config",
		},
	],
	defaultProvider: "OPENAI_DIRECT",
	providerIds: ["OPENAI_DIRECT"],
	models: [
		{
			id: "text-model",
			canonicalName: "text-model",
			displayName: "Text Model",
			description: null,
			family: "text",
			vendor: "Example AI",
			contextWindow: 128000,
			speedTier: "BALANCED",
			qualityTier: "STANDARD",
			suitableForTasks: ["EVAL"],
			providerMappings: [],
		},
	],
	modelsByProvider: {},
	modelsByGatewayAndProvider: {
		OPENAI_DIRECT: {
			gatewayDisplayName: "OpenAI",
			isDefault: true,
			providers: {
				OPENAI_DIRECT: {
					providerDisplayName: "OpenAI",
					models: [
						{
							id: "text-model",
							canonicalName: "text-model",
							displayName: "Text Model",
							providerModelId: "example/text-model",
							speedTier: "BALANCED",
							qualityTier: "STANDARD",
							capabilities: ["TEXT", "REASONING"],
						},
					],
				},
			},
		},
	},
};

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

describe("organization AI model preferences and the ChatGPT plan", () => {
	it("never renders a plan preference or plan default as the API choice", async () => {
		mockListAvailable.mockResolvedValue(generalModelsResponse);
		mockGetTaskDefaults.mockResolvedValue([
			{
				taskType: "CHAT",
				complexity: "MEDIUM",
				priority: 1,
				provider: "OPENAI_CHATGPT_PLAN",
				model: {
					id: "plan-default",
					canonicalName: "plan-default",
					displayName: "Plan Default Model",
					family: "gpt",
					vendor: "OpenAI",
					contextWindow: 128000,
					speedTier: "BALANCED",
					qualityTier: "STANDARD",
				},
			},
		]);
		mockGetOrg.mockResolvedValue([
			{
				id: "pref-plan",
				provider: "OPENAI_CHATGPT_PLAN",
				taskType: "SIMPLE",
				customParameters: null,
				model: {
					id: "plan-pref",
					canonicalName: "plan-pref",
					displayName: "Plan Preference Model",
					family: "gpt",
					vendor: "OpenAI",
					contextWindow: 128000,
					speedTier: "BALANCED",
					qualityTier: "STANDARD",
				},
			},
		]);

		renderForm();

		expect(await screen.findByText("Evaluations")).toBeInTheDocument();
		expect(screen.queryByText(/Plan Default Model/)).toBeNull();
		expect(screen.queryByText(/Plan Preference Model/)).toBeNull();
		expect(screen.queryByText(/OPENAI_CHATGPT_PLAN/)).toBeNull();
	});
});
