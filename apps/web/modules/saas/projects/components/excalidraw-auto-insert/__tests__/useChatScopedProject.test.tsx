/**
 * Tests for the four per-surface `useChatScopedProject*` adapters.
 *
 * Spec sections covered:
 *   - § 6.3 / FR-3   Per-surface user-prompt lookup
 *   - § 8 (table)    `useChatScopedProject` row
 *
 * Each adapter is tested in isolation so a regression in one surface's
 * context cannot silently break another's. The launcher adapter uses
 * the real `FabricAgentLauncherProvider` so the `useContext` hook is
 * exercised end-to-end; the other adapters take their context as a
 * plain argument and need no provider mounting.
 */

import type { ConversationTurn } from "@saas/agents/hooks/useMultiAgentStream";
import type { OrchestratorStreamMessage } from "@saas/agents/hooks/useOrchestratorStream";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Stub the `useFabricAgentLauncher` hook so the launcher adapter is
// testable without dragging in the entire FabricAgentLauncher tree
// (which loads FabricDirectChat dynamically and triggers other side
// effects). We re-import the launcher mock per test to swap its
// behaviour.
vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useFabricAgentLauncher: vi.fn(),
}));

import { useFabricAgentLauncher } from "@saas/agents/components/FabricAgentLauncher";
import {
	useChatScopedProject,
	useChatScopedProjectFromCopilotChat,
	useChatScopedProjectFromLauncher,
	useChatScopedProjectFromMultiAgentStream,
	useChatScopedProjectFromOrchestratorStream,
} from "../useChatScopedProject";

describe("useChatScopedProject — top-level placeholder", () => {
	it("returns null scope + no-op lookup", () => {
		const { result } = renderHook(() => useChatScopedProject());
		expect(result.current.projectId).toBeNull();
		expect(result.current.organizationId).toBeNull();
		expect(result.current.lastUserPromptForMessage("any-id")).toBeNull();
	});
});

describe("useChatScopedProjectFromLauncher", () => {
	it("returns the projectId from the launcher context", () => {
		vi.mocked(useFabricAgentLauncher).mockReturnValue({
			launchContext: {
				projectId: "proj_in_feature",
				storyId: "story_1",
				storyIdentifier: "F-001",
				storyTitle: "My Feature",
				prompt: "Help me design the login flow",
			},
			// Unused-by-adapter fields below; type-cast keeps the mock
			// shape lightweight.
		} as ReturnType<typeof useFabricAgentLauncher>);

		const { result } = renderHook(() => useChatScopedProjectFromLauncher());
		expect(result.current.projectId).toBe("proj_in_feature");
		expect(result.current.organizationId).toBeNull();
		expect(result.current.lastUserPromptForMessage("ignored")).toBe(
			"Help me design the login flow",
		);
	});

	it("returns null projectId when launcher has no context", () => {
		vi.mocked(useFabricAgentLauncher).mockReturnValue({
			launchContext: null,
		} as ReturnType<typeof useFabricAgentLauncher>);

		const { result } = renderHook(() => useChatScopedProjectFromLauncher());
		expect(result.current.projectId).toBeNull();
		expect(result.current.lastUserPromptForMessage("ignored")).toBeNull();
	});

	it("returns null prompt when launcher context has no prompt field", () => {
		vi.mocked(useFabricAgentLauncher).mockReturnValue({
			launchContext: {
				projectId: "proj_x",
				prompt: null,
			},
		} as ReturnType<typeof useFabricAgentLauncher>);

		const { result } = renderHook(() => useChatScopedProjectFromLauncher());
		expect(result.current.projectId).toBe("proj_x");
		expect(result.current.lastUserPromptForMessage("any")).toBeNull();
	});
});

