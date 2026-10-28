/**
 * Regression test for the Nexus composer dead end (staging finding 2026-07-06).
 *
 * With text typed and NO agent selected, the Send button stayed disabled and
 * Enter silently no-op'd — even though the send pipeline explicitly falls
 * back to the built-in "Nexus" assistant when the selection is empty (see
 * `agentsToUse` in `CopilotPage`'s send handler) and the placeholder promises
 * "or just ask anything". The composer must allow sending with an empty
 * agent selection so that fallback is actually reachable.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const models = vi.hoisted(() => vi.fn());
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: { registry: { list: vi.fn(async () => ({ agents: [] })) } },
		mcp: { configs: { list: vi.fn(async () => []) } },
		agentTemplates: {
			instances: {
				get: vi.fn(),
				list: vi.fn(async () => ({ instances: [] })),
			},
		},
		aiConfig: { models: { listAvailable: models } },
	},
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useEffectiveOrganizationId: (id: string | null | undefined) => id ?? null,
	useBasePath: () => "/app",
	useOrganizationContext: () => ({ organizationId: null }),
}));
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "u1", name: "Test User" } }),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
	AgentBrowserSection,
	ComposeInput,
	SelectedAgentsInline,
} from "@saas/ai/components/CopilotPage";

function wrap(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function renderComposer(value: string) {
	const onSend = vi.fn();
	wrap(
		<ComposeInput
			value={value}
			onChange={vi.fn()}
			onSend={onSend}
			isLoading={false}
			selectedAgents={[]}
			onRemoveAgent={vi.fn()}
			onOpenAgentPicker={vi.fn()}
		/>,
	);
	return { onSend };
}

describe("ComposeInput — sending without an explicit agent selection", () => {
	it("enables Send with text and no agent selected (default-assistant fallback)", async () => {
		const { onSend } = renderComposer("hello");

		const send = screen.getByRole("button", { name: "Send" });
		expect(send).not.toBeDisabled();

		await userEvent.click(send);
		expect(onSend).toHaveBeenCalledWith(
			expect.objectContaining({ message: "hello", files: [] }),
		);
	});

	it("sends on Enter with text and no agent selected", async () => {
		const { onSend } = renderComposer("hello");

		const textarea = screen.getByRole("textbox");
		textarea.focus();
		await userEvent.keyboard("{Enter}");

		expect(onSend).toHaveBeenCalledWith(
			expect.objectContaining({ message: "hello", files: [] }),
		);
	});

	it("keeps Send disabled when there is no content", () => {
		renderComposer("   ");

		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	});
});

it.each(["own", "shared", null])(
	"shows provider status in Nexus chips and header for plan source %s",
	async (source) => {
		models.mockResolvedValue({
			models: [],
			chatgptPlan: source ? { source, models: [] } : null,
		});
		const selectedAgents = [
			{
				agentId: "model:claude-sonnet-5",
				name: "Claude Sonnet 5",
				modelOverride: "claude-sonnet-5",
			},
		];
		wrap(
			<>
				<SelectedAgentsInline
					selectedAgents={selectedAgents}
					organizationId="example-org"
				/>
				<ComposeInput
					value=""
					onChange={vi.fn()}
					onSend={vi.fn()}
					isLoading={false}
					selectedAgents={selectedAgents}
					onRemoveAgent={vi.fn()}
					onOpenAgentPicker={vi.fn()}
					organizationId="example-org"
				/>
			</>,
		);
		await waitFor(() => expect(models).toHaveBeenCalled());
		if (source) {
			await waitFor(() =>
				expect(screen.getAllByText(/not applied/)).toHaveLength(2),
			);
			const note =
				source === "shared"
					? "Your organization's shared ChatGPT plan is on — ask an organization admin to turn it off to use Claude Sonnet 5."
					: "Your ChatGPT plan is on — turn it off to use Claude Sonnet 5.";
			expect(screen.getAllByTitle(note)).toHaveLength(2);
			expect(screen.getByRole("textbox")).not.toHaveAttribute(
				"placeholder",
				"Ask Claude Sonnet 5...",
			);
		} else {
			expect(screen.queryByText(/not applied/)).toBeNull();
			expect(screen.getByRole("textbox")).toHaveAttribute(
				"placeholder",
				"Ask Claude Sonnet 5...",
			);
		}
	},
);

it.each([true, false])(
	"offers provider models in the Nexus catalog only without a serving plan: %s",
	async (hasPlan) => {
		models.mockReset().mockResolvedValue({
			models: [
				{
					canonicalName: "claude-sonnet-5",
					displayName: "Claude Sonnet 5",
					vendor: "Anthropic",
					speedTier: "fast",
					contextWindow: 200000,
				},
			],
			chatgptPlan: hasPlan ? { source: "shared", models: [] } : null,
		});
		wrap(
			<AgentBrowserSection
				organizationId="example-org"
				selectedAgentIds={["model:claude-sonnet-5"]}
				onToggleAgent={vi.fn()}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Models", exact: true }),
		);
		if (hasPlan) {
			expect(
				await screen.findByText(
					"ChatGPT plan is on. Choose a plan model in the chat picker.",
				),
			).toBeInTheDocument();
			expect(screen.queryByText("Claude Sonnet 5")).toBeNull();
		} else {
			expect(
				(await screen.findByText("Claude Sonnet 5")).closest("button"),
			).toBeInTheDocument();
		}
	},
);
