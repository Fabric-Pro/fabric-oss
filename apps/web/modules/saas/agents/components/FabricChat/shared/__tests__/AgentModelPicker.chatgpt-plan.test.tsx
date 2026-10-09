/**
 * The model picker when a ChatGPT plan runs the member's work (Fizzy #2770):
 * the work never reaches an API provider, so the picker lists the models the
 * serving plan serves instead (F13). The organization's model is marked
 * "Default"; picking another applies to this chat only — it is kept in the
 * chat, never saved — and picking the default again clears it.
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
import { AgentModelPicker } from "../AgentModelPicker";
import type { SelectedAgent } from "../agent-selection";
import {
	isModelSelectionId,
	selectionToPersist,
	shouldPersistAgentSelection,
} from "../agent-selection";

const api = vi.hoisted(() => ({ models: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: { registry: { list: vi.fn() } },
		aiConfig: { models: { listAvailable: api.models } },
		agentTemplates: { instances: { list: vi.fn(), get: vi.fn() } },
	},
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useEffectiveOrganizationId: (id: string) => id,
}));
vi.mock("../AgentIdentity", () => ({
	AgentAvatar: () => null,
	VendorLogo: () => null,
}));

const PLAN_MODELS = [
	{
		canonicalName: "gpt-6-astra",
		slug: "gpt-6-astra",
		displayName: "GPT-6 Astra (ChatGPT plan)",
		isDefault: false,
		newest: true,
	},
	{
		canonicalName: "gpt-6.1-sol",
		slug: "gpt-6.1-sol",
		displayName: "GPT-6.1 Sol (ChatGPT plan)",
		isDefault: true,
		newest: false,
	},
];

function openModelPicker(
	selectedAgents: SelectedAgent[] = [],
	onToggleAgent = vi.fn(),
) {
	render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<AgentModelPicker
				catalog="models"
				onToggleAgent={onToggleAgent}
				organizationId="example-org"
				selectedAgents={selectedAgents}
			/>
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Model" }));
	return onToggleAgent;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("AgentModelPicker — work on a ChatGPT plan", () => {
	it("lists the serving plan's models, the default and the newest marked, and no provider models", async () => {
		api.models.mockResolvedValue({
			models: [
				{
					canonicalName: "claude-sonnet-5",
					displayName: "Claude Sonnet 5",
					vendor: "Anthropic",
				},
			],
			chatgptPlan: {
				model: "gpt-6.1-sol",
				source: "shared",
				models: PLAN_MODELS,
			},
		});
		openModelPicker();
		const plan = await screen.findByTestId("agent-picker-chatgpt-plan");
		expect(plan).toHaveTextContent(
			"Runs on your organization's shared ChatGPT plan",
		);
		const sol = within(plan).getByRole("button", {
			name: /GPT-6.1 Sol \(ChatGPT plan\)/,
		});
		expect(sol).toHaveTextContent("Default");
		expect(sol).toHaveAttribute("aria-pressed", "true");
		expect(
			within(plan).getByRole("button", { name: /GPT-6 Astra/ }),
		).toHaveTextContent("Newest");
		expect(screen.queryByText("Claude Sonnet 5")).toBeNull();
		expect(
			screen.getByText(/A model picked here applies to this chat only/),
		).toBeInTheDocument();
	});

	// Fizzy #2770: a spent plan still runs the member's work once it resets;
	// the menu says so instead of "No models configured".
	it("says until when a spent plan serves nothing, without provider models", async () => {
		const until = new Date();
		until.setHours(17, 50, 0, 0);
		api.models.mockResolvedValue({
			models: [
				{
					canonicalName: "claude-sonnet-5",
					displayName: "Claude Sonnet 5",
					vendor: "Anthropic",
				},
			],
			chatgptPlan: {
				model: "",
				source: "shared",
				models: [],
				spent: { until },
			},
		});
		openModelPicker();
		const notice = await screen.findByTestId(
			"agent-picker-chatgpt-plan-spent",
		);
		expect(notice).toHaveTextContent(/^Spent until \d{2}:\d{2}/);
		expect(notice.textContent).toContain(
			new Intl.DateTimeFormat(undefined, {
				hour: "2-digit",
				minute: "2-digit",
			}).format(until),
		);
		expect(screen.queryByText("No models configured")).toBeNull();
		expect(screen.queryByText("Claude Sonnet 5")).toBeNull();
		expect(
			screen.getByText(/A model picked here applies to this chat only/),
		).toBeInTheDocument();
	});

	it("keeps the chat's plan pick while the plan is spent", async () => {
		api.models.mockResolvedValue({
			models: [],
			chatgptPlan: {
				model: "",
				source: "own",
				models: [],
				spent: { until: null },
			},
		});
		const onToggle = openModelPicker([
			{
				agentId: "plan-model:gpt-6-astra",
				name: "GPT-6 Astra (ChatGPT plan)",
				modelOverride: "chatgpt-plan:gpt-6-astra",
				chatOnly: true,
			},
		]);
		await screen.findByText("Spent until its usage resets");
		expect(onToggle).not.toHaveBeenCalled();
	});

	it("asks for the plan's model of the work Advisor runs: tool calling", async () => {
		api.models.mockResolvedValue({ models: [], chatgptPlan: null });
		openModelPicker();
		await screen.findByText("No models configured");
		expect(api.models).toHaveBeenCalledWith(
			expect.objectContaining({
				taskType: "CHAT",
				planTaskType: "TOOL_CALLING",
			}),
		);
	});

	it("picks a model for this chat only", async () => {
		api.models.mockResolvedValue({
			models: [],
			chatgptPlan: {
				model: "gpt-6.1-sol",
				source: "own",
				models: PLAN_MODELS,
			},
		});
		const onToggleAgent = openModelPicker();
		fireEvent.click(
			await screen.findByRole("button", { name: /GPT-6 Astra/ }),
		);
		const picked = onToggleAgent.mock.calls[0]?.[0] as SelectedAgent;
		// The plan marker keeps it off every non-plan path.
		expect(picked).toMatchObject({
			agentId: "plan-model:gpt-6-astra",
			modelOverride: "chatgpt-plan:gpt-6-astra",
			chatOnly: true,
		});
		// Never saved as the member's selection, nor is clearing it.
		expect(shouldPersistAgentSelection(null, picked)).toBe(false);
		expect(shouldPersistAgentSelection(picked, null)).toBe(false);
	});

	it("clears the chat's choice when the default is picked again", async () => {
		api.models.mockResolvedValue({
			models: [],
			chatgptPlan: {
				model: "gpt-6.1-sol",
				source: "own",
				models: PLAN_MODELS,
			},
		});
		const picked: SelectedAgent = {
			agentId: "plan-model:gpt-6-astra",
			name: "GPT-6 Astra (ChatGPT plan)",
			modelOverride: "chatgpt-plan:gpt-6-astra",
			chatOnly: true,
		};
		const onToggleAgent = openModelPicker([picked]);
		expect(
			await screen.findByRole("button", { name: /GPT-6 Astra/ }),
		).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(screen.getByRole("button", { name: /GPT-6.1 Sol/ }));
		expect(onToggleAgent).toHaveBeenCalledWith(picked);
	});

	// A provider model saved before the plan is not the plan's choice: the
	// menu ticks the default, and picking that model makes a chat-only pick
	// instead of switching the saved selection off.
	it("treats a saved provider model as no plan pick", async () => {
		api.models.mockResolvedValue({
			models: [],
			chatgptPlan: {
				model: "gpt-6.1-sol",
				source: "own",
				models: PLAN_MODELS,
			},
		});
		const saved: SelectedAgent = {
			agentId: "model:gpt-6-astra",
			name: "GPT-6 Astra",
			modelOverride: "gpt-6-astra",
		};
		const onToggleAgent = openModelPicker([saved]);
		expect(
			await screen.findByRole("button", { name: /GPT-6.1 Sol/ }),
		).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(screen.getByRole("button", { name: /GPT-6 Astra/ }));
		const picked = onToggleAgent.mock.calls[0]?.[0] as SelectedAgent;
		expect(picked).toMatchObject({
			agentId: "plan-model:gpt-6-astra",
			chatOnly: true,
		});
		expect(shouldPersistAgentSelection(saved, picked)).toBe(false);
	});

	it("drops a pick the serving plan no longer lists, unsaved", async () => {
		api.models.mockResolvedValue({
			models: [],
			chatgptPlan: {
				model: "gpt-6.1-sol",
				source: "own",
				models: [PLAN_MODELS[1]],
			},
		});
		const stale: SelectedAgent = {
			agentId: "plan-model:gpt-6-astra",
			name: "GPT-6 Astra (ChatGPT plan)",
			modelOverride: "chatgpt-plan:gpt-6-astra",
			chatOnly: true,
		};
		const onToggleAgent = openModelPicker([stale]);
		await waitFor(() => expect(onToggleAgent).toHaveBeenCalledWith(stale));
		expect(shouldPersistAgentSelection(stale, null)).toBe(false);
	});

	it("keeps the empty state when no plan and no model is available", async () => {
		api.models.mockResolvedValue({ models: [], chatgptPlan: null });
		openModelPicker();
		expect(await screen.findByText("No models configured")).toBeTruthy();
	});
});

// Nexus renders the same picker with a multi-agent selection.
describe("a plan pick in a multi-agent selection (Nexus)", () => {
	const planPick: SelectedAgent = {
		agentId: "plan-model:gpt-6-astra",
		name: "GPT-6 Astra (ChatGPT plan)",
		modelOverride: "chatgpt-plan:gpt-6-astra",
		chatOnly: true,
	};
	const saved: SelectedAgent = { agentId: "data_analyst", name: "Analyst" };

	it("is a model, not an agent to enable", () => {
		expect(isModelSelectionId(planPick.agentId)).toBe(true);
		expect(isModelSelectionId("model:claude-sonnet-5")).toBe(true);
		expect(isModelSelectionId(saved.agentId)).toBe(false);
	});

	it("is never saved, and picking or clearing it saves nothing", () => {
		expect(selectionToPersist(planPick, [saved, planPick])).toBeNull();
		expect(selectionToPersist(planPick, [saved])).toBeNull();
		expect(selectionToPersist(saved, [saved, planPick])).toEqual([saved]);
	});
});
