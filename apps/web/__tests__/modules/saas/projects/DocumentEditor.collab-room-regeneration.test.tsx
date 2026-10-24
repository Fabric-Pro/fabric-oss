/**
 * A generation run's state in the document editor survives everything that
 * remounts the editor under it (Fizzy #2946).
 *
 * `CollaborativeDocumentEditor` unmounts the editor whenever the
 * collaboration room loses sync and mounts a fresh one when it is back. The
 * run's bookkeeping used to live in that editor, so a remount in the middle
 * of a run reset it: the review found no baseline, took the body the editor
 * already had for the run's result, and published this editor as the run's
 * starter — the reported revert to the previous body.
 *
 * Pinned here:
 *   - a remount mid-run neither reviews nor adopts anything until the run
 *     completes, keeps the published run role, and then ends on the run's
 *     body — through the review for the editor that started the run, through
 *     the adopt for one that follows it, also when the run ended while the
 *     room was away and the new editor exists only a render later;
 *   - a frame the review deferred lands in the editor on screen when it
 *     fires, not in the one destroyed meanwhile;
 *   - after the first sync, a drop waits for the reconnect, past the twelve
 *     seconds that used to swap in the non-collaborative editor;
 *   - in artifact mode the five-minute safety timer neither gives up on a
 *     live run nor says it is taking longer, but does give up, with the
 *     usual notice, on a run whose last write is more than ten minutes old;
 *     outside it, the timer is as before;
 *   - a regenerate the server answers with "already in progress", or with a
 *     live run it could not confirm, says so and arms no review; one whose
 *     own start it could not confirm is taken for started; a coded refusal
 *     shows the shared refusal copy;
 *   - the Save button and the save before an assistant run are refused,
 *     with the reason, while a run is live or its review is open. A run is
 *     live while the editor still polls it: a queued wait however long, a
 *     generating run that wrote within the last ten minutes. A save over a
 *     generating run silent for longer goes through, with a warning — also
 *     once an attached run this editor followed goes silent;
 *   - the Reject fallback never saves an empty body;
 *   - a review a newer saved body superseded closes without writing, and a
 *     Reject names the run it reviewed, so the server can refuse a stale one.
 *
 * Harness copied from `DocumentEditor.accept-version-guard.test.tsx`, with
 * the collaboration hook reading a sync flag a test can drop and restore,
 * the generate and reject-regeneration mutations answering as a test asks,
 * the server's run stamps settable against a fixed clock, and the sidebar
 * always rendering its children (the review and the save slot live there or
 * beside it). Translations echo their keys (see `vitest.setup.ts`).
 */

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

// ---- A fake server: one document, its version and status, the run's
// stamps, and every save. With no stamps the editor reads a run as having
// just written (`resolveGenerationClock` falls back to the current time).
const server = {
	content: "",
	version: 7,
	status: "COMPLETE",
	generationStartedAt: null as string | null,
	updatedAt: null as string | null,
};
const saveCalls: Array<Record<string, unknown>> = [];
/** What `documents.generate` answers with, or throws. */
const generate = {
	result: {
		outcome: "started",
		workflowId: "wf-1",
		runId: "run-1",
		message: "Generation started",
	} as Record<string, unknown>,
	error: null as unknown,
};
/** `documents.rejectRegeneration` finds no prior version to rewind to. */
let rejectFindsNoPriorVersion = false;
/** `documents.rejectRegeneration` finds a newer generation run holding the document. */
let rejectFindsRunLive = false;
/** `documents.rejectRegeneration` finds the document moved past the reviewed run. */
let rejectFindsReviewStale = false;
/** Every `documents.rejectRegeneration` request. */
const rejectCalls: Array<Record<string, unknown>> = [];

function serverDocument() {
	return {
		document: {
			id: "doc-1",
			title: "Example proposal",
			type: "PROPOSAL",
			content: server.content,
			version: server.version,
			status: server.status,
			generationStartedAt: server.generationStartedAt,
			updatedAt: server.updatedAt,
		},
	};
}

async function fakeUpdate(vars: Record<string, unknown>) {
	saveCalls.push({ ...vars });
	if (typeof vars.content === "string") {
		server.content = vars.content;
		if (vars.skipVersionBump !== true) {
			server.version += 1;
		}
	}
	return { ...serverDocument(), contentUnchanged: false };
}

function cannedResponseFor(path: string[]): unknown {
	const joined = path.join(".");
	if (joined === "projects.documents.get") {
		return serverDocument();
	}
	if (joined === "projects.get") {
		return { project: { name: "proj-1", techStack: [], features: [] } };
	}
	return {};
}

