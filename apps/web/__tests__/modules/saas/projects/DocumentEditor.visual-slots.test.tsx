/**
 * Visual slots across DocumentEditor's programmatic content applications
 * (Fizzy #2589, KTD17, R39).
 *
 * Every `applyProgrammaticContent` call names its source. An `assistant`
 * application — model output from the in-editor assistant — splices the
 * document's slots into the incoming markdown before it is rendered, so a
 * slot the model left out comes back under its heading. While a run streams,
 * those are the slots of the run's baseline; once it has ended, the editor's
 * current ones. A `server` application — a body the server already stands
 * behind — is applied as is, so a slot another editor deleted stays deleted.
 *
 * Drives the real component with a real TipTap editor built from the document
 * editor's own extensions:
 *   - the streaming diff apply (Effect 3), over one frame and over growing
 *     prefixes that reach the slot's section only in the last frame;
 *   - the full-document apply (Effect 3 with no baseline);
 *   - the final diff at the end of a run (Effect 2);
 *   - the diff the confirm card applies when it arms, and the accepted
 *     proposal, including a slot placed while the proposal was pending;
 *   - the polled regeneration body (a `server` application).
 *
 * Mocking harness copied from `DocumentEditor.handshake-baseline.test.tsx` —
 * see that file and `DocumentEditor.save-cache-key.test.tsx` for why each stub
 * exists. Changed here: `useCoAgent` serves a mutable agent state and node
 * name, `useCopilotAction` records each action's config so a test can invoke
 * its render callback, `useEditor` serves a real editor, and the save
 * mutation records what it was asked to persist.
 */

import {
	parseVisualSlots,
	serializeVisualSlot,
} from "@repo/utils/glossy/visual-slots";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- orpc: generic proxy, as in the sibling files. The document payload is
// mutable so a test can serve a newer polled body.
const documentPayload = {
	document: {
		id: "doc-1",
		title: "Business case",
		type: "BUSINESS_CASE",
		content: "",
		version: 1,
		status: "COMPLETED",
	},
};
const PROJECT_PAYLOAD = {
	project: { name: "proj-1", techStack: [], features: [] },
};

function cannedResponseFor(path: string[]): unknown {
	const joined = path.join(".");
	if (joined === "projects.documents.get") {
		return structuredClone(documentPayload);
	}
	if (joined === "projects.get") {
		return PROJECT_PAYLOAD;
	}
	return {};
}

let capturedUpdateMutationConfig: Record<string, any> | undefined;
const savedContents: string[] = [];

function makeOrpcProxy(): any {
	function build(path: string[]): any {
		const handler: ProxyHandler<any> = {
			get(_target, prop: string) {
				if (prop === "queryKey") {
					return (opts: { input?: unknown }) => [
						...path,
						opts?.input ?? {},
					];
				}
				if (prop === "queryOptions") {
					return (opts: { input?: unknown }) => ({
						queryKey: [...path, opts?.input ?? {}],
						queryFn: async () => cannedResponseFor(path),
					});
				}
				if (prop === "mutationOptions") {
					return (config: Record<string, unknown>) => {
						const isSave =
							path.join(".") === "projects.documents.update";
						if (isSave) {
							capturedUpdateMutationConfig = config;
						}
						return {
							mutationFn: async (vars: { content?: string }) => {
								if (
									isSave &&
									typeof vars?.content === "string"
								) {
									savedContents.push(vars.content);
								}
								return cannedResponseFor(path);
							},
							...config,
						};
					};
				}
				if (typeof prop === "symbol" || prop === "then") {
					return undefined;
				}
				return build([...path, prop]);
			},
			apply() {
				return build(path);
			},
		};
		return new Proxy(() => {}, handler);
	}
	return build([]);
}

vi.mock("@shared/lib/orpc-query-utils", () => ({ orpc: makeOrpcProxy() }));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: makeOrpcProxy() }));

