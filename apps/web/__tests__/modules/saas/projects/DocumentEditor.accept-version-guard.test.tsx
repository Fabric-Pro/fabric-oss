/**
 * The in-editor assistant accept guards its save with the document version
 * when a visual slot is involved (Fizzy #2589, KTD17).
 *
 * An accepted proposal keeps the editor's visual slots, which are right only
 * for the version the editor last took on. A save by someone else in between
 * — an MCP or API write, another editor — could add or delete a slot, and an
 * unguarded accept would silently undo it. So a slotted accept sends
 * `expectedVersion`; the server refuses a stale one with CONFLICT, and the
 * editor keeps the proposal, says nothing was saved, and refetches.
 *
 * Pinned here:
 *   - a slotted accept sends the version its slots came from: the loaded one,
 *     then whatever the last save, context update or regeneration brought —
 *     never a newer one a refetch put in the cache without the editor taking
 *     it on (the restore path's version is pinned in
 *     DocumentVersionHistory.test);
 *   - a slot-free accept and an ordinary save send what they always sent;
 *   - a CONFLICT shows the conflict toast, reports no success, leaves the
 *     proposal in the editor, reads as unsaved, and refetches the document.
 *
 * Mocking harness copied from `DocumentEditor.visual-slots.test.tsx`. Changed
 * here: a small fake server behind `documents.get` and `documents.update`
 * (a version counter, and CONFLICT on a stale `expectedVersion`), `useEditor`
 * records its options so a test can fire the editor's `onUpdate`, the
 * context-update hook records its options, and the editor renders its Save
 * button into a slot.
 */

import { serializeVisualSlot } from "@repo/utils/glossy/visual-slots";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	waitFor,
	within,
} from "@testing-library/react";
import { Editor } from "@tiptap/core";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- A fake server: one document with a version counter. A save carrying a
// stale `expectedVersion` is refused with the oRPC CONFLICT code, as
// `updateDocumentProcedure` does.
const server = { content: "", version: 7 };
// The document's status, kept beside `server` so the assertions that compare
// `server` as a whole still read as "content and version, nothing else".
let serverStatus = "COMPLETED";
let serverType = "BUSINESS_CASE";
let documentGetCalls = 0;
const saveCalls: Array<Record<string, unknown>> = [];

function serverDocument() {
	return {
		document: {
			id: "doc-1",
			title: "Business case",
			type: serverType,
			content: server.content,
			version: server.version,
			status: serverStatus,
		},
	};
}

async function fakeUpdate(vars: Record<string, unknown>) {
	saveCalls.push({ ...vars });
	if (
		vars.expectedVersion !== undefined &&
		vars.expectedVersion !== server.version
	) {
		throw Object.assign(
			new Error(
				"The document changed while your changes were being saved, so nothing was saved. Review the latest version and apply your changes again.",
			),
			{ code: "CONFLICT" },
		);
	}
	if (typeof vars.content === "string") {
		server.content = vars.content;
		server.version += 1;
	}
	// As `updateDocumentProcedure` does: a save that asks completes the
	// document only if it is still a draft and has content, and reports
	// whether this request did.
	let draftCompleted = false;
	if (
		vars.completeDraft === true &&
		serverStatus === "DRAFT" &&
		server.content.trim() !== ""
	) {
		serverStatus = "COMPLETE";
		draftCompleted = true;
	}
	return { ...serverDocument(), contentUnchanged: false, draftCompleted };
}

const PROJECT_PAYLOAD = {
	project: { name: "proj-1", techStack: [], features: [] },
};

function cannedResponseFor(path: string[]): unknown {
	const joined = path.join(".");
	if (joined === "projects.documents.get") {
		documentGetCalls += 1;
		return serverDocument();
	}
	if (joined === "projects.get") {
		return PROJECT_PAYLOAD;
	}
	return {};
}

