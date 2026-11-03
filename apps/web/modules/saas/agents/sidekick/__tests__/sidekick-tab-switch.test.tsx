import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ runtimeSidekick: false }));

// The real Sidekick and its chat transport run here: the Sidekick sends an opening
// message on mount, so remounting it on a tab switch costs a model call.
vi.mock("@saas/agents/sidekick/SidekickFormContext", () => ({
	SidekickFormProvider: ({ children }: { children: ReactNode }) => children,
	useSidekickForm: () => ({ getSnapshot: () => ({}) }),
}));
vi.mock("@saas/agents/sidekick/SidekickSuggestionsContext", () => ({
	SidekickSuggestionsProvider: ({ children }: { children: ReactNode }) =>
		children,
	useSidekickSuggestions: () => ({ pendingSuggestions: [] }),
}));
vi.mock("@saas/ai/hooks/useLimitToast", () => ({
	useLimitToast: () => vi.fn(),
}));
vi.mock("@saas/payments/lib/ai-usage-limit-toast", () => ({
	isAiUsageLimitExceededPayload: () => false,
	useShowAiUsageLimitToast: () => vi.fn(),
}));
vi.mock("@saas/agents/sidekick/editor/InstructionsEditor", () => ({
	InstructionsEditor: () => null,
}));
vi.mock("@shared/hooks/use-available-models", () => ({
	useAvailableModels: () => ({ modelsByProvider: {}, sortedProviders: [] }),
	getProviderDisplayName: (provider: string) => provider,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agentTemplates: {
			instances: {
				list: async () => ({ instances: [] }),
				create: vi.fn(),
				update: vi.fn(),
			},
		},
		agents: { registry: { get: vi.fn() } },
		workflows: {
			integrations: { list: async () => ({ integrations: [] }) },
		},
		documentWorkspaces: { list: async () => ({ workspaces: [] }) },
		mcp: { configs: { list: async () => ({ configs: [] }) } },
		skills: { list: async () => ({ skills: [] }) },
	},
}));
vi.mock("@shared/lib/orpc-query-utils", async () => {
	const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
	const { orpcClient } = await import("@shared/lib/orpc-client");
	return { orpc: createTanstackQueryUtils(orpcClient) };
});
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useEffectiveOrganizationId: (id?: string | null) =>
		id === undefined ? "example-org" : id,
	useContextPath: (path: string) => `/app/example-org/${path}`,
	useOrganizationContext: () => ({ organizationId: "example-org" }),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "COPILOTKIT_SIDEKICK_CHAT" && flags.runtimeSidekick,
}));
vi.mock("@saas/workflows/lib/plugins", () => ({
	getAllIntegrations: () => [],
	getIntegrationTypes: () => [],
	getIntegration: () => undefined,
}));
vi.mock("@saas/agent-templates/components/DataSourcesSheet", () => ({
	DataSourcesSheet: () => null,
}));
vi.mock("@saas/agent-templates/components/ToolsSheet", () => ({
	ToolsSheet: () => null,
}));
vi.mock("@saas/agent-templates/components/TriggersSheet", () => ({
	TriggersSheet: () => null,
}));
vi.mock("@saas/agent-templates/components/WorkspacesSheet", () => ({
	WorkspacesSheet: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CreateAgentPage } from "@saas/agent-templates/components/CreateAgentPage";
import { AgentBuilderPage } from "@saas/agents/sidekick/AgentBuilderPage";
import { TooltipProvider } from "@ui/components/tooltip";

// jsdom has no scrolling; the Sidekick scrolls its message list.
Element.prototype.scrollTo = vi.fn();

const pages = {
	CreateAgentPage: {
		otherTab: "Guide",
		otherContent: "Agent Setup Guide",
		element: (
			<CreateAgentPage
				template={{
					id: "example-template",
					slug: "example-template",
					name: "Example Template",
					displayName: "Example Template",
					description: "Example template description",
					category: "GENERAL",
					heroEmojis: [],
					instructions: "Use project context.",
				}}
				organizationId="example-org"
				basePath="/app/example-org"
				mode="create"
			/>
		),
	},
	AgentBuilderPage: {
		otherTab: "Preview",
		otherContent: "Preview will be available in a future update.",
		element: <AgentBuilderPage />,
	},
};

const fetchMock = vi.fn(
	(_input: RequestInfo | URL) => new Promise<never>(() => {}),
);
// Both transports' endpoints (stream route, agent runtime) name the Sidekick.
const sidekickCalls = () =>
	fetchMock.mock.calls.filter(([input]) => String(input).includes("sidekick"))
		.length;

beforeEach(() => {
	fetchMock.mockClear();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe.each(["legacy", "runtime"] as const)("%s transport", (transport) => {
	beforeEach(() => {
		flags.runtimeSidekick = transport === "runtime";
	});

	it.each(Object.keys(pages) as (keyof typeof pages)[])(
		"%s sends the opening message once across tab switches",
		async (name) => {
			const { otherTab, otherContent, element } = pages[name];
			const view = render(
				<QueryClientProvider client={new QueryClient()}>
					<TooltipProvider>{element}</TooltipProvider>
				</QueryClientProvider>,
			);
			await waitFor(() => expect(sidekickCalls()).toBe(1));
			const input = view.getByPlaceholderText(
				"Ask Sidekick for suggestions...",
			);
			expect(input).toBeVisible();

			// A remounted Sidekick would re-send after its 500 ms auto-start delay.
			vi.useFakeTimers();
			await act(async () => {
				fireEvent.click(view.getByRole("button", { name: otherTab }));
			});
			expect(view.getByText(otherContent)).toBeVisible();
			expect(input).not.toBeVisible();

			await act(async () => {
				fireEvent.click(view.getByRole("button", { name: "Sidekick" }));
				await vi.advanceTimersByTimeAsync(600);
			});
			expect(sidekickCalls()).toBe(1);

			expect(view.queryByText(otherContent)).toBeNull();
			expect(
				view.getByPlaceholderText("Ask Sidekick for suggestions..."),
			).toBe(input);
			expect(input).toBeVisible();
		},
	);
});