vi.mock("next/navigation", () => ({
	useParams: () => ({ organizationSlug: "example-org" }),
	useSearchParams: () => new URLSearchParams(),
	useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-example",
		organizationSlug: "example-org",
		organizationName: "Example Org",
		basePath: "/app/example-org",
		isOrgContext: true,
		isPersonalContext: false,
		isGuest: false,
		isOrganizationAdmin: false,
		userRole: "member",
		loaded: true,
		organization: {
			id: "org-example",
			slug: "example-org",
			name: "Example Org",
		},
	}),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1" }, session: {} }),
}));

// ---- CopilotKit: agent state, node name, and loading flag are mutable so a
// test can walk a run; every action config is recorded.
let mockIsLoading = false;
let mockAgentState: Record<string, unknown> = {};
let mockNodeName: string | undefined;
const actionConfigs = new Map<string, Record<string, any>>();
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({
		state: mockAgentState,
		setState: vi.fn(),
		nodeName: mockNodeName,
	}),
	useCopilotAction: (config: Record<string, any>) => {
		actionConfigs.set(config.name, config);
	},
	useCopilotChat: () => ({ isLoading: mockIsLoading, visibleMessages: [] }),
	useCopilotChatInternal: () => ({ messages: [], setMessages: vi.fn() }),
	useCopilotReadable: vi.fn(),
	useCopilotMessagesContext: () => ({ setMessages: vi.fn() }),
}));
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: () => null,
}));

let mockEditor: Editor | null = null;
vi.mock("@tiptap/react", () => ({
	EditorContent: () => null,
	useEditor: () => mockEditor,
	NodeViewWrapper: () => null,
	ReactNodeViewRenderer: () => () => null,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

// Scrolling helpers reach for layout jsdom does not have.
vi.mock("@saas/projects/lib/diff-utils", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@saas/projects/lib/diff-utils")>();
	return {
		...actual,
		resetScrollTracking: vi.fn(),
		focusOnLastDiff: vi.fn(),
		focusOnAnchor: vi.fn(),
	};
});

vi.mock("@saas/projects/hooks/useDocumentAssistantHistoryEnabled", () => ({
	useDocumentAssistantHistoryEnabled: () => false,
}));
vi.mock("@saas/projects/hooks/useDocumentAssistantHistory", () => ({
	useDocumentAssistantHistoryRealtimeSync: vi.fn(),
}));
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/TiptapEditorRegistry",
	() => ({ useRegisterTiptapEditor: vi.fn() }),
);
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/usePickerIntentConsumer",
	() => ({ usePickerIntentConsumer: vi.fn() }),
);
vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useRegisterFabricAgentContext: vi.fn(),
}));
vi.mock("@saas/agents/copilot/useConfirmChangesOperationResult", () => ({
	useConfirmChangesOperationResult: () => vi.fn(),
}));
vi.mock("@saas/agents/hooks/useCodeContextLauncher", () => ({
	useCodeContextLauncher: () => ({
		openWithSelectedCode: vi.fn(),
		getSelectedText: () => "",
		isLikelyCode: () => false,
	}),
}));
vi.mock("@saas/agents/hooks/useDefaultMcpInlineRender", () => ({
	useDefaultMcpInlineRender: vi.fn(),
}));
vi.mock("@saas/agents/hooks/useFabricMention", () => ({
	useFabricMention: () => ({ handleInputChange: vi.fn() }),
}));
vi.mock("@saas/shared/components/copilot/useClarifyingQuestions", () => ({
	useClarifyingQuestions: vi.fn(),
}));
vi.mock("@saas/shared/components/copilot/use-user-run-signal", () => ({
	useUserRunSignal: () => ({
		isUserGenerationActive: false,
		markUserRunInitiated: vi.fn(),
		clearUserRunMark: vi.fn(),
	}),
}));
vi.mock("../hooks/use-diff-view-mode", () => ({
	useDiffPreview: () => ({
		diffViewMode: "inline",
		setDiffViewMode: vi.fn(),
		diffViews: [],
		effectiveDiffViewMode: "inline",
		showDiffPreviewPanes: false,
	}),
}));
vi.mock("@saas/shared/components/copilot/AttachmentRegistry", () => ({
	AttachmentRegistryProvider: ({
		children,
	}: {
		children?: import("react").ReactNode;
	}) => children,
}));
vi.mock(
	"@saas/projects/components/copilot/DocumentAssistantOutcomesProvider",
	() => ({
		DocumentAssistantOutcomesProvider: ({
			children,
		}: {
			children?: import("react").ReactNode;
		}) => children,
	}),
);
vi.mock("@saas/projects/components/copilot/HydratedMessagesContext", () => ({
	HydratedMessagesProvider: ({
		children,
	}: {
		children?: import("react").ReactNode;
	}) => children,
}));
vi.mock("./documents/useUpdateDocumentWithContext", () => ({
	useUpdateDocumentWithContext: () => ({
		isActive: false,
		showingDiff: false,
		isLoading: false,
		loadingStage: null,
		elapsedSeconds: 0,
		preview: null,
		start: vi.fn(),
		confirm: vi.fn(),
		reject: vi.fn(),
	}),
}));