async function fakeMutation(
	path: string[],
	vars: Record<string, unknown>,
): Promise<unknown> {
	switch (path.join(".")) {
		case "projects.documents.update":
			return fakeUpdate(vars);
		case "projects.documents.generate":
			if (generate.error) {
				throw generate.error;
			}
			return generate.result;
		case "projects.documents.rejectRegeneration":
			rejectCalls.push({ ...vars });
			if (rejectFindsReviewStale) {
				throw Object.assign(new Error("The document changed"), {
					code: "CONFLICT",
					data: { code: "REJECT_REVIEW_STALE" },
				});
			}
			if (rejectFindsRunLive) {
				throw Object.assign(new Error("A generation run is writing"), {
					code: "CONFLICT",
					data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
				});
			}
			if (rejectFindsNoPriorVersion) {
				throw Object.assign(new Error("No prior version"), {
					code: "CONFLICT",
				});
			}
			return serverDocument();
		default:
			return cannedResponseFor(path);
	}
}

let saveMutationReady = false;

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
						if (path.join(".") === "projects.documents.update") {
							saveMutationReady = true;
						}
						return {
							mutationFn: (vars: Record<string, unknown>) =>
								fakeMutation(path, vars),
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

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ organizationSlug: "example-org" }),
	useSearchParams: () => new URLSearchParams(),
	useRouter: () => router,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-example",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
		isOrgContext: true,
		isGuest: false,
		loaded: true,
	}),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1" }, session: {} }),
}));

// ---- Collaboration: on when a test joins a room. The room's sync can drop
// and come back; the shared fragment already holds the body, so the
// editor's first-sync seeding stays out of the way.
type FakeAwareness = {
	clientID: number;
	getStates: () => Map<number, Record<string, unknown>>;
	getLocalState: () => Record<string, unknown> | null;
	setLocalStateField: ReturnType<typeof vi.fn>;
};
const collab = vi.hoisted(() => ({
	ydoc: { getXmlFragment: () => ({ length: 1 }) },
	provider: { awareness: null as unknown },
	isConnected: true,
	isSynced: true,
	enabledCalls: [] as boolean[],
}));
vi.mock("@saas/projects/hooks/useCollaborativeEditor", () => ({
	useCollaborativeEditor: (options: { enabled?: boolean }) => {
		collab.enabledCalls.push(options.enabled !== false);
		return {
			ydoc: collab.ydoc,
			provider: collab.provider,
			isConnected: collab.isConnected,
			isSynced: collab.isSynced,
			collaborators: [],
			userColor: "#4ECDC4",
		};
	},
}));
vi.mock("@saas/projects/lib/tiptap-extensions", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/projects/lib/tiptap-extensions")
	>()),
	createCollaborativeExtensions: () => [],
}));

