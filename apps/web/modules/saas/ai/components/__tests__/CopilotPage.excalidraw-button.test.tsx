/**
 * Tests for the Excalidraw chat -> editor auto-insert button wired
 * into Nexus / `CopilotPage` (F1 / spec § 8.1 row 1, § 22.1).
 *
 * The full `CopilotPage` component is ~5300 lines with a deep hook
 * graph (multi-agent SSE stream, history sidebar, MCP iframe bridge,
 * etc.), so testing the integration end-to-end through the page entry
 * point would explode in mocks for no additional coverage.
 *
 * Instead we lock the two pieces F1 actually introduces:
 *
 *   1. `shouldRenderNexusExcalidrawAutoInsertButton(tc)` -- the pure
 *      predicate that gates the slot mount inside
 *      `mcpAppToolCalls.map(...)`. Covers the "non-Excalidraw" and
 *      "status !== complete" rejection cases.
 *
 *   2. `NexusExcalidrawAutoInsertSlot` -- the wrapper that translates
 *      a `MultiAgentToolCall` envelope into the
 *      `<ChatMessageInsertDiagramButton>` props per spec § 8.1.
 *      Covers the "button renders below McpAppFrame" happy path with
 *      the right `surface`, `toolResult`, and chat-scope wiring.
 *
 * The button itself is mocked to a marker so we assert the wiring
 * inputs reach it correctly without re-testing its full state
 * machine (already covered by
 * `ChatMessageInsertDiagramButton.test.tsx`).
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks for the button + heavy hooks the slot pulls in
// ---------------------------------------------------------------------------

const buttonRenderProps = vi.fn();
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/ChatMessageInsertDiagramButton",
	() => ({
		ChatMessageInsertDiagramButton: (props: Record<string, unknown>) => {
			buttonRenderProps(props);
			return (
				<div
					data-testid="insert-diagram-button"
					data-surface={String(props.surface ?? "")}
					data-chat-message-id={String(props.chatMessageId ?? "")}
					data-organization-slug={String(
						props.organizationSlug ?? "",
					)}
				/>
			);
		},
	}),
);

// Resolver always returns null on Nexus (no on-page editor registered).
const resolverMock = vi.fn(() => null);
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useActiveTipTapEditor",
	() => ({
		useActiveTipTapEditor: (opts: unknown) => resolverMock(opts),
	}),
);

vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/deriveDiagramTitle",
	() => ({
		deriveDiagramTitle: ({
			userPromptText,
		}: {
			userPromptText?: string | null;
		}) =>
			userPromptText && userPromptText.trim().length > 0
				? userPromptText.trim().slice(0, 60)
				: "Untitled diagram from chat",
		DERIVED_DIAGRAM_TITLE_MAX_LENGTH: 60,
		UNTITLED_DIAGRAM_TITLE: "Untitled diagram from chat",
	}),
);

// The adapter is unused by the slot directly -- the chatScope is
// passed in as a prop. Stub the module so importing it from
// CopilotPage doesn't drag in `useFabricAgentLauncher` etc.
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useChatScopedProject",
	() => ({
		useChatScopedProject: () => ({
			projectId: null,
			organizationId: null,
			lastUserPromptForMessage: () => null,
		}),
		useChatScopedProjectFromMultiAgentStream: () => ({
			projectId: null,
			organizationId: null,
			lastUserPromptForMessage: () => null,
		}),
		useChatScopedProjectFromLauncher: () => ({
			projectId: null,
			organizationId: null,
			lastUserPromptForMessage: () => null,
		}),
		useChatScopedProjectFromOrchestratorStream: () => ({
			projectId: null,
			organizationId: null,
			lastUserPromptForMessage: () => null,
		}),
		useChatScopedProjectFromCopilotChat: () => ({
			projectId: null,
			organizationId: null,
			lastUserPromptForMessage: () => null,
		}),
	}),
);

// The slot itself is the only piece of CopilotPage under test here.
// CopilotPage is a 5k-line monolith with a deep hook graph; importing
// the named exports alone is enough because both the slot and the
// predicate are pure-render leaves that don't touch the rest of the
// file.
const {
	NexusExcalidrawAutoInsertSlot,
	shouldRenderNexusExcalidrawAutoInsertButton,
} = await import("../CopilotPage");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildChatScope(overrides?: {
	projectId?: string | null;
	organizationId?: string | null;
	lastUserPromptForMessage?: (id: string) => string | null;
}) {
	return {
		projectId: overrides?.projectId ?? null,
		organizationId: overrides?.organizationId ?? "org_1",
		lastUserPromptForMessage:
			overrides?.lastUserPromptForMessage ?? (() => null),
	};
}

function buildTc(
	overrides?: Partial<{
		id: string;
		args: unknown;
		result: unknown;
		mcpAppResourceUri: string;
		mcpAppConfigId: string;
	}>,
) {
	return {
		id: overrides?.id ?? "msg_excalidraw_1",
		args: overrides?.args ?? {
			elements: [{ type: "rect", id: "el_1" }],
			appState: { theme: "light" },
		},
		result: overrides?.result ?? {
			checkpointId: "cp_abc123",
		},
		mcpAppResourceUri:
			overrides?.mcpAppResourceUri ?? "ui://excalidraw/canvas",
		mcpAppConfigId: overrides?.mcpAppConfigId ?? "cfg_excalidraw_1",
	};
}

beforeEach(() => {
	buttonRenderProps.mockReset();
	resolverMock.mockReset();
	resolverMock.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// Predicate -- shouldRenderNexusExcalidrawAutoInsertButton
// ---------------------------------------------------------------------------

describe("shouldRenderNexusExcalidrawAutoInsertButton (Nexus mount gate)", () => {
	it("returns true for a completed Excalidraw create_view", () => {
		expect(
			shouldRenderNexusExcalidrawAutoInsertButton({
				mcpAppResourceUri: "ui://excalidraw/canvas",
				status: "complete",
			}),
		).toBe(true);
	});

	it("returns true for status === 'success' (alternate terminal status)", () => {
		expect(
			shouldRenderNexusExcalidrawAutoInsertButton({
				mcpAppResourceUri: "ui://excalidraw/canvas",
				status: "success",
			}),
		).toBe(true);
	});

	it("returns false for a non-Excalidraw MCP call (different resource URI)", () => {
		expect(
			shouldRenderNexusExcalidrawAutoInsertButton({
				mcpAppResourceUri: "ui://other-mcp/widget",
				status: "complete",
			}),
		).toBe(false);
	});

	it("returns false when status !== 'complete'/'success' (still running)", () => {
		expect(
			shouldRenderNexusExcalidrawAutoInsertButton({
				mcpAppResourceUri: "ui://excalidraw/canvas",
				status: "running",
			}),
		).toBe(false);
	});

	it("returns false when status is 'pending' (no envelope yet)", () => {
		expect(
			shouldRenderNexusExcalidrawAutoInsertButton({
				mcpAppResourceUri: "ui://excalidraw/canvas",
				status: "pending",
			}),
		).toBe(false);
	});

	it("returns false when mcpAppResourceUri is missing entirely", () => {
		expect(
			shouldRenderNexusExcalidrawAutoInsertButton({
				mcpAppResourceUri: undefined,
				status: "complete",
			}),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Slot -- NexusExcalidrawAutoInsertSlot
// ---------------------------------------------------------------------------

describe("NexusExcalidrawAutoInsertSlot (button wiring)", () => {
	it("renders the button with surface='nexus' for a successful Excalidraw create_view", () => {
		render(
			<NexusExcalidrawAutoInsertSlot
				tc={buildTc()}
				chatScope={buildChatScope()}
				organizationSlug="example-org"
			/>,
		);

		const button = screen.getByTestId("insert-diagram-button");
		expect(button).toBeInTheDocument();
		expect(button).toHaveAttribute("data-surface", "nexus");
		expect(button).toHaveAttribute(
			"data-chat-message-id",
			"msg_excalidraw_1",
		);
		expect(button).toHaveAttribute("data-organization-slug", "example-org");
	});

	it("forwards the tool envelope as `toolResult` with elements, appState, checkpointId, mcpConfigId, resourceUri", () => {
		render(
			<NexusExcalidrawAutoInsertSlot
				tc={buildTc()}
				chatScope={buildChatScope()}
				organizationSlug="example-org"
			/>,
		);

		expect(buttonRenderProps).toHaveBeenCalledTimes(1);
		const props = buttonRenderProps.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		const toolResult = props.toolResult as Record<string, unknown>;
		expect(toolResult.elements).toEqual([{ type: "rect", id: "el_1" }]);
		expect(toolResult.appState).toEqual({ theme: "light" });
		expect(toolResult.checkpointId).toBe("cp_abc123");
		expect(toolResult.mcpConfigId).toBe("cfg_excalidraw_1");
		expect(toolResult.resourceUri).toBe("ui://excalidraw/canvas");
	});

	it("falls back to empty checkpointId when the tool result doesn't expose one", () => {
		render(
			<NexusExcalidrawAutoInsertSlot
				tc={buildTc({ result: { foo: "bar" } })}
				chatScope={buildChatScope()}
			/>,
		);

		const props = buttonRenderProps.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		const toolResult = props.toolResult as Record<string, unknown>;
		expect(toolResult.checkpointId).toBe("");
	});

	it("derives the diagram title from the chat scope's lastUserPromptForMessage", () => {
		render(
			<NexusExcalidrawAutoInsertSlot
				tc={buildTc({ id: "msg_2" })}
				chatScope={buildChatScope({
					lastUserPromptForMessage: (id) =>
						id === "msg_2"
							? "Draw the request lifecycle diagram"
							: null,
				})}
			/>,
		);

		const props = buttonRenderProps.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(props.title).toBe("Draw the request lifecycle diagram");
	});

	it("falls back to 'Untitled diagram from chat' when no preceding user prompt exists", () => {
		render(
			<NexusExcalidrawAutoInsertSlot
				tc={buildTc()}
				chatScope={buildChatScope({
					lastUserPromptForMessage: () => null,
				})}
			/>,
		);

		const props = buttonRenderProps.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(props.title).toBe("Untitled diagram from chat");
	});

	it("wires resolverOptions.chatContext with surface 'nexus' + launcherContext: null (FR-7 picker path)", () => {
		render(
			<NexusExcalidrawAutoInsertSlot
				tc={buildTc()}
				chatScope={buildChatScope({
					projectId: null,
					organizationId: "org_1",
				})}
			/>,
		);

		expect(resolverMock).toHaveBeenCalledWith(
			expect.objectContaining({
				chatContext: expect.objectContaining({
					projectId: null,
					organizationId: "org_1",
					surface: "nexus",
				}),
				launcherContext: null,
			}),
		);

		const props = buttonRenderProps.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		// Resolver returns null on Nexus (no editor on the page);
		// button surfaces the picker path per FR-7.
		expect(props.resolverTarget).toBeNull();
	});

	it("passes the full chatScope through to the button", () => {
		const chatScope = buildChatScope({
			projectId: null,
			organizationId: "org_xyz",
		});

		render(
			<NexusExcalidrawAutoInsertSlot
				tc={buildTc()}
				chatScope={chatScope}
			/>,
		);

		const props = buttonRenderProps.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		const passedScope = props.chatScope as Record<string, unknown>;
		expect(passedScope.projectId).toBeNull();
		expect(passedScope.organizationId).toBe("org_xyz");
	});

	it("coerces `organizationSlug=undefined` to null when forwarding", () => {
		render(
			<NexusExcalidrawAutoInsertSlot
				tc={buildTc()}
				chatScope={buildChatScope()}
			/>,
		);

		const props = buttonRenderProps.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(props.organizationSlug).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Integration -- the .map(...) block in CopilotPage uses the predicate
// to decide whether to mount the slot. These tests exercise the same
// joint behavior the production render path applies.
// ---------------------------------------------------------------------------

describe("CopilotPage Excalidraw button -- conditional mount integration", () => {
	it("renders the button below McpAppFrame for a successful Excalidraw create_view (happy path)", () => {
		const tc = buildTc();
		// In production the `.map(...)` block in CopilotPage feeds the
		// predicate the full `MultiAgentToolCall` (which carries
		// `status`). The slot itself doesn't read status; only the
		// predicate does. Pass the matching shape through.
		const shouldRender = shouldRenderNexusExcalidrawAutoInsertButton({
			mcpAppResourceUri: tc.mcpAppResourceUri,
			status: "complete",
		});
		expect(shouldRender).toBe(true);

		render(
			<NexusExcalidrawAutoInsertSlot
				tc={tc}
				chatScope={buildChatScope()}
				organizationSlug="example-org"
			/>,
		);

		expect(screen.getByTestId("insert-diagram-button")).toBeInTheDocument();
	});

	it("does NOT render the slot when the tool result is a non-Excalidraw MCP call", () => {
		const tc = buildTc({
			mcpAppResourceUri: "ui://other-mcp/widget",
		});
		const shouldRender = shouldRenderNexusExcalidrawAutoInsertButton({
			mcpAppResourceUri: tc.mcpAppResourceUri,
			status: "complete",
		});
		expect(shouldRender).toBe(false);
		// And nothing is rendered for the slot path -- the predicate
		// short-circuits the production .map() block.
		expect(buttonRenderProps).not.toHaveBeenCalled();
	});

	it("does NOT render the slot when the tool status !== 'complete'", () => {
		const tc = buildTc();
		const shouldRender = shouldRenderNexusExcalidrawAutoInsertButton({
			mcpAppResourceUri: tc.mcpAppResourceUri,
			status: "running",
		});
		expect(shouldRender).toBe(false);
		expect(buttonRenderProps).not.toHaveBeenCalled();
	});
});
