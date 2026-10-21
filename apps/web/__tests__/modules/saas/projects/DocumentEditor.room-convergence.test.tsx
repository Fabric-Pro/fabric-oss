/**
 * A collaborative room never restores an older body (Fizzy #2946), on real
 * Yjs documents.
 *
 * The room carries a stamp of the saved body it holds; every save from it
 * names that stamp as its base; a room behind the saved document is brought
 * back to it by one editor, and text it replaces is offered back. Pinned
 * here, with the room flag on unless a test says otherwise:
 *   - the end of a run: the starting editor's review, an attached
 *     follower, and a hidden starter whose review frame never lands all
 *     end on the run's body, in the room once;
 *   - a save in the window between a run's body save and its version step
 *     is refused on the body identity, nothing is written, the room
 *     converges and the typed text is offered back;
 *   - two editors converging at once behind a paused relay leave exactly
 *     one copy of the body, and nothing is saved meanwhile;
 *   - a read-only client with the smallest client id and a forged run role
 *     is never elected and never writes the room; an elected editor that
 *     never converges is replaced after the bounded interval;
 *   - a colleague's save in flight is not taken for a stale room: typing
 *     survives;
 *   - a persisted room behind the saved document shows the saved body, not
 *     the room's, and the first save carries the saved body plus the edit;
 *     a viewer alone sees the saved body and leaves the room alone;
 *   - a server write outside a run reaches every open editor;
 *   - a room from before the stamp that differs is replaced and its text
 *     offered back;
 *   - a save refused for want of a base says to reload;
 *   - a save refused because a generation run holds the document is no
 *     version conflict: it says a run is writing, the room is not brought
 *     back, the single-user editor keeps saving once the run ends, and a
 *     CONFLICT that names no run still stops it until a reload;
 *   - a CONFLICT after a colleague's save is retried once, silently;
 *   - a convergence that failed freezes only the session that wrote it: an
 *     editor opened later makes one more attempt at once, one that saw it
 *     fail after a short while, and Reload latest version on demand;
 *   - a colleague's save in flight holds a stale room back only when that
 *     client may edit, and only for one fall-through interval;
 *   - a colleague's cursor moving does not render the editor again;
 *   - a drop longer than forty-five seconds after the first sync shows the
 *     saved body read-only, with a reload and the text typed here to copy;
 *   - one save at a time: a save asked for while one is in flight goes once
 *     it is answered, from the base its answer produced;
 *   - with the flag off the editor seeds, saves and converges as before.
 *
 * Harness: one room Y.Doc and one Y.Doc per tab, linked by a relay a test
 * can pause; the collaboration hook returns the tab's real document and a
 * sync flag; the editor is a real TipTap editor bound to that document by
 * the real collaboration extension (the caret is left out: it needs a
 * y-protocols awareness, which does not resolve from apps/web, so awareness
 * is a hand-linked fake carried by the same relay). Each tab has its own
 * query client; the fake server tells tabs apart by it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// ---- Tabs ------------------------------------------------------------------

interface FakeAwareness {
	clientID: number;
	own: Record<string, unknown>;
	view: Map<number, Record<string, unknown>>;
	listeners: Set<() => void>;
	getStates(): Map<number, Record<string, unknown>>;
	getLocalState(): Record<string, unknown> | null;
	setLocalStateField(field: string, value: unknown): void;
	on(event: "change", listener: () => void): void;
	off(event: "change", listener: () => void): void;
}

interface Tab {
	name: string;
	doc: Y.Doc;
	awareness: FakeAwareness;
	provider: { awareness: FakeAwareness };
	synced: boolean;
	role: "owner" | "editor" | "viewer";
	attachToServerRun: boolean;
	queryClient: QueryClient;
	saveSlot: HTMLElement;
	syncSlot: HTMLElement;
	editors: Array<{ editor: Editor; readOnly: boolean }>;
	actions: Map<string, Record<string, any>>;
	/** Yjs updates this tab produced itself. */
	localUpdates: number;
	view: ReturnType<typeof render> | null;
}

const harness = await vi.hoisted(async () => {
	const React = await import("react");
	return {
		TabContext: React.createContext<Tab | null>(null),
		flags: {} as Record<string, boolean>,
		tabByClient: new Map<unknown, Tab>(),
		/** The stale rule's and the election's waits, shortened. */
		timings: {
			observationGapMs: 60,
			claimSettleMs: 30,
			fallThroughMs: 300,
			failedClaimExpiryMs: 60_000,
		},
		/** The assistant is running a turn (the save before it goes first). */
		chatLoading: false,
		/** The assistant's shared state: `document` is what it proposes. */
		agentState: {} as Record<string, unknown>,
		/** Where Save & Close sends the person. */
		routerPush: (() => {}) as (url: string) => void,
		/** What the editor handed the context-update hook last. */
		contextUpdateOptions: {} as Record<string, any>,
		/** What the editor handed the version history last. */
		versionHistoryProps: {} as Record<string, any>,
	};
});

const SHORT_TIMINGS = { ...harness.timings };

// ---- The fake server: one document, its version, its body identity, and
// every save. A save that names a base is refused with CONFLICT unless the
// document still holds that body at that version.
const server = {
	content: "",
	version: 7,
	status: "COMPLETE",
	type: "PROPOSAL",
	/** Write at once, answer when a test releases the answer. */
	holdAnswers: false,
	held: [] as Array<() => void>,
	/** Refuse every save as one from an editor older than the server. */
	requireBase: false,
	/** What a rejected regeneration rewinds the row to. */
	beforeRun: null as { content: string; version: number } | null,
	/** A rejected regeneration fails with this error, rewinding nothing. */
	rejectError: null as Error | null,
	/** The next save fails with this error, writing nothing. */
	failNext: null as Error | null,
	/** The project query answers only once this settles. */
	projectGate: null as Promise<void> | null,
};
const saveCalls: Array<Record<string, unknown>> = [];
const generate = {
	result: {
		outcome: "started",
		workflowId: "wf-1",
		runId: "run-1",
		message: "Generation started",
	} as Record<string, unknown>,
};

/** A stand-in for the server's body identity; the editor never computes it. */
function hashOf(content: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i += 1) {
		hash ^= content.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `h${hash.toString(16)}-${content.length}`;
}

function serverDocument() {
	return {
		document: {
			id: "doc-1",
			title: "Example proposal",
			type: server.type,
			content: server.content,
			version: server.version,
			status: server.status,
			contentHash: hashOf(server.content),
			generationStartedAt: null,
			updatedAt: null,
		},
	};
}

function savedStamp() {
	return { version: server.version, contentHash: hashOf(server.content) };
}

async function fakeUpdate(vars: Record<string, unknown>, tab?: Tab) {
	saveCalls.push({ tab: tab?.name, ...vars });
	if (server.requireBase) {
		throw Object.assign(new Error("base required"), {
			code: "PRECONDITION_FAILED",
			data: { code: "DOCUMENT_SAVE_BASE_REQUIRED" },
		});
	}
	const failure = server.failNext;
	server.failNext = null;
	const answer = () => {
		if (failure) {
			throw failure;
		}
		if (
			vars.expectedVersion !== undefined &&
			(vars.expectedVersion !== server.version ||
				(vars.expectedContentHash !== undefined &&
					vars.expectedContentHash !== hashOf(server.content)))
		) {
			throw Object.assign(new Error("Document changed"), {
				code: "CONFLICT",
			});
		}
		const unchanged = vars.content === server.content;
		if (!unchanged && typeof vars.content === "string") {
			server.content = vars.content;
			if (vars.skipVersionBump !== true) {
				server.version += 1;
			}
		}
		return { ...serverDocument(), contentUnchanged: unchanged };
	};
	return answerOrHold(answer);
}

/**
 * Runs a write at once; with `holdAnswers` its answer — or its error —
 * reaches the editor only when a test releases it.
 */
function answerOrHold(answer: () => unknown): unknown {
	if (!server.holdAnswers) {
		return answer();
	}
	let outcome: { ok?: unknown; error?: unknown };
	try {
		outcome = { ok: answer() };
	} catch (error) {
		outcome = { error };
	}
	return new Promise((resolve, reject) => {
		server.held.push(() =>
			outcome.error ? reject(outcome.error) : resolve(outcome.ok),
		);
	});
}

function cannedResponseFor(path: string[], tab?: Tab): unknown {
	const joined = path.join(".");
	if (joined === "projects.documents.get") {
		return serverDocument();
	}
	if (joined === "projects.get") {
		return {
			project: {
				name: "proj-1",
				techStack: [],
				features: [],
				userRole: tab?.role ?? "owner",
			},
		};
	}
	return {};
}

async function fakeMutation(
	path: string[],
	vars: Record<string, unknown>,
	tab?: Tab,
): Promise<unknown> {
	switch (path.join(".")) {
		case "projects.documents.update":
			return fakeUpdate(vars, tab);
		case "projects.documents.generate":
			return generate.result;
		case "projects.documents.rejectRegeneration":
			// Rewinds the row to the body and version before the run; its
			// answer, like the real one, names no body identity the editor
			// should trust. With `rejectError` it is refused instead, and
			// nothing is rewound.
			return answerOrHold(() => {
				if (server.rejectError) {
					throw server.rejectError;
				}
				if (server.beforeRun) {
					server.content = server.beforeRun.content;
					server.version = server.beforeRun.version;
				}
				return {
					document: {
						...serverDocument().document,
						contentHash: "embed-owned-column",
					},
				};
			});
		default:
			return cannedResponseFor(path, tab);
	}
}

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
						queryFn: async (context: { client?: unknown }) => {
							if (
								path.join(".") === "projects.get" &&
								server.projectGate
							) {
								await server.projectGate;
							}
							return cannedResponseFor(
								path,
								harness.tabByClient.get(context?.client),
							);
						},
					});
				}
				if (prop === "mutationOptions") {
					return (config: Record<string, unknown>) => ({
						mutationFn: (
							vars: Record<string, unknown>,
							context?: { client?: unknown },
						) =>
							fakeMutation(
								path,
								vars,
								harness.tabByClient.get(context?.client),
							),
						...config,
					});
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
	useRouter: () => ({
		push: (url: string) => harness.routerPush(url),
		replace: vi.fn(),
	}),
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
	useSession: () => ({
		user: { id: "user-1", name: "Dev" },
		session: {},
	}),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => harness.flags[key] ?? false,
}));

// ---- Collaboration: the tab's own document, its sync flag and awareness.
vi.mock("@saas/projects/hooks/useCollaborativeEditor", async () => {
	const React = await import("react");
	return {
		useCollaborativeEditor: () => {
			const tab = React.useContext(harness.TabContext);
			return {
				ydoc: tab?.doc ?? null,
				provider: tab?.provider ?? null,
				isConnected: tab?.synced ?? false,
				isSynced: tab?.synced ?? false,
				collaborators: [],
				userColor: "#4ECDC4",
			};
		},
	};
});
vi.mock("@saas/projects/lib/tiptap-extensions", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@saas/projects/lib/tiptap-extensions")
		>();
	return {
		...actual,
		createCollaborativeExtensions: (
			options: Parameters<typeof actual.createCollaborativeExtensions>[0],
		) =>
			actual.createCollaborativeExtensions({
				...options,
				provider: null,
			}),
	};
});
vi.mock(
	"@saas/projects/components/proposal-artifact/generation-run-awareness",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@saas/projects/components/proposal-artifact/generation-run-awareness")
		>()),
		ROOM_CONVERGENCE_TIMINGS: harness.timings,
	}),
);