// ---- CopilotKit: the loading flag is mutable, every action is recorded.
let mockIsLoading = false;
const actionConfigs = new Map<string, Record<string, any>>();
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({ state: {}, setState: vi.fn(), nodeName: undefined }),
	useCopilotAction: (config: Record<string, any>) => {
		actionConfigs.set(config.name, config);
	},
	useCopilotChat: () => ({ isLoading: mockIsLoading, visibleMessages: [] }),
	useCopilotChatInternal: () => ({ messages: [], setMessages: vi.fn() }),
	useCopilotReadable: vi.fn(),
	useCopilotMessagesContext: () => ({ setMessages: vi.fn() }),
}));
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({ children }: { children?: import("react").ReactNode }) =>
		children,
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
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
	MeetingSelector: () => null,
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
vi.mock("@saas/projects/hooks/use-diff-view-mode", () => ({
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
vi.mock(
	"@saas/projects/components/documents/useUpdateDocumentWithContext",
	() => ({
		useUpdateDocumentWithContext: () => ({
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
		}),
	}),
);

import { DocumentEditor } from "@saas/projects/components/DocumentEditor";
import { GENERATION_RUN_AWARENESS_FIELD } from "@saas/projects/components/proposal-artifact/generation-run-awareness";
import { fromMarkdown } from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { createAdvancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { toast } from "sonner";

const STORED =
	"## Scope\n\nPhase one, then two.\n\n## Pricing\n\nA fixed fee for the first phase.";
const REGENERATED = STORED.replace("then two", "then two, regenerated");
const TAKING_LONGER =
	"Document generation is taking longer than expected. Refresh the page to check for the latest version.";

/** The fixed clock the run-liveness tests read the server's stamps against. */
const NOW = Date.parse("2026-10-19T12:00:00.000Z");

/** A server stamp `minutes` before `NOW`. */
function minutesBeforeNow(minutes: number): string {
	return new Date(NOW - minutes * 60 * 1000).toISOString();
}

/** The document editor's own schema, as `DocumentEditor` builds it. */
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
/**
 * Artifact mode, as `DocumentEditorPage` passes it for a client-document
 * Proposal: the page hosts the run's progress, and the editor attaches to a
 * run the server reports while it is queued or generating.
 */
let artifactMode = false;
const editors: Editor[] = [];

function isRunning(status: string) {
	return status === "QUEUED" || status === "GENERATING";
}

function tree() {
	return (
		<QueryClientProvider client={queryClient}>
			<DocumentEditor
				projectId="proj-1"
				documentId="doc-1"
				saveSlot={saveSlot}
				suppressGenerationOverlay={artifactMode}
				attachToServerRun={artifactMode && isRunning(server.status)}
			/>
		</QueryClientProvider>
	);
}

function editorHolding(markdown: string): Editor {
	const editor = makeEditor(markdown);
	editors.push(editor);
	mockEditor = editor;
	return editor;
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

async function mount(stored: string) {
	server.content = stored;
	const editor = editorHolding(stored);
	const view = render(tree());
	await waitFor(() => {
		expect(saveMutationReady).toBe(true);
	});
	await flush();
	return { ...view, editor };
}

/** A later server snapshot, as the poll brings it. */
async function serverReports(
	rerender: (ui: ReactElement) => void,
	snapshot: {
		content?: string;
		version?: number;
		status: string;
		generationStartedAt?: string;
		updatedAt?: string;
	},
) {
	await new Promise((resolve) => setTimeout(resolve, 5));
	if (snapshot.content !== undefined) {
		server.content = snapshot.content;
	}
	if (snapshot.version !== undefined) {
		server.version = snapshot.version;
	}
	if (snapshot.generationStartedAt !== undefined) {
		server.generationStartedAt = snapshot.generationStartedAt;
	}
	if (snapshot.updatedAt !== undefined) {
		server.updatedAt = snapshot.updatedAt;
	}
	server.status = snapshot.status;
	await act(async () => {
		await queryClient.refetchQueries();
	});
	rerender(tree());
	await flush();
}

/** Regenerate from the assistant, the way its tool call does. */
async function startRunFromChat(
	rerender: (ui: ReactElement) => void,
	respond = vi.fn(),
) {
	await act(async () => {
		actionConfigs.get("regenerate_document")?.renderAndWaitForResponse({
			args: { prompt: "Rewrite it" },
			respond,
			status: "executing",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	rerender(tree());
	await flush();
	return respond;
}

/** The room loses sync: the editor unmounts and waits for it. */
async function dropSync(rerender: (ui: ReactElement) => void) {
	collab.isConnected = false;
	collab.isSynced = false;
	rerender(tree());
	await flush();
}

/** The room is back; the fresh editor shows what the room holds. */
async function restoreSync(
	rerender: (ui: ReactElement) => void,
	roomBody: string,
) {
	const editor = editorHolding(roomBody);
	collab.isConnected = true;
	collab.isSynced = true;
	rerender(tree());
	await flush();
	return editor;
}

/**
 * The room's awareness as this editor sees it: its own client id, and the
 * run role each other open editor has published.
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
		setLocalStateField: vi.fn((field: string, value: unknown) => {
			states.set(clientID, {
				...(states.get(clientID) ?? {}),
				[field]: value,
			});
		}),
	};
	collab.provider.awareness = awareness;
	vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "true");
	return awareness;
}

function publishedRoles(awareness: FakeAwareness) {
	return awareness.setLocalStateField.mock.calls
		.filter(([field]) => field === GENERATION_RUN_AWARENESS_FIELD)
		.map(([, role]) => role);
}

function reviewModal() {
	return screen.queryByTestId("regeneration-confirm-modal");
}

function saveButton() {
	return within(saveSlot).getByRole("button", {
		name: /^(Save document|Document saved, no changes to save|Saving)$/,
	});
}

/** Why the Save button is refused, as assistive technology reads it. */
function saveRefusal(): string | null {
	const id = saveButton().getAttribute("aria-describedby");
	return id
		? (window.document.getElementById(id)?.textContent ?? null)
		: null;
}

beforeEach(() => {
	vi.clearAllMocks();
	saveCalls.length = 0;
	actionConfigs.clear();
	latestEditorOptions = {};
	mockIsLoading = false;
	saveMutationReady = false;
	server.content = "";
	server.version = 7;
	server.status = "COMPLETE";
	server.generationStartedAt = null;
	server.updatedAt = null;
	generate.result = {
		outcome: "started",
		workflowId: "wf-1",
		runId: "run-1",
		message: "Generation started",
	};
	generate.error = null;
	rejectFindsNoPriorVersion = false;
	rejectFindsRunLive = false;
	rejectFindsReviewStale = false;
	rejectCalls.length = 0;
	artifactMode = false;
	collab.isConnected = true;
	collab.isSynced = true;
	collab.enabledCalls.length = 0;
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
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const editor of editors.splice(0)) {
		editor.destroy();
	}
	mockEditor = null;
	saveSlot.remove();
	vi.unstubAllEnvs();
	collab.provider.awareness = null;
});

describe("DocumentEditor — a sync-loss remount in the middle of a run (Fizzy #2946)", () => {
	beforeEach(() => {
		artifactMode = true;
	});

	it("the editor that started the run reviews nothing until it completes, keeps its role, and reviews the run's body", async () => {
		const awareness = joinRoom(3, {});
		const view = await mount(STORED);

		await startRunFromChat(view.rerender);
		await serverReports(view.rerender, { status: "GENERATING" });
		expect(publishedRoles(awareness)).toEqual(["started"]);

		await dropSync(view.rerender);
		expect(screen.getByText("reconnecting.title")).toBeInTheDocument();
		view.editor.destroy();
		const remounted = await restoreSync(view.rerender, STORED);
		await nextFrames();

		// Mid-run: nothing to review, the role unchanged, nothing saved.
		expect(reviewModal()).not.toBeInTheDocument();
		expect(publishedRoles(awareness)).toEqual(["started"]);
		expect(saveRefusal()).toBe("saveBlocked.regenerating");

		await serverReports(view.rerender, {
			content: REGENERATED,
			version: 8,
			status: "COMPLETE",
		});

		expect(
			await view.findByTestId("regeneration-confirm-modal"),
		).toBeInTheDocument();
		await waitFor(() => {
			expect(getEditorMarkdownForSave(remounted)).toContain(
				"regenerated",
			);
		});
		expect(previousPane()).toContain("Phase one, then two.");
		expect(saveRefusal()).toBe("saveBlocked.review");
		expect(publishedRoles(awareness)).toEqual(["started"]);
		expect(saveCalls).toEqual([]);
	});

	it("an editor that follows the run adopts its body after the remount, with no review", async () => {
		const awareness = joinRoom(3, {});
		const view = await mount(STORED);

		await serverReports(view.rerender, { status: "GENERATING" });
		expect(publishedRoles(awareness)).toEqual(["attached"]);

		await dropSync(view.rerender);
		view.editor.destroy();
		const remounted = await restoreSync(view.rerender, STORED);
		await nextFrames();

		expect(reviewModal()).not.toBeInTheDocument();
		expect(publishedRoles(awareness)).toEqual(["attached"]);

		await serverReports(view.rerender, {
			content: REGENERATED,
			version: 8,
			status: "COMPLETE",
		});

		await waitFor(() => {
			expect(getEditorMarkdownForSave(remounted)).toContain(
				"regenerated",
			);
		});
		expect(reviewModal()).not.toBeInTheDocument();
		expect(publishedRoles(awareness)).toEqual(["attached", null]);
		expect(saveCalls).toEqual([]);
	});

	it("an editor that follows the run and comes back after it ended adopts its body once the new editor exists", async () => {
		const awareness = joinRoom(3, {});
		const view = await mount(STORED);
		await serverReports(view.rerender, { status: "GENERATING" });
		expect(publishedRoles(awareness)).toEqual(["attached"]);

		await dropSync(view.rerender);
		view.editor.destroy();
		// The run ends while the room is away.
		await serverReports(view.rerender, {
			content: REGENERATED,
			version: 8,
			status: "COMPLETE",
		});

		// The room is back. The new editor exists only from the render after
		// the one that mounts it, as `useEditor` builds it.
		mockEditor = null;
		collab.isConnected = true;
		collab.isSynced = true;
		view.rerender(tree());
		await flush();
		const remounted = editorHolding(STORED);
		view.rerender(tree());
		await nextFrames();

		expect(getEditorMarkdownForSave(remounted)).toContain("regenerated");
		expect(reviewModal()).not.toBeInTheDocument();
		expect(publishedRoles(awareness)).toEqual(["attached", null]);
		expect(saveCalls).toEqual([]);
	});

	it("the review's body lands in the editor on screen without waiting for a frame a hidden tab holds back", async () => {
		joinRoom(3, {});
		const view = await mount(STORED);
		await startRunFromChat(view.rerender);
		await serverReports(view.rerender, { status: "GENERATING" });

		// A hidden tab: frames wait until it is shown again.
		const heldFrames: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
			heldFrames.push(cb);
			return heldFrames.length;
		});
		await serverReports(view.rerender, {
			content: REGENERATED,
			version: 8,
			status: "COMPLETE",
		});
		expect(reviewModal()).toBeInTheDocument();
		await flush();

		// Every editor in the room waits behind the saved body for it
		// meanwhile, so it goes in right after the render (Fizzy #2946).
		expect(getEditorMarkdownForSave(view.editor)).toContain("regenerated");
		expect(saveCalls).toEqual([]);
	});

	it("an editor mounted after the review opened, while the room was away, takes the review's body", async () => {
		joinRoom(3, {});
		const view = await mount(STORED);
		await startRunFromChat(view.rerender);
		await serverReports(view.rerender, { status: "GENERATING" });

		// The room drops before the run ends: no editor is on screen when
		// the review opens.
		await dropSync(view.rerender);
		view.editor.destroy();
		await serverReports(view.rerender, {
			content: REGENERATED,
			version: 8,
			status: "COMPLETE",
		});

		// The room is back with its previous body, behind the dialog.
		const remounted = await restoreSync(view.rerender, STORED);
		await flush();

		expect(reviewModal()).toBeInTheDocument();
		expect(getEditorMarkdownForSave(remounted)).toContain("regenerated");
		expect(saveCalls).toEqual([]);
	});

	it("stays collaborative through a drop longer than twelve seconds after the first sync", async () => {
		const awareness = joinRoom(3, {});
		const view = await mount(STORED);
		await startRunFromChat(view.rerender);
		await serverReports(view.rerender, { status: "GENERATING" });

		// The fallback's timer is armed by the drop, so the clock is faked
		// before it; nothing here waits on a real timer meanwhile.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		collab.isConnected = false;
		collab.isSynced = false;
		act(() => {
			view.rerender(tree());
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(13_000);
		});
		vi.useRealTimers();

		// Still waiting for the room, never the editor that saves around it.
		expect(screen.getByText("reconnecting.title")).toBeInTheDocument();
		expect(collab.enabledCalls.at(-1)).toBe(true);

		view.editor.destroy();
		await restoreSync(view.rerender, STORED);
		await nextFrames();
		expect(reviewModal()).not.toBeInTheDocument();
		expect(publishedRoles(awareness)).toEqual(["started"]);
		expect(saveRefusal()).toBe("saveBlocked.regenerating");
	});

	function previousPane(): string {
		return reviewModal()?.textContent ?? "";
	}
});

describe("DocumentEditor — the five-minute safety timer (Fizzy #2946)", () => {
	/**
	 * Starts a run on the fixed clock and lets six minutes pass, the timer
	 * firing at five. The server keeps reporting GENERATING with its last
	 * write `lastWriteMinutesBefore` minutes before the run was reported, so
	 * when the timer fires the run has been silent five minutes longer.
	 */
	async function runForSixMinutes(lastWriteMinutesBefore: number) {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(NOW);
		const view = await mount(STORED);
		const respond = await startRunFromChat(view.rerender);
		await serverReports(view.rerender, {
			status: "GENERATING",
			generationStartedAt: minutesBeforeNow(lastWriteMinutesBefore),
			updatedAt: minutesBeforeNow(lastWriteMinutesBefore),
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		});
		view.rerender(tree());
		await flush();
		return { ...view, respond };
	}

	it("in artifact mode, keeps waiting for a run that is still live: no notice, still regenerating, and the review still opens", async () => {
		artifactMode = true;
		// Last written as it was reported: five minutes silent when the
		// timer fires, inside the ten minutes the editor still polls.
		const view = await runForSixMinutes(0);

		expect(toast.info).not.toHaveBeenCalledWith(TAKING_LONGER);
		expect(view.respond).not.toHaveBeenCalledWith({ accepted: false });
		expect(saveRefusal()).toBe("saveBlocked.regenerating");

		await serverReports(view.rerender, {
			content: REGENERATED,
			version: 8,
			status: "COMPLETE",
		});
		expect(
			await view.findByTestId("regeneration-confirm-modal"),
		).toBeInTheDocument();
	});

	it("in artifact mode, gives up on a run silent for more than ten minutes: the usual notice, and no longer regenerating", async () => {
		artifactMode = true;
		// Last written six minutes before it was reported: eleven minutes
		// silent when the timer fires, past what the editor still polls.
		const view = await runForSixMinutes(6);

		expect(toast.info).toHaveBeenCalledWith(TAKING_LONGER);
		expect(view.respond).toHaveBeenCalledWith({ accepted: false });
		// Neither regenerating nor a run still writing: no save is refused.
		expect(saveRefusal()).toBeNull();
		expect(saveCalls).toEqual([]);
	});

	it("outside artifact mode, gives up after five minutes as before", async () => {
		await runForSixMinutes(0);

		expect(toast.info).toHaveBeenCalledWith(TAKING_LONGER);
		// No longer regenerating; the run the server reports still blocks saves.
		expect(saveRefusal()).toBe("saveBlocked.runLive");
	});
});

describe("DocumentEditor — what a regenerate request answered (Fizzy #2946)", () => {
	it("says a run is already in progress, releases the assistant, and arms no review", async () => {
		generate.result = {
			outcome: "alreadyInProgress",
			workflowId: "wf-1",
			runId: null,
			message: "A generation is already running",
		};
		const view = await mount(STORED);

		const respond = await startRunFromChat(view.rerender);
		await flush();

		expect(toast.info).toHaveBeenCalledWith("alreadyRunning");
		expect(respond).toHaveBeenCalledWith({ accepted: false });

		await serverReports(view.rerender, { status: "GENERATING" });
		await serverReports(view.rerender, {
			content: REGENERATED,
			version: 8,
			status: "COMPLETE",
		});
		await nextFrames();

		expect(reviewModal()).not.toBeInTheDocument();
		expect(saveCalls).toEqual([]);
	});

	it("says a live run could not be confirmed, releases the assistant, and arms no review", async () => {
		generate.result = {
			outcome: "liveRunUnknown",
			workflowId: "wf-1",
			runId: null,
			message: "Could not confirm the live run",
		};
		const view = await mount(STORED);

		const respond = await startRunFromChat(view.rerender);
		await flush();

		expect(toast.warning).toHaveBeenCalledWith("liveRunUnknown");
		expect(respond).toHaveBeenCalledWith({ accepted: false });
		// Nothing started here: this editor is not regenerating.
		expect(saveRefusal()).toBeNull();

		await serverReports(view.rerender, { status: "GENERATING" });
		await serverReports(view.rerender, {
			content: REGENERATED,
			version: 8,
			status: "COMPLETE",
		});
		await nextFrames();

		expect(reviewModal()).not.toBeInTheDocument();
		expect(saveCalls).toEqual([]);
	});

	it("takes a start whose outcome the server could not confirm for a started run: it keeps regenerating and reviews the run's body", async () => {
		generate.result = {
			outcome: "statusUnknown",
			workflowId: "wf-1",
			runId: null,
			message: "Start not confirmed",
		};
		const view = await mount(STORED);

		const respond = await startRunFromChat(view.rerender);
		await flush();

		expect(respond).not.toHaveBeenCalled();
		expect(toast.info).not.toHaveBeenCalled();
		expect(toast.warning).not.toHaveBeenCalled();
		expect(saveRefusal()).toBe("saveBlocked.regenerating");

		await serverReports(view.rerender, { status: "GENERATING" });
		await serverReports(view.rerender, {
			content: REGENERATED,
			version: 8,
			status: "COMPLETE",
		});

		expect(
			await view.findByTestId("regeneration-confirm-modal"),
		).toBeInTheDocument();
	});

	it("shows the shared copy for a coded refusal, with the way to resolve it", async () => {
		generate.error = Object.assign(new Error("Server wording"), {
			code: "PRECONDITION_FAILED",
			data: { code: "PROPOSAL_PROMPT_NOT_BOUND" },
		});
		const view = await mount(STORED);

		await startRunFromChat(view.rerender);
		await flush();

		expect(toast.error).toHaveBeenCalledWith(
			"promptNotBound",
			expect.objectContaining({
				action: expect.objectContaining({ label: "openCatalog" }),
			}),
		);
		expect(toast.error).not.toHaveBeenCalledWith(
			expect.stringContaining("Server wording"),
		);
	});
});

describe("DocumentEditor — saves while a run owns the document (Fizzy #2946)", () => {
	// The server's stamps are read against a fixed clock; timers stay real.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
	});

	async function typeALine(editor: Editor) {
		await act(async () => {
			editor.commands.insertContentAt(
				editor.state.doc.content.size,
				"<p>One more line.</p>",
			);
			latestEditorOptions.onUpdate?.({ editor });
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		await flush();
	}

	it("refuses the Save button and the save before an assistant run while a run is live, and says why", async () => {
		const view = await mount(STORED);
		await typeALine(view.editor);
		await waitFor(() => {
			expect(saveButton()).toBeEnabled();
		});

		// A run started elsewhere, last written a minute ago: this editor
		// only sees the server's status and stamps.
		await serverReports(view.rerender, {
			status: "GENERATING",
			generationStartedAt: minutesBeforeNow(3),
			updatedAt: minutesBeforeNow(1),
		});

		expect(saveButton()).toBeDisabled();
		expect(saveRefusal()).toBe("saveBlocked.runLive");
		await act(async () => {
			fireEvent.click(saveButton());
		});
		await flush();
		expect(saveCalls).toEqual([]);

		mockIsLoading = true;
		view.rerender(tree());
		await flush();
		mockIsLoading = false;
		view.rerender(tree());
		await flush();
		expect(saveCalls).toEqual([]);

		// The run ends: the text is still unsaved, and Save works again.
		await serverReports(view.rerender, { status: "COMPLETE" });
		expect(saveRefusal()).toBeNull();
		await act(async () => {
			fireEvent.click(saveButton());
		});
		await flush();
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]?.content).toEqual(
			expect.stringContaining("One more line."),
		);
		expect(toast.warning).not.toHaveBeenCalled();
	});

	it("lets a save through over a generating run silent for more than ten minutes, and warns that it ends the run", async () => {
		const view = await mount(STORED);
		await typeALine(view.editor);
		await waitFor(() => {
			expect(saveButton()).toBeEnabled();
		});

		// The server still lists a run this editor did not start, but its
		// last write is eleven minutes old: the editor no longer polls it.
		await serverReports(view.rerender, {
			status: "GENERATING",
			generationStartedAt: minutesBeforeNow(20),
			updatedAt: minutesBeforeNow(11),
		});

		expect(saveRefusal()).toBeNull();
		expect(saveButton()).toBeEnabled();
		await act(async () => {
			fireEvent.click(saveButton());
		});
		await flush();
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]?.content).toEqual(
			expect.stringContaining("One more line."),
		);
		expect(toast.warning).toHaveBeenCalledWith("staleRunSave");
	});

	it("stops following an attached run once it has not written for ten minutes: saves go through, with the warning", async () => {
		artifactMode = true;
		const view = await mount(STORED);
		// A run started elsewhere, which this editor attaches to and follows.
		await serverReports(view.rerender, {
			status: "GENERATING",
			generationStartedAt: minutesBeforeNow(3),
			updatedAt: minutesBeforeNow(1),
		});
		expect(saveRefusal()).toBe("saveBlocked.regenerating");

		// It goes silent: its last write is now eleven minutes old.
		await serverReports(view.rerender, {
			status: "GENERATING",
			generationStartedAt: minutesBeforeNow(20),
			updatedAt: minutesBeforeNow(11),
		});
		expect(saveRefusal()).toBeNull();

		await typeALine(view.editor);
		await waitFor(() => {
			expect(saveButton()).toBeEnabled();
		});
		await act(async () => {
			fireEvent.click(saveButton());
		});
		await flush();
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]?.content).toEqual(
			expect.stringContaining("One more line."),
		);
		expect(toast.warning).toHaveBeenCalledWith("staleRunSave");
	});

	it("still refuses saves while a run has waited in the queue for two hours", async () => {
		const view = await mount(STORED);
		await typeALine(view.editor);
		await waitFor(() => {
			expect(saveButton()).toBeEnabled();
		});

		// A wait on the project's context work: never aged out.
		await serverReports(view.rerender, {
			status: "QUEUED",
			generationStartedAt: minutesBeforeNow(120),
			updatedAt: minutesBeforeNow(120),
		});

		expect(saveButton()).toBeDisabled();
		expect(saveRefusal()).toBe("saveBlocked.runLive");
		await act(async () => {
			fireEvent.click(saveButton());
		});
		await flush();
		expect(saveCalls).toEqual([]);
		expect(toast.warning).not.toHaveBeenCalled();
	});
});

