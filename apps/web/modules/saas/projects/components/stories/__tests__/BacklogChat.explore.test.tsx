/**
 * Explore intake for the backlog chat (plan Slice 6).
 *
 * The CopilotKit runtime is mocked: the sidebar renders its `labels` and
 * every `useCopilotAction` registration is recorded so the `analyze_backlog`
 * handler can be invoked directly. Verifies that under an EXPLORE project:
 *   - the empty state asks for the hunch, with no document / integration
 *     requirement;
 *   - `projects.backlog.startAnalysis` is called with `intakeMode: "explore"`;
 * and that every other profile keeps the standard chat and omits the mode.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks ----------------------------------------------------------------

const registeredActions = vi.hoisted(
	() =>
		new Map<
			string,
			{ handler?: (args: Record<string, unknown>) => unknown }
		>(),
);
const startAnalysis = vi.hoisted(() => vi.fn());
const projectState = vi.hoisted(() => ({
	engagementProfile: "EXPLORE" as string,
}));

vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({ state: undefined, setState: vi.fn() }),
	useCopilotAction: (action: {
		name: string;
		handler?: (args: Record<string, unknown>) => unknown;
	}) => {
		registeredActions.set(action.name, { handler: action.handler });
	},
	// BacklogChat reads the live chat through CopilotChatSessionProvider.
	useCopilotChatInternal: () => ({ messages: [] }),
}));

vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({
		labels,
		suggestions,
		children,
	}: {
		labels: { title: string; initial: string };
		suggestions?: Array<{ title: string; message: string }>;
		children?: ReactNode;
	}) => (
		<div>
			<p data-testid="chat-title">{labels.title}</p>
			<p data-testid="chat-initial">{labels.initial}</p>
			<ul data-testid="chat-suggestions">
				{(suggestions ?? []).map((s) => (
					<li key={s.title}>{s.title}</li>
				))}
			</ul>
			{children}
		</div>
	),
}));
vi.mock("@copilotkit/react-ui/styles.css", () => ({}));
vi.mock("@saas/shared/components/copilot/CopilotAssistantMessage", () => ({
	CopilotAssistantMessage: () => null,
	CopilotAssistantMessageForBacklogUpdater: () => null,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/acme",
	}),
}));
vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			backlog: {
				startAnalysis: (...args: unknown[]) => startAnalysis(...args),
			},
		},
	},
}));
vi.mock("../BacklogChangeProposal", () => ({
	BacklogChangeProposal: () => null,
}));
vi.mock("../ReviewSourcesSelector", () => ({
	ReviewSourcesSelector: () => null,
}));

// Import AFTER mocks.
import type { EngagementProfile } from "@repo/database";
import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { BacklogChat } from "../BacklogChat";

function renderChat() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<CopilotChatSessionProvider>
				<BacklogChat
					projectId="p1"
					projectName="Heritage"
					engagementProfile={
						projectState.engagementProfile as EngagementProfile
					}
					hasTeamsIntegration={false}
					hasSlackIntegration={false}
					hasNotionIntegration={false}
					hasPMTool={false}
					backlogSummary="0 features"
					onClose={() => {}}
					onChangesApplied={() => {}}
				/>
			</CopilotChatSessionProvider>
		</QueryClientProvider>,
	);
}

describe("BacklogChat explore intake", () => {
	beforeEach(() => {
		registeredActions.clear();
		startAnalysis.mockReset();
		// Returning no workflowId makes the handler return before polling.
		startAnalysis.mockResolvedValue({ workflowId: null });
		projectState.engagementProfile = "EXPLORE";
	});

	it("shows the explore empty state with no document or integration requirement", async () => {
		renderChat();

		await waitFor(() => {
			expect(screen.getByTestId("chat-initial")).toHaveTextContent(
				"Describe the hunch. I'll propose the first spikes.",
			);
		});
		const initial = screen.getByTestId("chat-initial").textContent ?? "";
		expect(initial).toMatch(/no document needed/);
		expect(initial).not.toMatch(/Connect Teams, Slack, or Notion/);
		expect(screen.getByTestId("chat-title")).toHaveTextContent(
			"Explore: first spikes",
		);
		expect(screen.getByTestId("chat-suggestions")).toHaveTextContent(
			"Start from a hunch",
		);
	});

	it("starts the analysis in explore mode", async () => {
		renderChat();
		await waitFor(() => {
			expect(screen.getByTestId("chat-initial")).toHaveTextContent(
				"Describe the hunch",
			);
		});

		const analyze = registeredActions.get("analyze_backlog");
		expect(analyze?.handler).toBeTypeOf("function");
		await analyze?.handler?.({
			userPrompt: "Small lenders want faster intake.",
		});

		expect(startAnalysis).toHaveBeenCalledTimes(1);
		expect(startAnalysis.mock.calls[0]?.[0]).toMatchObject({
			projectId: "p1",
			organizationId: "org-1",
			intakeMode: "explore",
			userPrompt: "Small lenders want faster intake.",
		});
	});

	it("keeps the standard chat and omits intakeMode for non-EXPLORE profiles", async () => {
		projectState.engagementProfile = "GOVERNED";
		renderChat();

		await waitFor(() => {
			expect(screen.getByTestId("chat-title")).toHaveTextContent(
				"AI Backlog Update",
			);
		});
		// Give the project query a tick to settle so the mode is final.
		await waitFor(() => {
			expect(screen.getByTestId("chat-initial")).toHaveTextContent(
				"Connect Teams, Slack, or Notion",
			);
		});

		const analyze = registeredActions.get("analyze_backlog");
		await analyze?.handler?.({ userPrompt: "Review the last sprint." });

		expect(startAnalysis).toHaveBeenCalledTimes(1);
		const input = startAnalysis.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(input.intakeMode).toBeUndefined();
		expect(input.userPrompt).toBe("Review the last sprint.");
	});
});