// ---- TipTap: a real editor, built from what the component passes, so the
// collaborative one binds to the tab's document.
vi.mock("@tiptap/react", async () => {
	const React = await import("react");
	const { Editor: CoreEditor } = await import("@tiptap/core");
	return {
		EditorContent: ({ className }: { className?: string }) => (
			<div data-testid="editor-content" className={className} />
		),
		useEditor: (
			options: Record<string, any>,
			deps: ReadonlyArray<unknown> = [],
		) => {
			const tab = React.useContext(harness.TabContext);
			const optionsRef = React.useRef(options);
			optionsRef.current = options;
			const [editor, setEditor] = React.useState<Editor | null>(null);
			// The deps the component passes, as `useEditor` takes them.
			React.useEffect(() => {
				const { immediatelyRender: _ignored, ...editorOptions } =
					optionsRef.current;
				const created = new CoreEditor({
					...editorOptions,
					onUpdate: (props: unknown) =>
						optionsRef.current.onUpdate?.(props),
				});
				tab?.editors.push({
					editor: created,
					readOnly: editorOptions.editable === false,
				});
				setEditor(created);
				return () => {
					created.destroy();
				};
			}, deps);
			return editor;
		},
		NodeViewWrapper: () => null,
		ReactNodeViewRenderer: () => () => null,
	};
});