describe("DocumentEditor — the Reject fallback (Fizzy #2946)", () => {
	async function reviewFirstRun(stored: string) {
		const view = await mount(stored);
		await startRunFromChat(view.rerender);
		await serverReports(view.rerender, { status: "GENERATING" });
		await serverReports(view.rerender, {
			content: REGENERATED,
			version: 8,
			status: "COMPLETE",
		});
		await view.findByTestId("regeneration-confirm-modal");
		await nextFrames();
		return view;
	}

	async function reject() {
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Reject" }));
		});
		await waitFor(
			() => {
				expect(reviewModal()).not.toBeInTheDocument();
			},
			{ timeout: 3000 },
		);
		await nextFrames();
		await flush();
	}

	it("writes nothing when there is no earlier body, says so, and keeps the regenerated body on screen", async () => {
		rejectFindsNoPriorVersion = true;
		const view = await reviewFirstRun("");

		await reject();

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("rejectEmptyBody");
		});
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(REGENERATED);
		expect(getEditorMarkdownForSave(view.editor)).toContain("regenerated");
	});

	it("still restores a non-empty earlier body without a version bump", async () => {
		rejectFindsNoPriorVersion = true;
		await reviewFirstRun(STORED);

		await reject();

		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			content: STORED,
			skipVersionBump: true,
		});
		expect(toast.error).not.toHaveBeenCalledWith("rejectEmptyBody");
	});

	it("writes nothing when a newer run holds the document, says so, and keeps the regenerated body on screen", async () => {
		rejectFindsRunLive = true;
		const view = await reviewFirstRun(STORED);

		await reject();

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("rejectRunLive");
		});
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(REGENERATED);
		expect(getEditorMarkdownForSave(view.editor)).toContain("regenerated");
	});
});

