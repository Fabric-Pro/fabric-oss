import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
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

const decisionModelsResponse = {
	...generalModelsResponse,
	providerIds: ["VERCEL_GATEWAY"],
	models: [
		{
			id: "jev-model",
			canonicalName: "typesafe-ai-jev",
			displayName: "TypeSafe AI Jev",
			description: null,
			family: "jev",
			vendor: "TypeSafe AI",
			contextWindow: 0,
			speedTier: "BALANCED",
			qualityTier: "STANDARD",
			suitableForTasks: ["DECISION"],
			providerMappings: [
				{
					provider: "VERCEL_GATEWAY",
					providerModelId: "typesafe-ai/jev",
					isAvailable: true,
				},
			],
		},
	],
	modelsByGatewayAndProvider: {
		VERCEL_GATEWAY: {
			gatewayDisplayName: "Vercel AI Gateway",
			isDefault: false,
			providers: {
				"TypeSafe AI": {
					providerDisplayName: "TypeSafe AI",
					models: [
						{
							id: "jev-model",
							canonicalName: "typesafe-ai-jev",
							displayName: "TypeSafe AI Jev",
							providerModelId: "typesafe-ai/jev",
							speedTier: "BALANCED",
							qualityTier: "STANDARD",
							capabilities: ["EVALUATION"],
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

describe("organization AI model preferences decisions", () => {
	it("renders Decisions separately from EVAL and selects Jev only from the DECISION query", async () => {
		mockListAvailable.mockImplementation(
			({ taskType }: { taskType?: string }) =>
				Promise.resolve(
					taskType === "DECISION"
						? decisionModelsResponse
						: generalModelsResponse,
				),
		);
		mockGetTaskDefaults.mockResolvedValue([]);
		mockGetOrg.mockResolvedValue([]);

		renderForm();

		const decisionsHeading = await screen.findByText("Decisions");
		expect(screen.getByText("Evaluations")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Bug or feature classification, with the regular AI model as fallback",
			),
		).toBeInTheDocument();

		expect(mockListAvailable).toHaveBeenCalledWith({
			organizationId: "org-1",
		});
		expect(mockListAvailable).toHaveBeenCalledWith({
			organizationId: "org-1",
			taskType: "DECISION",
		});

		const decisionCard = decisionsHeading.closest("div.p-4");
		if (!decisionCard) {
			throw new Error("Decisions card was not rendered");
		}

		fireEvent.click(within(decisionCard).getByRole("combobox"));
		expect(await screen.findByText("typesafe-ai/jev")).toBeInTheDocument();
		fireEvent.click(screen.getByText("TypeSafe AI Jev"));

		expect(
			await within(decisionCard).findByText("Unsaved"),
		).toBeInTheDocument();
	});
});

describe("switching decisions off", () => {
	function withDecisionModels() {
		mockListAvailable.mockImplementation(
			({ taskType }: { taskType?: string }) =>
				Promise.resolve(
					taskType === "DECISION"
						? decisionModelsResponse
						: generalModelsResponse,
				),
		);
		mockGetTaskDefaults.mockResolvedValue([]);
	}

	async function findDecisionCard() {
		const heading = await screen.findByText("Decisions");
		const card = heading.closest("div.p-4");
		if (!card) {
			throw new Error("Decisions card was not rendered");
		}
		return card as HTMLElement;
	}

	it("offers Disabled alongside the decision models", async () => {
		withDecisionModels();
		mockGetOrg.mockResolvedValue([]);

		renderForm();
		const decisionCard = await findDecisionCard();

		fireEvent.click(within(decisionCard).getByRole("combobox"));

		expect(await screen.findByText("TypeSafe AI Jev")).toBeInTheDocument();
		expect(screen.getByText("Off")).toBeInTheDocument();
		expect(screen.getByText("Disabled")).toBeInTheDocument();
		expect(
			screen.getByText("Use the regular AI model instead"),
		).toBeInTheDocument();
	});

	it("does not offer Disabled for a task that has no off state", async () => {
		withDecisionModels();
		mockGetOrg.mockResolvedValue([]);

		renderForm();
		const heading = await screen.findByText("Evaluations");
		const card = heading.closest("div.p-4");
		if (!card) {
			throw new Error("Evaluations card was not rendered");
		}

		fireEvent.click(within(card as HTMLElement).getByRole("combobox"));

		expect(await screen.findByText("Text Model")).toBeInTheDocument();
		expect(screen.queryByText("Disabled")).not.toBeInTheDocument();
	});

	it("saves the off switch as a null model rather than a sentinel string", async () => {
		withDecisionModels();
		mockGetOrg.mockResolvedValue([]);
		mockSetOrg.mockResolvedValue({
			id: "preference-off",
			provider: "VERCEL_GATEWAY",
			taskType: "DECISION",
			model: null,
		});

		renderForm();
		const decisionCard = await findDecisionCard();

		fireEvent.click(within(decisionCard).getByRole("combobox"));
		fireEvent.click(await screen.findByText("Disabled"));

		expect(
			await within(decisionCard).findByText("Unsaved"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByText("Save Changes"));

		await waitFor(() => {
			expect(mockSetOrg).toHaveBeenCalledWith({
				organizationId: "org-1",
				taskType: "DECISION",
				// The UI sentinel must never leave the browser as a model id.
				modelCanonicalName: null,
				overrideProvider: "VERCEL_GATEWAY",
			});
		});
	});

	it("renders a saved off switch as Disabled, with Reset back to the default", async () => {
		withDecisionModels();
		mockGetOrg.mockResolvedValue([
			{
				id: "preference-off",
				provider: "VERCEL_GATEWAY",
				taskType: "DECISION",
				customParameters: null,
				// A stored preference with no model. Reading it as "no
				// preference" would wrongly show the seeded Jev default.
				model: null,
			},
		]);

		renderForm();
		const decisionCard = await findDecisionCard();

		expect(
			await within(decisionCard).findByText("Disabled"),
		).toBeInTheDocument();
		expect(
			within(decisionCard).queryByText("TypeSafe AI Jev"),
		).not.toBeInTheDocument();
		expect(within(decisionCard).getByText("Reset")).toBeInTheDocument();
		expect(
			within(decisionCard).getByText(/Decisions are switched off/),
		).toHaveTextContent(
			"Decisions are switched off. Work items and action-item routing use your regular AI model.",
		);
	});
});

describe("decisions without Vercel", () => {
	it("disables the decision selector and explains the regular classifier fallback", async () => {
		const withoutVercel = {
			...generalModelsResponse,
			configuredProviders:
				generalModelsResponse.configuredProviders.filter(
					(provider) => provider.provider !== "VERCEL_GATEWAY",
				),
		};
		mockListAvailable.mockImplementation(
			({ taskType }: { taskType?: string }) =>
				Promise.resolve(
					taskType === "DECISION"
						? {
								...withoutVercel,
								models: [],
								modelsByGatewayAndProvider: {},
							}
						: withoutVercel,
				),
		);
		mockGetTaskDefaults.mockResolvedValue([]);
		mockGetOrg.mockResolvedValue([]);
		renderForm();
		const heading = await screen.findByText("Decisions");
		const card = heading.closest("div.p-4");
		if (!card) {
			throw new Error("Decisions card missing");
		}
		expect(within(card).getByRole("combobox")).toBeDisabled();
		expect(
			within(card).queryByText("TypeSafe AI Jev"),
		).not.toBeInTheDocument();
		// Nothing to switch off when there was never anything to switch on.
		expect(within(card).queryByText("Disabled")).not.toBeInTheDocument();
		expect(
			within(card).getByText(/Jev requires Vercel AI Gateway/),
		).toHaveTextContent(
			"Jev requires Vercel AI Gateway. Work items use your regular AI model when no decision model is available.",
		);
	});
});