// ---- CopilotKit: each tab records its own actions.
vi.mock("@copilotkit/react-core", async () => {
	const React = await import("react");
	return {
		useCoAgent: () => ({
			state: harness.agentState,
			setState: vi.fn(),
			nodeName: undefined,
		}),
		useCopilotAction: (config: Record<string, any>) => {
			const tab = React.useContext(harness.TabContext);
			tab?.actions.set(config.name, config);
		},
		useCopilotChat: () => ({
			isLoading: harness.chatLoading,
			visibleMessages: [],
		}),
		useCopilotChatInternal: () => ({ messages: [], setMessages: vi.fn() }),
		useCopilotReadable: vi.fn(),
		useCopilotMessagesContext: () => ({ setMessages: vi.fn() }),
	};
});
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@saas/projects/components/DocumentGenerationProgress", () => ({
	DocumentGenerationProgress: () => null,
}));
vi.mock("@saas/projects/components/EditorToolbar", () => ({
	EditorToolbar: () => null,
}));
vi.mock("@saas/projects/components/DocumentTocRail", () => ({
	DocumentTocRail: () => null,
}));
vi.mock("@saas/projects/components/DocumentVersionHistory", () => ({
	DocumentVersionHistory: (props: Record<string, any>) => {
		harness.versionHistoryProps = props;
		return null;
	},
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
	CollaborationStatus: () => <span data-testid="sync-pill" />,
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
vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
	},
}));
vi.mock("@saas/projects/lib/diff-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@saas/projects/lib/diff-utils")>()),
	resetScrollTracking: vi.fn(),
	focusOnLastDiff: vi.fn(),
	focusOnAnchor: vi.fn(),
}));
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
	AttachmentRegistryProvider: ({ children }: { children?: ReactNode }) =>
		children,
}));
vi.mock(
	"@saas/projects/components/copilot/DocumentAssistantOutcomesProvider",
	() => ({
		DocumentAssistantOutcomesProvider: ({
			children,
		}: {
			children?: ReactNode;
		}) => children,
	}),
);
vi.mock("@saas/projects/components/copilot/HydratedMessagesContext", () => ({
	HydratedMessagesProvider: ({ children }: { children?: ReactNode }) =>
		children,
}));
vi.mock(
	"@saas/projects/components/documents/useUpdateDocumentWithContext",
	() => ({
		useUpdateDocumentWithContext: (options: Record<string, any>) => {
			harness.contextUpdateOptions = options;
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

import { useCopilotReadable } from "@copilotkit/react-core";
import { DocumentEditor } from "@saas/projects/components/DocumentEditor";
import {
	GENERATION_RUN_AWARENESS_FIELD,
	isRoomBodyEmpty,
	ROOM_META_MAP,
	ROOM_PEER_AWARENESS_FIELD,
	ROOM_SAVE_AWARENESS_FIELD,
	readConvergenceClaim,
	readRoomStamp,
	writeConvergenceClaim,
	writeRoomStamp,
} from "@saas/projects/components/proposal-artifact/generation-run-awareness";
import { fromMarkdown } from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { createCollaborativeExtensions } from "@saas/projects/lib/tiptap-extensions";
import { toast } from "sonner";

const BODY_A =
	"## Scope\n\nPhase one, then two.\n\n## Pricing\n\nA fixed fee for the first phase.";
const BODY_B =
	"## Scope\n\nPhase one, then two, rewritten by the run.\n\n## Pricing\n\nA fixed fee for both phases.";

// ---- The room and its relay ------------------------------------------------

const room = {
	doc: new Y.Doc(),
	paused: false,
	queue: [] as Array<() => void>,
	tabs: [] as Tab[],
	peers: new Map<number, Record<string, unknown>>(),
};

function relay(send: () => void) {
	if (room.paused) {
		room.queue.push(send);
	} else {
		send();
	}
}

function resetRoom() {
	room.doc = new Y.Doc();
	room.paused = false;
	room.queue = [];
	room.tabs = [];
	room.peers = new Map();
	room.doc.on("update", (update: Uint8Array, origin: unknown) => {
		for (const tab of room.tabs) {
			if (tab === origin) {
				continue;
			}
			relay(() => Y.applyUpdate(tab.doc, update, "relay"));
		}
	});
}

function notify(tab: Tab) {
	for (const listener of [...tab.awareness.listeners]) {
		listener();
	}
}

function makeAwareness(doc: Y.Doc): FakeAwareness {
	const awareness: FakeAwareness = {
		clientID: doc.clientID,
		own: {},
		view: new Map(),
		listeners: new Set(),
		getStates: () => {
			const states = new Map(awareness.view);
			states.set(awareness.clientID, awareness.own);
			return states;
		},
		getLocalState: () => awareness.own,
		setLocalStateField: (field, value) => {
			awareness.own = { ...awareness.own, [field]: value };
			const tab = room.tabs.find((t) => t.awareness === awareness);
			if (!tab) {
				return;
			}
			const state = awareness.own;
			for (const other of room.tabs) {
				if (other === tab) {
					continue;
				}
				relay(() => {
					other.awareness.view.set(awareness.clientID, state);
					notify(other);
				});
			}
			notify(tab);
		},
		on: (_event, listener) => {
			awareness.listeners.add(listener);
		},
		off: (_event, listener) => {
			awareness.listeners.delete(listener);
		},
	};
	return awareness;
}

/** Another client's awareness state, as every tab sees it. */
function addPeer(clientId: number, state: Record<string, unknown>) {
	room.peers.set(clientId, state);
	for (const tab of room.tabs) {
		tab.awareness.view.set(clientId, state);
		notify(tab);
	}
}

async function resume() {
	await act(async () => {
		room.paused = false;
		while (room.queue.length > 0) {
			room.queue.shift()?.();
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

/** A room nobody is connected to, persisted with `body` and maybe a stamp. */
async function persistRoom(
	body: string,
	stamp: { version: number; contentHash: string } | null,
) {
	const writer = new Editor({
		extensions:
			createCollaborativeExtensions({
				ydoc: room.doc,
				provider: null,
				user: { name: "Earlier", color: "#000" },
				projectId: null,
				documentId: null,
			}) ?? [],
	});
	room.doc.transact(() => {
		writer.commands.setContent(fromMarkdown(body));
		if (stamp) {
			writeRoomStamp(room.doc, stamp);
		}
	});
	writer.destroy();
}

/** What the room holds, read by a fresh client of it. */
async function roomBody(): Promise<string> {
	const probe = new Y.Doc();
	Y.applyUpdate(probe, Y.encodeStateAsUpdate(room.doc));
	const reader = new Editor({
		extensions:
			createCollaborativeExtensions({
				ydoc: probe,
				provider: null,
				user: { name: "Probe", color: "#000" },
				projectId: null,
				documentId: null,
			}) ?? [],
	});
	await new Promise((resolve) => setTimeout(resolve, 5));
	const body = getEditorMarkdownForSave(reader) ?? "";
	reader.destroy();
	return body;
}

function occurrences(text: string, part: string): number {
	return text.split(part).length - 1;
}

// ---- Tab lifecycle ---------------------------------------------------------

function TabRoot({ tab }: { tab: Tab }) {
	return (
		<harness.TabContext.Provider value={tab}>
			<QueryClientProvider client={tab.queryClient}>
				<DocumentEditor
					projectId="proj-1"
					documentId="doc-1"
					saveSlot={tab.saveSlot}
					syncSlot={tab.syncSlot}
					suppressGenerationOverlay={tab.attachToServerRun}
					attachToServerRun={
						tab.attachToServerRun &&
						(server.status === "QUEUED" ||
							server.status === "GENERATING")
					}
				/>
			</QueryClientProvider>
		</harness.TabContext.Provider>
	);
}

async function openTab(
	name: string,
	{
		role = "owner",
		clientId,
		attachToServerRun = false,
	}: {
		role?: Tab["role"];
		clientId?: number;
		attachToServerRun?: boolean;
	} = {},
): Promise<Tab> {
	const doc = new Y.Doc();
	if (clientId !== undefined) {
		doc.clientID = clientId;
	}
	const awareness = makeAwareness(doc);
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const saveSlot = window.document.createElement("div");
	const syncSlot = window.document.createElement("div");
	window.document.body.append(saveSlot, syncSlot);
	const tab: Tab = {
		name,
		doc,
		awareness,
		provider: { awareness },
		synced: true,
		role,
		attachToServerRun,
		queryClient,
		saveSlot,
		syncSlot,
		editors: [],
		actions: new Map(),
		localUpdates: 0,
		view: null,
	};
	harness.tabByClient.set(queryClient, tab);
	// Join the room: both directions synced, then every update relayed. The
	// collaboration server drops what a read-only client sends.
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc), "relay");
	doc.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin === "relay") {
			return;
		}
		tab.localUpdates += 1;
		if (tab.role === "viewer") {
			return;
		}
		relay(() => Y.applyUpdate(room.doc, update, tab));
	});
	for (const other of room.tabs) {
		awareness.view.set(other.awareness.clientID, other.awareness.own);
		other.awareness.view.set(awareness.clientID, awareness.own);
	}
	for (const [clientIdOfPeer, state] of room.peers) {
		awareness.view.set(clientIdOfPeer, state);
	}
	room.tabs.push(tab);
	await act(async () => {
		tab.view = render(<TabRoot tab={tab} />);
	});
	await waitFor(() => {
		expect(mainEditor(tab)).not.toBeNull();
	});
	await settle();
	return tab;
}

function mainEditor(tab: Tab): Editor | null {
	const live = tab.editors.filter(
		(entry) => !entry.readOnly && !entry.editor.isDestroyed,
	);
	return live.at(-1)?.editor ?? null;
}

function editorBody(tab: Tab): string {
	const editor = mainEditor(tab);
	return editor ? (getEditorMarkdownForSave(editor) ?? "") : "";
}

async function settle(ms = 20) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

function rerender(tab: Tab) {
	act(() => {
		tab.view?.rerender(<TabRoot tab={tab} />);
	});
}

/** The `document_change` nudge: every open tab refetches the document. */
async function nudge(...tabs: Tab[]) {
	await act(async () => {
		await Promise.all(
			tabs.map((tab) =>
				tab.queryClient.invalidateQueries({
					queryKey: ["projects", "documents", "get"],
				}),
			),
		);
	});
	for (const tab of tabs) {
		rerender(tab);
	}
}

async function type(tab: Tab, text: string) {
	const editor = mainEditor(tab);
	if (!editor) {
		throw new Error(`${tab.name} has no editor`);
	}
	await act(async () => {
		editor.commands.insertContentAt(
			editor.state.doc.content.size - 1,
			text,
		);
	});
	// The dirty check is debounced.
	await settle(220);
}

function saveButton(tab: Tab) {
	return within(tab.saveSlot).getByRole("button", {
		name: /^(Save document|Document saved, no changes to save|Saving)$/,
	});
}

async function clickSave(tab: Tab) {
	await waitFor(() => {
		expect(saveButton(tab)).not.toBeDisabled();
	});
	await act(async () => {
		saveButton(tab).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function showsSavedBody(tab: Tab): boolean {
	return (
		tab.view?.queryByTestId("room-saved-body") !== null &&
		tab.view?.queryByTestId("room-saved-body") !== undefined
	);
}

/** Where the room's editor is drawn (not the saved body's). */
function roomEditorContent(tab: Tab): HTMLElement | undefined {
	return tab.view
		?.queryAllByTestId("editor-content")
		.find((element) => !element.closest('[data-testid="room-saved-body"]'));
}

function savedBodyViewText(tab: Tab): string {
	const readOnly = tab.editors.filter(
		(entry) => entry.readOnly && !entry.editor.isDestroyed,
	);
	const editor = readOnly.at(-1)?.editor;
	return editor ? (getEditorMarkdownForSave(editor) ?? "") : "";
}

function offerBackCalls() {
	return vi
		.mocked(toast.warning)
		.mock.calls.filter(([message]) => message === "offerBack.message");
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "true");
	harness.flags = { DOCUMENT_ROOM_CONVERGENCE: true };
	harness.tabByClient.clear();
	harness.chatLoading = false;
	harness.agentState = {};
	harness.routerPush = vi.fn();
	Object.assign(harness.timings, SHORT_TIMINGS);
	saveCalls.length = 0;
	harness.versionHistoryProps = {};
	server.content = BODY_A;
	server.version = 7;
	server.status = "COMPLETE";
	server.type = "PROPOSAL";
	server.holdAnswers = false;
	server.held = [];
	server.requireBase = false;
	server.beforeRun = null;
	server.rejectError = null;
	server.failNext = null;
	server.projectGate = null;
	resetRoom();
});

afterEach(() => {
	vi.useRealTimers();
	for (const tab of room.tabs) {
		tab.view?.unmount();
		tab.saveSlot.remove();
		tab.syncSlot.remove();
		for (const { editor } of tab.editors) {
			if (!editor.isDestroyed) {
				editor.destroy();
			}
		}
	}
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// ---- Scenarios -------------------------------------------------------------

describe("the room at the end of a run (Fizzy #2946)", () => {
	async function startRunFromChat(tab: Tab) {
		await act(async () => {
			tab.actions.get("regenerate_document")?.renderAndWaitForResponse({
				args: { prompt: "Rewrite it" },
				respond: vi.fn(),
				status: "executing",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	it("the starter's review and an attached follower both end on the run's body, held once by the room, with no save", async () => {
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		expect(editorBody(starter)).toContain("Phase one, then two.");

		await startRunFromChat(starter);
		server.status = "GENERATING";
		await nudge(starter, follower);
		await settle(30);
		expect(follower.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"attached",
		);

		// The run's final save: the new body at the old version.
		server.content = BODY_B;
		server.status = "COMPLETE";
		await nudge(starter, follower);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
		});
		await waitFor(() => {
			expect(editorBody(starter)).toContain("rewritten by the run");
			expect(editorBody(follower)).toContain("rewritten by the run");
		});
		expect(readRoomStamp(room.doc)).toEqual({
			version: 7,
			contentHash: hashOf(BODY_B),
		});

		// Its version step: the same body, so only the stamp moves.
		server.version = 8;
		await nudge(starter, follower);
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		expect(occurrences(await roomBody(), "rewritten by the run")).toBe(1);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(saveCalls).toEqual([]);
	});

	it("a Reject that rewinds the version brings the room back to the earlier body, stamped, with no save", async () => {
		await persistRoom(BODY_A, savedStamp());
		// The stamp follows the rewind itself, not a later look at the room.
		harness.timings.observationGapMs = 5000;
		const starter = await openTab("starter");
		const colleague = await openTab("colleague");
		server.beforeRun = { content: BODY_A, version: 7 };
		await startRunFromChat(starter);
		server.status = "GENERATING";
		await nudge(starter, colleague);

		server.content = BODY_B;
		server.version = 8;
		server.status = "COMPLETE";
		await nudge(starter, colleague);
		await waitFor(() => {
			expect(editorBody(colleague)).toContain("rewritten by the run");
		});
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());

		await act(async () => {
			within(
				starter.view?.getByTestId(
					"regeneration-confirm-modal",
				) as HTMLElement,
			)
				.getByRole("button", { name: "Reject" })
				.click();
			// The dialog closes on a short delay before it rejects.
			await new Promise((resolve) => setTimeout(resolve, 900));
		});

		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual({
				version: 7,
				contentHash: hashOf(BODY_A),
			});
		});
		expect(server.content).toBe(BODY_A);
		const held = await roomBody();
		expect(occurrences(held, "Phase one, then two.")).toBe(1);
		expect(held).not.toContain("rewritten by the run");
		expect(editorBody(colleague)).toContain("Phase one, then two.");
		expect(starter.awareness.own[ROOM_SAVE_AWARENESS_FIELD]).toBeNull();
		// The colleague takes the rewind for the room's own doing: nothing
		// converges and nothing is saved.
		await nudge(colleague);
		await settle(200);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		expect(saveCalls).toEqual([]);
		expect(offerBackCalls()).toHaveLength(0);
	});

	it("a hidden starter whose review frame never lands still ends on the run's body, through convergence", async () => {
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter");
		await startRunFromChat(starter);
		server.status = "GENERATING";
		await nudge(starter);

		const heldFrames: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
			heldFrames.push(cb);
			return heldFrames.length;
		});
		server.content = BODY_B;
		server.status = "COMPLETE";
		await nudge(starter);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
		});
		expect(heldFrames.length).toBeGreaterThan(0);

		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(starter)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);

		// Once the room's body has been read back, typing resumes.
		await waitFor(() => {
			expect(readConvergenceClaim(room.doc)?.settled).toBe("verified");
			expect(mainEditor(starter)?.isEditable).toBe(true);
		});
		await type(starter, " Typed after the update.");

		// The frame lands late, over a room that holds the body already, and
		// leaves what was typed on it.
		await act(async () => {
			for (const frame of heldFrames.splice(0)) {
				frame(performance.now());
			}
		});
		const held = await roomBody();
		expect(occurrences(held, "rewritten by the run")).toBe(1);
		expect(held).toContain("Typed after the update.");
		expect(editorBody(starter)).toContain("Typed after the update.");
		expect(saveCalls).toEqual([]);
	});
});

describe("guarded saves and convergence (Fizzy #2946)", () => {
	it("a save between a run's body save and its version step is refused on the body, writes nothing, and the room converges with the typed text offered back", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Typed after the last save.");

		// The run's final save lands: the new body at the old version.
		server.content = BODY_B;
		await clickSave(tab);

		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		expect(server.content).toBe(BODY_B);

		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(tab)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(editorBody(tab)).not.toContain("Typed after the last save.");
		expect(saveCalls).toHaveLength(1);

		// The typed text is offered back, once.
		expect(offerBackCalls()).toHaveLength(1);
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		const options = offerBackCalls()[0]?.[1] as {
			action: { label: string; onClick: () => void };
		};
		expect(options.action.label).toBe("offerBack.copy");
		options.action.onClick();
		expect(writeText).toHaveBeenCalledWith(
			expect.stringContaining("Typed after the last save."),
		);
	});

	it("two editors converging behind a paused relay leave one copy of the body and save nothing", async () => {
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const second = await openTab("second", { clientId: 20 });
		await settle(30);

		room.paused = true;
		server.content = BODY_B;
		server.version = 8;
		await nudge(first, second);
		// Long enough for both to observe twice and for the second in line
		// to fall through: each sees the room still behind.
		await waitFor(
			() => {
				expect(editorBody(first)).toContain("rewritten by the run");
				expect(editorBody(second)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(saveCalls).toEqual([]);

		await resume();
		await waitFor(
			async () => {
				expect(
					occurrences(await roomBody(), "rewritten by the run"),
				).toBe(1);
				expect(
					occurrences(editorBody(first), "rewritten by the run"),
				).toBe(1);
				expect(
					occurrences(editorBody(second), "rewritten by the run"),
				).toBe(1);
			},
			{ timeout: 3000 },
		);
		await waitFor(() => {
			expect(readConvergenceClaim(room.doc)?.settled).toBe("verified");
		});
		expect(saveCalls).toEqual([]);
	});

	it("a colleague's save in flight is not taken for a stale room: the other editor's typing survives", async () => {
		// The save is answered well inside the interval it holds the stale
		// rule back for.
		harness.timings.fallThroughMs = 5000;
		await persistRoom(BODY_A, savedStamp());
		const saver = await openTab("saver", { clientId: 10 });
		const typist = await openTab("typist", { clientId: 20 });
		await type(saver, " Saved by the first editor.");

		server.holdAnswers = true;
		await clickSave(saver);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(
			typist.awareness.view.get(10)?.[ROOM_SAVE_AWARENESS_FIELD],
		).toEqual({ version: 7, contentHash: hashOf(BODY_A) });

		// The typist types, and its refetch brings the saved document before
		// the saver has advanced the stamp.
		await type(typist, " Typed by the second editor.");
		await nudge(typist);
		await settle(400);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(editorBody(typist)).toContain("Typed by the second editor.");

		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		expect(saver.awareness.own[ROOM_SAVE_AWARENESS_FIELD]).toBeNull();
		await nudge(typist);
		await settle(200);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(editorBody(typist)).toContain("Typed by the second editor.");
		expect(await roomBody()).toContain("Typed by the second editor.");
		expect(offerBackCalls()).toHaveLength(0);
	});

	it("a CONFLICT after a colleague's save of the same room is retried once, silently, from the moved stamp", async () => {
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const second = await openTab("second", { clientId: 20 });
		await type(first, " A shared edit.");
		await waitFor(() => {
			expect(editorBody(second)).toContain("A shared edit.");
		});
		await type(second, " And another.");

		server.holdAnswers = true;
		await clickSave(first);
		await clickSave(second);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		});

		await waitFor(() => {
			expect(saveCalls).toHaveLength(3);
		});
		expect(saveCalls[2]).toMatchObject({
			tab: "second",
			expectedVersion: 8,
		});
		await settle(100);
		expect(saveCalls).toHaveLength(3);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		expect(toast.error).not.toHaveBeenCalled();
		expect(toast.info).not.toHaveBeenCalledWith("saveConflictRoom");
		expect(server.content).toContain("And another.");
	});

	it("offers back what a colleague typed since their last save when another editor's convergence replaces it", async () => {
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const typist = await openTab("typist", { clientId: 20 });
		await type(typist, " Unsaved by the typist.");

		server.content = BODY_B;
		server.version = 8;
		await nudge(first, typist);
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(typist)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(readConvergenceClaim(room.doc)?.clientId).toBe(10);
		expect(editorBody(typist)).not.toContain("Unsaved by the typist.");

		// Offered to the typist alone: the editor that applied had typed
		// nothing.
		expect(offerBackCalls()).toHaveLength(1);
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		(
			offerBackCalls()[0]?.[1] as { action: { onClick: () => void } }
		).action.onClick();
		expect(writeText).toHaveBeenCalledWith(
			expect.stringContaining("Unsaved by the typist."),
		);
		expect(saveCalls).toEqual([]);
	});

	it("a server write outside a run reaches both open editors without a reload, applied by one", async () => {
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const second = await openTab("second", { clientId: 20 });
		const roomUpdatesBefore = second.localUpdates;

		// An update through the API, with its nudge.
		server.content = BODY_B;
		server.version = 8;
		await nudge(first, second);

		await waitFor(
			() => {
				expect(editorBody(first)).toContain("rewritten by the run");
				expect(editorBody(second)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		await waitFor(() => {
			expect(readConvergenceClaim(room.doc)).toMatchObject({
				clientId: 10,
				settled: "verified",
			});
		});
		// The second, later in the order, wrote nothing to the room.
		expect(second.localUpdates).toBe(roomUpdatesBefore);
		expect(occurrences(await roomBody(), "rewritten by the run")).toBe(1);
		expect(saveCalls).toEqual([]);
	});
});

describe("the convergence election (Fizzy #2946)", () => {
	it("never elects a read-only client, whatever its client id or forged run role: an editor converges and the viewer never writes", async () => {
		// A candidate ahead of the editor would hold it back this long.
		harness.timings.fallThroughMs = 5000;
		await persistRoom(BODY_A, savedStamp());
		const viewer = await openTab("viewer", { role: "viewer", clientId: 1 });
		const editor = await openTab("editor", { clientId: 50 });
		act(() => {
			viewer.awareness.setLocalStateField(
				GENERATION_RUN_AWARENESS_FIELD,
				"started",
			);
		});
		expect(
			editor.awareness.view.get(1)?.[ROOM_PEER_AWARENESS_FIELD],
		).toEqual({ canEdit: false, visible: true });

		server.content = BODY_B;
		server.version = 8;
		await nudge(viewer, editor);
		// The viewer may show the saved body while the room is behind, but only
		// if its refetch lands before the editor converges; when the editor is
		// first, the viewer never sees the room behind. Either way it ends on
		// the new body without writing.
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(editor)).toContain("rewritten by the run");
			},
			{ timeout: 2000 },
		);
		expect(readConvergenceClaim(room.doc)?.clientId).toBe(50);
		await waitFor(() => {
			expect(showsSavedBody(viewer)).toBe(false);
			expect(editorBody(viewer)).toContain("rewritten by the run");
		});
		expect(viewer.localUpdates).toBe(0);
	});

	it("replaces an elected editor that never converges after the bounded interval", async () => {
		await persistRoom(BODY_A, savedStamp());
		addPeer(5, {
			[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
		});
		const tab = await openTab("tab", { clientId: 50 });

		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);
		// Two looks and the claim settle are well under the interval the
		// silent editor ahead is given.
		await settle(200);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(editorBody(tab)).toContain("Phase one, then two.");

		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(tab)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(readConvergenceClaim(room.doc)?.clientId).toBe(50);
	});
});

describe("a convergence that failed (Fizzy #2946)", () => {
	/** A room whose stamp names the saved body while it holds the older one. */
	async function persistFailedRoom(claimant: number, failedAt?: number) {
		server.content = BODY_B;
		server.version = 8;
		await persistRoom(BODY_A, savedStamp());
		writeConvergenceClaim(room.doc, {
			clientId: claimant,
			target: savedStamp(),
			settled: "failed",
			...(failedAt === undefined ? {} : { failedAt }),
		});
	}

	function saysUpdateFailed(tab: Tab): boolean {
		return within(tab.syncSlot).queryByText("updateFailed") !== null;
	}

	async function expectConvergedBy(tab: Tab, clientId: number) {
		await waitFor(
			() => {
				expect(editorBody(tab)).toContain("rewritten by the run");
				expect(readConvergenceClaim(room.doc)).toMatchObject({
					clientId,
					settled: "verified",
				});
				expect(showsSavedBody(tab)).toBe(false);
			},
			{ timeout: 3000 },
		);
		expect(occurrences(await roomBody(), "rewritten by the run")).toBe(1);
		expect(saysUpdateFailed(tab)).toBe(false);
		expect(mainEditor(tab)?.isEditable).toBe(true);
	}

	it("a failure the room kept from an editor that is gone does not freeze an editor opened later: it makes one more attempt and the room converges", async () => {
		// Written a moment ago, well inside the while a witness would wait.
		await persistFailedRoom(999, Date.now());

		const tab = await openTab("member", { clientId: 50 });

		await expectConvergedBy(tab, 50);
		expect(saveCalls).toEqual([]);
	});

	it("an editor that saw another editor's convergence fail leaves the room alone for a short while, then makes one more attempt", async () => {
		harness.timings.failedClaimExpiryMs = 400;
		server.content = BODY_B;
		server.version = 8;
		await persistRoom(BODY_B, savedStamp());
		const tab = await openTab("witness", { clientId: 50 });
		await settle(50);
		expect(saysUpdateFailed(tab)).toBe(false);

		// Another editor's convergence fails: the room ends up holding the
		// older body under the saved stamp, and its claim says so.
		await act(async () => {
			const writer = new Editor({
				extensions:
					createCollaborativeExtensions({
						ydoc: room.doc,
						provider: null,
						user: { name: "Colleague", color: "#000" },
						projectId: null,
						documentId: null,
					}) ?? [],
			});
			room.doc.transact(() => {
				writer.commands.setContent(fromMarkdown(BODY_A));
				writeConvergenceClaim(room.doc, {
					clientId: 999,
					target: savedStamp(),
					settled: "failed",
					failedAt: Date.now(),
				});
			});
			writer.destroy();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(saysUpdateFailed(tab)).toBe(true);
		});
		expect(showsSavedBody(tab)).toBe(true);
		expect(readConvergenceClaim(room.doc)?.clientId).toBe(999);

		await expectConvergedBy(tab, 50);
	});

	it.each([
		["ten minutes ahead", () => Date.now() + 10 * 60_000],
		["ten minutes behind", () => Date.now() - 10 * 60_000],
		["absurdly far ahead", () => Number.MAX_SAFE_INTEGER / 2],
	])(
		"a failure stamped by a claimant's clock %s holds an editor that sees it for the short while from when it saw it, no more and no less",
		async (_skew, failedAt) => {
			harness.timings.failedClaimExpiryMs = 400;
			server.content = BODY_B;
			server.version = 8;
			await persistRoom(BODY_B, savedStamp());
			const tab = await openTab("witness", { clientId: 50 });
			await settle(50);
			const timeout = vi.spyOn(globalThis, "setTimeout");

			await act(async () => {
				const writer = new Editor({
					extensions:
						createCollaborativeExtensions({
							ydoc: room.doc,
							provider: null,
							user: { name: "Colleague", color: "#000" },
							projectId: null,
							documentId: null,
						}) ?? [],
				});
				room.doc.transact(() => {
					writer.commands.setContent(fromMarkdown(BODY_A));
					writeConvergenceClaim(room.doc, {
						clientId: 999,
						target: savedStamp(),
						settled: "failed",
						failedAt: failedAt(),
					});
				});
				writer.destroy();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await waitFor(() => {
				expect(saysUpdateFailed(tab)).toBe(true);
			});
			// Still held a moment later, whichever way the clocks disagree.
			await settle(200);
			expect(saysUpdateFailed(tab)).toBe(true);
			expect(readConvergenceClaim(room.doc)?.clientId).toBe(999);
			// No wait a timer cannot hold — which browsers fire at once — is
			// ever asked for.
			expect(
				timeout.mock.calls.some(
					([, ms]) => typeof ms === "number" && ms > 2 ** 31 - 1,
				),
			).toBe(false);
			timeout.mockRestore();

			await expectConvergedBy(tab, 50);
		},
	);

	it("an editor whose own convergence failed stays frozen until the person asks to reload the latest version, which makes one more attempt", async () => {
		// Written by this session: the client id is the editor's own.
		await persistFailedRoom(50, Date.now());

		const tab = await openTab("member", { clientId: 50 });
		await settle(200);
		expect(saysUpdateFailed(tab)).toBe(true);
		expect(showsSavedBody(tab)).toBe(true);
		expect(await roomBody()).toContain("Phase one, then two.");

		await act(async () => {
			within(tab.syncSlot)
				.getByRole("button", { name: "reloadLatest" })
				.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		await expectConvergedBy(tab, 50);
	});
});

describe("a colleague's save in flight (Fizzy #2946)", () => {
	const savingAt = () => ({
		[ROOM_SAVE_AWARENESS_FIELD]: {
			version: 7,
			contentHash: hashOf(BODY_A),
		},
	});

	async function staleRoomConverges(tab: Tab) {
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(tab)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(readConvergenceClaim(room.doc)?.clientId).toBe(50);
	}

	it("claimed by a client that may not edit does not hold a stale room back", async () => {
		// Long enough that only who claims the save decides.
		harness.timings.fallThroughMs = 5000;
		await persistRoom(BODY_A, savedStamp());
		addPeer(900, {
			[ROOM_PEER_AWARENESS_FIELD]: { canEdit: false, visible: true },
			...savingAt(),
		});
		const tab = await openTab("tab", { clientId: 50 });

		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);

		await staleRoomConverges(tab);
	});

	it("from an editor that keeps naming a new base holds a stale room back for one fall-through interval only", async () => {
		await persistRoom(BODY_A, savedStamp());
		const peer = (round: number) => ({
			[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: false },
			[ROOM_SAVE_AWARENESS_FIELD]: {
				version: 7,
				contentHash: `rotated-${round}`,
			},
		});
		addPeer(900, peer(0));
		const tab = await openTab("tab", { clientId: 50 });

		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);
		let round = 0;
		const rotate = setInterval(() => {
			round += 1;
			act(() => addPeer(900, peer(round)));
		}, 100);
		try {
			// Converged while the peer is still rotating its base.
			await staleRoomConverges(tab);
		} finally {
			clearInterval(rotate);
		}
		expect(round).toBeGreaterThanOrEqual(3);
	});

	it("from many clients appearing one after another holds a stale room back for one fall-through interval only", async () => {
		await persistRoom(BODY_A, savedStamp());
		const peer = () => ({
			[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: false },
			...savingAt(),
		});
		addPeer(900, peer());
		const tab = await openTab("tab", { clientId: 50 });

		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);
		let next = 901;
		const appear = setInterval(() => {
			const clientId = next;
			next += 1;
			act(() => addPeer(clientId, peer()));
		}, 100);
		try {
			await staleRoomConverges(tab);
		} finally {
			clearInterval(appear);
		}
		expect(next).toBeGreaterThanOrEqual(904);
	});

	it("that is never answered holds a stale room back for one fall-through interval only", async () => {
		await persistRoom(BODY_A, savedStamp());
		// An editor behind this one in the election: hidden, larger id.
		addPeer(900, {
			[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: false },
			...savingAt(),
		});
		const tab = await openTab("tab", { clientId: 50 });

		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);
		// Inside the interval, the room is left alone.
		await settle(150);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(editorBody(tab)).toContain("Phase one, then two.");

		await staleRoomConverges(tab);
	});
});

describe("what the convergence listens to (Fizzy #2946)", () => {
	it("a colleague's cursor moving does not render the editor again; a change in what the convergence reads does", async () => {
		await persistRoom(BODY_A, savedStamp());
		await openTab("tab", { clientId: 50 });
		const colleague = (extra: Record<string, unknown>) => ({
			[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
			...extra,
		});
		act(() => {
			addPeer(900, colleague({ cursor: { anchor: 1, head: 1 } }));
		});
		await settle(100);
		const renders = () => vi.mocked(useCopilotReadable).mock.calls.length;
		const settled = renders();

		for (let at = 2; at < 12; at += 1) {
			act(() => {
				addPeer(900, colleague({ cursor: { anchor: at, head: at } }));
			});
		}
		await settle(100);
		expect(renders()).toBe(settled);

		act(() => {
			addPeer(
				900,
				colleague({
					cursor: { anchor: 11, head: 11 },
					[ROOM_SAVE_AWARENESS_FIELD]: {
						version: 7,
						contentHash: hashOf(BODY_A),
					},
				}),
			);
		});
		await settle(100);
		expect(renders()).toBeGreaterThan(settled);
	});
});

describe("a room nobody kept up (Fizzy #2946)", () => {
	it("a member opening a room persisted behind the saved document sees the saved body, never the room's, and the first autosave carries it plus the edit", async () => {
		await persistRoom(BODY_A, { version: 7, contentHash: hashOf(BODY_A) });
		server.content = BODY_B;
		server.version = 8;
		// Room for a look at the screen before the second observation.
		harness.timings.observationGapMs = 400;

		const tab = await openTab("member");
		// Until the room is brought up, the saved body is what shows.
		expect(showsSavedBody(tab)).toBe(true);
		expect(savedBodyViewText(tab)).toContain("rewritten by the run");
		expect(roomEditorContent(tab)?.className).toContain("hidden");
		expect(within(tab.syncSlot).getByText("updating")).toBeInTheDocument();

		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(showsSavedBody(tab)).toBe(false);
			},
			{ timeout: 3000 },
		);
		expect(editorBody(tab)).toContain("rewritten by the run");
		expect(
			within(tab.syncSlot).getByTestId("sync-pill"),
		).toBeInTheDocument();

		// The autosave, ten seconds into the pause after the edit.
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " An edit on the saved body.");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		vi.useRealTimers();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).not.toHaveProperty("completeDraft");
		expect(saveCalls[0]?.content).toContain("rewritten by the run");
		expect(saveCalls[0]?.content).toContain("An edit on the saved body.");
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 8,
			expectedContentHash: hashOf(BODY_B),
		});
		// Nothing typed here was replaced.
		expect(offerBackCalls()).toHaveLength(0);
	});

	it("a viewer alone sees the saved body read-only and leaves the room as it was", async () => {
		await persistRoom(BODY_A, { version: 7, contentHash: hashOf(BODY_A) });
		server.content = BODY_B;
		server.version = 8;

		const viewer = await openTab("viewer", { role: "viewer" });
		await settle(250);
		expect(showsSavedBody(viewer)).toBe(true);
		expect(savedBodyViewText(viewer)).toContain("rewritten by the run");
		expect(mainEditor(viewer)?.isEditable).toBe(false);
		expect(viewer.localUpdates).toBe(0);
		expect(readRoomStamp(room.doc)).toEqual({
			version: 7,
			contentHash: hashOf(BODY_A),
		});
		expect(await roomBody()).toContain("Phase one, then two.");
		expect(readConvergenceClaim(room.doc)).toBeNull();
	});

	it("a room from before the stamp that differs from the saved body is replaced by it, and what it held is offered back", async () => {
		await persistRoom(`${BODY_A}\n\nUnsaved text from before.`, null);
		server.content = BODY_B;
		server.version = 8;

		const tab = await openTab("member");
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(tab)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(editorBody(tab)).not.toContain("Unsaved text from before.");
		expect(offerBackCalls()).toHaveLength(1);
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		(
			offerBackCalls()[0]?.[1] as { action: { onClick: () => void } }
		).action.onClick();
		expect(writeText).toHaveBeenCalledWith(
			expect.stringContaining("Unsaved text from before."),
		);
	});

	it("a room from before the stamp that equals the saved body only gets its stamp", async () => {
		await persistRoom(BODY_A, null);
		const tab = await openTab("member");
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			},
			{ timeout: 3000 },
		);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(editorBody(tab)).toContain("Phase one, then two.");
		expect(offerBackCalls()).toHaveLength(0);
	});
});

