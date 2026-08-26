/**
 * Tests for the Excalidraw auto-insert button wiring in
 * `FabricTemporalOrchestratorChat` (F2 / spec § 8.1 / FR-14 / § 22.1).
 *
 * Scope:
 *   - `<ChatMessageInsertDiagramButton surface="loom" ... />` is rendered
 *     as a sibling under each `<McpAppFrame>` when the tool call
 *     produces a successful Excalidraw `create_view` result.
 *   - The button does NOT render for non-Excalidraw MCP results, missing
 *     MCP handles, or missing checkpointId.
 *
 * Implementation note:
 *   The full `FabricTemporalOrchestratorChat` is 3.7k LOC with dozens
 *   of cross-package deps (Temporal, oRPC, TanStack Query, CopilotKit,
 *   etc.) — mounting it in jsdom is impractical. Group D's
 *   `ChatMessageInsertDiagramButton.test.tsx` already exercises the
 *   button's render-decision branches in isolation. What F2 actually
 *   adds is the *slot wiring* in this surface — i.e., the per-tool-call
 *   adapter that decides whether to mount the button at all and builds
 *   the `toolResult` envelope from the orchestrator's `{ args, result,
 *   mcpAppResourceUri, mcpAppConfigId }` shape.
 *
 *   To keep the test fast and focused on what F2 actually introduces, we
 *   import the exported `ExcalidrawAutoInsertSlot` helper directly and
 *   mock the button component to capture the props it would receive. The
 *   ergonomics mirror Group F's sibling tests in CopilotPage/FabricDirectChat.
 */

import type {
	ChatScope,
	UseChatScopedProjectFromOrchestratorStreamOptions,
} from "@saas/projects/components/excalidraw-auto-insert/useChatScopedProject";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Capture every props payload that the slot passes to the real button.
 * The assertions below read from this array to confirm:
 *   - the button is invoked at all (or NOT invoked, for negative cases),
 *   - the `surface` prop is "loom" (not "loom-orchestrator" — spec § 22.1
 *     pins the surface-tag mapping),
 *   - the `toolResult` envelope is built from `tc.result` + `tc.args`.
 */
const buttonPropsCalls: Array<Record<string, unknown>> = [];

vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/ChatMessageInsertDiagramButton",
	() => ({
		ChatMessageInsertDiagramButton: (props: Record<string, unknown>) => {
			buttonPropsCalls.push(props);
			return (
				<div
					data-testid="mock-insert-diagram-button"
					data-surface={String(props.surface ?? "")}
					data-chat-message-id={String(props.chatMessageId ?? "")}
				/>
			);
		},
	}),
);

// The resolver hook subscribes to the TipTap editor registry. In this
// surface the registry is always empty (Loom has no on-page editor —
// spec § 22.1) so we return `null` from `useActiveTipTapEditor` directly.
// This keeps the test free of the registry provider plumbing.
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/useActiveTipTapEditor",
	() => ({
		useActiveTipTapEditor: () => null,
	}),
);

// `deriveDiagramTitle` is a pure function — let it run for real so the
// test pins the chain end-to-end.