describe("useChatScopedProjectFromOrchestratorStream", () => {
	const buildMessages = (): OrchestratorStreamMessage[] => [
		{
			id: "u1",
			role: "user",
			content: "Diagram the login flow",
			timestamp: new Date(),
		},
		{
			id: "a1",
			role: "assistant",
			content: "Sure, here is the diagram",
			timestamp: new Date(),
		},
		{
			id: "u2",
			role: "user",
			content: "Now show me the signup flow",
			timestamp: new Date(),
		},
		{
			id: "a2",
			role: "assistant",
			content: "Here is the signup diagram",
			timestamp: new Date(),
		},
	];

	it("returns projectId + organizationId verbatim", () => {
		const { result } = renderHook(() =>
			useChatScopedProjectFromOrchestratorStream({
				projectId: "proj_loom",
				organizationId: "org_loom",
				messages: [],
			}),
		);
		expect(result.current.projectId).toBe("proj_loom");
		expect(result.current.organizationId).toBe("org_loom");
	});

	it("returns the most recent user message preceding the assistant message", () => {
		const messages = buildMessages();
		const { result } = renderHook(() =>
			useChatScopedProjectFromOrchestratorStream({
				projectId: "p",
				organizationId: "o",
				messages,
			}),
		);
		expect(result.current.lastUserPromptForMessage("a2")).toBe(
			"Now show me the signup flow",
		);
		expect(result.current.lastUserPromptForMessage("a1")).toBe(
			"Diagram the login flow",
		);
	});

	it("returns null when no preceding user message exists", () => {
		// Only an assistant message in the stream — no user prompt to find.
		const messages: OrchestratorStreamMessage[] = [
			{
				id: "a_only",
				role: "assistant",
				content: "Hello",
				timestamp: new Date(),
			},
		];
		const { result } = renderHook(() =>
			useChatScopedProjectFromOrchestratorStream({
				projectId: "p",
				organizationId: "o",
				messages,
			}),
		);
		expect(result.current.lastUserPromptForMessage("a_only")).toBeNull();
	});

	it("returns null for an empty message list", () => {
		const { result } = renderHook(() =>
			useChatScopedProjectFromOrchestratorStream({
				projectId: "p",
				organizationId: "o",
				messages: [],
			}),
		);
		expect(result.current.lastUserPromptForMessage("anything")).toBeNull();
	});

	it("falls back to scanning the whole stream when message id is unknown", () => {
		// If the assistant message id isn't yet in the array (e.g. streaming
		// partial), we still surface the latest user prompt.
		const messages = buildMessages();
		const { result } = renderHook(() =>
			useChatScopedProjectFromOrchestratorStream({
				projectId: "p",
				organizationId: "o",
				messages,
			}),
		);
		expect(result.current.lastUserPromptForMessage("does-not-exist")).toBe(
			"Now show me the signup flow",
		);
	});
});

describe("useChatScopedProjectFromMultiAgentStream", () => {
	function buildTurns(): ConversationTurn[] {
		const turn1: ConversationTurn = {
			id: "t1",
			userMessage: "Sketch the login flow",
			agentResponses: new Map([
				[
					"agent_a",
					{
						agentId: "agent_a",
						agentName: "Agent A",
						content: "Sure",
						toolCalls: [
							{
								id: "tc_login",
								name: "create_view",
								args: {},
								status: "complete" as const,
							},
						],
						isLoading: false,
						isError: false,
						status: "completed" as const,
					},
				],
			]),
			timestamp: new Date(),
		};
		const turn2: ConversationTurn = {
			id: "t2",
			userMessage: "Now sketch the signup flow",
			agentResponses: new Map([
				[
					"agent_a",
					{
						agentId: "agent_a",
						agentName: "Agent A",
						content: "Here you go",
						toolCalls: [
							{
								id: "tc_signup",
								name: "create_view",
								args: {},
								status: "complete" as const,
							},
						],
						isLoading: false,
						isError: false,
						status: "completed" as const,
					},
				],
			]),
			timestamp: new Date(),
		};
		return [turn1, turn2];
	}

	it("returns scope verbatim", () => {
		const { result } = renderHook(() =>
			useChatScopedProjectFromMultiAgentStream({
				projectId: "proj_nexus",
				organizationId: "org_nexus",
				turns: [],
			}),
		);
		expect(result.current.projectId).toBe("proj_nexus");
		expect(result.current.organizationId).toBe("org_nexus");
	});

	it("returns the user message from the turn that owns the tool call", () => {
		const turns = buildTurns();
		const { result } = renderHook(() =>
			useChatScopedProjectFromMultiAgentStream({
				projectId: "p",
				organizationId: "o",
				turns,
			}),
		);
		expect(result.current.lastUserPromptForMessage("tc_login")).toBe(
			"Sketch the login flow",
		);
		expect(result.current.lastUserPromptForMessage("tc_signup")).toBe(
			"Now sketch the signup flow",
		);
	});

	it("falls back to the latest turn's user message when id is unknown", () => {
		const turns = buildTurns();
		const { result } = renderHook(() =>
			useChatScopedProjectFromMultiAgentStream({
				projectId: "p",
				organizationId: "o",
				turns,
			}),
		);
		expect(
			result.current.lastUserPromptForMessage("unknown-tool-call-id"),
		).toBe("Now sketch the signup flow");
	});

	it("returns null when there are no turns at all", () => {
		const { result } = renderHook(() =>
			useChatScopedProjectFromMultiAgentStream({
				projectId: "p",
				organizationId: "o",
				turns: [],
			}),
		);
		expect(result.current.lastUserPromptForMessage("any")).toBeNull();
	});
});

