/**
 * Organization settings → AI Models (Fizzy #2770 F6). With CHATGPT_PLAN on, an
 * admin gets one page: how AI work runs (the three sources in order, with the
 * spend policy and the fallback model), then each kind of work's model on a
 * plan and on API billing, then embeddings. Without the flag — and for
 * members — the page is exactly the legacy form.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real translator: the page uses ICU plurals.
vi.mock("next-intl", async () => vi.importActual("next-intl"));

const api = vi.hoisted(() => ({
	status: vi.fn(),
	planModels: vi.fn(),
	setPlanModel: vi.fn(),
	setFallback: vi.fn(),
	pool: vi.fn(),
	updatePolicy: vi.fn(),
	acknowledgeTerms: vi.fn(),
	listAvailable: vi.fn(),
	taskDefaults: vi.fn(),
	orgPreferences: vi.fn(),
	setOrg: vi.fn(),
	deleteOrg: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			resolution: { getStatus: api.status },
			models: { listAvailable: api.listAvailable },
			preferences: {
				getTaskDefaults: api.taskDefaults,
				getOrg: api.orgPreferences,
				setOrg: api.setOrg,
				deleteOrg: api.deleteOrg,
			},
		},
		organizations: {
			chatgptPlanModels: {
				get: api.planModels,
				set: api.setPlanModel,
				setFallback: api.setFallback,
			},
			chatgptPlanPool: {
				get: api.pool,
				updatePolicy: api.updatePolicy,
				acknowledgeTerms: api.acknowledgeTerms,
				updateAccount: vi.fn(),
				disconnectAccount: vi.fn(),
			},
		},
	},
}));

const flags = vi.hoisted(() => ({
	current: {} as Record<string, boolean>,
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => flags.current[key] === true,
}));
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { slug: "example-org" },
		isSessionOnActiveOrganization: true,
	}),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationSlug: "example-org",
		isOrgContext: true,
	}),
}));
vi.mock("@saas/shared/components/SettingsItem", () => ({
	SettingsItem: ({
		title,
		children,
	}: {
		title: string;
		children: React.ReactNode;
	}) => (
		<section>
			<h2>{title}</h2>
			{children}
		</section>
	),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OrgAiModelsSettings } from "../OrgAiModelsSettings";

const copy = en.settings.aiModelsRouting;

const plan = (model: string, displayName: string, newest = false) => ({
	canonicalName: model,
	slug: model,
	displayName,
	description: `${displayName} description`,
	autoDetected: false,
	newest,
});

const PLAN_MODELS = {
	tasks: [
		{
			taskType: "COMPLEX",
			model: {
				canonicalName: "gpt-5.6-sol",
				displayName: "GPT-5.6 Sol (ChatGPT plan)",
			},
			source: "default",
			noLongerServed: false,
		},
		{
			taskType: "TOOL_CALLING",
			model: {
				canonicalName: "gpt-5.6-terra",
				displayName: "GPT-5.6 Terra (ChatGPT plan)",
			},
			source: "organization",
			noLongerServed: true,
		},
	],
	models: [
		plan("gpt-6-astra", "GPT-6 Astra (ChatGPT plan)", true),
		plan("gpt-5.6-sol", "GPT-5.6 Sol (ChatGPT plan)"),
	],
	fallbackModel: "gpt-6-astra" as string | null,
	recommendedFallbackModel: "gpt-6-astra",
	servedCheckedAt: new Date("2026-10-08T06:00:00Z"),
	ownPlanMembers: 1,
	canEdit: true,
};

const POOL = {
	policy: {
		apiFallbackInteractive: "ASK",
		apiFallbackBackground: "NEVER",
		headroomPct: 40,
		termsAcknowledged: true,
		termsAcknowledgedAt: new Date("2026-10-02T00:00:00Z"),
	},
	accounts: [
		{
			id: "acc-1",
			label: "Shared plan 1",
			enabled: true,
			status: "ACTIVE",
			usageEstimate: { estimatedPercent: 34 },
		},
	],
	viewer: { isOwner: false },
};

const OPENAI = {
	provider: "OPENAI_DIRECT",
	displayName: "OpenAI",
	isDefault: true,
	isEmbeddingProvider: true,
	purpose: "ALL",
	source: "org_config",
};

function statusWith(providers: unknown[]) {
	return {
		configuredProviders: providers,
		embeddingProvider: null,
		embeddingModel: null,
	};
}

function available(providers: unknown[]) {
	return {
		configuredProviders: providers.length
			? [
					{
						id: "cpc-1",
						provider: "OPENAI_DIRECT",
						displayName: "OpenAI",
						isDefault: true,
						priority: 1,
						enabledProviders: [],
						purpose: "ALL",
						source: "org_config",
					},
				]
			: [],
		defaultProvider: providers.length ? "OPENAI_DIRECT" : null,
		providerIds: [],
		models: [],
		modelsByProvider: {},
		modelsByGatewayAndProvider: {},
	};
}

function renderPage({
	canManagePlanModels = true,
}: {
	canManagePlanModels?: boolean;
} = {}) {
	return render(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			<QueryClientProvider
				client={
					new QueryClient({
						defaultOptions: { queries: { retry: false } },
					})
				}
			>
				<OrgAiModelsSettings
					canManagePlanModels={canManagePlanModels}
					readOnly={false}
				/>
			</QueryClientProvider>
		</NextIntlClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	flags.current = { CHATGPT_PLAN: true };
	api.status.mockResolvedValue(statusWith([OPENAI]));
	api.planModels.mockResolvedValue(PLAN_MODELS);
	api.setFallback.mockResolvedValue(PLAN_MODELS);
	api.pool.mockResolvedValue(POOL);
	api.updatePolicy.mockResolvedValue({});
	api.listAvailable.mockResolvedValue(available([OPENAI]));
	api.taskDefaults.mockResolvedValue([]);
	api.orgPreferences.mockResolvedValue([]);
});

describe("the gate", () => {
	it("renders exactly the legacy form with CHATGPT_PLAN off", async () => {
		flags.current = {};
		renderPage();
		expect(
			await screen.findByText("Organization AI Model Preferences"),
		).toBeInTheDocument();
		expect(screen.queryByTestId("ai-routing-card")).toBeNull();
		expect(api.planModels).not.toHaveBeenCalled();
	});

	it("renders the legacy form to a member", async () => {
		renderPage({ canManagePlanModels: false });
		expect(
			await screen.findByText("Organization AI Model Preferences"),
		).toBeInTheDocument();
		expect(screen.queryByTestId("ai-routing-card")).toBeNull();
	});
});

describe("plan and API provider", () => {
	it("shows the three sources in order with their live status", async () => {
		renderPage();
		const own = await screen.findByTestId("ai-routing-step-own");
		expect(own).toHaveTextContent("1 member connected");
		expect(screen.getByTestId("ai-routing-step-shared")).toHaveTextContent(
			"1 active · 34% of window used",
		);
		const apiStep = screen.getByTestId("ai-routing-step-api");
		expect(apiStep).toHaveTextContent("OpenAI");
		expect(
			within(apiStep).getByRole("link", {
				name: copy.routing.manageProviders,
			}),
		).toHaveAttribute("href", "/app/example-org/settings/ai-providers");
		expect(
			screen.getByRole("link", { name: copy.routing.manageShared }),
		).toHaveAttribute(
			"href",
			"/app/example-org/settings/ai-providers#shared-chatgpt-plans",
		);
	});

	it("sets what background work does when every plan is spent", async () => {
		renderPage();
		const spent = await screen.findByTestId("ai-routing-spent");
		expect(spent).toHaveTextContent(
			`${copy.routing.spentHelpBackgroundWait} ${copy.routing.spentHelpPeopleStopWait}`,
		);
		expect(copy.routing.backgroundLabel).toBe("Background work");
		expect(within(spent).getAllByRole("radio")).toHaveLength(4);
		const background = within(spent).getByRole("radiogroup", {
			name: copy.routing.backgroundLabel,
		});
		fireEvent.click(
			within(background).getByRole("radio", {
				name: copy.routing.backgroundApi,
			}),
		);
		await waitFor(() =>
			expect(api.updatePolicy).toHaveBeenCalledWith({
				apiFallbackBackground: "AUTO",
			}),
		);
		expect(
			screen.queryByTestId("ai-routing-api-disabled-reason"),
		).toBeNull();
	});

	// Fizzy #3048: what people's own work does once every plan is spent.
	it("sets what people's own work does when every plan is spent, Stop by default", async () => {
		renderPage();
		const spent = await screen.findByTestId("ai-routing-spent");
		const people = within(spent).getByRole("radiogroup", {
			name: "People's own work",
		});
		expect(
			within(people).getByRole("radio", {
				name: "Stop and show the reset time",
			}),
		).toHaveAttribute("aria-checked", "true");
		fireEvent.click(
			within(people).getByRole("radio", { name: "Use API billing" }),
		);
		await waitFor(() =>
			expect(api.updatePolicy).toHaveBeenCalledWith({
				apiFallbackInteractive: "AUTO",
			}),
		);
	});

	it.each([
		[
			"NEVER",
			"ASK",
			"Background work pauses and continues when the plan resets. People see when it resets.",
		],
		[
			"AUTO",
			"ASK",
			"Background work continues on your API provider, billed to the organization. People see when the plan resets.",
		],
		[
			"NEVER",
			"AUTO",
			"Background work pauses and continues when the plan resets. People's work continues on your API provider too, and they see a note that it was billed to the organization.",
		],
		[
			"AUTO",
			"AUTO",
			"Background work continues on your API provider, billed to the organization. People's work continues on your API provider too, and they see a note that it was billed to the organization.",
		],
	])(
		"composes the help from background %s and people %s",
		async (apiFallbackBackground, apiFallbackInteractive, help) => {
			api.pool.mockResolvedValue({
				...POOL,
				policy: {
					...POOL.policy,
					apiFallbackBackground,
					apiFallbackInteractive,
				},
			});
			renderPage();
			const spent = await screen.findByTestId("ai-routing-spent");
			await waitFor(() => expect(spent).toHaveTextContent(help));
		},
	);

	it("warns that all AI work can be billed, naming people's work only when it moves too", async () => {
		api.pool.mockResolvedValue({
			...POOL,
			policy: { ...POOL.policy, apiFallbackBackground: "AUTO" },
		});
		const { unmount } = renderPage();
		const warning = await screen.findByTestId("ai-routing-auto-warning");
		expect(warning).toHaveTextContent(
			"All AI work can be billed to the organization",
		);
		expect(warning).toHaveTextContent(
			"background work (such as security scans, publishing suggestions, scheduled reports and the first import of meeting and channel history)",
		);
		expect(warning).not.toHaveTextContent("People's own work moves");
		unmount();

		api.pool.mockResolvedValue({
			...POOL,
			policy: { ...POOL.policy, apiFallbackInteractive: "AUTO" },
		});
		renderPage();
		expect(
			await screen.findByTestId("ai-routing-auto-warning"),
		).toHaveTextContent(
			"People's own work moves to it too, and they see a note under each reply.",
		);
	});

	it("shows no warning while both stop", async () => {
		renderPage();
		await screen.findByTestId("ai-routing-spent");
		expect(screen.queryByTestId("ai-routing-auto-warning")).toBeNull();
	});

	it("keeps what is left for people under Advanced, and saves a new share", async () => {
		renderPage();
		const advanced = await screen.findByTestId("ai-routing-advanced");
		expect(
			screen.queryByRole("combobox", {
				name: copy.routing.headroomLabel,
			}),
		).toBeNull();
		fireEvent.click(
			within(advanced).getByRole("button", {
				name: en.settings.chatgptPlanPool.advanced,
			}),
		);
		expect(advanced).toHaveTextContent(copy.routing.headroomHelp);
		const headroom = await screen.findByRole("combobox", {
			name: copy.routing.headroomLabel,
		});
		expect(headroom).toHaveTextContent("40%");
		fireEvent.click(headroom);
		fireEvent.click(await screen.findByRole("option", { name: "60%" }));
		await waitFor(() =>
			expect(api.updatePolicy).toHaveBeenCalledWith({ headroomPct: 60 }),
		);
	});

	it("lists each kind of work with both columns, marking API-only work", async () => {
		renderPage();
		const image = await screen.findByTestId("ai-models-row-IMAGE");
		expect(image).toHaveTextContent(copy.models.notOnPlan);
		const decision = screen.getByTestId("ai-models-row-DECISION");
		expect(decision).not.toHaveTextContent(copy.models.notOnPlan);
		expect(decision).toHaveTextContent(copy.models.decisionOnPlan);
		expect(
			within(decision).getByRole("combobox", {
				name: "Decisions on API billing",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("ai-models-plan-not-served-TOOL_CALLING"),
		).toHaveTextContent(copy.models.noLongerServed);
		expect(
			screen.getByRole("combobox", {
				name: "Complex work on a ChatGPT plan",
			}),
		).toHaveTextContent("Default · GPT-5.6 Sol (ChatGPT plan)");
		expect(
			screen.getByRole("combobox", {
				name: "Complex work on API billing",
			}),
		).toBeInTheDocument();
	});

	it("shows only the chosen plan model's name in the select, not its description", async () => {
		api.planModels.mockResolvedValue({
			...PLAN_MODELS,
			tasks: [
				{
					taskType: "COMPLEX",
					model: {
						canonicalName: "gpt-6-astra",
						displayName: "GPT-6 Astra (ChatGPT plan)",
					},
					source: "organization",
					noLongerServed: false,
				},
			],
		});
		renderPage();
		const select = await screen.findByRole("combobox", {
			name: "Complex work on a ChatGPT plan",
		});
		await waitFor(() =>
			expect(select).toHaveTextContent("GPT-6 Astra (ChatGPT plan)"),
		);
		expect(select).not.toHaveTextContent(
			"GPT-6 Astra (ChatGPT plan) description",
		);
		expect(select).not.toHaveTextContent(copy.models.newest);
	});

	// Each row says what uses it: Advisor and ⌘J run tool calling, not chat.
	it("names the features behind tool calling and chat", async () => {
		renderPage();
		expect(
			await screen.findByTestId("ai-models-row-TOOL_CALLING"),
		).toHaveTextContent("Advisor, ⌘J chat, agents, MCP tools");
		expect(screen.getByTestId("ai-models-row-CHAT")).toHaveTextContent(
			"Workspace document chat, Atlas assistant, Agent Builder Sidekick",
		);
	});

	it("saves a plan model chosen in the table", async () => {
		api.setPlanModel.mockResolvedValue(PLAN_MODELS);
		renderPage();
		fireEvent.click(
			await screen.findByRole("combobox", {
				name: "Complex work on a ChatGPT plan",
			}),
		);
		fireEvent.click(
			await screen.findByRole("option", {
				name: /GPT-6 Astra \(ChatGPT plan\)/,
			}),
		);
		await waitFor(() =>
			expect(api.setPlanModel).toHaveBeenCalledWith({
				taskType: "COMPLEX",
				modelCanonicalName: "gpt-6-astra",
			}),
		);
	});

	// The plan column has a "Default" item; the API column has one too, which
	// clears the organization's choice for the task.
	it("clears an API choice with the Default item", async () => {
		const model = {
			id: "m-1",
			canonicalName: "gpt-5",
			displayName: "GPT-5",
			providerModelId: "gpt-5",
			speedTier: "STANDARD",
			qualityTier: "PREMIUM",
			capabilities: ["TEXT"],
		};
		api.listAvailable.mockResolvedValue({
			...available([OPENAI]),
			models: [model],
			modelsByGatewayAndProvider: {
				OPENAI_DIRECT: {
					gatewayDisplayName: "OpenAI",
					isDefault: true,
					providers: {
						OPENAI_DIRECT: {
							providerDisplayName: "OpenAI",
							models: [model],
						},
					},
				},
			},
		});
		api.orgPreferences.mockResolvedValue([
			{
				taskType: "COMPLEX",
				modelCanonicalName: "gpt-5",
				overrideProvider: "OPENAI_DIRECT",
			},
		]);
		api.deleteOrg.mockResolvedValue({ success: true });
		renderPage();
		const trigger = await screen.findByRole("combobox", {
			name: "Complex work on API billing",
		});
		// The choice and the models load separately; wait for both.
		const row = screen.getByTestId("ai-models-row-COMPLEX");
		await within(row).findByText(copy.models.enforced);
		await waitFor(() => expect(trigger).not.toBeDisabled());
		fireEvent.click(trigger);
		fireEvent.click(
			await screen.findByRole("option", {
				name: copy.models.defaultPlain,
			}),
		);
		await waitFor(() =>
			expect(api.deleteOrg).toHaveBeenCalledWith({
				organizationId: "org-1",
				taskType: "COMPLEX",
			}),
		);
	});

	it("shows the embeddings row with its model select", async () => {
		renderPage();
		const row = await screen.findByTestId("ai-models-embeddings");
		expect(row).toHaveTextContent(copy.models.embeddingsWhy);
		expect(
			within(row).getByRole("combobox", {
				name: "Embeddings on API billing",
			}),
		).toBeInTheDocument();
		expect(screen.queryByTestId("ai-models-embeddings-off")).toBeNull();
	});
});

describe("plan only (no API provider)", () => {
	beforeEach(() => {
		api.status.mockResolvedValue(statusWith([]));
		api.listAvailable.mockResolvedValue(available([]));
	});

	it("warns that requests no plan serves fail, and links to add a provider", async () => {
		renderPage();
		const apiStep = await screen.findByTestId("ai-routing-step-api");
		expect(apiStep).toHaveTextContent(copy.routing.apiNone);
		// An embeddings-only key is still a provider: the copy says LLM work.
		expect(copy.routing.apiNone).toBe("No API provider for LLM work");
		expect(apiStep).toHaveTextContent(copy.routing.apiBodyNone);
		expect(
			within(apiStep).getByRole("link", {
				name: copy.routing.addProvider,
			}),
		).toBeInTheDocument();
	});

	it("offers no API billing as a spent-plan fallback, and says why", async () => {
		renderPage();
		const spent = await screen.findByTestId("ai-routing-spent");
		expect(spent).toHaveTextContent(copy.routing.spentHelpNoApi);
		for (const radio of within(spent).getAllByRole("radio", {
			name: "Use API billing",
		})) {
			expect(radio).toBeDisabled();
		}
		expect(
			screen.getByTestId("ai-routing-api-disabled-reason"),
		).toHaveTextContent("Needs an API provider. Add one in AI Providers.");
	});

	// No control that looks clickable where no choice can exist.
	it("says there is no API provider for LLM work instead of a disabled select", async () => {
		renderPage();
		expect(
			await screen.findByTestId("ai-models-api-none-COMPLEX"),
		).toHaveTextContent("No API provider for LLM work");
		expect(
			screen.queryByRole("combobox", {
				name: "Complex work on API billing",
			}),
		).toBeNull();
		expect(screen.queryByText("No AI Providers Configured")).toBeNull();
	});

	it("merges both columns for work that needs an API provider and never runs on a plan", async () => {
		renderPage();
		for (const taskType of ["IMAGE", "AUDIO"]) {
			const cell = await screen.findByTestId(
				`ai-models-unavailable-${taskType}`,
			);
			expect(cell).toHaveTextContent(copy.models.needsApiProvider);
			expect(cell).toHaveAttribute("colspan", "2");
		}
		// A row the plan runs keeps its plan select.
		expect(
			screen.getByRole("combobox", {
				name: "Complex work on a ChatGPT plan",
			}),
		).toBeInTheDocument();
	});

	// Decisions defer to the plan whenever one can serve the call; the API
	// decision model is only the fallback (Fizzy #2770).
	it("says decisions run on the plan, not that they need an API provider", async () => {
		renderPage();
		const row = await screen.findByTestId("ai-models-row-DECISION");
		expect(
			screen.queryByTestId("ai-models-unavailable-DECISION"),
		).toBeNull();
		expect(row).not.toHaveTextContent(copy.models.needsApiProvider);
		expect(
			within(row).getByTestId("ai-models-plan-decision-DECISION"),
		).toHaveTextContent(copy.models.decisionOnPlan);
		expect(row).toHaveTextContent(copy.models.decisionOnPlanHint);
		expect(
			within(row).getByTestId("ai-models-api-none-DECISION"),
		).toHaveTextContent(copy.models.noApiProvider);
	});

	it("says document search is off and links to add an embeddings key", async () => {
		renderPage();
		const off = await screen.findByTestId("ai-models-embeddings-off");
		expect(off).toHaveTextContent(copy.models.embeddingsOffTitle);
		expect(
			within(off).getByRole("link", {
				name: copy.models.addEmbeddingsKey,
			}),
		).toHaveAttribute("href", "/app/example-org/settings/ai-providers");
	});
});

// The QA organization's state: a plan, and one Vercel AI Gateway key saved
// for embeddings only — no provider for LLM work.
describe("plan and an embeddings-only gateway key", () => {
	const GATEWAY = {
		provider: "VERCEL_GATEWAY",
		displayName: "Vercel AI Gateway",
		isDefault: false,
		isEmbeddingProvider: true,
		purpose: "EMBEDDINGS_ONLY",
		source: "org_config",
	};
	const embeddingModel = {
		id: "m-emb",
		canonicalName: "text-embedding-3-small",
		displayName: "Text Embedding 3 Small",
		providerModelId: "openai/text-embedding-3-small",
		speedTier: "FAST",
		qualityTier: "STANDARD",
		capabilities: ["EMBEDDING"],
	};

	beforeEach(() => {
		api.status.mockResolvedValue(statusWith([GATEWAY]));
	});

	it("says API billing needs a provider for chat and generation, not an embeddings-only key", async () => {
		renderPage();
		const reason = await screen.findByTestId(
			"ai-routing-api-disabled-reason",
		);
		expect(reason).toHaveTextContent(
			'Needs an API provider for chat and generation. Your organization\'s only key is set to "Embeddings only" — change that or add a provider in AI Providers.',
		);
		const spent = screen.getByTestId("ai-routing-spent");
		for (const radio of within(spent).getAllByRole("radio", {
			name: "Use API billing",
		})) {
			expect(radio).toBeDisabled();
		}
	});

	it("offers the gateway's embedding models in the embeddings row", async () => {
		api.listAvailable.mockResolvedValue({
			...available([GATEWAY]),
			defaultProvider: null,
			models: [embeddingModel],
			modelsByGatewayAndProvider: {
				VERCEL_GATEWAY: {
					gatewayDisplayName: "Vercel AI Gateway",
					isDefault: false,
					providers: {
						OPENAI_DIRECT: {
							providerDisplayName: "OpenAI",
							models: [embeddingModel],
						},
					},
				},
			},
		});
		renderPage();
		const row = await screen.findByTestId("ai-models-embeddings");
		await waitFor(() =>
			expect(
				within(row).getByRole("combobox", {
					name: "Embeddings on API billing",
				}),
			).not.toBeDisabled(),
		);
		expect(row).toHaveTextContent("via Vercel AI Gateway");
		expect(
			screen.getByTestId("ai-models-api-none-COMPLEX"),
		).toHaveTextContent("No API provider for LLM work");
	});

	// Fizzy #2770: the document index holds 1536-dimension vectors only.
	const largeModel = {
		...embeddingModel,
		id: "m-emb-large",
		canonicalName: "text-embedding-3-large",
		displayName: "Text Embedding 3 Large",
		providerModelId: "openai/text-embedding-3-large",
	};
	const adaModel = {
		...embeddingModel,
		id: "m-emb-ada",
		canonicalName: "text-embedding-ada-002",
		displayName: "Text Embedding Ada 002",
		providerModelId: "openai/text-embedding-ada-002",
	};
	const listEmbeddingModels = () =>
		api.listAvailable.mockResolvedValue({
			...available([GATEWAY]),
			defaultProvider: null,
			models: [embeddingModel, largeModel, adaModel],
			modelsByGatewayAndProvider: {
				VERCEL_GATEWAY: {
					gatewayDisplayName: "Vercel AI Gateway",
					isDefault: false,
					providers: {
						OPENAI_DIRECT: {
							providerDisplayName: "OpenAI",
							models: [embeddingModel, largeModel, adaModel],
						},
					},
				},
			},
		});
	const openEmbeddingsSelect = async () => {
		const row = await screen.findByTestId("ai-models-embeddings");
		const trigger = within(row).getByRole("combobox", {
			name: "Embeddings on API billing",
		});
		await waitFor(() => expect(trigger).not.toBeDisabled());
		fireEvent.click(trigger);
	};

	it("shows a model whose vectors do not fit disabled, saying why", async () => {
		listEmbeddingModels();
		renderPage();
		await openEmbeddingsSelect();
		const large = await screen.findByRole("option", {
			name: /Text Embedding 3 Large/,
		});
		expect(large).toHaveAttribute("aria-disabled", "true");
		expect(large).toHaveTextContent(copy.models.embeddingsNeedsVectorSize);
		expect(
			screen.getByRole("option", { name: /Text Embedding Ada 002/ }),
		).not.toHaveAttribute("aria-disabled", "true");
	});

	it("asks before changing the embeddings model, and saves only on Change", async () => {
		listEmbeddingModels();
		api.orgPreferences.mockResolvedValue([
			{
				id: "pref-1",
				taskType: "EMBEDDING",
				provider: "VERCEL_GATEWAY",
				customParameters: null,
				model: embeddingModel,
			},
		]);
		api.setOrg.mockResolvedValue({ success: true });
		renderPage();
		const row = await screen.findByTestId("ai-models-embeddings");
		await within(row).findByText(copy.models.enforced);
		await openEmbeddingsSelect();
		fireEvent.click(
			await screen.findByRole("option", {
				name: /Text Embedding Ada 002/,
			}),
		);
		const dialog = await screen.findByTestId("ai-models-embeddings-change");
		expect(dialog).toHaveTextContent(copy.models.embeddingsChangeBody);
		fireEvent.click(
			within(dialog).getByRole("button", {
				name: copy.models.embeddingsChangeCancel,
			}),
		);
		await waitFor(() =>
			expect(
				screen.queryByTestId("ai-models-embeddings-change"),
			).toBeNull(),
		);
		expect(api.setOrg).not.toHaveBeenCalled();

		await openEmbeddingsSelect();
		fireEvent.click(
			await screen.findByRole("option", {
				name: /Text Embedding Ada 002/,
			}),
		);
		fireEvent.click(
			within(
				await screen.findByTestId("ai-models-embeddings-change"),
			).getByRole("button", {
				name: copy.models.embeddingsChangeConfirm,
			}),
		);
		await waitFor(() =>
			expect(api.setOrg).toHaveBeenCalledWith(
				expect.objectContaining({
					taskType: "EMBEDDING",
					modelCanonicalName: "text-embedding-ada-002",
				}),
			),
		);
	});

	const smallDefault = {
		taskType: "EMBEDDING",
		complexity: "MEDIUM",
		priority: 1,
		provider: "VERCEL_GATEWAY",
		model: embeddingModel,
	};

	it("does not ask when Default resolves to the model already in use", async () => {
		listEmbeddingModels();
		api.taskDefaults.mockResolvedValue([smallDefault]);
		api.orgPreferences.mockResolvedValue([
			{
				id: "pref-1",
				taskType: "EMBEDDING",
				provider: "VERCEL_GATEWAY",
				customParameters: null,
				model: embeddingModel,
			},
		]);
		api.deleteOrg.mockResolvedValue({ success: true });
		renderPage();
		const row = await screen.findByTestId("ai-models-embeddings");
		await within(row).findByText(copy.models.enforced);
		await openEmbeddingsSelect();
		fireEvent.click(
			await screen.findByRole("option", {
				name: copy.models.defaultPlain,
			}),
		);
		await waitFor(() =>
			expect(api.deleteOrg).toHaveBeenCalledWith(
				expect.objectContaining({ taskType: "EMBEDDING" }),
			),
		);
		expect(screen.queryByTestId("ai-models-embeddings-change")).toBeNull();
	});

	it("asks before a first explicit pick that differs from the default in use", async () => {
		listEmbeddingModels();
		api.taskDefaults.mockResolvedValue([smallDefault]);
		api.orgPreferences.mockResolvedValue([]);
		renderPage();
		await openEmbeddingsSelect();
		fireEvent.click(
			await screen.findByRole("option", {
				name: /Text Embedding Ada 002/,
			}),
		);
		expect(
			await screen.findByTestId("ai-models-embeddings-change"),
		).toHaveTextContent(copy.models.embeddingsChangeBody);
		expect(api.setOrg).not.toHaveBeenCalled();
	});

	it("saves a first embeddings choice without asking", async () => {
		listEmbeddingModels();
		api.orgPreferences.mockResolvedValue([]);
		api.taskDefaults.mockResolvedValue([]);
		api.setOrg.mockResolvedValue({ success: true });
		renderPage();
		await openEmbeddingsSelect();
		fireEvent.click(
			await screen.findByRole("option", {
				name: /Text Embedding Ada 002/,
			}),
		);
		await waitFor(() => expect(api.setOrg).toHaveBeenCalled());
		expect(screen.queryByTestId("ai-models-embeddings-change")).toBeNull();
	});

	it("says no model is available, in plain text, when none can be listed", async () => {
		api.listAvailable.mockResolvedValue({
			...available([GATEWAY]),
			defaultProvider: null,
		});
		renderPage();
		expect(
			await screen.findByTestId("ai-models-api-no-models-EMBEDDING"),
		).toHaveTextContent(copy.models.noModelsAvailable);
		expect(
			screen.queryByRole("combobox", {
				name: "Embeddings on API billing",
			}),
		).toBeNull();
	});
});

describe("without shared accounts", () => {
	it("says none are connected and still lets the spend policy be chosen", async () => {
		api.pool.mockResolvedValue({ ...POOL, accounts: [] });
		renderPage();
		const shared = await screen.findByTestId("ai-routing-step-shared");
		await waitFor(() =>
			expect(shared).toHaveTextContent(copy.routing.sharedNone),
		);
		const spent = screen.getByTestId("ai-routing-spent");
		expect(spent).toHaveTextContent(copy.routing.spentHelpBackgroundWait);
		expect(
			within(spent).getByRole("radio", {
				name: copy.routing.backgroundWait,
			}),
		).not.toBeDisabled();
		expect(screen.queryByRole("switch")).toBeNull();
	});
});

describe("sharing and its terms", () => {
	it("shows the terms to accept; accounts wait for them, with no sharing switch", async () => {
		api.pool.mockResolvedValue({
			...POOL,
			policy: {
				...POOL.policy,
				termsAcknowledged: false,
			},
			viewer: { isOwner: true },
		});
		api.acknowledgeTerms.mockResolvedValue({});
		renderPage();
		const terms = await screen.findByTestId("ai-routing-terms");
		expect(screen.getByTestId("ai-routing-step-shared")).toHaveTextContent(
			copy.routing.sharedNeedsTerms,
		);
		expect(screen.queryByRole("switch")).toBeNull();
		fireEvent.click(
			within(terms).getByRole("button", {
				name: en.settings.chatgptPlanPool.acceptTerms,
			}),
		);
		await waitFor(() => expect(api.acknowledgeTerms).toHaveBeenCalled());
	});
});

describe("the fallback model", () => {
	it("recommends Astra and saves no fallback, explaining what then happens", async () => {
		renderPage();
		const row = await screen.findByTestId("ai-routing-fallback");
		expect(row).toHaveTextContent(copy.routing.fallbackHelpRecommended);
		const picker = within(row).getByRole("combobox", {
			name: copy.routing.fallbackLabel,
		});
		expect(picker).toHaveTextContent(
			"GPT-6 Astra (ChatGPT plan) · Recommended",
		);
		fireEvent.click(picker);
		fireEvent.click(
			await screen.findByRole("option", {
				name: copy.routing.noFallback,
			}),
		);
		await waitFor(() =>
			expect(api.setFallback).toHaveBeenCalledWith({
				fallbackModel: null,
			}),
		);
	});

	it("explains a missing fallback", async () => {
		api.planModels.mockResolvedValue({
			...PLAN_MODELS,
			fallbackModel: null,
		});
		renderPage();
		expect(
			await screen.findByTestId("ai-routing-fallback"),
		).toHaveTextContent(copy.routing.fallbackHelpNone);
	});
});