import { DocumentEditor } from "@saas/projects/components/DocumentEditor";
import { fromMarkdown } from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { createAdvancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { VISUAL_SLOT_NODE_NAME } from "@saas/projects/lib/tiptap-visual-slot-extension";

const SLOT_A = serializeVisualSlot({
	id: "slot-a",
	kind: "timeline",
	hint: "Show the phases",
});
const SLOT_B = serializeVisualSlot({ id: "slot-b", kind: "stat" });

const STORED = `## Implementation Phases\n\nPhase one, then two.\n\n${SLOT_A}\n\n## Risks\n\nFew.`;
/** What the model proposes: a rewrite that leaves the slot tag out. */
const PROPOSED =
	"## Implementation Phases\n\nPhase one, then two, then three.\n\n## Risks\n\nFew.";

/** The document editor's own schema, diff marks and slot node included. */
function makeEditor(markdown: string): Editor {
	return new Editor({
		extensions: createAdvancedExtensions({
			projectId: null,
			documentId: null,
		}),
		content: markdown ? fromMarkdown(markdown) : "",
	});
}

function slotIds(editor: Editor): string[] {
	const ids: string[] = [];
	editor.state.doc.descendants((node) => {
		if (node.type.name === VISUAL_SLOT_NODE_NAME) {
			ids.push(node.attrs.slotId as string);
		}
	});
	return ids;
}

/** Stands in for a collaborator placing a slot mid-run: a remote change. */
function appendSlot(editor: Editor, slotId: string, kind: string) {
	editor.commands.command(({ tr, state }) => {
		tr.insert(
			state.doc.content.size,
			state.schema.nodes[VISUAL_SLOT_NODE_NAME].create({ slotId, kind }),
		);
		return true;
	});
}

let queryClient: QueryClient;

function tree() {
	return (
		<QueryClientProvider client={queryClient}>
			<DocumentEditor projectId="proj-1" documentId="doc-1" />
		</QueryClientProvider>
	);
}

async function mount(editor: Editor) {
	mockEditor = editor;
	const view = render(tree());
	await waitFor(() => {
		expect(capturedUpdateMutationConfig?.onMutate).toBeTypeOf("function");
	});
	return view;
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("DocumentEditor — visual slots on programmatic applications (KTD17)", () => {
	beforeEach(() => {
		capturedUpdateMutationConfig = undefined;
		savedContents.length = 0;
		actionConfigs.clear();
		mockIsLoading = false;
		mockNodeName = undefined;
		mockAgentState = {};
		documentPayload.document.content = STORED;
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
	});

	afterEach(() => {
		mockEditor?.destroy();
		mockEditor = null;
	});

	/** Start an assistant run: Effect 1 captures the editor as the baseline. */
	async function startRun(rerender: (ui: ReactElement) => void) {
		mockIsLoading = true;
		rerender(tree());
		await flush();
	}

	async function stream(
		rerender: (ui: ReactElement) => void,
		document: string,
	) {
		mockAgentState = { document };
		rerender(tree());
		await flush();
	}

	it("streaming diff apply keeps a slot the model left out", async () => {
		const editor = makeEditor(STORED);
		const { rerender } = await mount(editor);

		await startRun(rerender);
		await stream(rerender, PROPOSED);

		expect(slotIds(editor)).toEqual(["slot-a"]);
		expect(getEditorMarkdownForSave(editor)).toContain(
			`Phase one, then two, then three.\n\n${SLOT_A}\n\n## Risks`,
		);
	});

	it("full-document apply takes its slots from the run's baseline, not from the editor mid-run", async () => {
		documentPayload.document.content = "";
		const editor = makeEditor("");
		const { rerender } = await mount(editor);

		await startRun(rerender);
		// The person's editor is read-only while the run streams, so a slot
		// can only reach it as a collaborator's remote change — which the
		// frame replaces, like the rest of the editor's mid-run content.
		appendSlot(editor, "slot-b", "stat");
		await stream(rerender, PROPOSED);

		expect(slotIds(editor)).toEqual([]);
		expect(getEditorMarkdownForSave(editor)).toBe(PROPOSED);
	});

	it("full-document apply strips a slot the model invented", async () => {
		documentPayload.document.content = "";
		const editor = makeEditor("");
		const { rerender } = await mount(editor);

		await startRun(rerender);
		await stream(rerender, `${PROPOSED}\n\n${SLOT_A}`);

		expect(slotIds(editor)).toEqual([]);
	});

	it("the final diff at the end of a run keeps the slot", async () => {
		const editor = makeEditor(STORED);
		const { rerender } = await mount(editor);

		await startRun(rerender);
		mockAgentState = { document: PROPOSED };
		mockIsLoading = false;
		mockNodeName = "end";
		rerender(tree());
		await flush();

		expect(slotIds(editor)).toEqual(["slot-a"]);
		expect(getEditorMarkdownForSave(editor)).toContain(
			`then three.\n\n${SLOT_A}`,
		);
	});

	it("the confirm card's diff and the accepted proposal keep slots, one placed while it was pending included", async () => {
		const editor = makeEditor(STORED);
		const { rerender } = await mount(editor);

		await startRun(rerender);
		mockAgentState = { document: PROPOSED };
		mockIsLoading = false;
		rerender(tree());
		await flush();

		const respond = vi.fn();
		const confirm = actionConfigs.get("confirm_changes");
		let card: ReactElement | undefined;
		await act(async () => {
			card = confirm?.renderAndWaitForResponse({
				args: {},
				respond,
				status: "executing",
			});
			await Promise.resolve();
		});
		await flush();

		// Arming applied the reviewed diff with the slot spliced in.
		expect(slotIds(editor)).toEqual(["slot-a"]);

		// The person places a second slot while the proposal is pending.
		appendSlot(editor, "slot-b", "stat");

		await act(async () => {
			(card?.props as { onConfirm: () => void }).onConfirm();
		});
		await flush();

		expect(respond).toHaveBeenCalledWith({ accepted: true });
		expect(slotIds(editor)).toEqual(["slot-a", "slot-b"]);
		const saved = savedContents.at(-1) ?? "";
		expect(saved).toContain(`then three.\n\n${SLOT_A}\n\n## Risks`);
		expect(saved).toContain(SLOT_B);
	});

	it("a rewrite that deletes the slot's section reviews and saves it once, at the end, naming the section", async () => {
		const editor = makeEditor(STORED);
		const { rerender } = await mount(editor);

		await startRun(rerender);
		mockAgentState = { document: "## Risks\n\nFew, revised." };
		mockIsLoading = false;
		mockNodeName = "end";
		rerender(tree());
		await flush();

		const respond = vi.fn();
		let card: ReactElement | undefined;
		await act(async () => {
			card = actionConfigs
				.get("confirm_changes")
				?.renderAndWaitForResponse({
					args: {},
					respond,
					status: "executing",
				});
			await Promise.resolve();
		});
		await flush();
		await act(async () => {
			(card?.props as { onConfirm: () => void }).onConfirm();
		});
		await flush();

		const saved = savedContents.at(-1) ?? "";
		expect(saved).not.toMatch(/&lt;visual-slot|\\<visual-slot/);
		expect(saved).toBe(
			`## Risks\n\nFew, revised.\n\n${serializeVisualSlot({
				id: "slot-a",
				kind: "timeline",
				hint: "Show the phases",
				orphanedFrom: "Implementation Phases",
			})}`,
		);
	});

	it("a streamed run keeps a slot in a later section once, under its heading, through the final diff and accept", async () => {
		const stored = `## 1. Summary\n\nWe propose a phased rollout.\n\n## 2. Scope\n\nThree teams.\n\n## 3. Implementation Phases\n\nPhase one, then two.\n\n${SLOT_A}\n\n## 4. Risks\n\nFew.`;
		const proposed =
			"## 1. Summary\n\nWe propose a phased rollout across the organization.\n\n## 2. Scope\n\nThree teams, then five.\n\n## 3. Implementation Phases\n\nPhase one, then two, then three.\n\n## 4. Risks\n\nFew.";
		documentPayload.document.content = stored;
		const editor = makeEditor(stored);
		const { rerender } = await mount(editor);

		await startRun(rerender);
		// Growing prefixes, the way the agent streams a rewrite: the slot's
		// section only arrives with the last frame, so every earlier frame
		// ends before it.
		const sectionThree = proposed.indexOf("## 3.");
		for (const end of [8, 40, 90, sectionThree, proposed.length]) {
			await stream(rerender, proposed.slice(0, end));
		}

		mockIsLoading = false;
		mockNodeName = "end";
		rerender(tree());
		await flush();

		// The editor escapes a numbered heading's dot when it serializes.
		const expectOneSlotInPlace = (markdown: string) => {
			expect(parseVisualSlots(markdown)).toEqual([
				expect.objectContaining({ id: "slot-a", orphanedFrom: null }),
			]);
			expect(markdown).toContain(
				`then three.\n\n${SLOT_A}\n\n## 4\\. Risks`,
			);
		};
		expect(slotIds(editor)).toEqual(["slot-a"]);
		expectOneSlotInPlace(getEditorMarkdownForSave(editor) ?? "");

		const respond = vi.fn();
		let card: ReactElement | undefined;
		await act(async () => {
			card = actionConfigs
				.get("confirm_changes")
				?.renderAndWaitForResponse({
					args: {},
					respond,
					status: "executing",
				});
			await Promise.resolve();
		});
		await flush();
		await act(async () => {
			(card?.props as { onConfirm: () => void }).onConfirm();
		});
		await flush();

		expect(respond).toHaveBeenCalledWith({ accepted: true });
		expectOneSlotInPlace(savedContents.at(-1) ?? "");
	});

	it("a server application of a polled regeneration body does not bring back a slot it lacks", async () => {
		const editor = makeEditor(STORED);
		const { rerender } = await mount(editor);

		// Start a regeneration the way the assistant's tool call does.
		const regenerate = actionConfigs.get("regenerate_document");
		await act(async () => {
			regenerate?.renderAndWaitForResponse({
				args: { prompt: "Rewrite it" },
				respond: vi.fn(),
				status: "executing",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		rerender(tree());

		// Another editor deleted the slot; the polled body no longer has it.
		documentPayload.document.content = PROPOSED;
		documentPayload.document.version = 2;
		await act(async () => {
			await queryClient.refetchQueries();
		});

		await waitFor(() => {
			expect(getEditorMarkdownForSave(editor)).toBe(PROPOSED);
		});
		expect(slotIds(editor)).toEqual([]);
	});
});