let capturedUpdateMutationConfig: Record<string, any> | undefined;

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
							mutationFn: async (
								vars: Record<string, unknown>,
							) =>
								isSave
									? fakeUpdate(vars)
									: cannedResponseFor(path),
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
const actionConfigs = new Map<string, Record<string, any>>();
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({
		state: mockAgentState,
		setState: vi.fn(),
		nodeName: undefined,
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
let latestEditorOptions: { onUpdate?: (p: { editor: Editor }) => void } = {};
vi.mock("@tiptap/react", () => ({
	EditorContent: () => null,
	useEditor: (options: typeof latestEditorOptions) => {
		latestEditorOptions = options;
		return mockEditor;
	},
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

// The context-update hook records its options, so a test can play a
// confirmed context update.
let contextUpdateOptions: { onSaved?: (version: number) => void } = {};
vi.mock(
	"@saas/projects/components/documents/useUpdateDocumentWithContext",
	() => ({
		useUpdateDocumentWithContext: (
			options: typeof contextUpdateOptions,
		) => {
			contextUpdateOptions = options;
			return {
				isActive: false,
				showingDiff: false,
				isApplying: false,
				isLoading: false,
				loadingStage: null,
				elapsedSeconds: 0,
				preview: null,
				start: vi.fn(),
				confirm: vi.fn(),
				reject: vi.fn(),
			};
		},
	}),
);

import { DocumentEditor } from "@saas/projects/components/DocumentEditor";
import { fromMarkdown } from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { createAdvancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { toast } from "sonner";

const SLOT_A = serializeVisualSlot({
	id: "slot-a",
	kind: "timeline",
	hint: "Show the phases",
});

const STORED = `## Implementation Phases\n\nPhase one, then two.\n\n${SLOT_A}\n\n## Risks\n\nFew.`;
const SLOT_FREE =
	"## Implementation Phases\n\nPhase one, then two.\n\n## Risks\n\nFew.";
/** What the model proposes: a rewrite that leaves the slot tag out. */
const PROPOSED =
	"## Implementation Phases\n\nPhase one, then two, then three.\n\n## Risks\n\nFew.";
const PROPOSED_AGAIN =
	"## Implementation Phases\n\nPhase one, then two, then three.\n\n## Risks\n\nFew, and all of them known.";

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

let queryClient: QueryClient;
let saveSlot: HTMLElement;

function tree() {
	return (
		<QueryClientProvider client={queryClient}>
			<DocumentEditor
				projectId="proj-1"
				documentId="doc-1"
				saveSlot={saveSlot}
			/>
		</QueryClientProvider>
	);
}

async function mount(stored: string) {
	server.content = stored;
	mockEditor = makeEditor(stored);
	const view = render(tree());
	await waitFor(() => {
		expect(capturedUpdateMutationConfig?.onMutate).toBeTypeOf("function");
	});
	return { ...view, editor: mockEditor };
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

/**
 * One assistant run that proposes `proposed`, reviewed and accepted through
 * the confirm card, then resolved so a later run can arm again.
 */
async function acceptProposal(
	rerender: (ui: ReactElement) => void,
	proposed: string,
) {
	mockAgentState = {};
	mockIsLoading = true;
	rerender(tree());
	await flush();
	mockAgentState = { document: proposed };
	mockIsLoading = false;
	rerender(tree());
	await flush();

	const respond = vi.fn();
	let card: ReactElement | undefined;
	await act(async () => {
		card = actionConfigs.get("confirm_changes")?.renderAndWaitForResponse({
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
	await act(async () => {
		actionConfigs.get("confirm_changes")?.renderAndWaitForResponse({
			args: {},
			respond,
			status: "complete",
		});
	});
	expect(respond).toHaveBeenCalledWith({ accepted: true });
}

function cachedDocument() {
	const [[, data]] = queryClient.getQueriesData<{
		document: { content: string; version: number };
	}>({ queryKey: ["projects", "documents", "get"] });
	return data?.document;
}

function saveButton() {
	return within(saveSlot).getByRole("button", {
		name: /^(Save document|Document saved, no changes to save|Saving)$/,
	});
}

describe("DocumentEditor — the assistant accept's version guard (KTD17)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedUpdateMutationConfig = undefined;
		saveCalls.length = 0;
		actionConfigs.clear();
		contextUpdateOptions = {};
		latestEditorOptions = {};
		mockIsLoading = false;
		mockAgentState = {};
		server.content = "";
		server.version = 7;
		serverStatus = "COMPLETED";
		serverType = "BUSINESS_CASE";
		documentGetCalls = 0;
		saveSlot = window.document.createElement("div");
		window.document.body.appendChild(saveSlot);
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
		saveSlot.remove();
	});

	it("a slotted accept sends expectedVersion equal to the version its slots came from", async () => {
		const { rerender } = await mount(STORED);

		await acceptProposal(rerender, PROPOSED);

		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({
			projectId: "proj-1",
			id: "doc-1",
			expectedVersion: 7,
		});
		expect(saveCalls[0].content).toContain(SLOT_A);
		expect(server.version).toBe(8);
		expect(toast.success).toHaveBeenCalledWith(
			"Changes applied — saved as v8",
		);
	});

	it("a later slotted accept is guarded with the version the previous save answered with", async () => {
		const { rerender } = await mount(STORED);

		await acceptProposal(rerender, PROPOSED);
		await acceptProposal(rerender, PROPOSED_AGAIN);

		expect(saveCalls.map((call) => call.expectedVersion)).toEqual([7, 8]);
		expect(server.version).toBe(9);
		expect(server.content).toContain("all of them known");
		expect(server.content).toContain(SLOT_A);
	});

	it("a slotted accept after a confirmed context update is guarded with the version that update was saved as", async () => {
		const { rerender } = await mount(STORED);

		// The context update saved the body the editor holds as v9.
		server.version = 9;
		await act(async () => {
			contextUpdateOptions.onSaved?.(9);
		});
		await acceptProposal(rerender, PROPOSED);

		expect(saveCalls.at(-1)?.expectedVersion).toBe(9);
		expect(server.version).toBe(10);
	});

	it("a slotted accept after a regeneration is guarded with the version of the regenerated body", async () => {
		const { rerender, editor } = await mount(STORED);

		// Start a regeneration the way the assistant's tool call does.
		await act(async () => {
			actionConfigs.get("regenerate_document")?.renderAndWaitForResponse({
				args: { prompt: "Rewrite it" },
				respond: vi.fn(),
				status: "executing",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		rerender(tree());

		// The workflow writes the regenerated body, slot carried over, as v8;
		// the poll brings it into the editor.
		const regenerated = STORED.replace("then two", "then two, regenerated");
		server.content = regenerated;
		server.version = 8;
		await act(async () => {
			await queryClient.refetchQueries();
		});
		await waitFor(() => {
			expect(getEditorMarkdownForSave(editor)).toContain("regenerated");
		});

		await acceptProposal(rerender, PROPOSED);

		expect(saveCalls.at(-1)?.expectedVersion).toBe(8);
		expect(server.version).toBe(9);
	});

	it("a slot-free accept sends exactly the unguarded save it always did", async () => {
		const { rerender } = await mount(SLOT_FREE);

		await acceptProposal(rerender, PROPOSED);

		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).not.toHaveProperty("expectedVersion");
		expect(saveCalls[0]).toEqual({
			projectId: "proj-1",
			id: "doc-1",
			content: expect.stringContaining("then three"),
		});
		expect(toast.success).toHaveBeenCalledWith(
			"Changes applied — saved as v8",
		);
	});

	it("an ordinary save of a slotted document sends exactly the unguarded save it always did", async () => {
		const { editor } = await mount(STORED);

		// The person types; the editor's onUpdate re-derives the dirty flag.
		await act(async () => {
			editor.commands.insertContentAt(
				editor.state.doc.content.size,
				"<p>One more line.</p>",
			);
			latestEditorOptions.onUpdate?.({ editor });
		});
		await waitFor(() => {
			expect(saveButton()).toHaveAccessibleName("Save document");
		});

		await act(async () => {
			fireEvent.click(saveButton());
		});
		await flush();

		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).not.toHaveProperty("expectedVersion");
		expect(saveCalls[0]).toEqual({
			projectId: "proj-1",
			id: "doc-1",
			content: expect.stringContaining("One more line."),
			// The Save button is the author's own call on the document, so
			// it also asks the server to complete a draft. Still unguarded.
			completeDraft: true,
		});
		expect(saveCalls[0].content).toContain(SLOT_A);
	});

	it("a CONFLICT shows the conflict toast, keeps the proposal in the editor, reads as unsaved, and refetches", async () => {
		const { rerender, editor } = await mount(STORED);

		// Someone else deletes the slot and saves (v8), and a refetch brings
		// that version into the cache — but not into the editor, which still
		// holds the v7 body its slots came from.
		const elsewhere =
			"## Implementation Phases\n\nPhase one, then two, revised elsewhere.\n\n## Risks\n\nFew.";
		server.content = elsewhere;
		server.version = 8;
		await act(async () => {
			await queryClient.refetchQueries();
		});
		expect(cachedDocument()?.version).toBe(8);
		const getCallsBeforeAccept = documentGetCalls;

		await acceptProposal(rerender, PROPOSED);

		// Guarded with the editor's version, not the cache's — so refused.
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0].expectedVersion).toBe(7);
		expect(server).toEqual({ content: elsewhere, version: 8 });

		// Told plainly, never told it worked.
		expect(toast.error).toHaveBeenCalledWith(
			expect.stringMatching(
				/^Your accepted changes were not saved: the document changed in the meantime\./,
			),
		);
		expect(toast.error).not.toHaveBeenCalledWith(
			expect.stringMatching(/^Failed to save document/),
		);
		expect(toast.success).not.toHaveBeenCalled();

		// The proposal, slot included, is still there to copy or reapply.
		const inEditor = getEditorMarkdownForSave(editor) ?? "";
		expect(inEditor).toContain("then three");
		expect(inEditor).toContain(SLOT_A);

		// Not marked saved: the Save button offers a save.
		expect(saveButton()).toHaveAccessibleName("Save document");
		expect(saveButton()).toBeEnabled();

		// The document is refetched, and the cache holds the server's version,
		// not the refused proposal.
		await waitFor(() => {
			expect(documentGetCalls).toBeGreaterThan(getCallsBeforeAccept);
		});
		expect(cachedDocument()).toMatchObject({
			content: elsewhere,
			version: 8,
		});
	});

	/**
	 * Completing a draft is the explicit Save's job, and only its job. Kept in
	 * this file for its harness: the fake server above also holds the
	 * document's status, and completes a draft when a save asks it to.
	 *
	 * The autosave fires ten seconds after the last keystroke and clears the
	 * unsaved state. Two things follow, and both are pinned here: it must not
	 * complete the draft, and it must not leave Save disabled on a draft that
	 * is still owed its completion.
	 */
	describe("completing a draft", () => {
		beforeEach(() => {
			serverStatus = "DRAFT";
		});

		it("an autosave keeps the text, leaves the draft a draft, and leaves Save available", async () => {
			const { editor } = await mount(STORED);

			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				await act(async () => {
					editor.commands.insertContentAt(
						editor.state.doc.content.size,
						"<p>One more line.</p>",
					);
					latestEditorOptions.onUpdate?.({ editor });
				});
				// The debounce, then the save it starts: the save's own
				// follow-ups are timers too, and would be dropped with the
				// fake clock if it were restored before they ran.
				await act(async () => {
					await vi.advanceTimersByTimeAsync(10_000);
				});
				await act(async () => {
					await vi.advanceTimersByTimeAsync(1_000);
				});
			} finally {
				vi.useRealTimers();
			}
			await flush();

			expect(saveCalls).toHaveLength(1);
			expect(saveCalls[0]).toEqual({
				projectId: "proj-1",
				id: "doc-1",
				content: expect.stringContaining("One more line."),
			});
			expect(saveCalls[0]).not.toHaveProperty("completeDraft");
			expect(serverStatus).toBe("DRAFT");

			await waitFor(() => {
				expect(saveButton()).toHaveAccessibleName("Save document");
			});
			expect(saveButton()).toBeEnabled();
		});

		it("Save on a draft whose text is already saved completes it, and then has nothing left to do", async () => {
			await mount(STORED);
			await waitFor(() => {
				expect(saveButton()).toBeEnabled();
			});

			await act(async () => {
				fireEvent.click(saveButton());
			});
			await flush();

			expect(saveCalls).toHaveLength(1);
			expect(saveCalls[0]).toMatchObject({
				id: "doc-1",
				completeDraft: true,
			});
			expect(serverStatus).toBe("COMPLETE");
			expect(toast.success).toHaveBeenCalledWith(
				"Document saved and marked as complete",
			);
			await waitFor(() => {
				expect(saveButton()).toHaveAccessibleName(
					"Document saved, no changes to save",
				);
			});
			expect(saveButton()).toBeDisabled();
		});

		it("does not claim the completion when someone else had already completed the draft", async () => {
			await mount(STORED);
			await waitFor(() => {
				expect(saveButton()).toBeEnabled();
			});
			// Completed elsewhere; this editor has not refetched and still
			// holds the document as a draft.
			serverStatus = "COMPLETE";

			await act(async () => {
				fireEvent.click(saveButton());
			});
			await flush();

			expect(saveCalls).toHaveLength(1);
			expect(toast.success).toHaveBeenCalledWith(
				"Document saved successfully",
			);
			expect(toast.success).not.toHaveBeenCalledWith(
				"Document saved and marked as complete",
			);
			// The response says the document is complete, so Save has nothing
			// left to finish and does not stay enabled.
			await waitFor(() => {
				expect(saveButton()).toHaveAccessibleName(
					"Document saved, no changes to save",
				);
			});
			expect(saveButton()).toBeDisabled();
		});

		it("does not offer Save on a draft while an assistant proposal is streaming or awaiting review", async () => {
			const { rerender } = await mount(STORED);
			await waitFor(() => {
				expect(saveButton()).toBeEnabled();
			});

			// The assistant is writing into the editor.
			mockAgentState = {};
			mockIsLoading = true;
			rerender(tree());
			await flush();
			expect(saveButton()).toBeDisabled();

			// Its proposal is on screen, waiting for Accept or Reject. Saving
			// now would store text nobody accepted and complete the document
			// on it.
			mockAgentState = { document: PROPOSED };
			mockIsLoading = false;
			rerender(tree());
			await flush();
			await act(async () => {
				actionConfigs.get("confirm_changes")?.renderAndWaitForResponse({
					args: {},
					respond: vi.fn(),
					status: "executing",
				});
				await Promise.resolve();
			});
			await flush();
			expect(saveButton()).toBeDisabled();
			expect(saveCalls).toHaveLength(0);
		});

		it("does not keep Save enabled on a draft integration contract, which a save never completes", async () => {
			serverType = "INTEGRATION_CONTRACT";
			await mount(STORED);

			await waitFor(() => {
				expect(saveButton()).toHaveAccessibleName(
					"Document saved, no changes to save",
				);
			});
			expect(saveButton()).toBeDisabled();
		});

		it("a document that is not a draft keeps Save disabled until there is something to save", async () => {
			serverStatus = "COMPLETE";
			await mount(STORED);

			await waitFor(() => {
				expect(saveButton()).toHaveAccessibleName(
					"Document saved, no changes to save",
				);
			});
			expect(saveButton()).toBeDisabled();
		});
	});
});