describe("a long drop after the first sync (Fizzy #2946)", () => {
	it("shows the saved body read-only after forty-five seconds, with a reload and the text typed here to copy, and gives the editor back with the room", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Typed before the drop.");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});

		tab.synced = false;
		rerender(tab);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(44_000);
		});
		expect(tab.view?.getByText("reconnecting.title")).toBeInTheDocument();
		expect(showsSavedBody(tab)).toBe(false);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		await waitFor(() => {
			expect(showsSavedBody(tab)).toBe(true);
		});
		expect(tab.view?.getByText("away.title")).toBeInTheDocument();
		expect(savedBodyViewText(tab)).toContain("Phase one, then two.");
		expect(savedBodyViewText(tab)).not.toContain("Typed before the drop.");
		// No editor on screen, so nothing to save from.
		expect(mainEditor(tab)).toBeNull();
		expect(within(tab.saveSlot).queryByRole("button")).toBeNull();
		expect(
			tab.view?.getByRole("button", { name: "reload" }),
		).toBeInTheDocument();

		const copy = await waitFor(() => {
			const button = tab.view?.queryByRole("button", {
				name: "offerBack.copy",
			});
			expect(button).toBeTruthy();
			return button as HTMLElement;
		});
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		await act(async () => {
			copy.click();
		});
		expect(writeText).toHaveBeenCalledWith(
			expect.stringContaining("Typed before the drop."),
		);
		vi.useRealTimers();

		tab.synced = true;
		rerender(tab);
		await waitFor(() => {
			expect(showsSavedBody(tab)).toBe(false);
			expect(editorBody(tab)).toContain("Typed before the drop.");
		});
		expect(tab.view?.queryByText("away.title")).toBeNull();
	});

	it("text typed before a short drop is offered back once when the room comes back behind a newer saved document", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Typed before the drop.");

		// The room drops before the autosave, and the saved document moves
		// on meanwhile — a run's final save, an API write, a restore.
		tab.synced = false;
		rerender(tab);
		await settle(20);
		expect(mainEditor(tab)).toBeNull();
		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);

		tab.synced = true;
		rerender(tab);

		await waitFor(
			() => {
				expect(editorBody(tab)).toContain("rewritten by the run");
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			},
			{ timeout: 3000 },
		);
		expect(offerBackCalls()).toHaveLength(1);
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		const options = offerBackCalls()[0]?.[1] as {
			action: { onClick: () => void };
		};
		options.action.onClick();
		expect(writeText).toHaveBeenCalledWith(
			expect.stringContaining("Typed before the drop."),
		);
		expect(saveCalls).toEqual([]);
	});

	it("keeps typing from before a short drop unsaved once the room is back: Save stays on, and one autosave carries it after the autosave delay", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " Typed before the drop.");
		expect(saveButton(tab)).toHaveAccessibleName("Save document");

		tab.synced = false;
		rerender(tab);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4_000);
		});
		expect(mainEditor(tab)).toBeNull();

		tab.synced = true;
		rerender(tab);
		await waitFor(() => {
			expect(editorBody(tab)).toContain("Typed before the drop.");
		});
		await waitFor(() => {
			expect(saveButton(tab)).toHaveAccessibleName("Save document");
		});
		expect(saveCalls).toHaveLength(0);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]?.content).toContain("Typed before the drop.");
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		await waitFor(() => {
			expect(server.content).toContain("Typed before the drop.");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(11_000);
		});
		vi.useRealTimers();
		expect(saveCalls).toHaveLength(1);
		expect(saveButton(tab)).toHaveAccessibleName(
			"Document saved, no changes to save",
		);
	});

	it("offers nothing to copy when nothing was typed here since the last save", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		tab.synced = false;
		rerender(tab);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(46_000);
		});
		await waitFor(() => {
			expect(showsSavedBody(tab)).toBe(true);
		});
		await settle(50);
		vi.useRealTimers();
		expect(
			tab.view?.queryByRole("button", { name: "offerBack.copy" }),
		).toBeNull();
	});
});

