import { act, fireEvent, render, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
	useCoAgent: () => ({ state: {}, setState: mocks.setState }),
	useCopilotAction: (action: { name: string }) => {
		if (action.name === "confirm_changes") {
			mocks.action = action as typeof mocks.action;
		}
	},
	useCopilotChat: () => ({ isLoading: mocks.loading }),
	useCopilotChatInternal: () => ({ messages: [], setMessages: vi.fn() }),
	useCopilotReadable: vi.fn(),
}));
vi.mock("@copilotkit/react-ui", () => ({ CopilotSidebar: () => null }));
vi.mock("@tiptap/react", () => ({
	useEditor: () => null,
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

import { PromptContentEnhancer } from "@saas/prompts/components/PromptContentEnhancer";
import { DocumentGeneratorEditor } from "../../components/DocumentGeneratorEditor";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.action = null;
	mocks.loading = false;
	mocks.extract.mockReturnValue("Example draft");
});
function callbacks() {
	const element = mocks.action?.renderAndWaitForResponse({
		args: {},
		status: "executing",
		respond: vi.fn(),
	});
	if (!element) {
		throw new Error("Missing confirmation action");
	}
	return element.props;
}
describe("projectless draft buttons", () => {
	it.each([true, false])(
		"document generator records %s with no project or chat write",
		async (accepted) => {
			render(<DocumentGeneratorEditor agentId="example-agent" />);
			const props = callbacks();
			await act(async () => {
				if (accepted) {
					props.onConfirm();
				} else {
					props.onReject();
				}
			});
			expect(mocks.confirmDraft).toHaveBeenCalledOnce();
			expect(mocks.confirmDraft).toHaveBeenCalledWith({
				surface: "document-generator",
				draftId: expect.any(String),
				verdict: accepted ? "accepted" : "rejected",
			});
		},
	);

	it.each(["document-generator", "prompt-enhancer"] as const)(
		"%s keeps the old card's identity through another run and a second card",
		async (surface) => {
			const tree = () =>
				surface === "document-generator" ? (
					<DocumentGeneratorEditor />
				) : (
					<PromptContentEnhancer
						promptId="example-prompt"
						promptName="Example prompt"
						format="PLAIN_TEXT"
						tags={[]}
						initialContent="Example content"
						onSave={vi.fn()}
						onCancel={vi.fn()}
					/>
				);
			const parent = render(tree());
			const offered = () => {
				const element = mocks.action?.renderAndWaitForResponse({
					args: {},
					status: "executing",
					respond: vi.fn(),
				});
				if (!element) {
					throw new Error("Missing confirm card");
				}
				return element;
			};
			const first = render(offered());
			mocks.loading = true;
			parent.rerender(tree());
			mocks.loading = false;
			parent.rerender(tree());
			first.rerender(offered());
			const second = render(offered());
			await act(async () => {
				fireEvent.click(
					within(first.container).getByTestId("reject-button"),
				);
			});
			await act(async () => {
				fireEvent.click(
					within(second.container).getByTestId("confirm-button"),
				);
			});
			expect(mocks.confirmDraft).toHaveBeenCalledTimes(2);
			expect(
				mocks.confirmDraft.mock.calls.map(([input]) => input.verdict),
			).toEqual(["rejected", "accepted"]);
			expect(mocks.confirmDraft.mock.calls[0][0].draftId).not.toBe(
				mocks.confirmDraft.mock.calls[1][0].draftId,
			);
		},
	);
	it("document generator preserves the empty fallback and emits no verdict on null extraction", async () => {
		mocks.extract.mockReturnValue(null);
		render(<DocumentGeneratorEditor />);
		const props = callbacks();
		await act(async () => props.onConfirm());
		expect(mocks.confirmDraft).not.toHaveBeenCalled();
		expect(mocks.setState).toHaveBeenCalledWith({ document: "" });
	});
	it.each([true, false])(
		"prompt enhancer records %s with no project or chat write",
		async (accepted) => {
			render(
				<PromptContentEnhancer
					promptId="example-prompt"
					promptName="Example prompt"
					format="PLAIN_TEXT"
					tags={[]}
					initialContent="Example prompt content"
					onSave={vi.fn()}
					onCancel={vi.fn()}
				/>,
			);
			const props = callbacks();
			await act(async () => {
				if (accepted) {
					props.onConfirm();
				} else {
					props.onReject();
				}
			});
			expect(mocks.confirmDraft).toHaveBeenCalledOnce();
			expect(mocks.confirmDraft).toHaveBeenCalledWith({
				surface: "prompt-enhancer",
				draftId: expect.any(String),
				verdict: accepted ? "accepted" : "rejected",
			});
		},
	);
});
