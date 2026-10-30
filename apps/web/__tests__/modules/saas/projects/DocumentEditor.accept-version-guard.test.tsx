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
 *     proposal in the editor, reads as unsaved, and refetches the document;
 *     a CONFLICT because a generation run holds the document says a run is
 *     writing instead (Fizzy #2946);
 *   - the regeneration review counts both bodies' words as the server counts
 *     a document's, a diagram fence or an image being no words (Fizzy #2946).
 *
 * Mocking harness copied from `DocumentEditor.visual-slots.test.tsx`. Changed
 * here: a small fake server behind `documents.get` and `documents.update`
 * (a version counter, and CONFLICT on a stale `expectedVersion`), `useEditor`
 * records its options so a test can fire the editor's `onUpdate`, the
 * context-update hook records its options, and the editor renders its Save
 * button into a slot. For the attached-run tests the sidebar can render its
 * children (with stand-ins for those not under test), and collaboration can
 * be switched on over a fake room.
 */

import { countDocumentWords } from "@repo/utils/document-word-count";
import { serializeVisualSlot } from "@repo/utils/glossy/visual-slots";
import { buildSectionMap } from "@repo/utils/proposal-artifact/section-hash";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { Editor } from "@tiptap/core";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- A fake server: one document with a version counter. A save carrying a
// stale `expectedVersion` is refused with the oRPC CONFLICT code, as
// `updateDocumentProcedure` does.
const meetingNotesFetch = vi.fn();
let mockChatMessages: unknown[] = [];
const server = { content: "", version: 7 };
// The document's status, kept beside `server` so the assertions that compare
// `server` as a whole still read as "content and version, nothing else".
let serverStatus = "COMPLETED";
let serverType = "BUSINESS_CASE";
/** Whether a read names the body's identity; a server older than it does not. */
let serverNamesHash = true;
let documentGetCalls = 0;
const saveCalls: Array<Record<string, unknown>> = [];
/** The next save is refused with this error, writing nothing. */
let refuseNextSave: Error | null = null;
/** What the editor records of a confirm in the chat. */
const recordOutcome = vi.fn();

function serverDocument() {
	return {
		document: {
			id: "doc-1",
			title: "Business case",
			type: serverType,
			content: server.content,
			version: server.version,
			status: serverStatus,
			contentHash: serverNamesHash ? hashOf(server.content) : null,
		},
	};
}

/** A stand-in for the server's body identity; the editor never computes it. */
function hashOf(content: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i += 1) {
		hash ^= content.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `h${hash.toString(16)}-${content.length}`;
}

async function fakeUpdate(vars: Record<string, unknown>) {
	saveCalls.push({ ...vars });
	const refusal = refuseNextSave;
	refuseNextSave = null;
	if (refusal) {
		throw refusal;
	}
	if (
		vars.expectedVersion !== undefined &&
		(vars.expectedVersion !== server.version ||
			(vars.expectedContentHash !== undefined &&
				vars.expectedContentHash !== hashOf(server.content)))
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
			apply(_target, _this, args) {
				if (path.join(".") === "projects.documents.fetchMeetingNotes") {
					return meetingNotesFetch(...args);
				}
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

// ---- Collaboration: off unless a test sets NEXT_PUBLIC_ENABLE_COLLABORATION.
// Then the editor runs on a connected, synced room whose awareness a test
// supplies; the shared fragment already holds the body, so the editor's
// first-sync seeding stays out of the way.
type FakeAwareness = {
	clientID: number;
	getStates: () => Map<number, Record<string, unknown>>;
	getLocalState: () => Record<string, unknown> | null;
	setLocalStateField: ReturnType<typeof vi.fn>;
};
const collab = vi.hoisted(() => ({
	ydoc: { getXmlFragment: () => ({ length: 1 }) },
	provider: { awareness: null as unknown },
}));
vi.mock("@saas/projects/hooks/useCollaborativeEditor", () => ({
	useCollaborativeEditor: () => ({
		ydoc: collab.ydoc,
		provider: collab.provider,
		isConnected: true,
		isSynced: true,
		collaborators: [],
		userColor: "#4ECDC4",
	}),
}));
vi.mock("@saas/projects/lib/tiptap-extensions", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/projects/lib/tiptap-extensions")
	>()),
	createCollaborativeExtensions: () => [],
}));

// ---- CopilotKit: agent state, node name, and loading flag are mutable so a
// test can walk a run; every action config is recorded.
let mockIsLoading = false;
let mockAgentState: Record<string, unknown> = {};
const coAgentSetState = vi.fn();
const actionConfigs = new Map<string, Record<string, any>>();
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({
		state: mockAgentState,
		setState: coAgentSetState,
		nodeName: undefined,
	}),
	useCopilotAction: (config: Record<string, any>) => {
		actionConfigs.set(config.name, config);
	},
	useFrontendTool: vi.fn(),
	useCopilotChat: () => ({ isLoading: mockIsLoading, visibleMessages: [] }),
	useCopilotChatInternal: () => ({
		messages: mockChatMessages,
		setMessages: vi.fn(),
	}),
	useCopilotReadable: vi.fn(),
	useCopilotMessagesContext: () => ({ setMessages: vi.fn() }),
}));
// The sidebar renders nothing, except for the tests that look at what the
// editor shows inside it: the progress overlay and the regeneration review.
// Its other children are stand-ins.
const sidebar = vi.hoisted(() => ({ rendersChildren: false }));
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({ children }: { children?: import("react").ReactNode }) =>
		sidebar.rendersChildren ? children : null,
}));
// Every flag off unless a test turns one on.
const featureFlags = vi.hoisted(() => ({
	values: {} as Record<string, boolean>,
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => featureFlags.values[key] ?? false,
}));
vi.mock("@saas/projects/components/DocumentGenerationProgress", () => ({
	DocumentGenerationProgress: () => (
		<div data-testid="generation-progress-overlay" />
	),
}));
vi.mock("@saas/projects/components/EditorToolbar", () => ({
	EditorToolbar: () => null,
}));
vi.mock("@saas/projects/components/DocumentTocRail", () => ({
	DocumentTocRail: () => null,
}));
vi.mock("@saas/projects/components/DocumentVersionHistory", () => ({
	DocumentVersionHistory: () => null,
}));
vi.mock("@saas/projects/components/DiffReviewBar", () => ({
	DiffReviewBar: () => null,
}));
vi.mock("@saas/projects/components/DiffViewModeToggle", () => ({
	DiffViewModeToggle: () => null,
}));
vi.mock("@saas/projects/components/DiffPreviewPanes", () => ({
	DiffPreviewPanes: () => null,
}));
vi.mock("@saas/projects/components/DocumentAssetFrame", () => ({
	DocumentAssetsPanel: () => null,
}));
vi.mock("@saas/projects/components/DocumentDecisionPrecheckBanner", () => ({
	DocumentDecisionPrecheckBanner: () => null,
}));
vi.mock("@saas/projects/components/DocumentGenerationFailedNotice", () => ({
	DocumentGenerationFailedNotice: () => null,
}));
vi.mock("@saas/projects/components/ImageSelectionToolbar", () => ({
	ImageSelectionToolbar: () => null,
}));
vi.mock("@saas/projects/components/ImageLightbox", () => ({
	ImageLightbox: () => null,
}));
vi.mock("@saas/projects/components/CollaborationStatus", () => ({
	CollaborationStatus: () => null,
}));
vi.mock("@saas/projects/components/copilot/CopilotHistoryDrawer", () => ({
	CopilotHistoryDrawer: () => null,
}));
vi.mock("@saas/projects/components/copilot/CopilotPersistenceHook", () => ({
	CopilotPersistenceHook: () => null,
}));
vi.mock("@saas/projects/components/stories/MeetingSelector", () => ({
	MeetingSelector: ({
		onConfirm,
	}: {
		onConfirm: (meetings: { joinUrl: string }[]) => void;
	}) => (
		<button
			type="button"
			onClick={() =>
				onConfirm([{ joinUrl: "https://example.com/meeting" }])
			}
		>
			Confirm meeting notes
		</button>
	),
}));
vi.mock("@saas/prompts/components/PromptSelector", () => ({
	PromptSelector: () => null,
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
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		dismiss: vi.fn(),
	},
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
	// The editor stamps a proposal it answers itself (the idle limit).
	useRecordDocumentAssistantDiffOutcome: () => ({ mutateAsync: vi.fn() }),
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
	useConfirmChangesOperationResult: () => recordOutcome,
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
import { GENERATION_RUN_AWARENESS_FIELD } from "@saas/projects/components/proposal-artifact/generation-run-awareness";
import { aiAcceptOfferToastId } from "@saas/projects/components/proposal-artifact/useSectionRevision";
import { fromMarkdown, toAgentDocument } from "@saas/projects/lib/diff-utils";
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

function tree(extraProps: { attachToServerRun?: boolean } = {}) {
	return (
		<QueryClientProvider client={queryClient}>
			<DocumentEditor
				projectId="proj-1"
				documentId="doc-1"
				saveSlot={saveSlot}
				{...extraProps}
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

/** Lets the editor's animation-frame writes land before a test looks. */
async function nextFrames() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
}

/**
 * One assistant run that proposes `proposed`, reviewed and accepted through
 * the confirm card, then resolved so a later run can arm again. `settle`
 * lets each step land; a test on a fake clock passes one that steps it.
 */
async function acceptProposal(
	rerender: (ui: ReactElement) => void,
	proposed: string,
	settle: () => Promise<void> = flush,
) {
	mockAgentState = {};
	mockIsLoading = true;
	rerender(tree());
	await settle();
	mockAgentState = { document: proposed };
	mockIsLoading = false;
	rerender(tree());
	await settle();

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
	await settle();
	await act(async () => {
		(card?.props as { onConfirm: () => void }).onConfirm();
	});
	await settle();
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
		mockChatMessages = [];
		meetingNotesFetch.mockResolvedValue({
			notes: [
				{ subject: "Example meeting", content: "Example transcript" },
			],
		});
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
		refuseNextSave = null;
		featureFlags.values = {};
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
		vi.unstubAllEnvs();
		collab.provider.awareness = null;
	});

	it.each([
		[
			{ type: "text", text: "Use these meeting notes" },
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,example" },
			},
		],
		[
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,example" },
			},
		],
	])(
		"meeting notes wiring admits content parts %j and caches one fetch",
		async (...parts) => {
			mockChatMessages = [
				{ role: "user", id: "example-meeting-request", content: parts },
			];
			await mount(SLOT_FREE);
			const respond = vi.fn();
			render(
				actionConfigs.get("select_meetings")?.renderAndWaitForResponse({
					args: {},
					respond,
					status: "executing",
				}),
			);
			fireEvent.click(
				await screen.findByRole("button", {
					name: "Confirm meeting notes",
				}),
			);
			await waitFor(() =>
				expect(respond).toHaveBeenCalledWith(
					expect.stringContaining("Example transcript"),
				),
			);
			expect(meetingNotesFetch).toHaveBeenCalledTimes(1);
			const cached = await actionConfigs
				.get("fetchMeetingNotes")
				?.handler({
					selectedMeetings: [
						{ joinUrl: "https://example.com/meeting" },
					],
				});
			expect(cached).toContain("Example transcript");
			expect(meetingNotesFetch).toHaveBeenCalledTimes(1);
		},
	);

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
		// Recorded in the chat once its save has landed (Fizzy #2946).
		expect(recordOutcome).toHaveBeenCalledTimes(1);
		expect(recordOutcome).toHaveBeenCalledWith({
			accepted: true,
			summary: "Changes applied.",
			operationKey: expect.any(String),
		});
	});

	it("hands the agent the document without Turndown's escapes", async () => {
		// Arrange
		const escaped = "## Notes\n\nSources \\[S1\\] and a path C:\\\\Users.";

		// Act
		await mount(escaped);
		const sent = coAgentSetState.mock.calls
			.map(([update]) =>
				typeof update === "function" ? update({}) : update,
			)
			.map((state) => state?.document)
			.filter(
				(document): document is string => typeof document === "string",
			)
			.filter((document) => document.length > 0);

		// Assert
		expect(sent.length).toBeGreaterThan(0);
		expect(sent.at(-1)).toContain("Sources [S1] and a path C:\\\\Users.");
		for (const document of sent) {
			expect(document).not.toContain("\\[");
		}
	});

	it("treats a proposal that only drops the editor's escapes as unchanged", async () => {
		// Arrange
		const { rerender, editor } = await mount(
			"## Notes\n\nSources \\[S1\\] and \\[S2\\].",
		);
		const baseline = getEditorMarkdownForSave(editor) ?? "";
		mockAgentState = {};
		mockIsLoading = true;
		rerender(tree());
		await flush();
		mockAgentState = { document: toAgentDocument(baseline) };
		mockIsLoading = false;
		rerender(tree());
		await flush();
		const respond = vi.fn();

		// Act
		await act(async () => {
			actionConfigs.get("confirm_changes")?.renderAndWaitForResponse({
				args: {},
				respond,
				status: "executing",
			});
			await Promise.resolve();
		});
		await flush();

		// Assert
		expect(baseline).toContain("\\[S1\\]");
		expect(respond).toHaveBeenCalledWith({ accepted: false });
		expect(toast.info).toHaveBeenCalledWith(
			"No updates found — the document is unchanged.",
		);
		expect(saveCalls).toHaveLength(0);
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

		// Told plainly, never told it worked — in the document's one
		// refused-save toast, which the next save that lands takes away
		// (Fizzy #2946).
		expect(toast.error).toHaveBeenCalledWith(
			expect.stringMatching(
				/^Your accepted changes were not saved: the document changed in the meantime\./,
			),
			{ id: "document-save-failed:doc-1" },
		);
		// The chat records the refusal once, never that it was applied.
		expect(recordOutcome).toHaveBeenCalledTimes(1);
		expect(recordOutcome).toHaveBeenCalledWith({
			accepted: true,
			outcome: "failure",
			summary:
				"The accepted changes could not be saved; they are still in the editor.",
			operationKey: expect.any(String),
		});
		// Not the generic refusal either (translations echo their keys).
		expect(toast.error).not.toHaveBeenCalledWith("failed");
		expect(toast.error).not.toHaveBeenCalledWith("changedMeanwhile");
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

	it("a slotted accept refused because a generation run holds the document says a run is writing, not that the document changed, and keeps the proposal unsaved (Fizzy #2946)", async () => {
		const { rerender, editor } = await mount(STORED);
		const getCallsBeforeAccept = documentGetCalls;
		refuseNextSave = Object.assign(
			new Error(
				"A generation run is writing this document; try again when it finishes.",
			),
			{
				code: "CONFLICT",
				data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
			},
		);

		await acceptProposal(rerender, PROPOSED);

		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0].expectedVersion).toBe(7);
		expect(server).toEqual({ content: STORED, version: 7 });

		expect(toast.info).toHaveBeenCalledWith("saveBlocked.runLive");
		expect(toast.error).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();

		const inEditor = getEditorMarkdownForSave(editor) ?? "";
		expect(inEditor).toContain("then three");
		expect(inEditor).toContain(SLOT_A);
		expect(saveButton()).toHaveAccessibleName("Save document");

		await waitFor(() => {
			expect(documentGetCalls).toBeGreaterThan(getCallsBeforeAccept);
		});
	});

	it("says beside Save that the assistant is finishing while the run that answers an accepted proposal keeps the editor read-only, and nothing once it ends (Fizzy #2946)", async () => {
		const { rerender, editor } = await mount(STORED);
		await acceptProposal(rerender, PROPOSED);
		expect(within(saveSlot).queryByText("assistantFinishing")).toBeNull();
		expect(editor.isEditable).toBe(true);

		// The short run CopilotKit starts after an Accept: the chat is busy,
		// and no message was sent, so no Generating pill.
		mockIsLoading = true;
		rerender(tree());
		await flush();
		expect(editor.isEditable).toBe(false);
		const status = await within(saveSlot).findByText("assistantFinishing");
		expect(status.closest("output")).toHaveAttribute("aria-live", "polite");

		mockIsLoading = false;
		rerender(tree());
		await flush();
		expect(within(saveSlot).queryByText("assistantFinishing")).toBeNull();
		expect(editor.isEditable).toBe(true);
	});

	it("says nothing while the chat is busy with no proposal answered — the connect handshake on a page load — however long it lasts, and says it once the run an accept starts has held the editor for its delay (Fizzy #2946)", async () => {
		const { rerender } = await mount(STORED);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const shown = () =>
				within(saveSlot).queryByText("assistantFinishing");
			const step = (ms: number) =>
				act(async () => {
					await vi.advanceTimersByTimeAsync(ms);
				});

			// Busy for a second with nothing answered: never shown.
			mockIsLoading = true;
			rerender(tree());
			await step(1000);
			expect(shown()).toBeNull();
			mockIsLoading = false;
			rerender(tree());
			await step(0);

			// The run an accept starts: shown once its delay has passed, and
			// gone when it ends.
			await acceptProposal(rerender, PROPOSED, () => step(0));
			mockIsLoading = true;
			rerender(tree());
			await step(250);
			expect(shown()).toBeNull();
			await step(100);
			expect(shown()).not.toBeNull();
			mockIsLoading = false;
			rerender(tree());
			await step(0);
			expect(shown()).toBeNull();

			// That answer was for that run: the next busy spell says nothing.
			mockIsLoading = true;
			rerender(tree());
			await step(1000);
			expect(shown()).toBeNull();
			mockIsLoading = false;
			rerender(tree());
			await step(0);

			// Nor does an answer whose run never came, once it is long past.
			await acceptProposal(rerender, PROPOSED_AGAIN, () => step(0));
			await step(10_000);
			mockIsLoading = true;
			rerender(tree());
			await step(1000);
			expect(shown()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * A run the editor did not start — from the documents list, the chat, or
	 * before a reload — is adopted, not reviewed: its body replaces the one the
	 * editor loaded with no Accept/Reject, since Reject would rewind someone
	 * else's run. Only the run's final save counts as its result, and a run
	 * that ends without a new body lets the editor go. Under collaboration one
	 * editor writes the body into the shared document; the others get it
	 * through the room.
	 *
	 * The sidebar renders its children here, so the progress overlay (shown
	 * while the editor regenerates) and the regeneration review are visible.
	 */
	describe("attaching to a run it did not start (Fizzy #2801)", () => {
		beforeEach(() => {
			sidebar.rendersChildren = true;
		});
		afterEach(() => {
			sidebar.rendersChildren = false;
		});

		const REGENERATED = STORED.replace("then two", "then two, regenerated");
		const WRITTEN_DURING_RUN = STORED.replace(
			"then two",
			"then two, typed by a colleague",
		);

		/** The server reports a run in progress, rendered with `attach`. */
		async function serverStartsRun(
			rerender: (ui: ReactElement) => void,
			attach: boolean,
		) {
			serverStatus = "GENERATING";
			await act(async () => {
				await queryClient.refetchQueries();
			});
			rerender(tree({ attachToServerRun: attach }));
			await flush();
		}

		/** A later server snapshot; the page attaches only while it runs. */
		async function serverReports(
			rerender: (ui: ReactElement) => void,
			snapshot: { content?: string; version?: number; status: string },
		) {
			// A later snapshot than the one that showed the run in progress.
			await new Promise((resolve) => setTimeout(resolve, 5));
			if (snapshot.content !== undefined) {
				server.content = snapshot.content;
			}
			if (snapshot.version !== undefined) {
				server.version = snapshot.version;
			}
			serverStatus = snapshot.status;
			await act(async () => {
				await queryClient.refetchQueries();
			});
			const running =
				snapshot.status === "QUEUED" ||
				snapshot.status === "GENERATING";
			rerender(tree({ attachToServerRun: running }));
			await flush();
		}

		/** The run's final save lands: its body and COMPLETE together. */
		async function serverSavesRegeneratedBody(
			rerender: (ui: ReactElement) => void,
		) {
			await serverReports(rerender, {
				content: REGENERATED,
				version: 8,
				status: "COMPLETE",
			});
		}

		function progressOverlay() {
			return screen.queryByTestId("generation-progress-overlay");
		}

		it("while it regenerates, shows the run's progress and not that the assistant is finishing, though the chat is busy too (Fizzy #2946)", async () => {
			const { rerender } = await mount(STORED);
			await serverStartsRun(rerender, true);

			mockIsLoading = true;
			rerender(tree({ attachToServerRun: true }));
			await flush();
			// Past the delay the status waits for before it shows.
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 400));
			});

			expect(progressOverlay()).not.toBeNull();
			expect(
				within(saveSlot).queryByText("assistantFinishing"),
			).toBeNull();
		});

		it("without attaching, keeps the body it loaded when another run regenerates the document", async () => {
			const { rerender, editor } = await mount(STORED);

			await serverStartsRun(rerender, false);
			await serverSavesRegeneratedBody(rerender);

			expect(getEditorMarkdownForSave(editor)).not.toContain(
				"regenerated",
			);
		});

		it("takes the regenerated body of a run it did not start", async () => {
			const { rerender, editor } = await mount(STORED);

			await serverStartsRun(rerender, true);
			await serverSavesRegeneratedBody(rerender);

			await waitFor(() => {
				expect(getEditorMarkdownForSave(editor)).toContain(
					"regenerated",
				);
			});
		});

		it("adopts that body with no review, and stops regenerating", async () => {
			const view = await mount(STORED);

			await serverStartsRun(view.rerender, true);
			expect(progressOverlay()).toBeInTheDocument();
			await serverSavesRegeneratedBody(view.rerender);

			await waitFor(() => {
				expect(getEditorMarkdownForSave(view.editor)).toContain(
					"regenerated",
				);
			});
			expect(
				view.queryByTestId("regeneration-confirm-modal"),
			).not.toBeInTheDocument();
			expect(progressOverlay()).not.toBeInTheDocument();
			expect(toast.error).not.toHaveBeenCalled();
		});

		it("takes on the adopted body's version: a later slotted accept is guarded with it", async () => {
			const view = await mount(STORED);

			await serverStartsRun(view.rerender, true);
			await serverSavesRegeneratedBody(view.rerender);
			await waitFor(() => {
				expect(getEditorMarkdownForSave(view.editor)).toContain(
					"regenerated",
				);
			});

			await acceptProposal(view.rerender, PROPOSED);

			expect(saveCalls.at(-1)?.expectedVersion).toBe(8);
			expect(server.version).toBe(9);
		});

		it("does not take a write made while the run is still generating for its result", async () => {
			const view = await mount(STORED);

			await serverStartsRun(view.rerender, true);
			// A colleague's save lands mid-run; the server is still writing.
			await serverReports(view.rerender, {
				content: WRITTEN_DURING_RUN,
				version: 8,
				status: "GENERATING",
			});
			await nextFrames();

			expect(getEditorMarkdownForSave(view.editor)).not.toContain(
				"typed by a colleague",
			);
			expect(
				view.queryByTestId("regeneration-confirm-modal"),
			).not.toBeInTheDocument();
			expect(progressOverlay()).toBeInTheDocument();

			// The run's own final save is what the editor takes.
			await serverReports(view.rerender, {
				content: REGENERATED,
				version: 9,
				status: "COMPLETE",
			});
			await waitFor(() => {
				expect(getEditorMarkdownForSave(view.editor)).toContain(
					"regenerated",
				);
			});
			expect(progressOverlay()).not.toBeInTheDocument();
		});

		it("lets go of a run that completes with the body it started from", async () => {
			const view = await mount(STORED);

			await serverStartsRun(view.rerender, true);
			await serverReports(view.rerender, { status: "COMPLETE" });

			await waitFor(() => {
				expect(progressOverlay()).not.toBeInTheDocument();
			});
			expect(
				view.queryByTestId("regeneration-confirm-modal"),
			).not.toBeInTheDocument();
			expect(toast.error).not.toHaveBeenCalled();
			expect(getEditorMarkdownForSave(view.editor)).toContain(SLOT_A);
		});

		it("lets go of a run that leaves the running states for any status but FAILED", async () => {
			const view = await mount(STORED);

			await serverStartsRun(view.rerender, true);
			await serverReports(view.rerender, { status: "DRAFT" });

			await waitFor(() => {
				expect(progressOverlay()).not.toBeInTheDocument();
			});
			expect(toast.error).not.toHaveBeenCalled();
		});

		it("keeps the review for a run it started, attached or not", async () => {
			const view = await mount(STORED);

			// Start a regeneration the way the assistant's tool call does.
			await act(async () => {
				actionConfigs
					.get("regenerate_document")
					?.renderAndWaitForResponse({
						args: { prompt: "Rewrite it" },
						respond: vi.fn(),
						status: "executing",
					});
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await serverStartsRun(view.rerender, true);
			await serverSavesRegeneratedBody(view.rerender);

			expect(
				await view.findByTestId("regeneration-confirm-modal"),
			).toBeInTheDocument();
			// The body under review is in the editor, as it always was.
			await waitFor(() => {
				expect(getEditorMarkdownForSave(view.editor)).toContain(
					"regenerated",
				);
			});
		});

		it("counts both bodies under review the way the server counts the document's words (Fizzy #2946)", async () => {
			// Prose around a diagram fence and an image, which are no words.
			const previous =
				"Intro text here.\n\n```mermaid\ngraph TD; A-->B\n```\n\n![diagram](https://example.com/a.png)\n\nClosing words.";
			const regenerated =
				"Intro text here, regenerated.\n\n```mermaid\ngraph LR; C-->D-->E\n```\n\n![chart](https://example.com/b.png)\n\nThe closing words were rewritten too.";
			const previousWords = countDocumentWords(previous);
			const regeneratedWords = countDocumentWords(regenerated);
			// The whitespace split the headings used to count with disagrees,
			// so the headings tell the two apart.
			const rawSplitCount = (text: string) =>
				text.split(/\s+/).filter((w) => w.length > 0).length;
			expect(previousWords).not.toBe(rawSplitCount(previous));
			expect(regeneratedWords).not.toBe(rawSplitCount(regenerated));

			const view = await mount(previous);

			await act(async () => {
				actionConfigs
					.get("regenerate_document")
					?.renderAndWaitForResponse({
						args: { prompt: "Rewrite it" },
						respond: vi.fn(),
						status: "executing",
					});
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await serverStartsRun(view.rerender, true);
			await serverReports(view.rerender, {
				content: regenerated,
				version: 8,
				status: "COMPLETE",
			});

			const review = within(
				await view.findByTestId("regeneration-confirm-modal"),
			);
			expect(
				await review.findByText(/Previous Version \(\d+ words\)/),
			).toHaveTextContent(`Previous Version (${previousWords} words)`);
			expect(
				review.getByText(/New Version \(\d+ words\)/),
			).toHaveTextContent(`New Version (${regeneratedWords} words)`);
		});

		it("stops regenerating with the failure toast when the attached run fails", async () => {
			const { rerender, editor } = await mount(STORED);

			await serverStartsRun(rerender, true);
			// A later snapshot than the one that showed the run in progress.
			await new Promise((resolve) => setTimeout(resolve, 5));
			serverStatus = "FAILED";
			await act(async () => {
				await queryClient.refetchQueries();
			});
			rerender(tree());
			await flush();

			await waitFor(() => {
				expect(toast.error).toHaveBeenCalledWith(
					"Document generation failed. Please try again.",
				);
			});
			expect(getEditorMarkdownForSave(editor)).not.toContain(
				"regenerated",
			);
		});

		it("leaves an empty document to the first-load path", async () => {
			const { rerender } = await mount("");

			await serverStartsRun(rerender, true);
			await new Promise((resolve) => setTimeout(resolve, 5));
			serverStatus = "FAILED";
			await act(async () => {
				await queryClient.refetchQueries();
			});
			rerender(tree());
			await flush();

			// Not attached, so the FAILED watcher has no run to stop.
			expect(toast.error).not.toHaveBeenCalledWith(
				"Document generation failed. Please try again.",
			);
		});

		describe("under collaboration", () => {
			/**
			 * The room's awareness as this editor sees it: its own client id,
			 * and the run role each other open editor has published.
			 */
			function joinRoom(
				clientID: number,
				others: Record<number, "started" | "attached" | null>,
			): FakeAwareness {
				const states = new Map<number, Record<string, unknown>>();
				for (const [id, role] of Object.entries(others)) {
					states.set(Number(id), {
						user: { name: `Colleague ${id}` },
						[GENERATION_RUN_AWARENESS_FIELD]: role,
					});
				}
				states.set(clientID, { user: { name: "Me" } });
				const awareness: FakeAwareness = {
					clientID,
					getStates: () => states,
					getLocalState: () => states.get(clientID) ?? null,
					setLocalStateField: vi.fn(
						(field: string, value: unknown) => {
							states.set(clientID, {
								...(states.get(clientID) ?? {}),
								[field]: value,
							});
						},
					),
				};
				collab.provider.awareness = awareness;
				vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "true");
				return awareness;
			}

			function publishedRoles(awareness: FakeAwareness) {
				return awareness.setLocalStateField.mock.calls
					.filter(
						([field]) => field === GENERATION_RUN_AWARENESS_FIELD,
					)
					.map(([, role]) => role);
			}

			it("says it is attached while the run is in progress, and stops saying so after", async () => {
				const awareness = joinRoom(3, {});
				const view = await mount(STORED);

				await serverStartsRun(view.rerender, true);
				expect(publishedRoles(awareness)).toEqual(["attached"]);

				await serverSavesRegeneratedBody(view.rerender);
				await waitFor(() => {
					expect(publishedRoles(awareness)).toEqual([
						"attached",
						null,
					]);
				});
			});

			it("writes the body when it is the attached editor with the smallest client id", async () => {
				joinRoom(3, { 7: "attached", 11: null });
				const view = await mount(STORED);

				await serverStartsRun(view.rerender, true);
				await serverSavesRegeneratedBody(view.rerender);

				await waitFor(() => {
					expect(getEditorMarkdownForSave(view.editor)).toContain(
						"regenerated",
					);
				});
				expect(progressOverlay()).not.toBeInTheDocument();
			});

			it("leaves the body to an attached editor with a smaller client id, and stops regenerating", async () => {
				joinRoom(7, { 3: "attached" });
				const view = await mount(STORED);

				await serverStartsRun(view.rerender, true);
				await serverSavesRegeneratedBody(view.rerender);

				await waitFor(() => {
					expect(progressOverlay()).not.toBeInTheDocument();
				});
				await nextFrames();
				// The elected editor writes it; this one receives it through
				// the room rather than writing it a second time.
				expect(getEditorMarkdownForSave(view.editor)).not.toContain(
					"regenerated",
				);
				expect(
					view.queryByTestId("regeneration-confirm-modal"),
				).not.toBeInTheDocument();
			});

			it("leaves the body to the editor that started the run, which reviews it", async () => {
				joinRoom(3, { 7: "started" });
				const view = await mount(STORED);

				await serverStartsRun(view.rerender, true);
				await serverSavesRegeneratedBody(view.rerender);

				await waitFor(() => {
					expect(progressOverlay()).not.toBeInTheDocument();
				});
				await nextFrames();
				expect(getEditorMarkdownForSave(view.editor)).not.toContain(
					"regenerated",
				);
				expect(
					view.queryByTestId("regeneration-confirm-modal"),
				).not.toBeInTheDocument();
			});

			it("says it started the run it started, until its review is done", async () => {
				const awareness = joinRoom(3, { 7: "attached" });
				const view = await mount(STORED);

				await act(async () => {
					actionConfigs
						.get("regenerate_document")
						?.renderAndWaitForResponse({
							args: { prompt: "Rewrite it" },
							respond: vi.fn(),
							status: "executing",
						});
					await new Promise((resolve) => setTimeout(resolve, 0));
				});
				view.rerender(tree());
				await flush();
				expect(publishedRoles(awareness)).toEqual(["started"]);

				await serverStartsRun(view.rerender, true);
				await serverSavesRegeneratedBody(view.rerender);
				// The review is open: still the editor that started the run,
				// and the one that wrote the body.
				expect(
					await view.findByTestId("regeneration-confirm-modal"),
				).toBeInTheDocument();
				await waitFor(() => {
					expect(getEditorMarkdownForSave(view.editor)).toContain(
						"regenerated",
					);
				});
				expect(publishedRoles(awareness)).toEqual(["started"]);
			});
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

describe("DocumentEditor — an AI accept on a client-document Proposal (Fizzy #2946)", () => {
	const CLIENT_STORED = [
		"## Approach",
		"",
		"We start with a pilot for Example Org.",
		"",
		"## Pricing",
		"",
		"A fixed fee for the first phase.",
		"",
		"### Terms",
		"",
		"Net 30.",
		"",
		"## Timeline",
		"",
		"Four weeks.",
	].join("\n");
	/** The chat patched the Pricing subtree, Terms included. */
	const CLIENT_PROPOSED = CLIENT_STORED.replace(
		"A fixed fee for the first phase.",
		"A fixed fee covers both phases.",
	).replace("Net 30.", "Net 45.");

	function keysOf(markdown: string, headings: string[]): string[] {
		return buildSectionMap(markdown)
			.sections.filter((section) =>
				headings.includes(section.headingText ?? ""),
			)
			.map((section) => section.key);
	}

	/** The lines of every section outside `headings`, in order. */
	function untouched(markdown: string, headings: string[]): string {
		const lines = markdown.split("\n");
		return buildSectionMap(markdown)
			.sections.filter(
				(section) => !headings.includes(section.headingText ?? ""),
			)
			.map((section) =>
				lines.slice(section.startLine - 1, section.endLine).join("\n"),
			)
			.join("\n---\n");
	}

	const PATCHED = ["Pricing", "Terms"];

	afterEach(() => {
		mockEditor?.destroy();
		mockEditor = null;
		saveSlot.remove();
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mockChatMessages = [];
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
		serverNamesHash = true;
		documentGetCalls = 0;
		refuseNextSave = null;
		saveSlot = window.document.createElement("div");
		window.document.body.appendChild(saveSlot);
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		serverType = "PROPOSAL";
		featureFlags.values = {
			PROPOSAL_ARTIFACT: true,
			DOCUMENT_ROOM_CONVERGENCE: true,
		};
	});

	/** One run that proposes `proposed`, answered Accept on its card. */
	async function acceptOnCard(
		rerender: (ui: ReactElement) => void,
		proposed: string,
	) {
		mockAgentState = {};
		mockIsLoading = true;
		rerender(tree());
		await flush();
		mockAgentState = {
			document: proposed,
			proposalPatchedSectionKeys: keysOf(CLIENT_STORED, PATCHED),
		};
		mockIsLoading = false;
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
		await nextFrames();
		return respond;
	}

	it("sends the CHAT descriptor with the patched sections from the saved base; everything outside them is byte-identical from the editor to the save", async () => {
		const { rerender, editor } = await mount(CLIENT_STORED);
		const before = getEditorMarkdownForSave(editor) ?? "";

		const respond = await acceptOnCard(rerender, CLIENT_PROPOSED);

		expect(respond).toHaveBeenCalledWith({ accepted: true });
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({
			aiReview: {
				kind: "CHAT",
				patchedSectionKeys: keysOf(CLIENT_STORED, PATCHED),
			},
			expectedVersion: 7,
			expectedContentHash: hashOf(CLIENT_STORED),
		});
		const saved = saveCalls[0].content as string;
		expect(saved).toContain("A fixed fee covers both phases.");
		expect(untouched(saved, PATCHED)).toBe(untouched(before, PATCHED));
		expect(untouched(getEditorMarkdownForSave(editor) ?? "", PATCHED)).toBe(
			untouched(before, PATCHED),
		);
		await waitFor(() => {
			expect(recordOutcome).toHaveBeenCalledWith(
				expect.objectContaining({
					accepted: true,
					summary: "Changes applied.",
				}),
			);
		});
		// A saved accept takes down an offer left by an earlier refused one.
		expect(toast.dismiss).toHaveBeenCalledWith(
			aiAcceptOfferToastId("doc-1"),
		);
	});

	it("an accept with no base to be checked against is not applied: the proposal goes back out of the editor and nothing is saved", async () => {
		// The read named no body identity, so the editor knows no base.
		serverNamesHash = false;
		const { rerender, editor } = await mount(CLIENT_STORED);
		const before = getEditorMarkdownForSave(editor) ?? "";

		const respond = await acceptOnCard(rerender, CLIENT_PROPOSED);

		expect(respond).toHaveBeenCalledWith({ accepted: false });
		expect(getEditorMarkdownForSave(editor)).toBe(before);
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(CLIENT_STORED);
		expect(recordOutcome).toHaveBeenCalledWith({
			accepted: false,
			summary:
				"Not applied: the editor was still syncing with the saved document.",
		});
		expect(toast.error).toHaveBeenCalledWith("chatNotApplied");
	});

	it("with the room flag off, an accept still names the body the editor loaded as its base, and is saved", async () => {
		featureFlags.values = { PROPOSAL_ARTIFACT: true };
		const { rerender } = await mount(CLIENT_STORED);

		const respond = await acceptOnCard(rerender, CLIENT_PROPOSED);

		expect(respond).toHaveBeenCalledWith({ accepted: true });
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({
			aiReview: { kind: "CHAT" },
			expectedVersion: 7,
			expectedContentHash: hashOf(CLIENT_STORED),
		});
		expect(server.content).toContain("A fixed fee covers both phases.");
		expect(toast.error).not.toHaveBeenCalledWith("chatNotApplied");
	});

	it("with the room flag off, a later accept names the body the previous save answered with", async () => {
		featureFlags.values = { PROPOSAL_ARTIFACT: true };
		const { rerender } = await mount(CLIENT_STORED);
		await acceptOnCard(rerender, CLIENT_PROPOSED);
		await waitFor(() => {
			expect(server.version).toBe(8);
		});
		const firstSaved = server.content;

		const respond = await acceptOnCard(
			rerender,
			CLIENT_PROPOSED.replace("Four weeks.", "Five weeks."),
		);

		expect(respond).toHaveBeenCalledWith({ accepted: true });
		expect(saveCalls).toHaveLength(2);
		expect(saveCalls[1]).toMatchObject({
			aiReview: { kind: "CHAT" },
			expectedVersion: 8,
			expectedContentHash: hashOf(firstSaved),
		});
		expect(server.version).toBe(9);
	});

	it("a refused accept puts back the body it was accepted over — not the proposal — offers the refused text once, records why, and is never autosaved", async () => {
		const { rerender, editor } = await mount(CLIENT_STORED);
		const before = getEditorMarkdownForSave(editor) ?? "";
		refuseNextSave = Object.assign(new Error("refused"), {
			code: "PRECONDITION_FAILED",
			data: { code: "REVISION_OUTSIDE_TARGET" },
		});

		const respond = await acceptOnCard(rerender, CLIENT_PROPOSED);

		expect(respond).toHaveBeenCalledWith({ accepted: true });
		expect(saveCalls).toHaveLength(1);
		expect(getEditorMarkdownForSave(editor)).toBe(before);
		expect(server.content).toBe(CLIENT_STORED);
		const offers = vi
			.mocked(toast.warning)
			.mock.calls.filter(([message]) => message === "offerBack");
		expect(offers).toHaveLength(1);
		// Under the document's one offer toast, which stays until a later
		// revision or saved accept takes it down.
		expect(offers[0]?.[1]).toMatchObject({
			id: aiAcceptOfferToastId("doc-1"),
			duration: Number.POSITIVE_INFINITY,
		});
		expect(toast.dismiss).not.toHaveBeenCalledWith(
			aiAcceptOfferToastId("doc-1"),
		);
		expect(recordOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				accepted: false,
				summary:
					"Not applied: it changed a section outside the one it targeted.",
			}),
		);
		expect(toast.error).toHaveBeenCalledWith("chatNotApplied");
		// Nothing is left to save: the editor holds the saved body again.
		await waitFor(() => {
			expect(saveButton()).toHaveAccessibleName(
				"Document saved, no changes to save",
			);
		});
		expect(editor.isEditable).toBe(true);
	});

	it("a version conflict keeps today's answer: the accepted text stays in the editor, unsaved, and is recorded as not saved", async () => {
		const { rerender, editor } = await mount(CLIENT_STORED);
		refuseNextSave = Object.assign(new Error("Document changed"), {
			code: "CONFLICT",
		});

		await acceptOnCard(rerender, CLIENT_PROPOSED);

		expect(getEditorMarkdownForSave(editor)).toContain(
			"A fixed fee covers both phases.",
		);
		expect(recordOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				accepted: true,
				outcome: "failure",
			}),
		);
		expect(toast.warning).not.toHaveBeenCalled();
	});

	it("with the gate off, a Proposal's accept sends no descriptor", async () => {
		featureFlags.values = { DOCUMENT_ROOM_CONVERGENCE: true };
		const { rerender } = await mount(CLIENT_STORED);

		await acceptOnCard(rerender, CLIENT_PROPOSED);

		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).not.toHaveProperty("aiReview");
	});
});

// Page-agent behavior is covered by page-agent-render-cost; retain this harness's agent fixture.
vi.mock("@saas/shared/components/copilot/use-page-agent", async () => {
	const core = await import("@copilotkit/react-core");
	return {
		usePageAgent: (name: string, initialState: object) =>
			core.useCoAgent({ name, initialState }),
	};
});

// These editor harnesses predate the enclosing page's session provider.
vi.mock(
	"@saas/shared/components/copilot/CopilotChatSessionProvider",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@saas/shared/components/copilot/CopilotChatSessionProvider")
			>();
		const core = await import("@copilotkit/react-core");
		return {
			...actual,
			useCopilotChatSessionSelector: (
				select: (session: object) => unknown,
			) =>
				select({
					...core.useCopilotChatInternal(),
					...core.useCopilotChat(),
				}),
			useCopilotChatSessionActions: () => core.useCopilotChatInternal(),
		};
	},
);