describe("leaving with unsaved typing in the room (Fizzy #2946)", () => {
	function leave(): boolean {
		// `false` when a listener asked the browser to confirm.
		return window.dispatchEvent(
			new Event("beforeunload", { cancelable: true }),
		);
	}

	it("asks first while typing here is not covered by a save, and no longer once the save answers", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		expect(leave()).toBe(true);

		await type(tab, " Not saved yet.");
		expect(leave()).toBe(false);

		await clickSave(tab);
		await waitFor(() => {
			expect(server.content).toContain("Not saved yet.");
		});
		await settle(20);
		expect(leave()).toBe(true);
	});

	it("never asks a client that may not edit the room", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("viewer", { role: "viewer" });
		await settle(50);

		expect(mainEditor(tab)?.isEditable ?? false).toBe(false);
		expect(leave()).toBe(true);
	});
});

describe("leaving within the app with unsaved typing in the room (Fizzy #2946)", () => {
	// The page's Close and its breadcrumb links both navigate within the
	// app: the editor unmounts, and no `beforeunload` fires.
	async function leaveWithinApp(tab: Tab) {
		await act(async () => {
			tab.view?.unmount();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	it("saves the typing on the way out as an autosave, from the room's stamp", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");

		await type(tab, " Typed before leaving.");
		expect(saveCalls).toHaveLength(0);
		await leaveWithinApp(tab);

		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]?.content).toContain("Typed before leaving.");
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		expect(saveCalls[0]).not.toHaveProperty("completeDraft");
		await waitFor(() => {
			expect(server.content).toContain("Typed before leaving.");
		});
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("saves nothing when the typing is already saved", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Saved before leaving.");
		await clickSave(tab);
		await waitFor(() => {
			expect(server.content).toContain("Saved before leaving.");
		});
		await settle(20);

		await leaveWithinApp(tab);
		await settle(50);

		expect(saveCalls).toHaveLength(1);
	});

	it("saves nothing when nothing was typed", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");

		await leaveWithinApp(tab);
		await settle(50);

		expect(saveCalls).toHaveLength(0);
	});

	it("never saves for a client that may not edit the room", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("viewer", { role: "viewer" });
		await settle(50);

		await leaveWithinApp(tab);
		await settle(50);

		expect(saveCalls).toHaveLength(0);
	});

	it("never saves around the room: a sync loss that unmounts the editor sends nothing, and neither does leaving while the room is away", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Typed before the drop.");

		tab.synced = false;
		rerender(tab);
		await settle(50);
		expect(mainEditor(tab)).toBeNull();
		expect(saveCalls).toHaveLength(0);

		await leaveWithinApp(tab);
		await settle(50);

		expect(saveCalls).toHaveLength(0);
	});

	it("waits for the save in flight, then saves the rest from the base its answer produced", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " First edit.");
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});

		await type(tab, " Typed during the save.");
		await leaveWithinApp(tab);
		expect(saveCalls).toHaveLength(1);

		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await vi.advanceTimersByTimeAsync(10);
		});
		vi.useRealTimers();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 8,
			expectedContentHash: hashOf(String(saveCalls[0]?.content)),
		});
		expect(saveCalls[1]?.content).toContain("Typed during the save.");
		await waitFor(() => {
			expect(server.content).toContain("Typed during the save.");
		});
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("saves on the way out what was typed while the last save was in flight, once that save is answered", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " First edit.");
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		await type(tab, " Typed during the save.");

		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await vi.advanceTimersByTimeAsync(10);
		});
		await settle(220);
		expect(saveCalls).toHaveLength(1);

		await leaveWithinApp(tab);
		vi.useRealTimers();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 8,
			expectedContentHash: hashOf(String(saveCalls[0]?.content)),
		});
		expect(saveCalls[1]?.content).toContain("Typed during the save.");
		await waitFor(() => {
			expect(server.content).toContain("Typed during the save.");
		});
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("never reads the editor it left behind: the answer of the save on the way out, and the autosave delay after it, serialize nothing", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " Typed before leaving.");
		const consoleError = vi.spyOn(console, "error");

		await leaveWithinApp(tab);
		await waitFor(() => {
			expect(server.content).toContain("Typed before leaving.");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(21_000);
		});
		vi.useRealTimers();

		expect(saveCalls).toHaveLength(1);
		expect(
			consoleError.mock.calls.filter(
				([message]) =>
					typeof message === "string" &&
					message.includes("[editor-markdown-save]"),
			),
		).toEqual([]);
	});

	it("says so, with the text to copy, when the save on the way out is refused, and sends it only once", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Typed before leaving.");
		// A server write the room has not heard of yet.
		server.content = BODY_B;
		server.version = 8;

		await leaveWithinApp(tab);
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"leaveSaveFailed",
				expect.objectContaining({
					action: expect.objectContaining({
						label: "offerBack.copy",
					}),
				}),
			);
		});
		await settle(50);

		expect(saveCalls).toHaveLength(1);
		expect(server.content).toBe(BODY_B);
	});
});