/**
 * A review dialog left open while a newer run (or a save) wrote the document
 * (Fizzy #2946): its Reject reverted the newer write and deleted its version.
 */
describe("DocumentEditor — a review a newer write superseded (Fizzy #2946)", () => {
	const SECOND_RUN = STORED.replace(
		"Phase one",
		"Phase one, rewritten by a second run",
	);

	async function reviewFirstRun() {
		const view = await mount(STORED);
		await startRunFromChat(view.rerender);
		await serverReports(view.rerender, { status: "GENERATING" });
		await serverReports(view.rerender, {
			content: REGENERATED,
			version: 8,
			status: "COMPLETE",
		});
		await view.findByTestId("regeneration-confirm-modal");
		await nextFrames();
		return view;
	}

	async function clickReject() {
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Reject" }));
		});
		await waitFor(
			() => {
				expect(reviewModal()).not.toBeInTheDocument();
			},
			{ timeout: 3000 },
		);
		await nextFrames();
		await flush();
	}

	it("names the reviewed run's version with its Reject", async () => {
		await reviewFirstRun();

		await clickReject();

		await waitFor(() => {
			expect(rejectCalls).toHaveLength(1);
		});
		expect(rejectCalls[0]).toMatchObject({ expectedVersion: 8 });
		// The server named no run identity, so none is sent.
		expect(rejectCalls[0]).not.toHaveProperty(
			"expectedGenerationStartedAt",
		);
	});

	it("names the reviewed run itself with its Reject: the run identity the review opened with", async () => {
		const view = await mount(STORED);
		await startRunFromChat(view.rerender);
		const startedAt = "2026-10-19T11:58:00.000Z";
		await serverReports(view.rerender, {
			status: "GENERATING",
			generationStartedAt: startedAt,
		});
		await serverReports(view.rerender, {
			content: REGENERATED,
			version: 8,
			status: "COMPLETE",
		});
		await view.findByTestId("regeneration-confirm-modal");
		await nextFrames();

		await clickReject();

		await waitFor(() => {
			expect(rejectCalls).toHaveLength(1);
		});
		expect(rejectCalls[0]).toMatchObject({
			expectedVersion: 8,
			expectedGenerationStartedAt: startedAt,
		});
	});

	it("closes the review once a newer saved body arrives, sending and saving nothing", async () => {
		const view = await reviewFirstRun();

		await serverReports(view.rerender, {
			content: SECOND_RUN,
			version: 9,
			status: "COMPLETE",
		});

		await waitFor(() => {
			expect(reviewModal()).not.toBeInTheDocument();
		});
		expect(toast.info).toHaveBeenCalledWith("reviewSuperseded");
		await nextFrames();
		await flush();
		expect(rejectCalls).toEqual([]);
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(SECOND_RUN);
		// Outside a stamped room nothing else would bring the editor to the
		// newer body: the close puts it there, so the older reviewed body is
		// not left on screen to edit and save over it.
		await waitFor(() => {
			expect(getEditorMarkdownForSave(view.editor)).toContain(
				"rewritten by a second run",
			);
		});
		expect(getEditorMarkdownForSave(view.editor)).not.toContain(
			"regenerated",
		);
		// The review winds down a second after it closes.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1200));
		});
		await act(async () => {
			view.editor.commands.insertContentAt(
				view.editor.state.doc.content.size,
				"<p>One more line.</p>",
			);
			latestEditorOptions.onUpdate?.({ editor: view.editor });
		});
		// The dirty check is debounced.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
		});
		await act(async () => {
			fireEvent.click(saveButton());
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]?.content).toContain("rewritten by a second run");
		expect(saveCalls[0]?.content).toContain("One more line.");
		expect(saveCalls[0]?.content).not.toContain("regenerated");
	});

	it("a Reject clicked just before a newer saved body closes the review is never sent", async () => {
		const view = await reviewFirstRun();

		// The choice lands after the dialog's short closing delay; the newer
		// body closes the review inside it.
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Reject" }));
		});
		await serverReports(view.rerender, {
			content: SECOND_RUN,
			version: 9,
			status: "COMPLETE",
		});
		await waitFor(() => {
			expect(reviewModal()).not.toBeInTheDocument();
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1000));
		});
		await flush();

		expect(toast.info).toHaveBeenCalledWith("reviewSuperseded");
		expect(toast.info).not.toHaveBeenCalledWith("rejectReviewStale");
		expect(rejectCalls).toEqual([]);
		expect(toast.error).not.toHaveBeenCalled();
		expect(saveCalls).toEqual([]);
		expect(getEditorMarkdownForSave(view.editor)).toContain(
			"rewritten by a second run",
		);
	});

	it("keeps the review open through the run's own version step, and its Reject names the new version", async () => {
		const view = await reviewFirstRun();

		await serverReports(view.rerender, { version: 9, status: "COMPLETE" });

		expect(reviewModal()).toBeInTheDocument();
		expect(toast.info).not.toHaveBeenCalledWith("reviewSuperseded");

		await clickReject();

		await waitFor(() => {
			expect(rejectCalls).toHaveLength(1);
		});
		expect(rejectCalls[0]).toMatchObject({ expectedVersion: 9 });
	});

	it("a Reject the server refuses as stale says so, saves nothing, and brings the editor to the newer saved body", async () => {
		rejectFindsReviewStale = true;
		const view = await reviewFirstRun();
		// The second run's write the dialog has not heard of yet.
		server.content = SECOND_RUN;
		server.version = 9;

		await clickReject();

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("rejectReviewStale");
		});
		expect(rejectCalls).toHaveLength(1);
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");
		await waitFor(() => {
			expect(getEditorMarkdownForSave(view.editor)).toContain(
				"rewritten by a second run",
			);
		});
		await nextFrames();
		await flush();
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(SECOND_RUN);
	});
});