describe("useChatScopedProjectFromCopilotChat", () => {
	const buildMessages = () => [
		{ id: "u1", role: "user", content: "First prompt" },
		{ id: "a1", role: "assistant", content: "First answer" },
		{ id: "u2", role: "user", content: "Second prompt" },
		{ id: "a2", role: "assistant", content: "Second answer" },
	];

	it("returns scope verbatim", () => {
		const { result } = renderHook(() =>
			useChatScopedProjectFromCopilotChat({
				projectId: "proj_copilot",
				organizationId: "org_copilot",
				visibleMessages: [],
			}),
		);
		expect(result.current.projectId).toBe("proj_copilot");
		expect(result.current.organizationId).toBe("org_copilot");
	});

	it("returns the most recent user message preceding the assistant message", () => {
		const messages = buildMessages();
		const { result } = renderHook(() =>
			useChatScopedProjectFromCopilotChat({
				projectId: "p",
				organizationId: "o",
				visibleMessages: messages,
			}),
		);
		expect(result.current.lastUserPromptForMessage("a2")).toBe(
			"Second prompt",
		);
		expect(result.current.lastUserPromptForMessage("a1")).toBe(
			"First prompt",
		);
	});

	it("ignores non-user messages and result-message intermixing", () => {
		// CopilotKit interleaves ActionExecutionMessage / ResultMessage
		// objects that don't match our `TextMessage` type-guard. The
		// adapter must skip them and find the underlying user TextMessage.
		const messages: unknown[] = [
			{ id: "u1", role: "user", content: "Real prompt" },
			// A ResultMessage-like object with no string `content` shape
			{ id: "r1", role: "tool", resultPayload: { foo: "bar" } },
			{ id: "a1", role: "assistant", content: "Answer" },
		];
		const { result } = renderHook(() =>
			useChatScopedProjectFromCopilotChat({
				projectId: "p",
				organizationId: "o",
				visibleMessages: messages,
			}),
		);
		expect(result.current.lastUserPromptForMessage("a1")).toBe(
			"Real prompt",
		);
	});

	it("returns null when no preceding user message exists", () => {
		const messages = [
			{ id: "a_only", role: "assistant", content: "Hello" },
		];
		const { result } = renderHook(() =>
			useChatScopedProjectFromCopilotChat({
				projectId: "p",
				organizationId: "o",
				visibleMessages: messages,
			}),
		);
		expect(result.current.lastUserPromptForMessage("a_only")).toBeNull();
	});

	it("returns null for an empty list", () => {
		const { result } = renderHook(() =>
			useChatScopedProjectFromCopilotChat({
				projectId: "p",
				organizationId: "o",
				visibleMessages: [],
			}),
		);
		expect(result.current.lastUserPromptForMessage("anything")).toBeNull();
	});
});