describe("a room nobody has written yet (Fizzy #2946)", () => {
	it("is seeded once by the first editor, with the saved body's stamp; a second editor does not seed it again", async () => {
		const first = await openTab("first", { clientId: 50 });
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			expect(editorBody(first)).toContain("Phase one, then two.");
		});
		expect(occurrences(await roomBody(), "Phase one, then two.")).toBe(1);

		const second = await openTab("second", { clientId: 60 });
		await settle(200);

		expect(editorBody(second)).toContain("Phase one, then two.");
		expect(occurrences(await roomBody(), "Phase one, then two.")).toBe(1);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		expect(second.localUpdates).toBe(0);
		expect(saveCalls).toEqual([]);
	});

	it("is never seeded by a viewer", async () => {
		const tab = await openTab("viewer", { role: "viewer" });
		await settle(200);

		expect(isRoomBodyEmpty(room.doc)).toBe(true);
		expect(readRoomStamp(room.doc)).toBeNull();
		expect(saveCalls).toEqual([]);
		expect(tab.localUpdates).toBe(0);
	});

	it("waits to seed until the project says whether this client may edit", async () => {
		let release: () => void = () => {};
		server.projectGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tab = await openTab("tab");
		await settle(200);
		expect(isRoomBodyEmpty(room.doc)).toBe(true);
		expect(readRoomStamp(room.doc)).toBeNull();

		await act(async () => {
			release();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		rerender(tab);

		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		expect(occurrences(await roomBody(), "Phase one, then two.")).toBe(1);
	});

	it("takes only the stamp of an empty saved body", async () => {
		server.content = "";
		const tab = await openTab("tab");

		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		expect(isRoomBodyEmpty(room.doc)).toBe(true);
		expect(editorBody(tab).trim()).toBe("");
		expect(saveCalls).toEqual([]);
	});
});

describe("one save at a time (Fizzy #2946)", () => {
	it("the save before an assistant run, asked for while the autosave is in flight, goes once that one is answered, from the base its answer produced: the single-user editor keeps saving", async () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		const tab = await openTab("solo");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});

		// The autosave, ten seconds into the pause after the edit; the
		// server writes it and holds its answer.
		await type(tab, " First edit.");
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});

		// More typing, then the assistant starts a turn: the save before it
		// is asked for while the autosave is still in flight.
		await type(tab, " Second edit.");
		harness.chatLoading = true;
		rerender(tab);
		await settle(50);
		expect(saveCalls).toHaveLength(1);

		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		vi.useRealTimers();
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 8,
			expectedContentHash: hashOf(String(saveCalls[0]?.content)),
		});
		expect(saveCalls[1]?.content).toContain("Second edit.");
		await settle(50);
		expect(saveCalls).toHaveLength(2);
		expect(server.version).toBe(9);
		expect(server.content).toContain("Second edit.");
		expect(toast.error).not.toHaveBeenCalled();
	});
});

describe("typing while a save is in flight (Fizzy #2946)", () => {
	beforeEach(() => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
	});

	/** The autosave, ten seconds into the pause after an edit, held. */
	async function autosaveInFlight(tab: Tab, text: string) {
		await type(tab, text);
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		server.holdAnswers = false;
	}

	async function answerHeld() {
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await vi.advanceTimersByTimeAsync(10);
		});
		await settle(220);
	}

	it("opens saved, with nothing to save", async () => {
		const tab = await openTab("solo");
		await settle(220);
		expect(saveButton(tab)).toHaveAccessibleName(
			"Document saved, no changes to save",
		);
	});

	it("keeps the typing the save did not carry unsaved once that save is answered, and autosaves it", async () => {
		const tab = await openTab("solo");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await autosaveInFlight(tab, " First edit.");
		await type(tab, " Typed during the save.");

		await answerHeld();
		expect(server.content).not.toContain("Typed during the save.");
		expect(saveButton(tab)).toHaveAccessibleName("Save document");

		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		vi.useRealTimers();
		expect(saveCalls[1]?.content).toContain("Typed during the save.");
		await waitFor(() => {
			expect(server.content).toContain("Typed during the save.");
		});
		await settle(220);
		expect(saveButton(tab)).toHaveAccessibleName(
			"Document saved, no changes to save",
		);
	});

	it("reads as saved once the save is answered when nothing was typed meanwhile", async () => {
		const tab = await openTab("solo");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await autosaveInFlight(tab, " First edit.");

		await answerHeld();
		expect(saveButton(tab)).toHaveAccessibleName(
			"Document saved, no changes to save",
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		vi.useRealTimers();
		expect(saveCalls).toHaveLength(1);
	});
});

describe("one save at a time, when things go wrong (Fizzy #2946)", () => {
	beforeEach(() => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
	});

	/** The autosave, ten seconds into the pause after an edit, held. */
	async function autosaveInFlight(tab: Tab, text: string) {
		await type(tab, text);
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
	}

	async function answerHeld() {
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	it("a save asked for while the one in flight fails is not sent; a later save still goes", async () => {
		const tab = await openTab("solo");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		server.failNext = new Error("Service unavailable");
		await autosaveInFlight(tab, " First edit.");

		// The save before an assistant turn, asked for meanwhile.
		await type(tab, " Second edit.");
		harness.chatLoading = true;
		rerender(tab);
		await settle(50);
		expect(saveCalls).toHaveLength(1);

		server.holdAnswers = false;
		await answerHeld();
		// In the reader's words, never the server's (Fizzy #2946).
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("failed");
		});
		expect(toast.error).not.toHaveBeenCalledWith(
			expect.stringContaining("Service unavailable"),
		);
		await settle(50);
		expect(saveCalls).toHaveLength(1);
		expect(server.version).toBe(7);

		harness.chatLoading = false;
		rerender(tab);
		await type(tab, " Third edit.");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		vi.useRealTimers();
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		expect(saveCalls[1]?.content).toContain("Third edit.");
		await waitFor(() => {
			expect(server.content).toContain("Third edit.");
		});
	});

	it("a Save & Close asked for during the autosave leaves the page only on the answer of its own save, reported as a manual save", async () => {
		const user = userEvent.setup({
			advanceTimers: (ms) => vi.advanceTimersByTime(ms),
		});
		const tab = await openTab("solo");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " First edit.");
		// The menu was open when the autosave went out.
		await user.click(
			within(tab.saveSlot).getByRole("button", {
				name: "More save options",
			}),
		);
		const saveAndClose = await waitFor(() =>
			window.document.body.querySelector<HTMLElement>(
				'[role="menuitem"]',
			),
		);
		expect(saveAndClose?.textContent).toContain("Save & Close");
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});

		await type(tab, " Second edit.");
		await user.click(saveAndClose as HTMLElement);
		await settle(50);
		expect(saveCalls).toHaveLength(1);

		// The autosave answers: nothing is said, and the page stays.
		await answerHeld();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		expect(harness.routerPush).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
		expect(saveCalls[1]?.content).toContain("Second edit.");
		expect(saveCalls[1]).toMatchObject({ expectedVersion: 8 });

		// Its own save answers: reported as a manual save, then the page goes.
		server.holdAnswers = false;
		await answerHeld();
		await waitFor(() => {
			expect(harness.routerPush).toHaveBeenCalledTimes(1);
		});
		vi.useRealTimers();
		expect(harness.routerPush).toHaveBeenCalledWith(
			"/app/example-org/projects/proj-1",
		);
		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalledWith(
			expect.stringMatching(/^Document saved/),
		);
	});

	it("an assistant proposal accepted during the autosave is saved after that answer, from the base it produced: the single-user editor keeps saving", async () => {
		const tab = await openTab("solo");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await autosaveInFlight(tab, " First edit.");

		// The assistant proposes a body, and the person accepts it while the
		// autosave is still in flight.
		const proposed = `${editorBody(tab)}\n\nAn accepted paragraph.`;
		harness.agentState = { document: proposed };
		rerender(tab);
		await settle(20);
		const respond = vi.fn();
		let card: any;
		await act(async () => {
			card = tab.actions
				.get("confirm_changes")
				?.renderAndWaitForResponse({
					args: {},
					respond,
					status: "executing",
				});
			await Promise.resolve();
		});
		await settle(50);
		await act(async () => {
			card?.props.onConfirm();
		});
		await settle(50);
		expect(respond).toHaveBeenCalledWith({ accepted: true });
		expect(saveCalls).toHaveLength(1);

		server.holdAnswers = false;
		await answerHeld();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		vi.useRealTimers();
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 8,
			expectedContentHash: hashOf(String(saveCalls[0]?.content)),
		});
		expect(saveCalls[1]?.content).toContain("An accepted paragraph.");
		await waitFor(() => {
			expect(server.content).toContain("An accepted paragraph.");
		});
		expect(server.version).toBe(9);
		// One report, for the accept's own save.
		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalledWith(
			"Changes applied — saved as v9",
		);
		expect(toast.error).not.toHaveBeenCalled();
	});
});

