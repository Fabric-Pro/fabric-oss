import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import * as React from "react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	action: null as null | {
		renderAndWaitForResponse: (
			props: unknown,
		) => ReactElement<{ onConfirm: () => void; onReject: () => void }>;
	},
	confirmDraft: vi.fn(),
	loading: false,
	extract: vi.fn(),
	setState: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { ai: { feedback: { confirmDraft: mocks.confirmDraft } } },
}));
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => {
		const [, refresh] = React.useReducer((n: number) => n + 1, 0);
		React.useEffect(() => {
			const sub = fake.agent.subscribe({ onStateChanged: refresh });
			return () => sub.unsubscribe();
		}, []);
		return { state: fake.agent.state, setState: fake.agent.setState };
	},
	useCopilotAction: (action: { name: string }) => {
		if (action.name === "confirm_changes") {
			mocks.action = action as typeof mocks.action;
		}
	},
	useCopilotChat: () => ({ isLoading: mocks.loading }),
	useCopilotChatInternal: () => ({ messages: [], setMessages: vi.fn() }),
	useCopilotReadable: () => {
		fake.renders++;
	},
}));
vi.mock("@copilotkit/react-ui", () => ({ CopilotSidebar: () => null }));
vi.mock("@tiptap/react", () => ({
	useEditor: () => editor,
	EditorContent: () => null,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "example-org" }),
}));
vi.mock("@saas/projects/lib/editor-markdown-save", () => ({
	getEditorMarkdownForSave: mocks.extract,
}));
vi.mock("@saas/projects/lib/tiptap-extensions-advanced", () => ({
	advancedExtensions: [],
}));
vi.mock("@saas/projects/components/SlashCommands", () => ({
	SlashCommandsExtension: {},
}));
vi.mock("@saas/agents/components/DocumentGeneratorChatHeader", () => ({
	createDocumentGeneratorChatHeader: () => () => null,
}));
vi.mock("@saas/agents/components/DocumentGeneratorHistoryDrawer", () => ({
	DocumentGeneratorHistoryDrawer: () => null,
}));
vi.mock("@saas/shared/components/copilot/CopilotSidebarInput", () => ({
	createCopilotSidebarInput: () => () => null,
}));
vi.mock("@saas/shared/components/copilot/CopilotAssistantMessage", () => ({
	CopilotAssistantMessageForDocumentGenerator: () => null,
	CopilotAssistantMessageForPromptEnhancer: () => null,
}));
vi.mock("@saas/shared/components/copilot/useClarifyingQuestions", () => ({
	useClarifyingQuestions: vi.fn(),
}));
vi.mock("@saas/shared/components/copilot/use-agent-state-reseed", () => ({
	useReseedAgentStateOnRunStart: vi.fn(),
}));

import { DocumentGeneratorEditor } from "../../components/DocumentGeneratorEditor";

const fake = vi.hoisted(() => {
	const listeners = new Set<Record<string, (args: any) => void>>();
	const agent = {
		state: {} as Record<string, unknown>,
		subscribe: (subscriber: any) => {
			listeners.add(subscriber);
			return { unsubscribe: () => listeners.delete(subscriber) };
		},
		setState: (state: any) => {
			agent.state = structuredClone(state);
			for (const s of listeners) {
				s.onStateChanged?.({ state });
			}
		},
	};
	const runtimeListeners = new Set<Record<string, (args: any) => void>>();
	const runtime = {
		agents: { "example-agent": agent },
		subscribe: (subscriber: any) => {
			runtimeListeners.add(subscriber);
			return { unsubscribe: () => runtimeListeners.delete(subscriber) };
		},
	};
	return { agent, listeners, runtime, runtimeListeners, renders: 0 };
});
vi.mock("@copilotkit/react-core/v2", () => ({
	useAgent: vi.fn(() => ({ agent: fake.agent })),
	useCopilotKit: () => ({ copilotkit: fake.runtime }),
}));
vi.mock("@copilotkit/react-core/v2/context", () => ({
	useCopilotKit: () => ({ copilotkit: fake.runtime }),
}));

const editor = {
	commands: { setContent: vi.fn() },
	setEditable: vi.fn(),
	state: { doc: {} },
};
vi.mock("@saas/projects/lib/diff-utils", () => ({
	fromMarkdown: (text: string) => text,
	resetScrollTracking: vi.fn(),
	diffPartialText: (_before: string, after: string) => after,
	focusOnLastDiff: vi.fn(),
	focusOnAnchor: vi.fn(),
	repairMarkdownDocument: (text: string) => text,
}));
const emptyMessages: [] = [];
vi.mock("@saas/shared/components/copilot/CopilotChatSessionProvider", () => ({
	useCopilotChatSessionActions: () => ({ setMessages: mocks.setState }),
	useCopilotChatSessionSelector: (select: any) =>
		select({ isLoading: mocks.loading, messages: emptyMessages }),
}));
beforeEach(() => {
	fake.listeners.clear();
	fake.runtimeListeners.clear();
	fake.agent.state = {};
	fake.renders = 0;
	mocks.loading = true;
	mocks.extract.mockReturnValue("");
	editor.commands.setContent.mockClear();
});
it("ignores unrelated agent updates but applies document updates for a custom agent", () => {
	render(<DocumentGeneratorEditor agentId="example-agent" />);
	const before = fake.renders;
	act(() =>
		fake.agent.setState({
			...fake.agent.state,
			reasoningByTurn: { 1: { text: "Thinking" } },
		}),
	);
	expect(fake.renders).toBe(before);
	act(() =>
		fake.agent.setState({
			...fake.agent.state,
			document: "Generated content",
		}),
	);
	expect(fake.renders).toBeGreaterThan(before);
	expect(editor.commands.setContent).toHaveBeenCalledWith(
		"Generated content",
	);
});

it("seeds an empty custom-agent run with document and attachment context", () => {
	render(<DocumentGeneratorEditor agentId="example-agent" />);
	act(() => {
		fake.agent.state = {};
		for (const subscriber of fake.listeners) {
			subscriber.onRunInitialized?.({ state: {} });
		}
	});
	expect(fake.agent.state).toEqual(
		expect.objectContaining({
			document: "",
			documentType: "general",
			ragContexts: [],
			reasoningByTurn: {},
		}),
	);
});