beforeEach(() => {
	buttonPropsCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Imports under test — performed AFTER mocks so the module graph picks up
// the mocked dependencies.
// ---------------------------------------------------------------------------

const orchestratorChatModule = await import(
	"../FabricTemporalOrchestratorChat"
);
const { ExcalidrawAutoInsertSlot } = orchestratorChatModule;

function makeChatScope(overrides: Partial<ChatScope> = {}): ChatScope {
	return {
		projectId: "proj_loom_1",
		organizationId: "org_loom_1",
		lastUserPromptForMessage: (_messageId: string) => "Draw a flowchart",
		...overrides,
	};
}

function renderInDiv(node: ReactNode) {
	return render(<div>{node}</div>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FabricTemporalOrchestratorChat — Excalidraw auto-insert wiring (F2)", () => {
	it('renders the button with surface="loom" for a successful Excalidraw create_view tool call', () => {
		const { getByTestId } = renderInDiv(
			<ExcalidrawAutoInsertSlot
				toolCall={{
					id: "tc_1",
					mcpAppResourceUri: "ui://excalidraw/abc",
					mcpAppConfigId: "cfg_loom",
					args: {
						elements: [{ type: "rect" }],
						appState: { viewBackgroundColor: "#fff" },
					},
					result: { checkpointId: "cp_loom_1" },
				}}
				chatMessageId="exec_1-step_1-tc_1"
				chatScope={makeChatScope()}
				organizationSlug="example-org"
			/>,
		);

		const rendered = getByTestId("mock-insert-diagram-button");
		// Spec § 22.1 — the orchestrator stream's internal surface tag is
		// "loom-orchestrator" but the auto-insert button surface is "loom".
		expect(rendered.getAttribute("data-surface")).toBe("loom");
		expect(rendered.getAttribute("data-chat-message-id")).toBe(
			"exec_1-step_1-tc_1",
		);

		// Confirm the button received an envelope built from the tool
		// call shape — the wiring code is what F2 actually adds, so it's
		// what we lock down here.
		expect(buttonPropsCalls.length).toBe(1);
		const propsPassed = buttonPropsCalls[0];
		expect(propsPassed.surface).toBe("loom");
		expect(propsPassed.chatMessageId).toBe("exec_1-step_1-tc_1");
		expect(propsPassed.organizationSlug).toBe("example-org");
		expect(propsPassed.title).toBe("Draw a flowchart");
		const toolResult = propsPassed.toolResult as Record<string, unknown>;
		expect(toolResult.checkpointId).toBe("cp_loom_1");
		expect(toolResult.mcpConfigId).toBe("cfg_loom");
		expect(toolResult.resourceUri).toBe("ui://excalidraw/abc");
		expect(toolResult.elements).toEqual([{ type: "rect" }]);
		expect(toolResult.appState).toEqual({
			viewBackgroundColor: "#fff",
		});
	});

	it("falls back to 'Untitled diagram from chat' when the chat scope has no preceding user message", () => {
		renderInDiv(
			<ExcalidrawAutoInsertSlot
				toolCall={{
					id: "tc_2",
					mcpAppResourceUri: "ui://excalidraw/xyz",
					mcpAppConfigId: "cfg_loom",
					args: { elements: [] },
					result: { checkpointId: "cp_loom_2" },
				}}
				chatMessageId="exec_2-step_1-tc_2"
				chatScope={makeChatScope({
					lastUserPromptForMessage: () => null,
				})}
				organizationSlug="example-org"
			/>,
		);
		expect(buttonPropsCalls[0]?.title).toBe("Untitled diagram from chat");
	});

	it("does NOT render the button for a non-Excalidraw MCP resource (e.g. ui://forms/...)", () => {
		const { queryByTestId } = renderInDiv(
			<ExcalidrawAutoInsertSlot
				toolCall={{
					id: "tc_3",
					mcpAppResourceUri: "ui://forms/budget",
					mcpAppConfigId: "cfg_forms",
					args: { fields: [] },
					result: { checkpointId: "cp_forms_1" },
				}}
				chatMessageId="exec_3-step_1-tc_3"
				chatScope={makeChatScope()}
				organizationSlug="example-org"
			/>,
		);
		expect(queryByTestId("mock-insert-diagram-button")).toBeNull();
		expect(buttonPropsCalls.length).toBe(0);
	});

	it("does NOT render when the resource URI is absent", () => {
		const { queryByTestId } = renderInDiv(
			<ExcalidrawAutoInsertSlot
				toolCall={{
					id: "tc_4",
					mcpAppResourceUri: undefined,
					mcpAppConfigId: "cfg_loom",
					args: { elements: [] },
					result: { checkpointId: "cp_loom_4" },
				}}
				chatMessageId="exec_4-step_1-tc_4"
				chatScope={makeChatScope()}
				organizationSlug="example-org"
			/>,
		);
		expect(queryByTestId("mock-insert-diagram-button")).toBeNull();
		expect(buttonPropsCalls.length).toBe(0);
	});

	it("does NOT render when the mcpConfigId is absent", () => {
		const { queryByTestId } = renderInDiv(
			<ExcalidrawAutoInsertSlot
				toolCall={{
					id: "tc_5",
					mcpAppResourceUri: "ui://excalidraw/abc",
					mcpAppConfigId: undefined,
					args: { elements: [] },
					result: { checkpointId: "cp_loom_5" },
				}}
				chatMessageId="exec_5-step_1-tc_5"
				chatScope={makeChatScope()}
				organizationSlug="example-org"
			/>,
		);
		expect(queryByTestId("mock-insert-diagram-button")).toBeNull();
		expect(buttonPropsCalls.length).toBe(0);
	});

	it("does NOT render when the tool result has no extractable checkpointId", () => {
		const { queryByTestId } = renderInDiv(
			<ExcalidrawAutoInsertSlot
				toolCall={{
					id: "tc_6",
					mcpAppResourceUri: "ui://excalidraw/abc",
					mcpAppConfigId: "cfg_loom",
					args: { elements: [{ type: "rect" }] },
					// No `checkpointId`, no `checkpoint_id`, no
					// structuredContent / content[].text fallback.
					result: { ok: true },
				}}
				chatMessageId="exec_6-step_1-tc_6"
				chatScope={makeChatScope()}
				organizationSlug="example-org"
			/>,
		);
		expect(queryByTestId("mock-insert-diagram-button")).toBeNull();
		expect(buttonPropsCalls.length).toBe(0);
	});

	it("extracts checkpointId from `structuredContent` (alternate MCP shape)", () => {
		const { getByTestId } = renderInDiv(
			<ExcalidrawAutoInsertSlot
				toolCall={{
					id: "tc_7",
					mcpAppResourceUri: "ui://excalidraw/abc",
					mcpAppConfigId: "cfg_loom",
					args: { elements: [] },
					result: {
						structuredContent: { checkpointId: "cp_nested" },
					},
				}}
				chatMessageId="exec_7-step_1-tc_7"
				chatScope={makeChatScope()}
				organizationSlug="example-org"
			/>,
		);
		expect(getByTestId("mock-insert-diagram-button")).toBeTruthy();
		const propsPassed = buttonPropsCalls[0];
		const toolResult = propsPassed.toolResult as Record<string, unknown>;
		expect(toolResult.checkpointId).toBe("cp_nested");
	});

	it("passes through the chatScope unchanged so the button hooks can read projectId/organizationId", () => {
		const scope = makeChatScope({
			projectId: "proj_specific",
			organizationId: "org_specific",
		});
		renderInDiv(
			<ExcalidrawAutoInsertSlot
				toolCall={{
					id: "tc_8",
					mcpAppResourceUri: "ui://excalidraw/abc",
					mcpAppConfigId: "cfg_loom",
					args: { elements: [] },
					result: { checkpointId: "cp_8" },
				}}
				chatMessageId="exec_8-step_1-tc_8"
				chatScope={scope}
				organizationSlug="example-org"
			/>,
		);
		// The button receives the *same* ChatScope reference — D1 / D2
		// read `projectId` / `organizationId` from it directly.
		expect(buttonPropsCalls[0]?.chatScope).toBe(scope);
	});
});

// ---------------------------------------------------------------------------
// Type-level sanity — confirm we expose the adapter contract we expect
// to keep stable. Documented here so a future rename in
// `useChatScopedProject` causes this file to fail rather than silently
// drift away from the F2 wiring.
// ---------------------------------------------------------------------------

describe("F2 wiring — adapter contract", () => {
	it("the orchestrator-stream adapter option shape is what FabricTemporalOrchestratorChat wires", () => {
		// Type-only assertion: the adapter expects projectId, organizationId,
		// and the linear messages array. F2 reads these three off the
		// component's own state, so we pin the contract here.
		const _options: UseChatScopedProjectFromOrchestratorStreamOptions = {
			projectId: "proj_1",
			organizationId: "org_1",
			messages: [],
		};
		expect(_options.projectId).toBe("proj_1");
	});
});