describe("an assistant proposal accepted in a room (Fizzy #2946)", () => {
	/** The autosave, ten seconds into the pause after an edit, held. */
	async function autosaveInFlight(tab: Tab, text: string) {
		await type(tab, text);
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
	}

	async function answerHeld() {
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	/** The assistant proposes `proposed`, and the person accepts it. */
	async function acceptProposal(tab: Tab, proposed: string) {
		harness.agentState = { document: proposed };
		rerender(tab);
		await settle(20);
		const respond = vi.fn();
		let card: any;
		await act(async () => {
			card = tab.actions
				.get("confirm_changes")
				?.renderAndWaitForResponse({
					args: {},
					respond,
					status: "executing",
				});
			await Promise.resolve();
		});
		await settle(50);
		await act(async () => {
			card?.props.onConfirm();
		});
		await settle(50);
		return respond;
	}

	it("during the autosave, is saved after that answer, from the room's stamp the answer produced", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await autosaveInFlight(tab, " First edit.");
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});

		const respond = await acceptProposal(
			tab,
			`${editorBody(tab)}\n\nAn accepted paragraph.`,
		);
		expect(respond).toHaveBeenCalledWith({ accepted: true });
		expect(saveCalls).toHaveLength(1);

		server.holdAnswers = false;
		await answerHeld();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		vi.useRealTimers();
		const firstAnswer = {
			version: 8,
			contentHash: hashOf(String(saveCalls[0]?.content)),
		};
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: firstAnswer.version,
			expectedContentHash: firstAnswer.contentHash,
		});
		expect(saveCalls[1]?.content).toContain("An accepted paragraph.");
		await waitFor(() => {
			expect(server.content).toContain("An accepted paragraph.");
		});
		expect(server.version).toBe(9);
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		// One report, for the accept's own save; no conflict.
		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalledWith(
			"Changes applied — saved as v9",
		);
		expect(toast.error).not.toHaveBeenCalled();
		expect(offerBackCalls()).toHaveLength(0);
	});

	it("in a room without a stamp yet, is not sent: it stays in the editor, unsaved, and the editor says it is updating to the latest version", async () => {
		// A room from before the stamp, still being looked at: it takes its
		// stamp only after the observation gap.
		await persistRoom(BODY_A, null);
		harness.timings.observationGapMs = 60_000;
		const tab = await openTab("tab");
		expect(readRoomStamp(room.doc)).toBeNull();

		const respond = await acceptProposal(
			tab,
			`${BODY_A}\n\nAn accepted paragraph.`,
		);
		await settle(50);

		expect(readRoomStamp(room.doc)).toBeNull();
		expect(toast.info).toHaveBeenCalledWith("saveBlocked.updatingToLatest");
		expect(respond).toHaveBeenCalledWith({ accepted: true });
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_A);
		expect(editorBody(tab)).toContain("An accepted paragraph.");
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});
});

describe("an update using context (Fizzy #2946)", () => {
	function updateUsingContext(tab: Tab): HTMLButtonElement | null {
		return (tab.view
			?.queryAllByText(/Update\s+using\s+context/)
			.map((label) => label.closest("button"))
			.find(Boolean) ?? null) as HTMLButtonElement | null;
	}

	it("confirms against the base the editor's saves name: the room's stamp", async () => {
		await persistRoom(BODY_A, savedStamp());
		await openTab("tab");

		expect(harness.contextUpdateOptions.resolveBase?.()).toEqual(
			savedStamp(),
		);
	});

	it("cannot be started while a run is generating the document", async () => {
		await persistRoom(BODY_A, savedStamp());
		const idle = await openTab("idle");
		const idleButton = updateUsingContext(idle);
		expect(idleButton).not.toBeNull();
		expect(idleButton).not.toBeDisabled();
		idle.view?.unmount();
		idle.view = null;
		room.tabs.splice(room.tabs.indexOf(idle), 1);

		server.status = "GENERATING";
		const during = await openTab("during");
		await waitFor(() => {
			expect(updateUsingContext(during)).toBeDisabled();
		});
	});

	it("cannot be started from the narrow layout's menu while a run is generating the document", async () => {
		const user = userEvent.setup();
		/** The menu's item, once the menu is open. */
		async function menuItem(tab: Tab): Promise<HTMLElement> {
			await user.click(
				(tab.view as ReturnType<typeof render>).getByRole("button", {
					name: "More document actions",
				}),
			);
			return waitFor(() => {
				const item = [
					...window.document.body.querySelectorAll<HTMLElement>(
						'[role="menuitem"]',
					),
				].find((element) =>
					/Update\s+using\s+context/.test(element.textContent ?? ""),
				);
				expect(item).toBeDefined();
				return item as HTMLElement;
			});
		}

		await persistRoom(BODY_A, savedStamp());
		const idle = await openTab("idle");
		expect(await menuItem(idle)).not.toHaveAttribute("aria-disabled");
		idle.view?.unmount();
		idle.view = null;
		room.tabs.splice(room.tabs.indexOf(idle), 1);

		server.status = "GENERATING";
		const during = await openTab("during");
		expect(await menuItem(during)).toHaveAttribute("aria-disabled", "true");
	});
});

describe("rejecting a regeneration in a room (Fizzy #2946)", () => {
	async function startRunFromChat(tab: Tab) {
		await act(async () => {
			tab.actions.get("regenerate_document")?.renderAndWaitForResponse({
				args: { prompt: "Rewrite it" },
				respond: vi.fn(),
				status: "executing",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	/** A run this tab started ends on BODY_B at version 8; its review is open. */
	async function reviewRun(tab: Tab) {
		await startRunFromChat(tab);
		server.status = "GENERATING";
		await nudge(tab);
		server.content = BODY_B;
		server.version = 8;
		server.status = "COMPLETE";
		await nudge(tab);
		await waitFor(() => {
			expect(
				tab.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
		});
		await waitFor(() => {
			expect(editorBody(tab)).toContain("rewritten by the run");
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
	}

	/** Reject, then the dialog's closing delay and the review's own wind-down. */
	async function reject(tab: Tab) {
		await act(async () => {
			within(
				tab.view?.getByTestId(
					"regeneration-confirm-modal",
				) as HTMLElement,
			)
				.getByRole("button", { name: "Reject" })
				.click();
			await new Promise((resolve) => setTimeout(resolve, 900));
		});
		await waitFor(() => {
			expect(
				tab.view?.queryByTestId("regeneration-confirm-modal"),
			).toBeNull();
		});
	}

	/** The server finds no earlier version to rewind to. */
	function noPriorVersion() {
		return Object.assign(
			new Error(
				"This document has no prior version to revert to. The current content is still in place.",
			),
			{ code: "CONFLICT" },
		);
	}

	/** Answers the oldest held write, and only it. */
	async function answerOldest() {
		await act(async () => {
			server.held.shift()?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	/**
	 * Reject, held, and an autosave of typing done once the review closed,
	 * held behind it: the Reject's answer then comes while the autosave is
	 * in flight.
	 */
	async function rejectAnsweredDuringAutosave(tab: Tab) {
		await reviewRun(tab);
		server.rejectError = noPriorVersion();
		server.holdAnswers = true;
		await reject(tab);
		await waitFor(() => {
			expect(editorBody(tab)).toContain("Phase one, then two.");
		});
		// The review winds down a second after it closes.
		await settle(1200);
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " Typed after the reject.");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 8,
			expectedContentHash: hashOf(BODY_B),
		});
		expect(saveCalls[0]?.content).toContain("Typed after the reject.");
		expect(server.held).toHaveLength(2);

		// The Reject's answer: nothing to rewind to, so the earlier body is
		// to be saved over the regenerated one.
		await answerOldest();
		await settle(50);
	}

	it("says the regeneration was rejected only once the server has rewound it", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		server.beforeRun = { content: BODY_A, version: 7 };
		await reviewRun(tab);
		server.holdAnswers = true;

		await reject(tab);
		await settle(50);
		expect(server.held).toHaveLength(1);
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");

		await answerOldest();
		await waitFor(() => {
			expect(toast.info).toHaveBeenCalledWith("regenerationRejected");
		});
		expect(toast.error).not.toHaveBeenCalled();
		expect(saveCalls).toEqual([]);
	});

	it("a Reject the server refuses says why in the reader's words, and never that it was rejected", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		await reviewRun(tab);
		server.rejectError = Object.assign(new Error("Database unavailable"), {
			code: "INTERNAL_SERVER_ERROR",
		});

		await reject(tab);
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("failed");
		});
		await settle(50);
		expect(toast.error).not.toHaveBeenCalledWith(
			expect.stringContaining("Database unavailable"),
		);
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_B);
	});

	it("with nothing to rewind to, the earlier body waits for the autosave in flight and goes from the base its answer produced; Save reads Saving meanwhile", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		await rejectAnsweredDuringAutosave(tab);

		// The earlier body waits: only the autosave has gone.
		expect(saveCalls).toHaveLength(1);
		expect(saveButton(tab)).toHaveAccessibleName("Saving");

		// The autosave's answer: the earlier body goes now, its own answer
		// held. The autosave's answer does not say the regeneration was
		// rejected.
		await answerOldest();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		expect(saveCalls[1]).toMatchObject({
			content: BODY_A,
			skipVersionBump: true,
			expectedVersion: 9,
			expectedContentHash: hashOf(String(saveCalls[0]?.content)),
		});
		await settle(50);
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");

		// Its answer: said once.
		server.holdAnswers = false;
		await answerOldest();
		vi.useRealTimers();
		await waitFor(() => {
			expect(toast.info).toHaveBeenCalledWith("regenerationRejected");
		});
		expect(
			vi
				.mocked(toast.info)
				.mock.calls.filter(
					([message]) => message === "regenerationRejected",
				),
		).toHaveLength(1);
		expect(server.content).toBe(BODY_A);
		expect(server.version).toBe(9);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("with nothing to rewind to, says the regeneration was rejected only once the earlier body's save has landed", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		await reviewRun(tab);
		server.rejectError = noPriorVersion();
		server.holdAnswers = true;
		await reject(tab);
		expect(server.held).toHaveLength(1);

		// The Reject's answer: nothing to rewind to. The earlier body goes,
		// from the run's stamp, and its answer is held.
		await answerOldest();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			content: BODY_A,
			skipVersionBump: true,
			expectedVersion: 8,
			expectedContentHash: hashOf(BODY_B),
		});
		await settle(50);
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");

		await answerOldest();
		await waitFor(() => {
			expect(toast.info).toHaveBeenCalledWith("regenerationRejected");
		});
		expect(server.content).toBe(BODY_A);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("with nothing to rewind to, a refused save of the earlier body says why, and never that the regeneration was rejected", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		await reviewRun(tab);
		server.rejectError = noPriorVersion();
		server.failNext = new Error("Service unavailable");

		await reject(tab);
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("failed");
		});
		await settle(50);
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({
			content: BODY_A,
			skipVersionBump: true,
		});
		expect(server.content).toBe(BODY_B);
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");
	});

	it("with nothing to rewind to, in a room without a stamp, sends nothing and says the editor is updating to the latest version", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		await reviewRun(tab);
		// The room loses its stamp, and is looked at again only after the
		// observation gap.
		harness.timings.observationGapMs = 60_000;
		await act(async () => {
			room.doc.getMap(ROOM_META_MAP).delete("stamp");
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(readRoomStamp(tab.doc)).toBeNull();
		server.rejectError = noPriorVersion();

		await reject(tab);
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"saveBlocked.updatingToLatest",
			);
		});
		await settle(50);
		expect(readRoomStamp(room.doc)).toBeNull();
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_B);
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");
	});

	it("with nothing to rewind to, the earlier body is dropped when the autosave it waited for fails: it stays unsaved in the editor", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		// The autosave the earlier body will wait for is refused.
		server.failNext = new Error("Service unavailable");
		await rejectAnsweredDuringAutosave(tab);
		expect(saveCalls).toHaveLength(1);

		server.holdAnswers = false;
		await answerOldest();
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("failed");
		});
		await settle(50);
		vi.useRealTimers();
		expect(saveCalls).toHaveLength(1);
		expect(server.content).toBe(BODY_B);
		expect(server.version).toBe(8);
		expect(editorBody(tab)).toContain("Phase one, then two.");
		expect(editorBody(tab)).toContain("Typed after the reject.");
		expect(saveButton(tab)).toHaveAccessibleName("Save document");
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");
	});
});

