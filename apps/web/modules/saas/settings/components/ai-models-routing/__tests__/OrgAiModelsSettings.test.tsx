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
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real translator: the page uses ICU plurals.
vi.mock("next-intl", async () => vi.importActual("next-intl"));

const api = vi.hoisted(() => ({
	impact: vi.fn(),
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
	setDefault: vi.fn(),
	previewSetDefault: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			embeddings: { changeImpact: api.impact },
			resolution: { getStatus: api.status },
			providers: {
				setDefault: api.setDefault,
				previewSetDefault: api.previewSetDefault,
			},
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
const invalidateQueries = vi.spyOn(QueryClient.prototype, "invalidateQueries");

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
	const rows = providers as Array<{
		provider: string;
		isEmbeddingProvider?: boolean;
		isDefault?: boolean;
	}>;
	const documents = rows.find((p) => p.isEmbeddingProvider);
	const resolved = documents ?? rows.find((p) => p.isDefault);
	const model = exampleModel("text-embedding-3-small", ["EMBEDDING"]);
	return {
		organizationEmbedding: {
			provider: resolved?.provider ?? null,
			model: resolved
				? {
						...model,
						providerModelId: "text-embedding-3-small",
						modelString: "text-embedding-3-small",
					}
				: null,
			identity: resolved
				? `${resolved.provider}:${resolved.provider === "VERCEL_GATEWAY" ? "openai/" : ""}text-embedding-3-small`
				: null,
			source: documents
				? "documents_provider"
				: resolved
					? "default_provider"
					: null,
		},
		configuredProviders: providers,
		embeddingProvider:
			(
				providers as Array<{
					provider: string;
					isEmbeddingProvider?: boolean;
				}>
			).find((provider) => provider.isEmbeddingProvider)?.provider ??
			null,
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
		organizationDefaultProvider: providers.length ? "OPENAI_DIRECT" : null,
		providerIds: [],
		models: [],
		modelsByProvider: {},
		modelsByGatewayAndProvider: {},
	};
}

function renderPage({
	canManagePlanModels = true,
	readOnly = false,
}: {
	canManagePlanModels?: boolean;
	readOnly?: boolean;
} = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const result = render(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			<QueryClientProvider client={client}>
				<OrgAiModelsSettings
					canManagePlanModels={canManagePlanModels}
					readOnly={readOnly}
				/>
			</QueryClientProvider>
		</NextIntlClientProvider>,
	);
	return { ...result, client };
}

async function openProviderSwitch() {
	const button = await screen.findByRole("button", {
		name: "Change default API provider",
	});
	await waitFor(() => expect(button).not.toBeDisabled());
	fireEvent.click(button);
}

beforeEach(() => {
	vi.clearAllMocks();
	api.impact.mockResolvedValue({
		companyContext: { indexedWithCurrentModel: 2, total: 5 },
		projectContent: { indexed: 7 },
	});
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

	// Fizzy #3085: the last step is the viewer's own key, and only theirs.
	it("shows the viewer's own plan-spent key as the last step, linking to the Personal tab", async () => {
		api.status.mockResolvedValue({
			...statusWith([OPENAI]),
			planSpentPersonalProvider: "ANTHROPIC_DIRECT",
		});
		renderPage();
		const step = await screen.findByTestId("ai-routing-step-personal");
		expect(step).toHaveTextContent(copy.routing.personalTitle);
		await waitFor(() => expect(step).toHaveTextContent(/Used: Anthropic/));
		expect(
			within(step).getByRole("link", {
				name: copy.routing.personalManage,
			}),
		).toHaveAttribute(
			"href",
			"/app/example-org/settings/ai-providers?tab=personal",
		);
		expect(screen.getByTestId("ai-routing-step-api")).toHaveTextContent(
			copy.routing.apiTitle,
		);
	});

	it("says the viewer's personal key is not set up, with a link to set one up", async () => {
		renderPage();
		const step = await screen.findByTestId("ai-routing-step-personal");
		expect(step).toHaveTextContent(copy.routing.personalNotSet);
		expect(
			within(step).getByRole("link", {
				name: copy.routing.personalSetUp,
			}),
		).toHaveAttribute(
			"href",
			"/app/example-org/settings/ai-providers?tab=personal",
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

	it("shows what background work may use under Advanced, saving it as what is left for people", async () => {
		renderPage();
		const advanced = await screen.findByTestId("ai-routing-advanced");
		expect(
			screen.queryByRole("combobox", {
				name: copy.routing.backgroundShareLabel,
			}),
		).toBeNull();
		fireEvent.click(
			within(advanced).getByRole("button", {
				name: en.settings.chatgptPlanPool.advanced,
			}),
		);
		expect(advanced).toHaveTextContent(
			copy.routing.backgroundShareDescription,
		);
		expect(
			within(advanced).getByRole("button", {
				name: `About ${copy.routing.backgroundShareLabel}`,
			}),
		).toBeInTheDocument();
		// Stored as 40% left for people (Fizzy #3085 FR8): 60% allowed.
		const share = await screen.findByRole("combobox", {
			name: copy.routing.backgroundShareLabel,
		});
		expect(share).toHaveTextContent("60%");
		fireEvent.click(share);
		fireEvent.click(await screen.findByRole("option", { name: "100%" }));
		await waitFor(() =>
			expect(api.updatePolicy).toHaveBeenCalledWith({ headroomPct: 0 }),
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
			within(decision).getByRole("button", {
				name: /^Decisions on API billing/,
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
			screen.getByRole("button", {
				name: /^Complex work on API billing/,
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
			"Library document chat, Atlas assistant, Agent Builder Sidekick",
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
				model: model,
				provider: "OPENAI_DIRECT",
			},
		]);
		api.deleteOrg.mockResolvedValue({ success: true });
		renderPage();
		const trigger = await screen.findByRole("button", {
			name: /^Complex work on API billing/,
		});
		// The choice and the models load separately; wait for both.
		const row = screen.getByTestId("ai-models-row-COMPLEX");
		await within(row).findByText(copy.models.enforced);
		await waitFor(() => expect(trigger).not.toBeDisabled());
		fireEvent.click(trigger);
		fireEvent.click(
			await screen.findByRole("option", {
				name: "No default model",
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
			within(row).getByRole("button", {
				name: /^Embeddings on API billing/,
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
			screen.queryByRole("button", {
				name: /^Complex work on API billing/,
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
		expect(screen.queryByText("Default API provider")).toBeNull();
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
				within(row).getByRole("button", {
					name: /^Embeddings on API billing/,
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
		const trigger = within(row).getByRole("button", {
			name: /^Embeddings on API billing/,
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
		const warning = await screen.findByTestId(
			"ai-models-embeddings-change",
		);
		expect(
			within(warning).getByRole("button", {
				name: copy.models.embeddingsChangeConfirm,
			}),
		).toBeDisabled();
		fireEvent.change(within(warning).getByRole("textbox"), {
			target: { value: " reindex " },
		});
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
				name: /\(default\)/,
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

	it("checks indexed impact for a first explicit choice even without a saved preference", async () => {
		api.impact.mockResolvedValue({
			companyContext: { indexedWithCurrentModel: 0, total: 0 },
			projectContent: { indexed: 0 },
		});
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

	it("keeps the resolved organization's embedding select visible when the catalog has no options", async () => {
		api.listAvailable.mockResolvedValue({
			...available([GATEWAY]),
			defaultProvider: null,
		});
		const { client } = renderPage();
		await waitFor(() => expect(client.isFetching()).toBe(0));
		await userEvent.setup().tab();
		const select = await screen.findByRole("button", {
			name: /^Embeddings on API billing/,
		});
		await waitFor(() => expect(select).toBeDisabled());
		expect(select).toHaveTextContent("text-embedding-3-small");
		expect(screen.queryByTestId("ai-models-embeddings-off")).toBeNull();
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

	// The shared accounts card links here with #chatgpt-plan-terms; the block
	// renders only after the policy loads, so it scrolls itself into view.
	it("brings the terms into view when the page is opened at their anchor", async () => {
		api.pool.mockResolvedValue({
			...POOL,
			policy: { ...POOL.policy, termsAcknowledged: false },
			viewer: { isOwner: true },
		});
		const original = Element.prototype.scrollIntoView;
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		window.location.hash = "#chatgpt-plan-terms";
		try {
			renderPage();
			const terms = await screen.findByTestId("ai-routing-terms");
			expect(terms).toHaveAttribute("id", "chatgpt-plan-terms");
			expect(scrollIntoView).toHaveBeenCalledTimes(1);
			expect(scrollIntoView.mock.contexts[0]).toBe(terms);
		} finally {
			window.location.hash = "";
			Element.prototype.scrollIntoView = original;
		}
	});

	it("leaves the scroll alone when the page is opened without the anchor", async () => {
		api.pool.mockResolvedValue({
			...POOL,
			policy: { ...POOL.policy, termsAcknowledged: false },
			viewer: { isOwner: true },
		});
		const original = Element.prototype.scrollIntoView;
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		try {
			renderPage();
			await screen.findByTestId("ai-routing-terms");
			expect(scrollIntoView).not.toHaveBeenCalled();
		} finally {
			Element.prototype.scrollIntoView = original;
		}
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

const exampleModel = (
	name: string,
	capabilities = ["TEXT", "REASONING", "TOOL_CALLING"],
) => ({
	id: name,
	canonicalName: name,
	displayName: name,
	family: "example",
	vendor: "Example",
	speedTier: "FAST",
	qualityTier: "STANDARD",
	capabilities,
	providerModelId: name,
});
const exampleGateway = (
	model: ReturnType<typeof exampleModel>,
	name: string,
	isDefault = false,
) => ({
	gatewayDisplayName: name,
	isDefault,
	providers: { example: { providerDisplayName: name, models: [model] } },
});
function providerFixture(documents = false) {
	const current = exampleModel("Example current");
	const secondary = exampleModel("Example secondary");
	const pending = exampleModel("Example pending");
	const embedding = exampleModel("text-embedding-3-small", ["EMBEDDING"]);
	const nextEmbedding = exampleModel("text-embedding-ada-002", ["EMBEDDING"]);
	const largeEmbedding = exampleModel("text-embedding-3-large", [
		"EMBEDDING",
	]);
	const image = exampleModel("Example image", ["IMAGE"]);
	const decision = exampleModel("Example decision", ["EVALUATION"]);
	const wrongDecision = exampleModel("Wrong decision", ["EVALUATION"]);
	const providers = [
		{ ...OPENAI, isEmbeddingProvider: documents },
		{
			...OPENAI,
			provider: "VERCEL_GATEWAY",
			displayName: "Vercel AI Gateway",
			isDefault: false,
			isEmbeddingProvider: false,
		},
	];
	api.status.mockResolvedValue(statusWith(providers));
	api.setDefault.mockResolvedValue({ success: true, preferencesCleared: 2 });
	api.listAvailable.mockImplementation(
		async ({ taskType }: { taskType?: string }) => ({
			...available(providers),
			configuredProviders: providers.map((p, i) => ({
				...p,
				id: `example-${i}`,
				priority: 1,
				enabledProviders: [],
			})),
			models:
				taskType === "DECISION"
					? [decision, wrongDecision]
					: [
							current,
							secondary,
							pending,
							embedding,
							nextEmbedding,
							largeEmbedding,
							image,
						],
			modelsByGatewayAndProvider:
				taskType === "DECISION"
					? {
							VERCEL_GATEWAY: exampleGateway(
								decision,
								"Vercel AI Gateway",
							),
							OPENAI_DIRECT: exampleGateway(
								wrongDecision,
								"OpenAI",
							),
						}
					: {
							OPENAI_DIRECT: {
								...exampleGateway(current, "OpenAI", true),
								providers: {
									example: {
										providerDisplayName: "OpenAI",
										models: [
											current,
											pending,
											embedding,
											nextEmbedding,
											largeEmbedding,
											{
												...image,
												canonicalName: "Wrong image",
												displayName: "Wrong image",
											},
										],
									},
								},
							},
							VERCEL_GATEWAY: {
								...exampleGateway(
									secondary,
									"Vercel AI Gateway",
								),
								providers: {
									example: {
										providerDisplayName: "Example",
										models: [secondary, image],
									},
								},
							},
						},
		}),
	);
	api.orgPreferences.mockResolvedValue([
		{ taskType: "COMPLEX", provider: "VERCEL_GATEWAY", model: secondary },
		{ taskType: "COMPLEX", provider: "OPENAI_DIRECT", model: current },
		{ taskType: "CHAT", provider: "VERCEL_GATEWAY", model: null },
		{ taskType: "DECISION", provider: "OPENAI_DIRECT", model: null },
		{ taskType: "DECISION", provider: "VERCEL_GATEWAY", model: decision },
		{
			taskType: "IMAGE",
			provider: "OPENAI_DIRECT",
			model: { ...image, displayName: "Wrong image" },
		},
		{ taskType: "IMAGE", provider: "VERCEL_GATEWAY", model: image },
		{ taskType: "EMBEDDING", provider: "OPENAI_DIRECT", model: embedding },
	]);
	api.taskDefaults.mockImplementation(async (input) =>
		input.provider
			? ["COMPLEX", "CHAT", "SIMPLE", "REASONING", "TOOL_CALLING"].map(
					(taskType) => ({
						taskType,
						provider: input.provider,
						model:
							input.provider === "OPENAI_DIRECT"
								? current
								: secondary,
					}),
				)
			: [
					{
						taskType: "CHAT",
						provider: "VERCEL_GATEWAY",
						model: secondary,
					},
					{
						taskType: "CHAT",
						provider: "OPENAI_DIRECT",
						model: current,
					},
				],
	);
	api.previewSetDefault.mockImplementation(
		async ({ provider }: { provider?: string }) => ({
			currentProvider: "OPENAI_DIRECT",
			targetProvider: provider ?? null,
			validProviders: [
				{ provider: "OPENAI_DIRECT" },
				{ provider: "VERCEL_GATEWAY" },
			],
			savedTextChoiceCount:
				provider && provider !== "OPENAI_DIRECT" ? 1 : 0,
			removedPreferences: [],
			keptPreferences: [
				{
					id: "example-image",
					taskType: "IMAGE",
					provider: "VERCEL_GATEWAY",
				},
				{
					id: "example-audio",
					taskType: "AUDIO",
					provider: "OPENAI_DIRECT",
				},
				{
					id: "example-decision",
					taskType: "DECISION",
					provider: "VERCEL_GATEWAY",
				},
			],
			preservesEmbedding: documents,
			documentsProvider: documents ? "OPENAI_DIRECT" : null,
			embeddingsModelChanged: !documents,
			textTasks: provider
				? [
						"SIMPLE",
						"COMPLEX",
						"REASONING",
						"CHAT",
						"TOOL_CALLING",
						"EVAL",
					].map((taskType) => ({
						taskType,
						currentModel: current,
						targetModel:
							taskType === "EVAL"
								? null
								: provider === "OPENAI_DIRECT"
									? current
									: secondary,
					}))
				: [],
		}),
	);

	return { current, secondary };
}

describe.each([false, true])(
	"effective providers with routing variant %s",
	(routing) => {
		beforeEach(() => {
			flags.current = { CHATGPT_PLAN: routing };
		});
		// Reverting the hook's provider-scoped row lookup or gateway filter breaks these assertions.
		it("shows the effective row and lists only its provider's models", async () => {
			providerFixture();
			renderPage();
			const trigger = await screen.findByRole("button", {
				name: /^Complex work on API billing/,
			});
			await waitFor(() =>
				expect(trigger).toHaveTextContent("Example current"),
			);
			expect(trigger).not.toHaveTextContent("Example secondary");
			expect(api.taskDefaults).toHaveBeenCalledWith({
				organizationId: "org-1",
				provider: "OPENAI_DIRECT",
			});
			expect(
				screen.getByTestId("ai-models-row-COMPLEX"),
			).toHaveTextContent("Example current");
			expect(screen.getByTestId("ai-models-row-CHAT")).toHaveTextContent(
				"Example current (default)",
			);
			fireEvent.click(trigger);
			expect(
				await screen.findByRole("option", {
					name: /^Example current Current/,
				}),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("option", { name: /Example secondary/ }),
			).toBeNull();
		});
		it("shows the provider bar above the text table and keeps chips only for other work", async () => {
			providerFixture(true);
			renderPage();
			const bar = await screen.findByRole("region", {
				name: "Default API provider",
			});
			await within(bar).findByText("OpenAI");
			expect(bar).toHaveTextContent("Runs 6 text tasks");
			expect(bar).toHaveTextContent(copy.models.providerSwitchNote);
			const table = screen.getByRole("table", { name: "Text tasks" });
			expect(
				bar.compareDocumentPosition(table) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(table).not.toContainElement(bar);
			expect(within(bar).queryByRole("combobox")).toBeNull();
			expect(
				within(bar).getByRole("button", {
					name: "Change default API provider",
				}),
			).toHaveTextContent("Change default API provider");
			for (const task of [
				"SIMPLE",
				"COMPLEX",
				"REASONING",
				"CHAT",
				"TOOL_CALLING",
				"EVAL",
			]) {
				expect(
					screen.getByTestId(`ai-models-row-${task}`),
				).not.toHaveTextContent(/via /);
			}
			expect(screen.getByTestId("ai-models-row-IMAGE")).toHaveTextContent(
				"via Vercel AI Gateway",
			);
			expect(
				screen.getByTestId("ai-models-embeddings"),
			).toHaveTextContent("via OpenAI");
			const button = within(bar).getByRole("button", {
				name: "Change default API provider",
			});
			await waitFor(() => expect(button).not.toBeDisabled());
			fireEvent.click(button);
			const dialog = await screen.findByRole("alertdialog");
			fireEvent.click(
				within(dialog).getByRole("button", { name: "Cancel" }),
			);
			await waitFor(() => expect(button).toHaveFocus());
		});
		// Removing the two-section partition puts the specialized rows back into the text table.
		it("places specialized work outside the six-row text table and pins Image to the gateway", async () => {
			providerFixture(true);
			renderPage();
			const other = await screen.findByRole("region", {
				name: "Other kinds of work",
			});
			for (const task of ["IMAGE", "AUDIO", "DECISION"]) {
				expect(
					within(other).getByTestId(`ai-models-row-${task}`),
				).toBeInTheDocument();
			}
			expect(
				within(other).getByTestId("ai-models-embeddings"),
			).toBeInTheDocument();
			const text = screen.getByRole("table", { name: "Text tasks" });
			expect(within(text).getAllByRole("row")).toHaveLength(7);
			expect(
				within(text).queryByTestId("ai-models-row-IMAGE"),
			).toBeNull();
			const image = within(other).getByRole("button", {
				name: /^Image generation on API billing/,
			});
			await waitFor(() =>
				expect(image).toHaveTextContent("Example image"),
			);
			fireEvent.click(image);
			expect(
				await screen.findByRole("option", { name: /Example image/ }),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("option", { name: /Wrong image/ }),
			).toBeNull();
			fireEvent.click(
				screen.getByRole("option", { name: /Example image/ }),
			);
			const decisionSelect = within(other).getByRole("button", {
				name: /^Decisions on API billing/,
			});
			await waitFor(() =>
				expect(decisionSelect).toHaveTextContent("Example decision"),
			);
			fireEvent.click(decisionSelect);
			expect(
				await screen.findByRole("option", { name: /Example decision/ }),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("option", { name: /Wrong decision/ }),
			).toBeNull();
			expect(
				screen.getByRole("option", { name: /Disabled/ }),
			).toBeInTheDocument();
		});
		// Removing the review panel or typed confirmation breaks the preview and mutation boundary.
		it("reviews all text tasks and requires typed confirmation without a documents provider", async () => {
			providerFixture();
			renderPage();
			if (!routing) {
				const modelSelect = await screen.findByRole("button", {
					name: /^Complex work on API billing/,
				});
				await waitFor(() => expect(modelSelect).not.toBeDisabled());
				fireEvent.click(modelSelect);
				fireEvent.click(
					await screen.findByRole("option", {
						name: /Example pending/,
					}),
				);
			}
			await openProviderSwitch();
			const select = await screen.findByRole("combobox", {
				name: "Change default provider",
			});
			await waitFor(() => expect(select).not.toBeDisabled());
			fireEvent.click(select);
			fireEvent.click(
				await screen.findByRole("option", {
					name: "Vercel AI Gateway",
				}),
			);
			const dialog = await screen.findByRole("alertdialog");
			await waitFor(() =>
				expect(
					within(dialog).getByTestId("provider-switch-task-CHAT"),
				).toBeInTheDocument(),
			);
			expect(
				within(dialog).getAllByTestId(/provider-switch-task-/),
			).toHaveLength(6);
			expect(dialog).toHaveTextContent("Example current");
			expect(dialog).not.toHaveTextContent("Example pending");
			expect(dialog).toHaveTextContent(
				"Your 1 saved choice for text tasks will be removed.",
			);
			await waitFor(() =>
				expect(
					within(dialog).getByTestId("provider-switch-task-CHAT"),
				).toHaveAccessibleName(
					"Chat: Example current, then Example secondary (default)",
				),
			);
			expect(
				within(dialog).getByTestId("provider-switch-task-EVAL"),
			).toHaveTextContent("No default model");
			expect(
				within(dialog)
					.getByTestId("provider-switch-task-CHAT")
					.querySelector("[aria-hidden=true]"),
			).toHaveTextContent("→");
			expect(api.previewSetDefault).toHaveBeenCalledWith({
				organizationId: "org-1",
				provider: "VERCEL_GATEWAY",
			});
			expect(dialog).toHaveTextContent("re-indexed");
			expect(dialog).toHaveTextContent(
				"Saved choices that will be kept:",
			);
			const confirm = within(dialog).getByRole("button", {
				name: "Make default",
			});
			expect(confirm).toBeDisabled();
			expect(api.setDefault).not.toHaveBeenCalled();

			fireEvent.change(within(dialog).getByRole("textbox"), {
				target: { value: "REINDEX" },
			});
			fireEvent.click(select);
			fireEvent.click(
				await screen.findByRole("option", { name: "OpenAI" }),
			);
			await waitFor(() =>
				expect(
					within(dialog).getByTestId("provider-switch-task-CHAT"),
				).toHaveAccessibleName(
					"Chat: Example current, then Example current (default)",
				),
			);
			expect(confirm).toBeDisabled();
			expect(within(dialog).queryByRole("textbox")).toHaveValue("");
			fireEvent.click(select);
			fireEvent.click(
				await screen.findByRole("option", {
					name: "Vercel AI Gateway",
				}),
			);
			await waitFor(() =>
				expect(
					within(dialog).getByTestId("provider-switch-task-CHAT"),
				).toHaveAccessibleName(
					"Chat: Example current, then Example secondary (default)",
				),
			);
			expect(within(dialog).queryByRole("textbox")).toHaveValue("");
			fireEvent.change(within(dialog).getByRole("textbox"), {
				target: { value: "REINDEX" },
			});
			const modelReads = api.listAvailable.mock.calls.length;
			const preferenceReads = api.orgPreferences.mock.calls.length;
			const defaultReads = api.taskDefaults.mock.calls.length;

			fireEvent.click(confirm);
			await waitFor(() =>
				expect(api.setDefault).toHaveBeenCalledWith({
					organizationId: "org-1",
					provider: "VERCEL_GATEWAY",
				}),
			);
			await waitFor(() => {
				expect(api.listAvailable.mock.calls.length).toBeGreaterThan(
					modelReads,
				);
				expect(api.orgPreferences.mock.calls.length).toBeGreaterThan(
					preferenceReads,
				);
				expect(api.taskDefaults.mock.calls.length).toBeGreaterThan(
					defaultReads,
				);
				expect(invalidateQueries).toHaveBeenCalledWith({
					queryKey: ["aiConfigStatus", "org-1"],
				});
			});
			await waitFor(() =>
				expect(screen.queryByRole("alertdialog")).toBeNull(),
			);
			await waitFor(() =>
				expect(
					screen.getByRole("button", {
						name: "Change default API provider",
					}),
				).toHaveFocus(),
			);
		});
		// Removing the dedicated-provider branch adds an unnecessary acknowledgement.
		it("keeps the documents provider in the preview without an acknowledgement", async () => {
			providerFixture(true);
			renderPage();
			await openProviderSwitch();
			const select = await screen.findByRole("combobox", {
				name: "Change default provider",
			});
			await waitFor(() => expect(select).not.toBeDisabled());
			fireEvent.click(select);
			fireEvent.click(
				await screen.findByRole("option", {
					name: "Vercel AI Gateway",
				}),
			);
			const dialog = await screen.findByRole("alertdialog");
			await waitFor(() =>
				expect(
					within(dialog).getByTestId("provider-switch-task-CHAT"),
				).toBeInTheDocument(),
			);
			expect(dialog).toHaveTextContent("Embeddings stay on OpenAI");
			expect(within(dialog).queryByRole("checkbox")).toBeNull();
			await waitFor(() =>
				expect(
					within(dialog).getByRole("button", {
						name: "Make default",
					}),
				).not.toBeDisabled(),
			);
		});

		it("keeps embeddings without acknowledgement when switching to the documents provider", async () => {
			providerFixture();
			const status = await api.status();
			status.configuredProviders[1].isEmbeddingProvider = true;
			const previousPreview =
				api.previewSetDefault.getMockImplementation();
			if (!previousPreview) {
				throw new Error("Missing preview fixture");
			}
			api.previewSetDefault.mockImplementation(async (input) => ({
				...(await previousPreview(input)),
				preservesEmbedding: true,
				documentsProvider: "VERCEL_GATEWAY",
				embeddingsModelChanged: false,
			}));
			renderPage();
			await openProviderSwitch();
			const select = await screen.findByRole("combobox", {
				name: "Change default provider",
			});
			await waitFor(() => expect(select).not.toBeDisabled());
			fireEvent.click(select);
			fireEvent.click(
				await screen.findByRole("option", {
					name: "Vercel AI Gateway",
				}),
			);
			const dialog = await screen.findByRole("alertdialog");
			await waitFor(() =>
				expect(
					within(dialog).getByTestId("provider-switch-task-CHAT"),
				).toBeInTheDocument(),
			);
			expect(dialog).toHaveTextContent(
				"Embeddings stay on Vercel AI Gateway",
			);
			expect(within(dialog).queryByRole("checkbox")).toBeNull();
			await waitFor(() =>
				expect(
					within(dialog).getByRole("button", {
						name: "Make default",
					}),
				).not.toBeDisabled(),
			);
		});
		it("shows the no-default explanation once in the bar with quiet disabled text rows", async () => {
			providerFixture();
			const previousPreview =
				api.previewSetDefault.getMockImplementation();
			if (!previousPreview) {
				throw new Error("Missing preview fixture");
			}
			api.previewSetDefault.mockImplementation(async (input) => ({
				...(await previousPreview(input)),
				currentProvider: null,
				savedTextChoiceCount: 0,
			}));
			const list = api.listAvailable.getMockImplementation();
			if (!list) {
				throw new Error("Missing catalog fixture");
			}
			api.listAvailable.mockImplementation(async (input) => {
				const result = await list(input);
				return {
					...result,
					organizationDefaultProvider: null,
				};
			});
			renderPage();
			expect(
				await screen.findByText("No default API provider"),
			).toBeInTheDocument();
			const trigger = await screen.findByRole("button", {
				name: /^Complex work on API billing/,
			});
			expect(trigger).toBeDisabled();
			for (const task of [
				"COMPLEX",
				"REASONING",
				"TOOL_CALLING",
				"CHAT",
				"EVAL",
				"SIMPLE",
			]) {
				const row = screen.getByTestId(`ai-models-row-${task}`);
				expect(row).not.toHaveTextContent(
					"Choose a default API provider to select text models.",
				);
				const control = within(row).getByRole("button");
				expect(control).toBeDisabled();
				expect(control).toHaveTextContent("—");
				expect(row).not.toHaveTextContent("No models available");
			}
			const bar = screen.getByRole("region", {
				name: "Default API provider",
			});
			expect(bar).toHaveTextContent("No default API provider");
			expect(
				within(bar).getByText(
					"Choose a default API provider to select text models.",
				),
			).toBeInTheDocument();
			expect(
				screen.getAllByText(
					"Choose a default API provider to select text models.",
				),
			).toHaveLength(1);
			const choose = screen.getByRole("button", {
				name: "Choose default API provider",
			});
			await waitFor(() => expect(choose).not.toBeDisabled());
			fireEvent.click(choose);
			const select = await screen.findByRole("combobox", {
				name: "Change default provider",
			});
			await waitFor(() => expect(select).not.toBeDisabled());
			fireEvent.click(select);
			fireEvent.click(
				await screen.findByRole("option", {
					name: "Vercel AI Gateway",
				}),
			);
			const dialog = await screen.findByRole("alertdialog");
			await waitFor(() =>
				expect(
					within(dialog).getByTestId("provider-switch-task-CHAT"),
				).toBeInTheDocument(),
			);
			expect(dialog).not.toHaveTextContent(/saved choice/);
			expect(dialog).toHaveTextContent(
				"Current: No default API provider",
			);
			fireEvent.change(within(dialog).getByRole("textbox"), {
				target: { value: "REINDEX" },
			});
			await waitFor(() =>
				expect(
					within(dialog).getByRole("button", {
						name: "Make default",
					}),
				).not.toBeDisabled(),
			);
		});
		it("does not persist or toast when Default cancels an unsaved choice without a saved row", async () => {
			providerFixture();
			api.orgPreferences.mockResolvedValue([]);
			api.taskDefaults.mockResolvedValue([
				{
					taskType: "COMPLEX",
					provider: "OPENAI_DIRECT",
					model: exampleModel("Example current"),
				},
			]);
			renderPage();
			const trigger = await screen.findByRole("button", {
				name: /^Complex work on API billing/,
			});
			await waitFor(() => expect(trigger).not.toBeDisabled());
			if (!routing) {
				fireEvent.click(trigger);
				fireEvent.click(
					await screen.findByRole("option", {
						name: /Example pending/,
					}),
				);
				expect(api.setOrg).not.toHaveBeenCalled();
			}
			fireEvent.click(trigger);
			await userEvent.click(
				await screen.findByRole("option", {
					name: "Example current (default)",
				}),
			);
			expect(api.deleteOrg).not.toHaveBeenCalled();
			expect(api.setOrg).not.toHaveBeenCalled();
			expect(toast.success).not.toHaveBeenCalled();
			expect(toast.error).not.toHaveBeenCalled();
			expect(
				screen.queryByRole("button", { name: "Save Changes" }),
			).toBeNull();
		});
		it.skipIf(routing)(
			"defers a saved choice reset until Save in the plain form",
			async () => {
				providerFixture();
				api.taskDefaults.mockResolvedValue([
					{
						taskType: "COMPLEX",
						provider: "OPENAI_DIRECT",
						model: exampleModel("Example pending"),
					},
				]);
				renderPage();
				const trigger = await screen.findByRole("button", {
					name: /^Complex work on API billing/,
				});
				await waitFor(() => expect(trigger).not.toBeDisabled());
				fireEvent.click(trigger);
				await userEvent.click(
					await screen.findByRole("option", {
						name: /^Example pending Fast model/,
					}),
				);
				expect(api.setOrg).not.toHaveBeenCalled();
				expect(api.deleteOrg).not.toHaveBeenCalled();

				fireEvent.click(trigger);
				await userEvent.click(
					await screen.findByRole("option", {
						name: "Example pending (default)",
					}),
				);
				expect(api.deleteOrg).not.toHaveBeenCalled();
				expect(trigger).toHaveTextContent("Example pending");
				fireEvent.click(
					screen.getByRole("button", { name: "Save Changes" }),
				);
				await waitFor(() =>
					expect(api.deleteOrg).toHaveBeenCalledWith({
						organizationId: "org-1",
						taskType: "COMPLEX",
					}),
				);
				expect(api.setOrg).not.toHaveBeenCalled();
			},
		);

		it.skipIf(routing)(
			"restores configure-provider help for rows without models",
			async () => {
				providerFixture();
				const list = api.listAvailable.getMockImplementation();
				if (!list) {
					throw new Error("Missing catalog fixture");
				}
				api.listAvailable.mockImplementation(async (input) => ({
					...(await list(input)),
					models: [],
					modelsByGatewayAndProvider: {},
				}));
				renderPage();
				await screen.findByTestId("ai-models-row-SIMPLE");
				for (const task of [
					"COMPLEX",
					"SIMPLE",
					"REASONING",
					"CHAT",
					"TOOL_CALLING",
					"EVAL",
					"IMAGE",
					"AUDIO",
					"EMBEDDING",
				]) {
					const row = screen.getByTestId(
						task === "EMBEDDING"
							? "ai-models-embeddings"
							: `ai-models-row-${task}`,
					);
					expect(
						within(row).getByRole("link", {
							name: "Configure providers first",
						}),
					).toHaveAttribute(
						"href",
						"/app/example-org/settings/ai-providers",
					);
				}
			},
		);

		// Removing the mutation-error rendering hides the existing procedure's refusal.
		it("keeps the switch dialog open and surfaces the procedure's error", async () => {
			providerFixture(true);
			api.setDefault.mockRejectedValueOnce(
				new Error("Example provider switch refused"),
			);
			renderPage();
			await openProviderSwitch();
			const select = await screen.findByRole("combobox", {
				name: "Change default provider",
			});
			await waitFor(() => expect(select).not.toBeDisabled());
			fireEvent.click(select);
			fireEvent.click(
				await screen.findByRole("option", {
					name: "Vercel AI Gateway",
				}),
			);
			const dialog = await screen.findByRole("alertdialog");
			await waitFor(() =>
				expect(
					within(dialog).getByRole("button", {
						name: "Make default",
					}),
				).not.toBeDisabled(),
			);
			fireEvent.click(
				within(dialog).getByRole("button", { name: "Make default" }),
			);
			expect(await within(dialog).findByRole("alert")).toHaveTextContent(
				"Example provider switch refused",
			);
			expect(screen.getByRole("alertdialog")).toBeInTheDocument();
		});
		// Removing the readOnly gate exposes the provider-change control to members.
		it("shows members the provider without switch controls", async () => {
			providerFixture(true);
			renderPage({ readOnly: true, canManagePlanModels: routing });
			expect(
				await screen.findByRole("region", {
					name: "Default API provider",
				}),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("combobox", {
					name: "Change default provider",
				}),
			).toBeNull();
			expect(
				screen.queryByRole("button", {
					name: "Change default API provider",
				}),
			).toBeNull();
			const bar = screen.getByRole("region", {
				name: "Default API provider",
			});
			await within(bar).findByText("OpenAI");
			expect(within(bar).queryByRole("button")).toBeNull();
			await within(
				screen.getByTestId("ai-models-row-COMPLEX"),
			).findByText("Example current");
			expect(
				screen.queryByRole("button", {
					name: /^Complex work on API billing/,
				}),
			).toBeNull();
			expect(
				screen.queryByRole("combobox", {
					name: /^Complex work on API billing/,
				}),
			).toBeNull();
		});

		it("gives members neutral no-default copy and no admin instructions", async () => {
			providerFixture();
			const list = api.listAvailable.getMockImplementation();
			if (!list) {
				throw new Error("Missing catalog fixture");
			}
			api.listAvailable.mockImplementation(async (input) => ({
				...(await list(input)),
				organizationDefaultProvider: null,
			}));
			renderPage({ readOnly: true, canManagePlanModels: routing });
			const bar = await screen.findByRole("region", {
				name: "Default API provider",
			});
			expect(bar).toHaveTextContent("No default API provider is set");
			expect(bar).not.toHaveTextContent("Choose a default API provider");
			expect(within(bar).queryByRole("button")).toBeNull();
		});
		it.skipIf(routing)(
			"labels the other-work table and shows one Decisions unavailable explanation",
			async () => {
				providerFixture();
				const list = api.listAvailable.getMockImplementation();
				if (!list) {
					throw new Error("Missing catalog fixture");
				}
				api.listAvailable.mockImplementation(async (input) => ({
					...(await list(input)),
					models: [],
					modelsByGatewayAndProvider: {},
				}));
				renderPage();
				const table = await screen.findByRole("table", {
					name: "Other kinds of work",
				});
				expect(within(table).getAllByRole("columnheader")).toHaveLength(
					2,
				);
				const row = screen.getByTestId("ai-models-row-DECISION");
				expect(row).toHaveTextContent(copy.models.decisionUnavailable);
				expect(row).not.toHaveTextContent(
					copy.models.noModelsAvailable,
				);
			},
		);
		// Removing the embedding-change confirmation makes the model change immediately.
		it("asks before changing the embeddings model", async () => {
			providerFixture(true);
			renderPage();
			const select = await screen.findByRole("button", {
				name: /^Embeddings on API billing/,
			});
			await waitFor(() => expect(select).not.toBeDisabled());
			fireEvent.click(select);
			expect(
				await screen.findByRole("option", {
					name: /text-embedding-3-large/,
				}),
			).toHaveAttribute("aria-disabled", "true");
			fireEvent.click(
				await screen.findByRole("option", {
					name: /text-embedding-ada-002/,
				}),
			);
			expect(await screen.findByRole("alertdialog")).toHaveTextContent(
				copy.models.embeddingsChangeBody,
			);
			expect(api.setOrg).not.toHaveBeenCalled();
			expect(
				screen.getByRole("button", {
					name: copy.models.embeddingsChangeConfirm,
				}),
			).toBeDisabled();
			fireEvent.change(screen.getByRole("textbox"), {
				target: { value: "REINDEX" },
			});
			fireEvent.click(
				screen.getByRole("button", {
					name: copy.models.embeddingsChangeConfirm,
				}),
			);
			if (routing) {
				await waitFor(() =>
					expect(api.setOrg).toHaveBeenCalledWith(
						expect.objectContaining({
							taskType: "EMBEDDING",
							modelCanonicalName: "text-embedding-ada-002",
						}),
					),
				);
			} else {
				expect(
					await screen.findByRole("button", { name: "Save Changes" }),
				).toBeInTheDocument();
			}
		});
	},
);

describe("model fit advice", () => {
	it.each([
		[true, true],
		[false, true],
		[true, false],
		[false, false],
	])(
		"shows current-model advice with plan layout %s and expensive choice %s without blocking save",
		async (planLayout, expensive) => {
			flags.current = { CHATGPT_PLAN: planLayout };
			const weak = {
				id: "example-weak",
				canonicalName: "example-weak",
				displayName: "Example weak",
				family: "example",
				vendor: "Example",
				speedTier: "FAST",
				qualityTier: "BASIC",
				suitableForTasks: ["COMPLEX", "CHAT"],
				capabilities: ["TEXT"],
			};
			const premium = {
				...weak,
				id: "example-premium",
				canonicalName: "example-premium",
				displayName: "Example premium",
				inputCostPer1M: expensive ? 2 : 0.59,
				outputCostPer1M: expensive ? 8 : 0.79,
				suitableForTasks: ["SIMPLE"],
				qualityTier: "PREMIUM",
			};
			const alternateSimple = {
				...premium,
				id: "example-alternate-simple",
				canonicalName: "example-alternate-simple",
				displayName: "Example alternate Simple",
				inputCostPer1M: expensive ? 0.59 : 2,
				outputCostPer1M: expensive ? 0.79 : 8,
			};
			const suitable = {
				...weak,
				id: "example-suitable",
				canonicalName: "example-suitable",
				displayName: "Example suitable",
				qualityTier: "STANDARD",
			};
			const anotherWeak = {
				...weak,
				id: "example-another-weak",
				canonicalName: "example-another-weak",
				displayName: "Example another weak",
			};
			const payload = available([OPENAI]);
			api.listAvailable.mockResolvedValue({
				...payload,
				models: [weak, premium, alternateSimple, suitable, anotherWeak],
				modelsByGatewayAndProvider: {
					OPENAI_DIRECT: {
						gatewayDisplayName: "OpenAI",
						isDefault: true,
						providers: {
							OPENAI_DIRECT: {
								providerDisplayName: "OpenAI",
								models: [
									weak,
									premium,
									alternateSimple,
									suitable,
									anotherWeak,
								].map((m) => ({
									...m,
									providerModelId: m.canonicalName,
								})),
							},
						},
					},
				},
			});
			api.taskDefaults.mockResolvedValue([
				{
					taskType: "COMPLEX",
					complexity: "MEDIUM",
					priority: 1,
					provider: "OPENAI_DIRECT",
					model: weak,
				},
				{
					taskType: "SIMPLE",
					complexity: "MEDIUM",
					priority: 1,
					provider: "OPENAI_DIRECT",
					model: premium,
				},
				{
					taskType: "CHAT",
					complexity: "MEDIUM",
					priority: 1,
					provider: "OPENAI_DIRECT",
					model: suitable,
				},
			]);
			api.orgPreferences.mockResolvedValue([
				{
					id: "example-simple-preference",
					taskType: "SIMPLE",
					provider: "OPENAI_DIRECT",
					model: premium,
					customParameters: null,
				},
				{
					id: "example-preference",
					taskType: "COMPLEX",
					provider: "OPENAI_DIRECT",
					model: weak,
					customParameters: null,
				},
			]);
			renderPage();
			const savedNote = await screen.findByText(
				/Example weak is a basic model/,
			);
			expect(savedNote).toBeInTheDocument();
			expect(
				savedNote.parentElement?.querySelector("svg"),
			).not.toHaveAttribute("role");
			expect(
				screen.queryByText("Costs more than this task needs."),
			).toEqual(expensive ? expect.any(HTMLElement) : null);
			expect(screen.queryByText(/Example suitable.*weaker/)).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();
			if (!planLayout) {
				const simpleRow = screen.getByTestId("ai-models-row-SIMPLE");
				await userEvent.click(
					within(simpleRow).getByRole("button", {
						name: /Simple tasks on API billing/,
					}),
				);
				await userEvent.click(
					await screen.findByText("Example alternate Simple", {
						selector: "[cmdk-item] span",
					}),
				);
				expect(
					within(simpleRow).queryByText(
						"Costs more than this task needs.",
					),
				).toEqual(expensive ? null : expect.any(HTMLElement));
			}

			const trigger = screen.getByRole("button", {
				name: /Complex work on API billing/,
			});
			await userEvent.click(trigger);
			await userEvent.click(
				await screen.findByText("Example another weak", {
					selector: "[cmdk-item] span",
				}),
			);
			if (!planLayout) {
				expect(
					screen.getByText(/Example another weak is a basic model/),
				).toBeInTheDocument();
				await userEvent.click(
					screen.getByRole("button", { name: /Save/ }),
				);
			}
			await waitFor(() =>
				expect(api.setOrg).toHaveBeenCalledWith(
					expect.objectContaining({
						taskType: "COMPLEX",
						modelCanonicalName: "example-another-weak",
					}),
				),
			);
			if (!planLayout) {
				const row = screen.getByTestId("ai-models-row-COMPLEX");
				expect(
					within(row).getByText(/Example weak is a basic model/),
				).toBeInTheDocument();
				await userEvent.click(
					within(row).getByRole("button", {
						name: "Reset",
						exact: true,
					}),
				);
				expect(within(row).queryByText(/is a basic model/)).toBeNull();
			}
		},
	);
});

it.each([true, false])(
	"hides advice for weak system defaults in plan layout %s",
	async (planLayout) => {
		flags.current = { CHATGPT_PLAN: planLayout };
		const model = {
			id: "example-weak-default",
			canonicalName: "example-weak-default",
			displayName: "Example weak default",
			family: "example",
			vendor: "Example",
			speedTier: "FAST",
			qualityTier: "BASIC",
			suitableForTasks: ["COMPLEX"],
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
							models: [
								{
									...model,
									providerModelId: model.canonicalName,
								},
							],
						},
					},
				},
			},
		});
		api.taskDefaults.mockResolvedValue([
			{
				taskType: "COMPLEX",
				complexity: "MEDIUM",
				priority: 1,
				provider: "OPENAI_DIRECT",
				model,
			},
		]);
		renderPage();
		expect(
			await screen.findByRole("button", {
				name: /Complex work on API billing Example weak default/,
			}),
		).toBeInTheDocument();
		expect(screen.queryByText(/is a basic model/)).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	},
);

it.each([false, true])(
	"ignores stale embeddings choices from another provider with routing %s",
	async (routing) => {
		flags.current = { CHATGPT_PLAN: routing };
		providerFixture(true);
		const status = await api.status();
		api.status.mockResolvedValue({
			...status,
			embeddingProvider: "OPENAI_DIRECT",
		});
		const preferences = await api.orgPreferences();
		api.orgPreferences.mockResolvedValue([
			{
				taskType: "EMBEDDING",
				provider: "VERCEL_GATEWAY",
				model: {
					...preferences.find(
						(entry: any) => entry.taskType === "EMBEDDING",
					).model,
					displayName: "Example stale embedding",
					canonicalName: "example-stale-embedding",
				},
			},
			...preferences,
		]);
		renderPage();
		const select = await screen.findByRole("button", {
			name: /^Embeddings on API billing/,
		});
		await waitFor(() =>
			expect(select).toHaveTextContent("text-embedding-3-small"),
		);
		expect(select).not.toHaveTextContent("Example stale embedding");
	},
);

it.each([false, true])(
	"uses the resolved organization embeddings provider ahead of legacy status with routing %s",
	async (routing) => {
		flags.current = { CHATGPT_PLAN: routing };
		providerFixture(true);
		const status = await api.status();
		api.status.mockResolvedValue({
			...status,
			embeddingProvider: "VERCEL_GATEWAY",
		});
		const preferences = await api.orgPreferences();
		const embedding = preferences.find(
			(entry: any) => entry.taskType === "EMBEDDING",
		);
		api.taskDefaults.mockResolvedValue([embedding]);
		renderPage();
		const select = await screen.findByRole("button", {
			name: /^Embeddings on API billing/,
		});
		await waitFor(() =>
			expect(select).toHaveTextContent("text-embedding-3-small"),
		);
	},
);

it.each([false, true])(
	"skips the embeddings warning for empty indexes with routing %s",
	async (routing) => {
		flags.current = { CHATGPT_PLAN: routing };
		providerFixture(true);
		api.impact.mockResolvedValue({
			companyContext: { indexedWithCurrentModel: 0, total: 0 },
			projectContent: { indexed: 0 },
		});
		api.setOrg.mockResolvedValue({ success: true });
		renderPage();
		const select = await screen.findByRole("button", {
			name: /^Embeddings on API billing/,
		});
		await waitFor(() => expect(select).not.toBeDisabled());
		fireEvent.click(select);
		fireEvent.click(
			await screen.findByRole("option", {
				name: /text-embedding-ada-002/,
			}),
		);
		await waitFor(() =>
			expect(api.impact).toHaveBeenCalledWith({
				organizationId: "org-1",
			}),
		);
		expect(screen.queryByRole("alertdialog")).toBeNull();
		if (!routing) {
			fireEvent.click(
				await screen.findByRole("button", { name: "Save Changes" }),
			);
		}
		await waitFor(() => expect(api.setOrg).toHaveBeenCalled());
	},
);

it("shows an embeddings select for an organization default without a documents flag", async () => {
	providerFixture(false);
	const status = await api.status();
	api.status.mockResolvedValue({
		...status,
		organizationEmbedding: {
			provider: "OPENAI_DIRECT",
			source: "default_provider",
			identity: "OPENAI_DIRECT:text-embedding-3-small",
			model: exampleModel("text-embedding-3-small", ["EMBEDDING"]),
		},
	});
	renderPage();
	expect(
		await screen.findByRole("button", {
			name: /^Embeddings on API billing/,
		}),
	).toBeInTheDocument();
	expect(screen.queryByTestId("ai-models-embeddings-off")).toBeNull();
});
it("shows included platform embeddings without using the viewer's personal provider", async () => {
	providerFixture(false);
	const status = await api.status();
	api.status.mockResolvedValue({
		...status,
		resolvedEmbeddingProvider: "OPENAI_DIRECT",
		organizationEmbedding: {
			provider: null,
			model: null,
			identity: null,
			source: "platform",
		},
	});
	renderPage();
	const row = await screen.findByTestId("ai-models-embeddings");
	await waitFor(() =>
		expect(row).toHaveTextContent("Runs on the platform's included key."),
	);
	expect(
		within(row).queryByRole("button", {
			name: /^Embeddings on API billing/,
		}),
	).toBeNull();
	expect(screen.queryByTestId("ai-models-embeddings-off")).toBeNull();
});
it("compares a reverted staged embeddings choice with the saved organization identity", async () => {
	flags.current = { CHATGPT_PLAN: false };
	providerFixture(true);
	renderPage();
	const select = await screen.findByRole("button", {
		name: /^Embeddings on API billing/,
	});
	await waitFor(() => expect(select).not.toBeDisabled());
	fireEvent.click(select);
	fireEvent.click(
		await screen.findByRole("option", { name: /text-embedding-ada-002/ }),
	);
	fireEvent.change(await screen.findByRole("textbox"), {
		target: { value: "REINDEX" },
	});
	fireEvent.click(
		screen.getByRole("button", {
			name: copy.models.embeddingsChangeConfirm,
		}),
	);
	await waitFor(() =>
		expect(select).toHaveTextContent("text-embedding-ada-002"),
	);
	api.impact.mockClear();
	fireEvent.click(select);
	fireEvent.click(
		await screen.findByRole("option", { name: /text-embedding-3-small/ }),
	);
	await waitFor(() =>
		expect(select).toHaveTextContent("text-embedding-3-small"),
	);
	expect(api.impact).not.toHaveBeenCalled();
	expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("returns focus to the model picker after its trigger was disabled during the impact read", async () => {
	providerFixture(true);
	let finish!: (value: unknown) => void;
	api.impact.mockReturnValue(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	renderPage();
	const trigger = await screen.findByRole("button", {
		name: /^Embeddings on API billing/,
	});
	await waitFor(() => expect(trigger).not.toBeDisabled());
	const user = userEvent.setup();
	await user.click(trigger);
	await user.click(
		await screen.findByRole("option", { name: /text-embedding-ada-002/ }),
	);
	await waitFor(() => expect(trigger).toBeDisabled());
	// Model selection dismisses the popover while its trigger is disabled.
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
	trigger.blur();
	expect(document.body).toHaveFocus();
	finish({
		companyContext: { indexedWithCurrentModel: 2, total: 5 },
		projectContent: { indexed: 0 },
	});
	await screen.findByRole("alertdialog");
	await user.click(
		screen.getByRole("button", {
			name: copy.models.embeddingsChangeCancel,
		}),
	);
	await waitFor(() => expect(trigger).toHaveFocus());
});