describe("restoring a version while a run holds the document (Fizzy #2946)", () => {
	it("is refused for a run on a run-guarded document, and for this tab's regeneration and its review; not otherwise", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		expect(harness.versionHistoryProps.restoreBlockedReason).toBeNull();

		// A run started elsewhere on a Proposal.
		server.status = "GENERATING";
		await nudge(tab);
		await waitFor(() => {
			expect(harness.versionHistoryProps.restoreBlockedReason).toBe(
				"runLive",
			);
		});
		server.status = "COMPLETE";
		await nudge(tab);
		await waitFor(() => {
			expect(harness.versionHistoryProps.restoreBlockedReason).toBeNull();
		});

		// This tab's own run, and then its review.
		await act(async () => {
			tab.actions.get("regenerate_document")?.renderAndWaitForResponse({
				args: { prompt: "Rewrite it" },
				respond: vi.fn(),
				status: "executing",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(harness.versionHistoryProps.restoreBlockedReason).toBe(
				"regenerating",
			);
		});
		server.status = "GENERATING";
		await nudge(tab);
		await waitFor(() => {
			expect(harness.versionHistoryProps.restoreBlockedReason).toBe(
				"runLive",
			);
		});
		server.content = BODY_B;
		server.version = 8;
		server.status = "COMPLETE";
		await nudge(tab);
		await waitFor(() => {
			expect(
				tab.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
		});
		expect(harness.versionHistoryProps.restoreBlockedReason).toBe(
			"regenerating",
		);
	});

	it("is not refused for a run on a document type the server does not guard", async () => {
		server.type = "PRD";
		await persistRoom(BODY_A, savedStamp());
		server.status = "GENERATING";
		await openTab("tab");
		await settle(50);
		expect(harness.versionHistoryProps.restoreBlockedReason).toBeNull();
	});
});

describe("a save from an editor older than the server (Fizzy #2946)", () => {
	it("says to reload to keep editing, and keeps the text", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Kept in the editor.");
		server.requireBase = true;
		await clickSave(tab);

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"baseRequired",
				expect.objectContaining({
					action: expect.objectContaining({ label: "reload" }),
				}),
			);
		});
		expect(editorBody(tab)).toContain("Kept in the editor.");
	});
});

describe("a save refused because a generation run holds the document (Fizzy #2946)", () => {
	/** The server's answer to a save once a run queued or is writing. */
	function runLiveRefusal() {
		return Object.assign(
			new Error(
				"A generation run is writing this document; try again when it finishes.",
			),
			{
				code: "CONFLICT",
				data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
			},
		);
	}

	/** Why the Save button refuses, as its description reads, if it does. */
	function saveRefusal(tab: Tab): string | null {
		const id = saveButton(tab).getAttribute("aria-describedby");
		return id
			? (tab.saveSlot.querySelector(`[id="${id}"]`)?.textContent ?? null)
			: null;
	}

	it("the single-user editor says a run is writing, keeps the text unsaved, and saves it from its base once the run ends", async () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		const tab = await openTab("solo");
		await type(tab, " Typed as a run queued.");

		// A run queued after the editor last read the document.
		server.status = "GENERATING";
		server.failNext = runLiveRefusal();
		await clickSave(tab);

		await waitFor(() => {
			expect(toast.info).toHaveBeenCalledWith("saveBlocked.runLive");
		});
		expect(saveCalls).toHaveLength(1);
		expect(server.content).toBe(BODY_A);
		expect(server.version).toBe(7);
		expect(toast.error).not.toHaveBeenCalled();
		expect(editorBody(tab)).toContain("Typed as a run queued.");
		// The refetch brings the run, whose state holds saves back.
		await waitFor(() => {
			expect(saveRefusal(tab)).toBe("saveBlocked.runLive");
		});

		// The run ends without moving the body: the base the editor holds is
		// still the saved one, and the text, still unsaved, saves.
		server.status = "COMPLETE";
		await nudge(tab);
		await waitFor(() => {
			expect(saveRefusal(tab)).toBeNull();
		});
		await clickSave(tab);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		await waitFor(() => {
			expect(server.content).toContain("Typed as a run queued.");
		});
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("a room's save is not taken for a room behind the saved document: nothing is converged or offered back, and the text saves once the run ends", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Typed as a run queued.");

		server.status = "GENERATING";
		server.failNext = runLiveRefusal();
		await clickSave(tab);

		await waitFor(() => {
			expect(toast.info).toHaveBeenCalledWith("saveBlocked.runLive");
		});
		await waitFor(() => {
			expect(saveRefusal(tab)).toBe("saveBlocked.runLive");
		});
		await settle(200);
		expect(toast.info).not.toHaveBeenCalledWith("saveConflictRoom");
		expect(toast.error).not.toHaveBeenCalled();
		expect(saveCalls).toHaveLength(1);
		expect(server.content).toBe(BODY_A);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		expect(offerBackCalls()).toHaveLength(0);
		expect(editorBody(tab)).toContain("Typed as a run queued.");
		expect(await roomBody()).toContain("Typed as a run queued.");

		server.status = "COMPLETE";
		await nudge(tab);
		await waitFor(() => {
			expect(saveRefusal(tab)).toBeNull();
		});
		await clickSave(tab);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		await waitFor(() => {
			expect(server.content).toContain("Typed as a run queued.");
		});
		expect(offerBackCalls()).toHaveLength(0);
	});

	it("a CONFLICT that names no run still stops the single-user editor's saves until a reload", async () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		const tab = await openTab("solo");
		await type(tab, " Typed over a moved base.");

		server.failNext = Object.assign(new Error("Document changed"), {
			code: "CONFLICT",
		});
		await clickSave(tab);

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"saveConflictSolo",
				expect.objectContaining({
					cancel: expect.objectContaining({ label: "reload" }),
				}),
			);
		});
		expect(toast.info).not.toHaveBeenCalledWith("saveBlocked.runLive");
		await waitFor(() => {
			expect(saveRefusal(tab)).toBe("saveBlocked.staleBase");
		});
		expect(saveCalls).toHaveLength(1);
		expect(editorBody(tab)).toContain("Typed over a moved base.");
	});
});

describe("with the room flag off (Fizzy #2946)", () => {
	beforeEach(() => {
		harness.flags = { DOCUMENT_ROOM_CONVERGENCE: false };
	});

	it("sends nothing when the page is left within the app with typing unsaved", async () => {
		await persistRoom(BODY_A, null);
		const tab = await openTab("tab");
		await type(tab, " Typed before leaving.");

		await act(async () => {
			tab.view?.unmount();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(50);

		expect(saveCalls).toHaveLength(0);
	});

	it("seeds, saves and leaves the room as after the run-state fix: no stamp, no base, no convergence", async () => {
		await persistRoom(BODY_A, { version: 7, contentHash: hashOf(BODY_A) });
		server.content = BODY_B;
		server.version = 8;
		const tab = await openTab("tab");

		// The first sync seeds the room with the loaded body, as before.
		await waitFor(() => {
			expect(editorBody(tab)).toContain("rewritten by the run");
		});
		expect(showsSavedBody(tab)).toBe(false);

		await type(tab, " An edit.");
		await clickSave(tab);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).not.toHaveProperty("expectedVersion");
		expect(saveCalls[0]).not.toHaveProperty("expectedContentHash");
		expect(tab.awareness.own[ROOM_SAVE_AWARENESS_FIELD]).toBeUndefined();
		expect(tab.awareness.own[ROOM_PEER_AWARENESS_FIELD]).toBeUndefined();
		await settle(200);
		expect(readRoomStamp(room.doc)).toEqual({
			version: 7,
			contentHash: hashOf(BODY_A),
		});
		expect(readConvergenceClaim(room.doc)).toBeNull();
	});
});
