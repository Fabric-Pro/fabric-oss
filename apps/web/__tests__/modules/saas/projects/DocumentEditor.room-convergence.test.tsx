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
 *   - an accepted assistant proposal answers the chat at once, and records
 *     what became of it only once its save is answered — applied, refused,
 *     or kept unsaved in the editor — exactly once; a refused save's toast
 *     carries one id per document, and the next save that lands takes it
 *     away;
 *   - an assistant proposal under review in one tab, from the assistant's
 *     first frame there, holds every other tab that may edit still — no
 *     input, no saves, no regeneration, restore or proposal of its own, the
 *     status says why — and the room is not brought to a newer saved body
 *     underneath it; the answer, a run that ends without a card, the
 *     reviewing tab leaving or its state leaving the room ends the hold,
 *     and nothing the other tab typed before is lost;
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
import {
	act,
	fireEvent,
	render,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import { Fragment, type ReactNode } from "react";
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
	/** The assistant conversation the page was loaded with, if any. */
	conversationId: string | null;
	queryClient: QueryClient;
	saveSlot: HTMLElement;
	/** Where the view switch and version history are drawn, if anywhere. */
	actionSlot: HTMLElement | null;
	syncSlot: HTMLElement;
	editors: Array<{ editor: Editor; readOnly: boolean }>;
	actions: Map<string, Record<string, any>>;
	/** Yjs updates this tab produced itself. */
	localUpdates: number;
	view: ReturnType<typeof render> | null;
	/** What this tab's editor handed its version history last. */
	versionHistoryProps?: Record<string, any>;
}

const harness = await vi.hoisted(async () => {
	const React = await import("react");
	return {
		TabContext: React.createContext<Tab | null>(null),
		flags: {} as Record<string, boolean>,
		tabByClient: new Map<unknown, Tab>(),
		/** How long into a pause in typing the editor autosaves. */
		autosave: { delayMs: 10_000 },
		/**
		 * The stale rule's and the election's waits, shortened. The saved
		 * body's grace is not: past the second look, it never takes over.
		 */
		timings: {
			observationGapMs: 60,
			savedBodyGraceMs: 750,
			claimSettleMs: 30,
			fallThroughMs: 300,
			failedClaimExpiryMs: 60_000,
			// As in production unless a test shortens it.
			proposalReviewIdleLimitMs: 10 * 60_000,
			proposalCardLateLimitMs: 20_000,
		},
		/** The assistant is running a turn (the save before it goes first). */
		chatLoading: false,
		/** The assistant's shared state: `document` is what it proposes. */
		agentState: {} as Record<string, unknown>,
		/**
		 * The tab whose chat the two above are, or every tab's when `null`:
		 * the others' chats are idle, with no proposal.
		 */
		chatIn: null as string | null,
		/** An idle chat's state, the same object every render. */
		idleAgentState: {} as Record<string, unknown>,
		/**
		 * Chats of their own, by tab, beside the one above: a tab here runs
		 * a turn with this state, whatever `chatIn` says.
		 */
		tabChats: new Map<
			string,
			{ loading: boolean; state: Record<string, unknown> }
		>(),
		/** The assistant's graph node; `"end"` once its run is over. */
		nodeName: undefined as string | undefined,
		/**
		 * Whether the chat's tab writes `agentState` back, as the agent's
		 * shared state does: the agent's next run starts from it.
		 */
		liveAgentState: false,
		/** The image upload's storage write; resolves to the stored key. */
		uploadImage: null as null | (() => Promise<string>),
		/** The upload handler the editor registered for slash commands. */
		slashImageUpload: null as null | ((files: FileList) => Promise<void>),
		/** Where Save & Close sends the person. */
		routerPush: (() => {}) as (url: string) => void,
		/** What the editor handed the context-update hook last. */
		contextUpdateOptions: {} as Record<string, any>,
		/** The tab whose update using context is under way, if any. */
		contextUpdateIn: null as string | null,
		/** What the editor asked of that update using context. */
		contextWithdraw: (() => {}) as () => void,
		contextReassert: (() => {}) as () => void,
		contextReject: (() => {}) as () => void,
		/** What the editor handed the context-update hook, by tab. */
		contextOptionsByTab: new Map<string, Record<string, any>>(),
		/**
		 * The body a tab's update using context was drafted from: its
		 * reject puts it back into the editor, as the hook does.
		 */
		contextBaselines: new Map<string, string>(),
		/** What the editor handed the version history last. */
		versionHistoryProps: {} as Record<string, any>,
		/** Tabs that drew the saved body before its editor existed. */
		blankSavedBodyFrames: [] as string[],
		/** What the editor records of a confirm in the chat. */
		recordOutcome: vi.fn(),
		/**
		 * The records also go through the real helper, under a
		 * conversation, to `recordOperationResult` below.
		 */
		postRecords: false,
		/** The server's `agents.conversations.recordOperationResult`. */
		recordOperationResult: vi.fn(),
		confirmDraft: vi.fn(),
		serializationMode: null as null | "null" | "empty",
		/** The chat's live messages, as CopilotKit holds them. */
		chatMessages: [] as Array<Record<string, unknown>>,
		/** The server's `agents.conversations.recordDiffOutcome`. */
		recordDiffOutcome: vi.fn(),
		/** What the editor handed its review bar last. */
		reviewBarProps: null as Record<string, any> | null,
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
	/** The latest run's identity, as the row names it. */
	generationStartedAt: null as string | null,
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
	/** How many generations were started. */
	calls: 0,
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
			generationStartedAt: server.generationStartedAt,
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
			generate.calls += 1;
			return generate.result;
		case "projects.documents.rejectRegeneration":
			// Rewinds the row to the body and version before the run, and
			// answers with that body and its identity, as the real one does.
			// With `rejectError` it is refused instead, and nothing is
			// rewound.
			return answerOrHold(() => {
				if (server.rejectError) {
					throw server.rejectError;
				}
				if (server.beforeRun) {
					server.content = server.beforeRun.content;
					server.version = server.beforeRun.version;
				}
				return serverDocument();
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
				if (prop === "mutationKey") {
					return () => [...path];
				}
				if (prop === "mutationOptions") {
					return (config: Record<string, unknown>) => ({
						mutationKey: [...path],
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
			apply(_target, _thisArg, args: unknown[]) {
				if (path.join(".") === "ai.feedback.confirmDraft") {
					return harness.confirmDraft(args[0]);
				}
				if (
					path.join(".") ===
					"agents.conversations.recordOperationResult"
				) {
					return harness.recordOperationResult(args[0]);
				}
				if (path.join(".") === "projects.documents.resolveMediaUrls") {
					const { s3Keys } = args[0] as { s3Keys: string[] };
					return Promise.resolve({
						urls: Object.fromEntries(
							s3Keys.map((key) => [
								key,
								`https://example.com/${key}`,
							]),
						),
					});
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

vi.mock("@saas/projects/lib/image-upload-utils", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/projects/lib/image-upload-utils")
	>()),
	uploadImage: () =>
		harness.uploadImage?.() ?? Promise.reject(new Error("no upload")),
}));
vi.mock("@saas/projects/components/SlashCommands", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@saas/projects/components/SlashCommands")
		>();
	return {
		...actual,
		setSlashCommandImageUploadHandler: (
			handler: ((files: FileList) => Promise<void>) | null,
		) => {
			harness.slashImageUpload = handler;
			actual.setSlashCommandImageUploadHandler(handler);
		},
	};
});

vi.mock("@saas/projects/lib/document-save-input", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/projects/lib/document-save-input")
	>()),
	DOCUMENT_AUTOSAVE_TIMINGS: harness.autosave,
}));

// ---- TipTap: a real editor, built from what the component passes, so the
// collaborative one binds to the tab's document.
vi.mock("@tiptap/react", async () => {
	const React = await import("react");
	const { Editor: CoreEditor } = await import("@tiptap/core");
	return {
		// Before the page is painted: a saved body shown with no editor yet
		// is an empty frame.
		EditorContent: ({
			className,
			editor,
		}: {
			className?: string;
			editor?: unknown;
		}) => {
			const tab = React.useContext(harness.TabContext);
			const ref = React.useRef<HTMLDivElement>(null);
			React.useLayoutEffect(() => {
				if (
					!editor &&
					ref.current?.closest('[data-testid="room-saved-body"]')
				) {
					harness.blankSavedBodyFrames.push(tab?.name ?? "?");
				}
			});
			return (
				<div
					ref={ref}
					data-testid="editor-content"
					className={className}
				/>
			);
		},
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
		useCoAgent: () => {
			const tab = React.useContext(harness.TabContext);
			return {
				state:
					(tab && harness.tabChats.get(tab.name)?.state) ??
					(harness.chatIn !== null && tab?.name !== harness.chatIn
						? harness.idleAgentState
						: harness.agentState),
				setState: (update: unknown) => {
					const own = tab
						? harness.tabChats.get(tab.name)
						: undefined;
					if (own && harness.liveAgentState) {
						own.state =
							typeof update === "function"
								? update(own.state)
								: (update as Record<string, unknown>);
						return;
					}
					if (
						!harness.liveAgentState ||
						(harness.chatIn !== null &&
							tab?.name !== harness.chatIn)
					) {
						return;
					}
					harness.agentState =
						typeof update === "function"
							? update(harness.agentState)
							: (update as Record<string, unknown>);
				},
				nodeName:
					harness.chatIn !== null && tab?.name !== harness.chatIn
						? undefined
						: harness.nodeName,
			};
		},
		useCopilotAction: (config: Record<string, any>) => {
			const tab = React.useContext(harness.TabContext);
			tab?.actions.set(config.name, config);
		},
		useCopilotChat: () => {
			const tab = React.useContext(harness.TabContext);
			return {
				isLoading:
					(tab && harness.tabChats.get(tab.name)?.loading) ??
					(harness.chatLoading &&
						(harness.chatIn === null ||
							tab?.name === harness.chatIn)),
				visibleMessages: [],
			};
		},
		useCopilotChatInternal: () => ({
			messages: [...harness.chatMessages],
			setMessages: vi.fn(),
		}),
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
vi.mock("@saas/projects/components/DocumentVersionHistory", async () => {
	const React = await import("react");
	return {
		DocumentVersionHistory: (props: Record<string, any>) => {
			const tab = React.useContext(harness.TabContext);
			harness.versionHistoryProps = props;
			if (tab) {
				tab.versionHistoryProps = props;
			}
			return null;
		},
	};
});
vi.mock("@saas/projects/components/DiffReviewBar", () => ({
	DiffReviewBar: (props: Record<string, any>) => {
		harness.reviewBarProps = props;
		return null;
	},
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
		dismiss: vi.fn(),
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
	useRecordDocumentAssistantDiffOutcome: () => ({
		mutateAsync: harness.recordDiffOutcome,
	}),
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
vi.mock(
	"@saas/agents/copilot/useConfirmChangesOperationResult",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@saas/agents/copilot/useConfirmChangesOperationResult")
			>();
		return {
			...actual,
			// Every record is captured; with `postRecords` it also goes
			// through the real helper, as in a conversation.
			useConfirmChangesOperationResult: (
				args: Parameters<
					typeof actual.useConfirmChangesOperationResult
				>[0],
			) => {
				const post = actual.useConfirmChangesOperationResult({
					...args,
					conversationId: "conversation-example",
				});
				return (options: Parameters<typeof post>[0]): Promise<void> => {
					harness.recordOutcome(options);
					return harness.postRecords
						? post(options)
						: Promise.resolve();
				};
			},
		};
	},
);
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
	useFabricMention: () => ({
		handleInputChange: (value: string) => ({ consumed: false, value }),
	}),
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
	async () => {
		const React = await import("react");
		return {
			useUpdateDocumentWithContext: (options: Record<string, any>) => {
				const tab = React.useContext(harness.TabContext);
				harness.contextUpdateOptions = options;
				if (tab) {
					harness.contextOptionsByTab.set(tab.name, options);
				}
				const isActive =
					tab !== null && tab.name === harness.contextUpdateIn;
				return {
					isActive,
					showingDiff: isActive,
					isApplying: false,
					isLoading: false,
					loadingStage: null,
					elapsedSeconds: 0,
					preview: null,
					start: vi.fn(),
					confirm: vi.fn(),
					reject: () => {
						harness.contextReject();
						const before = tab
							? harness.contextBaselines.get(tab.name)
							: undefined;
						if (before !== undefined) {
							options.editor?.commands.setContent(
								options.fromMarkdown(before),
							);
						}
					},
					isApplyingNow: () => false,
					withdraw: () => harness.contextWithdraw(),
					reassert: () => harness.contextReassert(),
				};
			},
		};
	},
);

import { useCopilotReadable } from "@copilotkit/react-core";
import { DocumentEditor } from "@saas/projects/components/DocumentEditor";
import {
	GENERATION_RUN_AWARENESS_FIELD,
	isRoomBodyEmpty,
	PROPOSAL_REVIEW_AWARENESS_FIELD,
	ROOM_META_MAP,
	ROOM_PEER_AWARENESS_FIELD,
	ROOM_SAVE_AWARENESS_FIELD,
	readConvergenceClaim,
	readRoomStamp,
	writeConvergenceClaim,
	writeRoomStamp,
} from "@saas/projects/components/proposal-artifact/generation-run-awareness";
import { transactionTouches } from "@saas/projects/components/proposal-artifact/room-convergence-helpers";
import { fromMarkdown } from "@saas/projects/lib/diff-utils";

vi.mock("@saas/projects/lib/editor-markdown-save", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@saas/projects/lib/editor-markdown-save")
		>();
	return {
		...actual,
		getEditorMarkdownForSave: (
			...args: Parameters<typeof actual.getEditorMarkdownForSave>
		) =>
			harness.serializationMode === "null"
				? null
				: harness.serializationMode === "empty"
					? ""
					: actual.getEditorMarkdownForSave(...args),
	};
});

import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { ROOM_BODY_FRAGMENT } from "@saas/projects/lib/room-body-fragment";
import { createCollaborativeExtensions } from "@saas/projects/lib/tiptap-extensions";
import { toast } from "sonner";

const BODY_A =
	"## Scope\n\nPhase one, then two.\n\n## Pricing\n\nA fixed fee for the first phase.";
const BODY_B =
	"## Scope\n\nPhase one, then two, rewritten by the run.\n\n## Pricing\n\nA fixed fee for both phases.";
/** A refused save's toast: one per document, taken away by the next save. */
const SAVE_FAILED_TOAST = { id: "document-save-failed:doc-1" };
/**
 * What the chat records of an accepted proposal, by what its save did —
 * each under the one key that accept made.
 */
const SAVED_ACCEPT_RECORD = {
	accepted: true,
	summary: "Changes applied.",
	operationKey: expect.any(String),
};
const FAILED_ACCEPT_RECORD = {
	accepted: true,
	outcome: "failure",
	summary:
		"The accepted changes could not be saved; they are still in the editor.",
	operationKey: expect.any(String),
};
/** Refused, and the editor no longer holds it: offered to copy instead. */
const FAILED_OFFERED_ACCEPT_RECORD = {
	accepted: true,
	outcome: "failure",
	summary:
		"The accepted changes could not be saved; they were offered to copy.",
	operationKey: expect.any(String),
};
/** Undone in the editor while its save waited: never saved, declined. */
const UNDONE_ACCEPT_RECORD = {
	accepted: false,
	summary: "The accepted changes were undone before they were saved.",
	operationKey: expect.any(String),
};
/** Refused after a single-user editor was closed: nothing holds it now. */
const CLOSED_ACCEPT_RECORD = {
	accepted: true,
	outcome: "failure",
	summary: "The accepted changes could not be saved.",
	operationKey: expect.any(String),
};
const UNSAVED_ACCEPT_RECORD = {
	accepted: true,
	outcome: "partial",
	summary: "The accepted changes are in the editor, not saved yet.",
	operationKey: expect.any(String),
};

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
					actionSlot={tab.actionSlot}
					syncSlot={tab.syncSlot}
					suppressGenerationOverlay={tab.attachToServerRun}
					initialAssistantConversationId={tab.conversationId}
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
		conversationId = null,
		withActions = false,
	}: {
		role?: Tab["role"];
		clientId?: number;
		attachToServerRun?: boolean;
		conversationId?: string | null;
		/** Draw the page's action buttons — the view switch among them. */
		withActions?: boolean;
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
	const actionSlot = withActions
		? window.document.createElement("div")
		: null;
	if (actionSlot) {
		window.document.body.append(actionSlot);
	}
	const tab: Tab = {
		name,
		doc,
		awareness,
		provider: { awareness },
		synced: true,
		role,
		attachToServerRun,
		conversationId,
		queryClient,
		saveSlot,
		actionSlot,
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

/** The raw markdown view, toggled as its keyboard shortcut does. */
async function toggleRawView() {
	await act(async () => {
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "V",
				ctrlKey: true,
				shiftKey: true,
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await settle(50);
}

function rawTextarea(tab: Tab): HTMLTextAreaElement {
	const area = [
		...(tab.view?.container.querySelectorAll("textarea") ?? []),
	].find((element) => element.value.includes("## Scope"));
	if (!area) {
		throw new Error(`${tab.name} shows no raw markdown`);
	}
	return area;
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
	harness.chatIn = null;
	harness.tabChats = new Map();
	harness.nodeName = undefined;
	harness.liveAgentState = false;
	harness.uploadImage = null;
	generate.calls = 0;
	harness.contextUpdateIn = null;
	harness.contextWithdraw = vi.fn();
	harness.contextReassert = vi.fn();
	harness.contextReject = vi.fn();
	harness.contextOptionsByTab = new Map();
	harness.contextBaselines = new Map();
	harness.routerPush = vi.fn();
	Object.assign(harness.timings, SHORT_TIMINGS);
	harness.autosave.delayMs = 10_000;
	saveCalls.length = 0;
	harness.versionHistoryProps = {};
	harness.blankSavedBodyFrames = [];
	harness.postRecords = false;
	harness.recordOperationResult.mockReset();
	harness.confirmDraft.mockReset();
	harness.serializationMode = null;
	harness.chatMessages = [];
	harness.recordDiffOutcome.mockReset();
	harness.reviewBarProps = null;
	server.content = BODY_A;
	server.version = 7;
	server.status = "COMPLETE";
	server.type = "PROPOSAL";
	server.generationStartedAt = null;
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
		tab.actionSlot?.remove();
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

	/**
	 * Types two characters at the end and deletes them again: Save is on in
	 * between, and off after only if the editor's saved body is what it
	 * holds.
	 */
	async function typeAndDeleteBack(tab: Tab) {
		const editor = mainEditor(tab) as Editor;
		const at = editor.state.doc.content.size - 1;
		await act(async () => {
			editor.commands.insertContentAt(at, " x");
		});
		await settle(220);
		expect(saveButton(tab)).not.toBeDisabled();
		await act(async () => {
			editor.commands.deleteRange({ from: at, to: at + 2 });
		});
		await settle(220);
	}

	/** Whether this tab, and not another, draws the saved body. */
	function drawsSavedBody(tab: Tab): boolean {
		return (
			tab.view?.container.querySelector(
				'[data-testid="room-saved-body"]',
			) != null
		);
	}

	/** A run the starter began ends on BODY_B, at version 7 still. */
	async function runEndsOnBody(starter: Tab, ...others: Tab[]) {
		await startRunFromChat(starter);
		server.status = "GENERATING";
		await nudge(starter, ...others);
		await settle(30);
		server.content = BODY_B;
		server.status = "COMPLETE";
		await nudge(starter, ...others);
	}

	it("a background starter whose frames are held still puts the run's body into the room at once: neither tab hides its editor behind the saved body", async () => {
		// Production waits: a convergence would take seconds.
		Object.assign(harness.timings, {
			observationGapMs: 3000,
			claimSettleMs: 1500,
			fallThroughMs: 10_000,
		});
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		await startRunFromChat(starter);
		server.status = "GENERATING";
		await nudge(starter, follower);
		await settle(30);

		// A background tab: frames wait until it is shown again.
		const heldFrames: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
			heldFrames.push(cb);
			return heldFrames.length;
		});
		server.content = BODY_B;
		server.status = "COMPLETE";
		await nudge(starter, follower);

		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(starter)).toContain("rewritten by the run");
				expect(editorBody(follower)).toContain("rewritten by the run");
			},
			{ timeout: 500 },
		);
		for (let look = 0; look < 6; look += 1) {
			expect(drawsSavedBody(starter)).toBe(false);
			expect(drawsSavedBody(follower)).toBe(false);
			await settle(100);
		}
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(occurrences(await roomBody(), "rewritten by the run")).toBe(1);
		expect(saveCalls).toEqual([]);
	});

	/**
	 * Steps through the end of a run in production waits and lists every
	 * moment a tab showed the previous body in an editor that takes input, or
	 * had Save on, until the room holds `marker` under the saved stamp.
	 */
	async function watchRunEnd(tabs: Tab[], marker: string) {
		const STEP_MS = 250;
		const violations: string[] = [];
		const converged = () =>
			readRoomStamp(room.doc)?.contentHash === hashOf(server.content) &&
			tabs.every(
				(tab) =>
					!drawsSavedBody(tab) && editorBody(tab).includes(marker),
			);
		for (let at = 0; at <= 20_000; at += STEP_MS) {
			for (const tab of tabs) {
				const editorHidden =
					roomEditorContent(tab)?.className.includes("hidden") ??
					true;
				const previousBody = !editorBody(tab).includes(marker);
				const editable = mainEditor(tab)?.isEditable === true;
				const saveOff = saveButton(tab).hasAttribute("disabled");
				if ((!editorHidden && previousBody && editable) || !saveOff) {
					violations.push(
						`${at} ms ${tab.name}: ${previousBody ? "previous" : "run's"} body${editable ? ", editable" : ""}; Save ${saveOff ? "off" : "on"}`,
					);
				}
			}
			if (converged()) {
				break;
			}
			await act(async () => {
				await vi.advanceTimersByTimeAsync(STEP_MS);
			});
		}
		return { violations, converged: converged() };
	}

	const BODY_C =
		"## Scope\n\nPhase one, then two, rewritten by a later run.\n\n## Pricing\n\nA fixed fee per phase.";

	/**
	 * A later run that no open tab started — a colleague whose tab is closed,
	 * the API, the MCP gateway, a batch: the open tabs only hear that the
	 * document generates, then that it is complete on BODY_C.
	 */
	async function laterRunStartsOutside(...tabs: Tab[]) {
		server.generationStartedAt = new Date(
			Date.now() + 60_000,
		).toISOString();
		server.status = "GENERATING";
		await nudge(...tabs);
		// A closed review stops counting as open a second later.
		await settle(1100);
		await nudge(...tabs);
		await settle(30);
	}

	it("a run started outside the open tabs, while one tab still holds the review of an earlier run, never leaves the previous body editable when it ends", async () => {
		// Production waits: a convergence would take seconds.
		Object.assign(harness.timings, {
			observationGapMs: 3000,
			claimSettleMs: 1500,
			fallThroughMs: 10_000,
		});
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", {
			clientId: 20,
			attachToServerRun: true,
		});
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		server.generationStartedAt = new Date().toISOString();
		await runEndsOnBody(starter, follower);
		server.version = 8;
		await nudge(starter, follower);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
			expect(editorBody(follower)).toContain("rewritten by the run");
		});

		// The starter leaves its review open; a later run starts elsewhere.
		// The review no longer describes the document, so it closes, and the
		// starter follows the later run like the follower does (Fizzy #2946).
		await laterRunStartsOutside(starter, follower);
		expect(
			starter.view?.queryByTestId("regeneration-confirm-modal"),
		).toBeNull();
		expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
			"reviewSupersededByRun",
		);
		expect(starter.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"attached",
		);
		expect(follower.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"attached",
		);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		server.content = BODY_C;
		server.status = "COMPLETE";
		await nudge(starter, follower);
		const { violations, converged } = await watchRunEnd(
			[starter, follower],
			"rewritten by a later run",
		);
		vi.useRealTimers();

		expect(violations).toEqual([]);
		expect(converged).toBe(true);
		// One editor wrote the run's body with its stamp: no second look, no
		// claim, no save.
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(occurrences(await roomBody(), "rewritten by a later run")).toBe(
			1,
		);
		expect(saveCalls).toEqual([]);
	});

	it("an attached tab writes the body of a run started outside the open tabs even when the tab holding an earlier run's review learns of that run only as it ends", async () => {
		Object.assign(harness.timings, {
			observationGapMs: 3000,
			claimSettleMs: 1500,
			fallThroughMs: 10_000,
		});
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", {
			clientId: 20,
			attachToServerRun: true,
		});
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		server.generationStartedAt = new Date().toISOString();
		await runEndsOnBody(starter, follower);
		server.version = 8;
		await nudge(starter, follower);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
			expect(editorBody(follower)).toContain("rewritten by the run");
		});

		// Only the follower hears that the later run started.
		await laterRunStartsOutside(follower);
		expect(
			starter.view?.queryByTestId("regeneration-confirm-modal"),
		).not.toBeNull();
		expect(starter.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"started",
		);
		expect(follower.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"attached",
		);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		server.content = BODY_C;
		server.status = "COMPLETE";
		await nudge(starter, follower);
		const { violations, converged } = await watchRunEnd(
			[starter, follower],
			"rewritten by a later run",
		);
		vi.useRealTimers();

		expect(violations).toEqual([]);
		expect(converged).toBe(true);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(occurrences(await roomBody(), "rewritten by a later run")).toBe(
			1,
		);
		expect(saveCalls).toEqual([]);
	});

	it("a starter whose page has not read its run's identity yet still writes that run's body alone, even when a follower reads the end first and the room relays late", async () => {
		await persistRoom(BODY_A, savedStamp());
		// An earlier run's identity, all the starter's page has read.
		server.generationStartedAt = "2026-10-21T09:00:00.000Z";
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		await startRunFromChat(starter);
		server.generationStartedAt = new Date().toISOString();
		server.status = "GENERATING";
		await nudge(follower);
		await settle(30);
		expect(follower.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"attached",
		);

		server.content = BODY_B;
		server.status = "COMPLETE";
		room.paused = true;
		await nudge(follower);
		await settle(50);
		await nudge(starter);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
		});
		await settle(50);
		await resume();
		await settle(100);

		expect(occurrences(await roomBody(), "rewritten by the run")).toBe(1);
		expect(saveCalls).toEqual([]);
	});

	it("without the room's stamps, a tab that does not follow runs keeps the review of an earlier run until a later run's body arrives, then shows that body", async () => {
		harness.flags = { DOCUMENT_ROOM_CONVERGENCE: false };
		await persistRoom(BODY_A, null);
		const starter = await openTab("starter");
		server.generationStartedAt = new Date().toISOString();
		await runEndsOnBody(starter);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
		});

		// Closing it now would leave the earlier body on screen: nothing
		// brings this editor the later run's body.
		await laterRunStartsOutside(starter);
		expect(
			starter.view?.queryByTestId("regeneration-confirm-modal"),
		).not.toBeNull();

		server.content = BODY_C;
		server.status = "COMPLETE";
		await nudge(starter);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).toBeNull();
			expect(editorBody(starter)).toContain("rewritten by a later run");
		});
		expect(vi.mocked(toast.info)).toHaveBeenCalledWith("reviewSuperseded");
		expect(saveCalls).toEqual([]);
	});

	it("a tab alone with the review of an earlier run follows a run started elsewhere and puts its body into the room when it ends", async () => {
		Object.assign(harness.timings, {
			observationGapMs: 3000,
			claimSettleMs: 1500,
			fallThroughMs: 10_000,
		});
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { attachToServerRun: true });
		server.generationStartedAt = new Date().toISOString();
		await runEndsOnBody(starter);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
		});

		await laterRunStartsOutside(starter);
		expect(
			starter.view?.queryByTestId("regeneration-confirm-modal"),
		).toBeNull();
		expect(starter.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"attached",
		);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		server.content = BODY_C;
		server.status = "COMPLETE";
		await nudge(starter);
		const { violations, converged } = await watchRunEnd(
			[starter],
			"rewritten by a later run",
		);
		vi.useRealTimers();

		expect(violations).toEqual([]);
		expect(converged).toBe(true);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(occurrences(await roomBody(), "rewritten by a later run")).toBe(
			1,
		);
		expect(saveCalls).toEqual([]);
	});

	it("an attached follower that typed nothing keeps Save off and never autosaves once the run's body lands, whether the version step is announced or not; nor does the starter after Accept", async () => {
		harness.autosave.delayMs = 300;
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		await runEndsOnBody(starter, follower);
		await waitFor(() => {
			expect(editorBody(follower)).toContain("rewritten by the run");
		});
		await settle(200);
		expect(saveButton(follower)).toHaveAccessibleName(
			"Document saved, no changes to save",
		);
		expect(saveButton(follower)).toBeDisabled();

		// The run's version step, which nothing announces.
		server.version = 8;
		await settle(700);
		expect(saveButton(follower)).toBeDisabled();
		expect(saveCalls).toEqual([]);

		// Something else announces a change later: the stamp moves.
		await nudge(starter, follower);
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		await settle(700);
		expect(saveButton(follower)).toBeDisabled();
		expect(saveCalls).toEqual([]);

		await act(async () => {
			within(
				starter.view?.getByTestId(
					"regeneration-confirm-modal",
				) as HTMLElement,
			)
				.getByRole("button", { name: "Accept" })
				.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(1500);
		expect(saveButton(starter)).toHaveAccessibleName(
			"Document saved, no changes to save",
		);
		expect(saveButton(follower)).toBeDisabled();
		expect(saveCalls).toEqual([]);
	});

	it("an attached follower takes the run's body as its saved body: typing and deleting it back turns Save off again", async () => {
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		await runEndsOnBody(starter, follower);
		await waitFor(() => {
			expect(editorBody(follower)).toContain("rewritten by the run");
		});
		await settle(200);

		await typeAndDeleteBack(follower);
		expect(editorBody(follower)).toBe(editorBody(starter));
		expect(saveButton(follower)).toBeDisabled();
	});

	it("an attached follower takes the run's body as its saved body when the version step's stamp reaches the room before it looks", async () => {
		const { starter, follower } = await reviewWithFollower({
			content: BODY_A,
			version: 7,
		});

		await typeAndDeleteBack(follower);
		expect(editorBody(follower)).toBe(editorBody(starter));
		expect(saveButton(follower)).toBeDisabled();
	});

	it("the run's unannounced version step moves the room's stamp at once, without a second look or a claim", async () => {
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		await runEndsOnBody(starter, follower);
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		await settle(100);
		// A second look would take five seconds.
		harness.timings.observationGapMs = 5000;

		server.version = 8;
		await nudge(follower);
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			},
			{ timeout: 500 },
		);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(drawsSavedBody(follower)).toBe(false);
		expect(saveCalls).toEqual([]);
	});

	/**
	 * The starter reviews the run's BODY_B at version 8 and an attached
	 * follower holds it; the rewind goes back to `beforeRun`.
	 */
	async function reviewWithFollower(beforeRun: {
		content: string;
		version: number;
	}) {
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		server.beforeRun = beforeRun;
		await runEndsOnBody(starter, follower);
		server.version = 8;
		await nudge(starter, follower);
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			expect(editorBody(follower)).toContain("rewritten by the run");
		});
		await settle(200);
		return { starter, follower };
	}

	async function clickReject(tab: Tab) {
		await act(async () => {
			within(
				tab.view?.getByTestId(
					"regeneration-confirm-modal",
				) as HTMLElement,
			)
				.getByRole("button", { name: "Reject" })
				.click();
			// The dialog closes on a short delay before it rejects.
			await new Promise((resolve) => setTimeout(resolve, 900));
		});
	}

	/** Room transactions that changed the body without its stamp. */
	function watchUnstampedBodyWrites(): Y.Transaction[] {
		const unstamped: Y.Transaction[] = [];
		const meta = room.doc.getMap(ROOM_META_MAP);
		const body = room.doc.getXmlFragment(ROOM_BODY_FRAGMENT);
		room.doc.on("afterTransaction", (transaction: Y.Transaction) => {
			if (
				transactionTouches(transaction, body) &&
				!transaction.changed
					.get(meta as unknown as Y.AbstractType<Y.YEvent<any>>)
					?.has("stamp")
			) {
				unstamped.push(transaction);
			}
		});
		return unstamped;
	}

	it("a Reject leaves the room alone until the server answers, then puts the rewound body in with its stamp, and no one saves", async () => {
		harness.autosave.delayMs = 300;
		const { starter, follower } = await reviewWithFollower({
			content: BODY_A,
			version: 7,
		});
		const unstamped = watchUnstampedBodyWrites();
		server.holdAnswers = true;
		await clickReject(starter);

		expect(server.held).toHaveLength(1);
		expect(await roomBody()).toContain("rewritten by the run");
		expect(readRoomStamp(room.doc)).toEqual({
			version: 8,
			contentHash: hashOf(BODY_B),
		});
		expect(editorBody(follower)).toContain("rewritten by the run");
		expect(saveButton(follower)).toBeDisabled();

		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual({
				version: 7,
				contentHash: hashOf(BODY_A),
			});
		});
		const held = await roomBody();
		expect(occurrences(held, "Phase one, then two.")).toBe(1);
		expect(held).not.toContain("rewritten by the run");
		expect(unstamped).toEqual([]);
		await waitFor(() => {
			expect(editorBody(follower)).toContain("Phase one, then two.");
		});

		await nudge(starter, follower);
		await settle(700);
		expect(saveButton(follower)).toBeDisabled();
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_A);
	});

	it("a Reject the server rewinds to a body other than the one the editor remembered ends the room on the server's body, under its stamp, and nothing writes the remembered one", async () => {
		harness.autosave.delayMs = 300;
		const BODY_C =
			"## Scope\n\nPhase one, then two, as saved before the run.\n\n## Pricing\n\nA fixed fee.";
		const { starter, follower } = await reviewWithFollower({
			content: BODY_C,
			version: 7,
		});
		await clickReject(starter);

		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual({
				version: 7,
				contentHash: hashOf(BODY_C),
			});
		});
		expect(await roomBody()).toContain("as saved before the run");
		await waitFor(() => {
			expect(editorBody(starter)).toContain("as saved before the run");
			expect(editorBody(follower)).toContain("as saved before the run");
		});

		await nudge(starter, follower);
		await settle(700);
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_C);
		expect(server.version).toBe(7);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
	});

	it("a Reject's answer leaves the room alone when a colleague's save moved it after the rewind: the colleague's body stays, under its stamp", async () => {
		const BODY_C =
			"## Scope\n\nPhase one, saved by a colleague after the rewind.\n\n## Pricing\n\nA fixed fee.";
		const { starter, follower } = await reviewWithFollower({
			content: BODY_A,
			version: 7,
		});
		// Only the answer may move the room here, not a later look at it.
		harness.timings.observationGapMs = 5000;
		server.holdAnswers = true;
		await clickReject(starter);
		expect(server.held).toHaveLength(1);
		expect(server.content).toBe(BODY_A);

		// The rewind is done; a colleague's save lands before its answer,
		// and the colleague's editor puts it into the room with its stamp.
		server.content = BODY_C;
		server.version = 8;
		await act(async () => {
			await persistRoom(BODY_C, savedStamp());
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(editorBody(starter)).toContain("saved by a colleague");
		});

		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(100);

		expect(readRoomStamp(room.doc)).toEqual({
			version: 8,
			contentHash: hashOf(BODY_C),
		});
		const held = await roomBody();
		expect(occurrences(held, "saved by a colleague")).toBe(1);
		expect(held).not.toContain("Phase one, then two.");
		expect(editorBody(starter)).toContain("saved by a colleague");
		expect(editorBody(follower)).toContain("saved by a colleague");
		expect(starter.awareness.own[ROOM_SAVE_AWARENESS_FIELD]).toBeNull();
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_C);
	});

	it("a Reject the server refuses as stale leaves the room to the stale rule: it ends on the newer saved body, and a colleague's unsaved typing is offered back", async () => {
		const BODY_C =
			"## Scope\n\nPhase one, written outside the room.\n\n## Pricing\n\nA fixed fee.";
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		server.beforeRun = { content: BODY_A, version: 7 };
		await runEndsOnBody(starter, follower);
		await waitFor(() => {
			expect(editorBody(follower)).toContain("rewritten by the run");
		});
		await settle(200);
		harness.autosave.delayMs = 60_000;
		await type(follower, " Typed by the follower.");
		// A write from outside the room that nobody announced yet.
		server.content = BODY_C;
		server.version = 8;
		server.rejectError = Object.assign(new Error("stale"), {
			code: "CONFLICT",
			data: { code: "REJECT_REVIEW_STALE" },
		});

		await clickReject(starter);
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("rejectReviewStale");
		});
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual({
					version: 8,
					contentHash: hashOf(BODY_C),
				});
			},
			{ timeout: 3000 },
		);
		await settle(200);
		expect(offerBackCalls()).toHaveLength(1);
		const held = await roomBody();
		expect(occurrences(held, "written outside the room")).toBe(1);
		expect(held).not.toContain("rewritten by the run");
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_C);
	});

	it("a review a newer saved body superseded closes in the room without writing anything: the stale rule brings the room to the newer body", async () => {
		const BODY_C =
			"## Scope\n\nPhase one, rewritten by a second run.\n\n## Pricing\n\nA fixed fee.";
		const { starter, follower } = await reviewWithFollower({
			content: BODY_A,
			version: 7,
		});
		const unstamped = watchUnstampedBodyWrites();

		server.content = BODY_C;
		server.version = 9;
		await nudge(starter, follower);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).toBeNull();
		});
		expect(toast.info).toHaveBeenCalledWith("reviewSuperseded");
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual({
					version: 9,
					contentHash: hashOf(BODY_C),
				});
			},
			{ timeout: 3000 },
		);
		await settle(100);
		expect(occurrences(await roomBody(), "rewritten by a second run")).toBe(
			1,
		);
		expect(editorBody(starter)).toContain("rewritten by a second run");
		expect(editorBody(follower)).toContain("rewritten by a second run");
		expect(unstamped).toEqual([]);
		expect(saveCalls).toEqual([]);
	});

	it("an editor mounted after the review opened leaves a room that already holds the reviewed body, and a colleague's typing on it, alone", async () => {
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		await startRunFromChat(starter);
		server.status = "GENERATING";
		await nudge(starter, follower);
		await settle(30);

		// The starter's room drops before the run ends: no editor of its
		// is on screen when its review opens.
		starter.synced = false;
		rerender(starter);
		await settle(20);
		expect(mainEditor(starter)).toBeNull();
		server.content = BODY_B;
		server.status = "COMPLETE";
		await nudge(starter, follower);
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(follower)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		await settle(200);
		harness.autosave.delayMs = 60_000;
		await type(follower, " Typed by the follower.");

		// The starter's room is back while its review is open.
		starter.synced = true;
		rerender(starter);
		await waitFor(() => {
			expect(mainEditor(starter)).not.toBeNull();
		});
		await settle(100);

		expect(
			starter.view?.queryByTestId("regeneration-confirm-modal"),
		).not.toBeNull();
		expect(editorBody(starter)).toContain("Typed by the follower.");
		expect(editorBody(follower)).toContain("Typed by the follower.");
		const held = await roomBody();
		expect(occurrences(held, "rewritten by the run")).toBe(1);
		expect(held).toContain("Typed by the follower.");
		expect(saveCalls).toEqual([]);
	});

	describe("what a tab shows between learning of a run's end and the room holding its body", () => {
		/** Production waits: a second look takes a poll, a claim seconds. */
		const PRODUCTION_TIMINGS = {
			observationGapMs: 3000,
			savedBodyGraceMs: 750,
			claimSettleMs: 1500,
			fallThroughMs: 10_000,
		};
		const FAKE_CLOCK = {
			toFake: ["setTimeout", "clearTimeout", "Date"],
		} as const;
		const BODY_C =
			"## Scope\n\nPhase one, then two, rewritten by a later run.\n\n## Pricing\n\nA fixed fee per phase.";

		/** Which body a text is: before the run, the run's, a later run's. */
		function bodyMarker(text: string): string {
			if (text.includes("rewritten by a later run")) {
				return "later";
			}
			if (text.includes("rewritten by the run")) {
				return "run";
			}
			if (text.includes("Phase one, then two.")) {
				return "before";
			}
			return text.trim() ? "other" : "empty";
		}

		type Sample = {
			at: number;
			tab: string;
			body: string;
			savedView: boolean;
			editable: boolean;
			saveOff: boolean;
			/** The saved body's editor is built, hidden, ahead of showing. */
			savedBodyReady: boolean;
		};

		function describeSample(sample: Sample): string {
			const how = sample.savedView
				? "saved body"
				: sample.editable
					? "editable"
					: "read-only";
			return `${sample.at} ms ${sample.tab}: ${sample.body}, ${how}, Save ${sample.saveOff ? "off" : "on"}`;
		}

		// The view's queries search the whole page, which holds every tab:
		// these look in one tab's own part of it.
		function drawsSavedBody(tab: Tab): boolean {
			return (
				tab.view?.container.querySelector(
					'[data-testid="room-saved-body"]',
				) != null
			);
		}
		function roomEditorHidden(tab: Tab): boolean {
			const content = [
				...(tab.view?.container.querySelectorAll(
					'[data-testid="editor-content"]',
				) ?? []),
			].find(
				(element) =>
					!element.closest('[data-testid="room-saved-body"]'),
			);
			return content?.className.includes("hidden") ?? true;
		}

		/** Steps the fake clock, noting every `stepMs` what each tab shows. */
		async function sampleShown(tabs: Tab[], untilMs: number, stepMs = 250) {
			const samples: Sample[] = [];
			for (let at = 0; at <= untilMs; at += stepMs) {
				for (const tab of tabs) {
					const savedView = drawsSavedBody(tab);
					const editorHidden = roomEditorHidden(tab);
					samples.push({
						at,
						tab: tab.name,
						body: bodyMarker(
							savedView
								? savedBodyViewText(tab)
								: editorBody(tab),
						),
						savedView,
						editable:
							!editorHidden &&
							mainEditor(tab)?.isEditable === true,
						saveOff: saveButton(tab).hasAttribute("disabled"),
						savedBodyReady:
							tab.view?.container.querySelector(
								'[data-testid="room-saved-body-ready"]',
							) != null,
					});
				}
				await act(async () => {
					await vi.advanceTimersByTimeAsync(stepMs);
				});
			}
			return samples;
		}

		/**
		 * The moments a tab showed another body than the run's other than as
		 * allowed: the body from before, read-only with Save off, within the
		 * grace.
		 */
		function otherThanTheRuns(samples: Sample[], body: string): string[] {
			return samples
				.filter(
					(sample) =>
						sample.body !== body &&
						(sample.at > PRODUCTION_TIMINGS.savedBodyGraceMs ||
							sample.editable ||
							sample.savedView ||
							!sample.saveOff),
				)
				.map(describeSample);
		}

		/** Steps the fake clock until `done`, at most `maxMs`. */
		async function stepUntil(done: () => boolean, maxMs = 20_000) {
			for (let at = 0; at <= maxMs; at += 100) {
				if (done()) {
					return true;
				}
				await act(async () => {
					await vi.advanceTimersByTimeAsync(100);
				});
			}
			return done();
		}

		/** The room holds the saved body under its stamp, and the tabs show it. */
		function convergedOn(tabs: Tab[], body: string) {
			return () =>
				readRoomStamp(room.doc)?.contentHash ===
					hashOf(server.content) &&
				tabs.every(
					(tab) =>
						!drawsSavedBody(tab) &&
						bodyMarker(editorBody(tab)) === body &&
						within(tab.syncSlot).queryByTestId("sync-pill") !==
							null,
				);
		}

		it("a passive follower that learns of a UI-started run's end a poll before its starter never shows the previous body editable: it holds it still, then shows the run's saved body until the starter's review puts it into the room", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			const starter = await openTab("starter", { clientId: 20 });
			const follower = await openTab("follower", {
				clientId: 30,
				attachToServerRun: true,
			});
			await startRunFromChat(starter);
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(starter, follower);
			await settle(30);
			expect(starter.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
				"started",
			);
			expect(follower.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
				"attached",
			);

			vi.useFakeTimers(FAKE_CLOCK);
			// The run's final save. The follower's poll lands just after it,
			// the starter's a poll later.
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(follower);
			const meanwhile = await sampleShown([follower], 2750);
			await nudge(starter);
			const converged = await stepUntil(
				convergedOn([starter, follower], "run"),
			);
			vi.useRealTimers();

			expect(otherThanTheRuns(meanwhile, "run")).toEqual([]);
			expect(meanwhile.some((sample) => sample.savedView)).toBe(true);
			// The starter's review put the body in, once; no claim, no save.
			expect(converged).toBe(true);
			expect(readConvergenceClaim(room.doc)).toBeNull();
			expect(occurrences(await roomBody(), "rewritten by the run")).toBe(
				1,
			);
			expect(saveCalls).toEqual([]);
		});

		it("a run no open tab follows: every tab holds the previous body still, then shows the run's saved body until the room is brought to it", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			// Not on the artifact page: neither tab attaches to the run.
			const one = await openTab("one", { clientId: 20 });
			const two = await openTab("two", { clientId: 30 });
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(one, two);
			await settle(30);

			vi.useFakeTimers(FAKE_CLOCK);
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(one, two);
			const meanwhile = await sampleShown([one, two], 6000);
			const converged = await stepUntil(convergedOn([one, two], "run"));
			vi.useRealTimers();

			expect(otherThanTheRuns(meanwhile, "run")).toEqual([]);
			expect(meanwhile.some((sample) => sample.savedView)).toBe(true);
			// The fallback brought the room to the saved body: one claim, the
			// body once, no save.
			expect(converged).toBe(true);
			expect(readConvergenceClaim(room.doc)?.settled).toBe("verified");
			expect(occurrences(await roomBody(), "rewritten by the run")).toBe(
				1,
			);
			expect(saveCalls).toEqual([]);
		});

		it("a tab alone with the review of an earlier run that learns of a newer run only from its end holds the reviewed body still, then shows the newer run's saved body", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("alone", { attachToServerRun: true });
			server.generationStartedAt = new Date().toISOString();
			await startRunFromChat(tab);
			server.status = "GENERATING";
			await nudge(tab);
			await settle(30);
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(tab);
			await waitFor(() => {
				expect(
					tab.view?.queryByTestId("regeneration-confirm-modal"),
				).not.toBeNull();
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			});
			await settle(100);

			vi.useFakeTimers(FAKE_CLOCK);
			// A later run started elsewhere: this tab hears of it only as it
			// ends.
			server.generationStartedAt = new Date(
				Date.now() + 60_000,
			).toISOString();
			server.content = BODY_C;
			server.status = "COMPLETE";
			await nudge(tab);
			const meanwhile = await sampleShown([tab], 6000);
			const converged = await stepUntil(convergedOn([tab], "later"));
			vi.useRealTimers();

			expect(otherThanTheRuns(meanwhile, "later")).toEqual([]);
			expect(meanwhile.some((sample) => sample.savedView)).toBe(true);
			expect(converged).toBe(true);
			expect(
				tab.view?.queryByTestId("regeneration-confirm-modal"),
			).toBeNull();
			expect(
				occurrences(await roomBody(), "rewritten by a later run"),
			).toBe(1);
			expect(saveCalls).toEqual([]);
		});

		it("the run's saved body is drawn with its text from the first frame it is shown in", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			const one = await openTab("one", { clientId: 20 });
			const two = await openTab("two", { clientId: 30 });
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(one, two);
			await settle(30);

			vi.useFakeTimers(FAKE_CLOCK);
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(one, two);
			const meanwhile = await sampleShown([one, two], 1500);
			vi.useRealTimers();

			expect(meanwhile.some((sample) => sample.savedView)).toBe(true);
			expect(harness.blankSavedBodyFrames).toEqual([]);
		});

		it("tabs opened while the run is under way hold the previous body still at its end, then show the run's saved body", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			// Neither tab saw the room before the run.
			const one = await openTab("one", { clientId: 20 });
			const two = await openTab("two", { clientId: 30 });
			await settle(30);

			vi.useFakeTimers(FAKE_CLOCK);
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(one, two);
			const meanwhile = await sampleShown([one, two], 3000);
			const converged = await stepUntil(convergedOn([one, two], "run"));
			vi.useRealTimers();

			expect(otherThanTheRuns(meanwhile, "run")).toEqual([]);
			expect(meanwhile.some((sample) => sample.savedView)).toBe(true);
			expect(converged).toBe(true);
			expect(occurrences(await roomBody(), "rewritten by the run")).toBe(
				1,
			);
			expect(saveCalls).toEqual([]);
		});

		it("a write outside any run — the API, an agent — leaves the second look as it was: the room's body stays on screen, editable, while saves wait", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			// The row names an earlier run, which the room took in.
			server.generationStartedAt = new Date().toISOString();
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");

			vi.useFakeTimers(FAKE_CLOCK);
			server.content = BODY_B;
			server.version = 8;
			await nudge(tab);
			const meanwhile = await sampleShown([tab], 2750);
			const converged = await stepUntil(convergedOn([tab], "run"));
			vi.useRealTimers();

			expect(
				meanwhile
					.filter(
						(sample) =>
							sample.body !== "before" ||
							!sample.editable ||
							sample.savedView ||
							!sample.saveOff,
					)
					.map(describeSample),
			).toEqual([]);
			// Nor is a hidden saved body built for a look that keeps the
			// room's body on screen (Fizzy #2946).
			expect(
				meanwhile
					.filter((sample) => sample.savedBodyReady)
					.map(describeSample),
			).toEqual([]);
			expect(converged).toBe(true);
			expect(saveCalls).toEqual([]);
		});

		it("a tab back from a drop, whose copy of the document predates a rewind the room took at the same version meanwhile, keeps the room's body: no run ended, so its older copy is never shown", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			// The row names an earlier run, and holds its body.
			server.generationStartedAt = new Date().toISOString();
			server.content = BODY_B;
			await persistRoom(BODY_B, savedStamp());
			const tab = await openTab("tab");
			expect(editorBody(tab)).toContain("rewritten by the run");

			tab.synced = false;
			rerender(tab);
			await settle(20);
			expect(mainEditor(tab)).toBeNull();
			// Meanwhile a colleague rejects that run with no version to go
			// back to: the row and the room go back to the body before it at
			// the same version, and this tab's copy is not asked again.
			server.content = BODY_A;
			await persistRoom(BODY_A, savedStamp());

			vi.useFakeTimers(FAKE_CLOCK);
			tab.synced = true;
			rerender(tab);
			const meanwhile = await sampleShown([tab], 3500);
			const converged = await stepUntil(convergedOn([tab], "before"));
			vi.useRealTimers();

			expect(
				meanwhile
					.filter((sample) => sample.body !== "before")
					.map(describeSample),
			).toEqual([]);
			expect(converged).toBe(true);
			expect(saveCalls).toEqual([]);
		});

		it("a tab back from a drop after a run ended while it was away holds the previous body still: with nothing to tell a run's end from a rewind, it waits read-only for the second look", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");

			tab.synced = false;
			rerender(tab);
			await settle(20);
			expect(mainEditor(tab)).toBeNull();
			// A run starts and ends while the room is away; the tab's copy of
			// the document hears of it.
			server.generationStartedAt = new Date().toISOString();
			server.content = BODY_B;
			await nudge(tab);

			vi.useFakeTimers(FAKE_CLOCK);
			tab.synced = true;
			rerender(tab);
			const meanwhile = await sampleShown([tab], 2750);
			const converged = await stepUntil(convergedOn([tab], "run"));
			vi.useRealTimers();

			expect(
				meanwhile
					.filter(
						(sample) =>
							sample.body !== "run" &&
							(sample.editable || !sample.saveOff),
					)
					.map(describeSample),
			).toEqual([]);
			expect(converged).toBe(true);
			expect(occurrences(await roomBody(), "rewritten by the run")).toBe(
				1,
			);
			expect(saveCalls).toEqual([]);
		});

		it("the raw markdown view holds still too, and shows the run's saved body with the rich view", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			// Opened before the run: the views do not switch while it writes.
			await toggleRawView();
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(tab);
			await settle(30);
			expect(rawTextarea(tab).value).toContain("Phase one, then two.");

			vi.useFakeTimers(FAKE_CLOCK);
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(tab);
			const meanwhile: string[] = [];
			for (let at = 0; at <= 2750; at += 250) {
				const area = rawTextarea(tab);
				meanwhile.push(
					`${at} ms: ${bodyMarker(area.value)}, ${area.disabled ? "read-only" : "editable"}`,
				);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(250);
				});
			}
			const converged = await stepUntil(
				() =>
					readRoomStamp(room.doc)?.contentHash === hashOf(BODY_B) &&
					!rawTextarea(tab).disabled,
			);
			vi.useRealTimers();

			expect(
				meanwhile.filter(
					(sample) =>
						sample.endsWith("editable") ||
						(!sample.includes(": run,") &&
							Number(sample.split(" ")[0]) >
								PRODUCTION_TIMINGS.savedBodyGraceMs),
				),
			).toEqual([]);
			expect(meanwhile.some((sample) => sample.includes(": run,"))).toBe(
				true,
			);
			expect(converged).toBe(true);
			expect(rawTextarea(tab).value).toContain("rewritten by the run");
			expect(saveCalls).toEqual([]);
		});

		/**
		 * What a tab's raw view shows, every `stepMs`, until `untilMs`, and
		 * which body the room holds meanwhile.
		 */
		async function sampleRawView(tab: Tab, untilMs: number, stepMs = 250) {
			const samples: string[] = [];
			for (let at = 0; at <= untilMs; at += stepMs) {
				const area = rawTextarea(tab);
				samples.push(
					`${at} ms: ${bodyMarker(area.value)}, ${area.disabled ? "read-only" : "editable"}, room ${readRoomStamp(room.doc)?.contentHash === hashOf(BODY_B) ? "run" : "before"}`,
				);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(stepMs);
				});
			}
			return samples;
		}

		it("a raw view open while a run is under way takes no input, and shows the run's body once the starter's review puts it into the room: never the previous body editable", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			// Opened first, so the shortcut opens the raw view in this tab only.
			const viewer = await openTab("viewer", { clientId: 30 });
			await toggleRawView();
			expect(rawTextarea(viewer).value).toContain("Phase one, then two.");
			const starter = await openTab("starter", { clientId: 20 });

			await startRunFromChat(starter);
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(starter, viewer);
			await settle(30);

			vi.useFakeTimers(FAKE_CLOCK);
			const during = await sampleRawView(viewer, 1000);
			// The run's final save; the viewer's poll lands a poll after the
			// starter's.
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(starter);
			const meanwhile = await sampleRawView(viewer, 2750);
			await nudge(viewer);
			const after = await sampleRawView(viewer, 3000);
			const converged = await stepUntil(
				() =>
					readRoomStamp(room.doc)?.contentHash === hashOf(BODY_B) &&
					!rawTextarea(viewer).disabled,
			);
			vi.useRealTimers();

			expect(
				[...during, ...meanwhile, ...after].filter((sample) =>
					sample.includes(": before, editable"),
				),
			).toEqual([]);
			expect(during.every((sample) => sample.includes("read-only"))).toBe(
				true,
			);
			// Once the room holds the run's body, the raw view shows it. The
			// first look is taken in the tick the room took it in, before the
			// tab has rendered.
			expect(
				[...meanwhile.slice(1), ...after].filter(
					(sample) =>
						sample.endsWith("room run") &&
						!sample.includes(": run,"),
				),
			).toEqual([]);
			expect(converged).toBe(true);
			expect(rawTextarea(viewer).value).toContain("rewritten by the run");
			expect(occurrences(await roomBody(), "rewritten by the run")).toBe(
				1,
			);
			expect(saveCalls).toEqual([]);
		});

		it("the raw view of the editor that writes an attached run's body itself shows that body when the run ends", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			// A run started elsewhere, which this tab alone follows.
			const tab = await openTab("follower", { attachToServerRun: true });
			await toggleRawView();
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(tab);
			await settle(30);
			expect(tab.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
				"attached",
			);
			expect(rawTextarea(tab).disabled).toBe(true);

			vi.useFakeTimers(FAKE_CLOCK);
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(tab);
			const meanwhile = await sampleRawView(tab, 2750);
			vi.useRealTimers();

			expect(
				meanwhile.filter((sample) => !sample.includes(": run,")),
			).toEqual([]);
			expect(meanwhile.at(-1)).toMatch(/: run, editable,/);
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			expect(occurrences(await roomBody(), "rewritten by the run")).toBe(
				1,
			);
			expect(saveCalls).toEqual([]);
		});
	});
});

describe("a tab that typed nothing in a room (Fizzy #2946)", () => {
	it("stays saved and never autosaves while a colleague types into the room", async () => {
		harness.autosave.delayMs = 300;
		await persistRoom(BODY_A, savedStamp());
		const typist = await openTab("typist", { clientId: 10 });
		const watcher = await openTab("watcher", { clientId: 20 });

		await type(typist, " Typed by a colleague.");
		await waitFor(() => {
			expect(editorBody(watcher)).toContain("Typed by a colleague.");
		});
		await settle(50);
		expect(saveButton(watcher)).toBeDisabled();

		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		await settle(700);
		expect(saveCalls.map((call) => call.tab)).toEqual(["typist"]);
		expect(saveButton(watcher)).toBeDisabled();
	});

	it("counts an edit in the raw view as typing: a saved body the room brings in does not replace it", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await toggleRawView();
		const edited = `${rawTextarea(tab).value}\n\nEdited in the raw view.`;
		await act(async () => {
			fireEvent.change(rawTextarea(tab), { target: { value: edited } });
		});
		await settle(50);
		expect(saveButton(tab)).not.toBeDisabled();

		// The saved document's unannounced version step, which an editor
		// with nothing typed takes as its saved body.
		server.version = 8;
		await nudge(tab);
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		await settle(100);

		expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
		expect(saveButton(tab)).not.toBeDisabled();
	});

	it("offers back the raw view's edits when the room is brought to a newer saved body, and keeps them there, unsaved", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await toggleRawView();
		const edited = `${rawTextarea(tab).value}\n\nEdited in the raw view.`;
		await act(async () => {
			fireEvent.change(rawTextarea(tab), { target: { value: edited } });
		});
		await settle(50);

		// A write from outside the room: the room is behind it.
		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			},
			{ timeout: 3000 },
		);
		await settle(100);

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
			expect.stringContaining("Edited in the raw view."),
		);
		expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
		expect(saveButton(tab)).not.toBeDisabled();
		expect(await roomBody()).toContain("rewritten by the run");
		expect(saveCalls).toEqual([]);
	});

	it("a raw view with no edits of its own shows a colleague's typing as it reaches the room, and stays saved", async () => {
		await persistRoom(BODY_A, savedStamp());
		// Opened first, so the shortcut opens the raw view in this tab only.
		const watcher = await openTab("watcher", { clientId: 20 });
		await toggleRawView();
		const typist = await openTab("typist", { clientId: 10 });

		await type(typist, " Typed by a colleague.");
		await waitFor(() => {
			expect(rawTextarea(watcher).value).toContain(
				"Typed by a colleague.",
			);
		});
		expect(rawTextarea(watcher).disabled).toBe(false);
		await settle(200);
		expect(saveButton(watcher)).toBeDisabled();
		expect(saveCalls.filter((call) => call.tab === "watcher")).toEqual([]);
	});

	it("a raw view someone is reading keeps the caret in its place in the text while a colleague's typing reaches it", async () => {
		await persistRoom(BODY_A, savedStamp());
		const watcher = await openTab("watcher", { clientId: 20 });
		await toggleRawView();
		const typist = await openTab("typist", { clientId: 10 });
		const area = rawTextarea(watcher);
		const at = area.value.indexOf("A fixed fee");
		act(() => {
			area.focus();
			area.setSelectionRange(at, at + "A fixed".length);
		});

		// Typed after the caret: the caret stays where it is.
		await type(typist, " Typed by a colleague.");
		await waitFor(() => {
			expect(rawTextarea(watcher).value).toContain(
				"Typed by a colleague.",
			);
		});
		expect(rawTextarea(watcher).selectionStart).toBe(at);
		expect(rawTextarea(watcher).selectionEnd).toBe(at + "A fixed".length);

		// Typed before it: the caret moves with the text after it.
		const typistEditor = mainEditor(typist) as Editor;
		await act(async () => {
			// At the start of the paragraph after the first heading.
			const first = typistEditor.state.doc.firstChild;
			typistEditor.commands.insertContentAt(
				(first?.nodeSize ?? 0) + 1,
				"Added ",
			);
		});
		await waitFor(() => {
			expect(rawTextarea(watcher).value).toContain("Added ");
		});
		const moved = rawTextarea(watcher).value.indexOf("A fixed fee");
		expect(moved).toBeGreaterThan(at);
		expect(rawTextarea(watcher).selectionStart).toBe(moved);
		expect(rawTextarea(watcher).selectionEnd).toBe(
			moved + "A fixed".length,
		);
	});

	it("a raw view with edits of its own keeps them as they are while a colleague's typing reaches the room", async () => {
		await persistRoom(BODY_A, savedStamp());
		const watcher = await openTab("watcher", { clientId: 20 });
		await toggleRawView();
		const edited = `${rawTextarea(watcher).value}\n\nEdited in the raw view.`;
		await act(async () => {
			fireEvent.change(rawTextarea(watcher), {
				target: { value: edited },
			});
		});
		const typist = await openTab("typist", { clientId: 10 });

		await type(typist, " Typed by a colleague.");
		await waitFor(() => {
			expect(editorBody(watcher)).toContain("Typed by a colleague.");
		});
		await settle(200);

		expect(rawTextarea(watcher).value).toBe(edited);
		expect(saveButton(watcher)).not.toBeDisabled();
	});

	it("a trip to the raw view and back with no edit is no typing: a colleague's text stays theirs to save", async () => {
		harness.autosave.delayMs = 300;
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		// A colleague's typing reaches the room; their editor saves it.
		await act(async () => {
			await persistRoom(`${BODY_A} Typed by a colleague.`, null);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(editorBody(tab)).toContain("Typed by a colleague.");
		});

		await toggleRawView();
		expect(rawTextarea(tab).value).toContain("Typed by a colleague.");
		await toggleRawView();
		expect(editorBody(tab)).toContain("Typed by a colleague.");
		await settle(700);

		expect(saveButton(tab)).toBeDisabled();
		expect(saveCalls).toEqual([]);
		expect(await roomBody()).toContain("Typed by a colleague.");
	});

	it("the single-user editor still autosaves its typing", async () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		harness.autosave.delayMs = 300;
		const tab = await openTab("solo");
		await type(tab, " Typed alone.");
		expect(saveButton(tab)).not.toBeDisabled();

		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]?.content).toContain("Typed alone.");
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
		// Room for a look at the screen before the second observation, and
		// while the room is replaced.
		harness.timings.observationGapMs = 400;
		harness.timings.claimSettleMs = 300;

		const tab = await openTab("member");
		// The first look only checks: the editor stays on screen, and saves
		// wait.
		expect(showsSavedBody(tab)).toBe(false);
		expect(roomEditorContent(tab)?.className).not.toContain("hidden");
		expect(within(tab.syncSlot).getByText("updating")).toBeInTheDocument();
		// Once the room is being brought up, the saved body is what shows.
		await waitFor(
			() => {
				expect(showsSavedBody(tab)).toBe(true);
			},
			{ timeout: 3000 },
		);
		expect(savedBodyViewText(tab)).toContain("rewritten by the run");
		expect(roomEditorContent(tab)?.className).toContain("hidden");

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

	it("keeps typing unsaved when the save in flight across a short drop fails after the room is back: the save's optimistic body is no saved baseline", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " Typed before the drop.");
		// The autosave goes out, and its answer is slow.
		server.failNext = new Error("Service unavailable");
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});

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

		// Only now does the save answer, with a failure: nothing was written.
		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"failed",
				SAVE_FAILED_TOAST,
			);
		});
		expect(server.content).toBe(BODY_A);
		await waitFor(() => {
			expect(saveButton(tab)).toHaveAccessibleName("Save document");
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		vi.useRealTimers();
		expect(saveCalls[1]?.content).toContain("Typed before the drop.");
		await waitFor(() => {
			expect(server.content).toContain("Typed before the drop.");
		});
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
			expect(toast.error).toHaveBeenCalledWith(
				"failed",
				SAVE_FAILED_TOAST,
			);
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

/** The editor's own undo, as Cmd+Z runs it. */
async function undo(tab: Tab) {
	await act(async () => {
		mainEditor(tab)?.commands.undo();
	});
	await settle(220);
}

/**
 * In a room the editor's undo goes through the room's undo manager, which
 * the binding applies as it applies a colleague's change; it is still this
 * person's edit, and is saved like typing (Fizzy #2946).
 */
describe("an undo in the editor (Fizzy #2946)", () => {
	it("in a room, of an edit whose save has landed, is saved like typing: the server ends on the body before the edit", async () => {
		harness.autosave.delayMs = 300;
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await settle(200);
		await type(tab, " First edit.");
		await waitFor(
			() => {
				expect(server.content).toContain("First edit.");
			},
			{ timeout: 3000 },
		);
		await settle(100);

		await undo(tab);
		expect(editorBody(tab)).not.toContain("First edit.");
		await waitFor(
			() => {
				expect(saveCalls).toHaveLength(2);
			},
			{ timeout: 3000 },
		);
		expect(saveCalls[1]?.content).not.toContain("First edit.");
		expect(server.content).not.toContain("First edit.");
		expect(server.content).toContain("Phase one, then two.");
	});

	it("in the single-user editor, of an edit whose save has landed, is saved as before", async () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		harness.autosave.delayMs = 300;
		const tab = await openTab("solo");
		await settle(200);
		await type(tab, " First edit.");
		await waitFor(
			() => {
				expect(server.content).toContain("First edit.");
			},
			{ timeout: 3000 },
		);
		await settle(100);

		await undo(tab);
		expect(editorBody(tab)).not.toContain("First edit.");
		await waitFor(
			() => {
				expect(saveCalls).toHaveLength(2);
			},
			{ timeout: 3000 },
		);
		expect(server.content).not.toContain("First edit.");
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

	it("whose save has landed, undone with the editor's undo, is saved back to the body before it", async () => {
		harness.autosave.delayMs = 300;
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await settle(200);
		await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
		await waitFor(() => {
			expect(server.content).toContain("An accepted paragraph.");
		});
		await settle(100);

		await undo(tab);
		expect(editorBody(tab)).not.toContain("An accepted paragraph.");
		await waitFor(
			() => {
				expect(saveCalls).toHaveLength(2);
			},
			{ timeout: 3000 },
		);
		expect(server.content).not.toContain("An accepted paragraph.");
		expect(server.content).toContain("Phase one, then two.");
	});

	it("whose save fails stays unsaved in the editor that accepted it, which saves it later", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		// The dirty check the editor scheduled while it opened has run, so
		// only the accept itself can say the accepted text is unsaved.
		await settle(200);
		server.failNext = new Error("Service unavailable");

		const respond = await acceptProposal(
			tab,
			`${BODY_A}\n\nAn accepted paragraph.`,
		);
		expect(respond).toHaveBeenCalledWith({ accepted: true });
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		await settle(300);
		expect(server.content).toBe(BODY_A);
		expect(editorBody(tab)).toContain("An accepted paragraph.");
		await waitFor(
			() => {
				expect(saveButton(tab)).toHaveAccessibleName("Save document");
				expect(saveButton(tab)).not.toBeDisabled();
			},
			{ timeout: 3000 },
		);

		await clickSave(tab);
		await waitFor(() => {
			expect(server.content).toContain("An accepted paragraph.");
		});
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
	});

	it("is saved once when the assistant goes on to its next turn while that save is in flight", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await settle(200);
		server.holdAnswers = true;

		await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
		await waitFor(() => {
			expect(server.held).toHaveLength(1);
		});
		// The assistant answers the accept and starts its next turn.
		harness.chatLoading = true;
		rerender(tab);
		await settle(50);
		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(300);

		expect(saveCalls).toHaveLength(1);
		expect(server.content).toContain("An accepted paragraph.");
	});

	it("whose save fails after the editor showed that save's optimistic answer stays unsaved past the autosave delay, and is saved on leaving the page", async () => {
		harness.autosave.delayMs = 300;
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await settle(200);
		server.failNext = new Error("Service unavailable");
		server.holdAnswers = true;

		await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
		await waitFor(() => {
			expect(server.held).toHaveLength(1);
		});
		// The editor renders the save's optimistic answer before the failure
		// arrives.
		await settle(100);
		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(server.content).toBe(BODY_A);
		await settle(500);
		expect(saveButton(tab)).toHaveAccessibleName("Save document");
		expect(saveCalls).toHaveLength(1);

		await act(async () => {
			tab.view?.unmount();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(server.content).toContain("An accepted paragraph.");
		});
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
		// The chat records it as kept in the editor, never as applied.
		expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
		expect(harness.recordOutcome).toHaveBeenCalledWith(
			UNSAVED_ACCEPT_RECORD,
		);
	});

	/**
	 * The chat is answered at once, and the assistant acknowledges the
	 * accept from that answer; what the chat records of the accepted text
	 * waits for its save to be answered, and is recorded once.
	 */
	describe("what the chat records (Fizzy #2946)", () => {
		it("records nothing until the save is answered, then a refused save once, as a failure", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			server.failNext = new Error("Service unavailable");
			server.holdAnswers = true;

			const respond = await acceptProposal(
				tab,
				`${BODY_A}\n\nAn accepted paragraph.`,
			);
			await waitFor(() => {
				expect(server.held).toHaveLength(1);
			});
			expect(respond).toHaveBeenCalledTimes(1);
			expect(respond).toHaveBeenCalledWith({ accepted: true });
			await settle(100);
			expect(harness.recordOutcome).not.toHaveBeenCalled();

			server.holdAnswers = false;
			await answerHeld();
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				FAILED_ACCEPT_RECORD,
			);
			await settle(300);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			expect(server.content).toBe(BODY_A);
			expect(respond).toHaveBeenCalledTimes(1);
		});

		it("records a save that lands once, as applied, only once it is answered", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			server.holdAnswers = true;

			await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
			await waitFor(() => {
				expect(server.held).toHaveLength(1);
			});
			await settle(100);
			expect(harness.recordOutcome).not.toHaveBeenCalled();

			server.holdAnswers = false;
			await answerHeld();
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				SAVED_ACCEPT_RECORD,
			);
			await settle(300);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			expect(server.content).toContain("An accepted paragraph.");
		});

		it("records an accept that waited for an autosave that failed, and so was never sent, once, as kept unsaved in the editor", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			vi.useFakeTimers({
				toFake: ["setTimeout", "clearTimeout"],
				shouldAdvanceTime: true,
			});
			server.failNext = new Error("Service unavailable");
			await autosaveInFlight(tab, " First edit.");

			await acceptProposal(
				tab,
				`${editorBody(tab)}\n\nAn accepted paragraph.`,
			);
			expect(harness.recordOutcome).not.toHaveBeenCalled();

			server.holdAnswers = false;
			await answerHeld();
			vi.useRealTimers();
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				UNSAVED_ACCEPT_RECORD,
			);
			await settle(300);
			expect(saveCalls).toHaveLength(1);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			expect(editorBody(tab)).toContain("An accepted paragraph.");
		});

		it("records a save refused after the page was left once, as a failure whose text was offered to copy", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			server.failNext = new Error("Service unavailable");
			server.holdAnswers = true;

			await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
			await waitFor(() => {
				expect(server.held).toHaveLength(1);
			});
			// Left within the app while the save is in flight.
			await act(async () => {
				tab.view?.unmount();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(harness.recordOutcome).not.toHaveBeenCalled();

			server.holdAnswers = false;
			await answerHeld();
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				FAILED_OFFERED_ACCEPT_RECORD,
			);
			expect(toast.error).toHaveBeenCalledWith(
				"leaveSaveFailed",
				expect.anything(),
			);
			await settle(100);
			expect(saveCalls).toHaveLength(1);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
		});

		/**
		 * An accept waiting behind an autosave when the page is left: the
		 * save on leaving carries its text, and its answer is what the accept
		 * records — never nothing, and never "in the editor".
		 */
		describe("when the page is left while it waits behind an autosave", () => {
			async function leaveWithinApp(tab: Tab) {
				await act(async () => {
					tab.view?.unmount();
					await new Promise((resolve) => setTimeout(resolve, 0));
				});
			}

			/** Answers the held autosave, and lets what waited for it go. */
			async function answerAutosave() {
				server.holdAnswers = false;
				await answerHeld();
				await act(async () => {
					await vi.advanceTimersByTimeAsync(50);
				});
				vi.useRealTimers();
			}

			/**
			 * Typing, its autosave held, and a proposal accepted behind it.
			 * Returns the editor's body from just before the proposal.
			 */
			async function acceptBehindAutosave(tab: Tab): Promise<string> {
				vi.useFakeTimers({
					toFake: ["setTimeout", "clearTimeout"],
					shouldAdvanceTime: true,
				});
				await autosaveInFlight(tab, " First edit.");
				const before = editorBody(tab);
				await acceptProposal(
					tab,
					`${before}\n\nAn accepted paragraph.`,
				);
				expect(saveCalls).toHaveLength(1);
				return before;
			}

			async function acceptBehindAutosaveThenLeave(tab: Tab) {
				await acceptBehindAutosave(tab);
				await leaveWithinApp(tab);
				expect(harness.recordOutcome).not.toHaveBeenCalled();
			}

			/** The person edits the editor back to `markdown`, as by undo. */
			async function editBackTo(tab: Tab, markdown: string) {
				await act(async () => {
					mainEditor(tab)?.commands.setContent(
						fromMarkdown(markdown),
					);
				});
				await settle(220);
				expect(editorBody(tab).trim()).toBe(markdown.trim());
			}

			/** The confirm resolves, and the assistant proposes again. */
			async function acceptAgain(tab: Tab): Promise<string> {
				const first = editorBody(tab);
				await act(async () => {
					tab.actions
						.get("confirm_changes")
						?.renderAndWaitForResponse({
							args: {},
							respond: vi.fn(),
							status: "complete",
						});
				});
				await acceptProposal(
					tab,
					`${first}\n\nA second accepted paragraph.`,
				);
				expect(saveCalls).toHaveLength(1);
				return first;
			}

			function savesCarryingTheAccept() {
				return saveCalls.filter((call) =>
					String(call.content).includes("An accepted paragraph."),
				);
			}

			it("undone back to the saved body before leaving, is never saved: the server ends on that body, and the accept records once that it was undone", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await acceptBehindAutosave(tab);
				await editBackTo(tab, BODY_A);
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				await settle(100);
				expect(savesCarryingTheAccept()).toEqual([]);
				expect(server.content).toContain("Phase one, then two.");
				expect(server.content).not.toContain("First edit.");
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					UNDONE_ACCEPT_RECORD,
				);
			});

			it("undone back to the body it was accepted over before leaving, is never saved, and records once that it was undone", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				const before = await acceptBehindAutosave(tab);
				await editBackTo(tab, before);
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				await settle(100);
				expect(savesCarryingTheAccept()).toEqual([]);
				expect(server.content).toContain("First edit.");
				expect(server.content).not.toContain("An accepted paragraph.");
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					UNDONE_ACCEPT_RECORD,
				);
			});

			it("typed on after the accept before leaving, goes in the save on leaving with that typing, and records its answer once", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await acceptBehindAutosave(tab);
				await type(tab, " Typed after the accept.");
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).toContain(
					"An accepted paragraph.",
				);
				expect(saveCalls[1]?.content).toContain(
					"Typed after the accept.",
				);
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				});
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					SAVED_ACCEPT_RECORD,
				);
				expect(server.content).toContain("Typed after the accept.");
			});

			it("whose own save is in flight, undone with the editor's undo before leaving: the server ends on the body before it, and it records once that it was undone", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await settle(200);
				server.holdAnswers = true;
				await acceptProposal(
					tab,
					`${BODY_A}\n\nAn accepted paragraph.`,
				);
				await waitFor(() => {
					expect(server.held).toHaveLength(1);
				});
				await undo(tab);
				expect(editorBody(tab)).not.toContain("An accepted paragraph.");
				await leaveWithinApp(tab);

				server.holdAnswers = false;
				await answerHeld();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				await settle(100);
				expect(saveCalls[1]?.content).not.toContain(
					"An accepted paragraph.",
				);
				expect(server.content).not.toContain("An accepted paragraph.");
				expect(server.content).toContain("Phase one, then two.");
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					UNDONE_ACCEPT_RECORD,
				);
			});

			it("whose own save is in flight, undone back to the saved body before leaving: the server ends on that body, and it records once that it was undone, never that it was applied", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await settle(200);
				server.holdAnswers = true;
				await acceptProposal(
					tab,
					`${BODY_A}\n\nAn accepted paragraph.`,
				);
				await waitFor(() => {
					expect(server.held).toHaveLength(1);
				});
				await editBackTo(tab, BODY_A);
				await leaveWithinApp(tab);

				server.holdAnswers = false;
				await answerHeld();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				await settle(100);
				expect(saveCalls[1]?.content).not.toContain(
					"An accepted paragraph.",
				);
				expect(server.content).not.toContain("An accepted paragraph.");
				expect(server.content).toContain("Phase one, then two.");
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					UNDONE_ACCEPT_RECORD,
				);
			});

			it("of two accepts waiting behind an autosave, the second undone back to the first's text before leaving: the first records its answer and the second that it was undone, under their own keys", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await acceptBehindAutosave(tab);
				const first = await acceptAgain(tab);
				await editBackTo(tab, first);
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).toContain(
					"An accepted paragraph.",
				);
				expect(saveCalls[1]?.content).not.toContain(
					"A second accepted paragraph.",
				);
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(2);
				});
				expect(harness.recordOutcome).toHaveBeenNthCalledWith(
					1,
					UNDONE_ACCEPT_RECORD,
				);
				expect(harness.recordOutcome).toHaveBeenNthCalledWith(
					2,
					SAVED_ACCEPT_RECORD,
				);
				const [undoneKey, savedKey] =
					harness.recordOutcome.mock.calls.map(
						(call) => call[0].operationKey,
					);
				expect(undoneKey).not.toBe(savedKey);
				expect(server.content).toContain("An accepted paragraph.");
				expect(server.content).not.toContain(
					"A second accepted paragraph.",
				);
			});

			it("that put the saved body back is carried by the save on leaving, and records that it was applied", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				vi.useFakeTimers({
					toFake: ["setTimeout", "clearTimeout"],
					shouldAdvanceTime: true,
				});
				await autosaveInFlight(tab, " First edit.");
				// The proposal is the saved body: it takes the typing back out.
				await acceptProposal(tab, BODY_A);
				expect(editorBody(tab).trim()).toBe(BODY_A.trim());
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).not.toContain("First edit.");
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				});
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					SAVED_ACCEPT_RECORD,
				);
				expect(server.content).not.toContain("First edit.");
			});

			it("in the single-user editor, of two accepts waiting behind an autosave, the second undone back to the first's text before it was closed: the server ends on the first's text, the first records its answer and the second that it was undone", async () => {
				vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
				const tab = await openTab("solo");
				await settle(200);
				await acceptBehindAutosave(tab);
				const first = await acceptAgain(tab);
				await editBackTo(tab, first);
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).not.toContain(
					"A second accepted paragraph.",
				);
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(2);
				});
				expect(harness.recordOutcome).toHaveBeenNthCalledWith(
					1,
					UNDONE_ACCEPT_RECORD,
				);
				expect(harness.recordOutcome).toHaveBeenNthCalledWith(
					2,
					SAVED_ACCEPT_RECORD,
				);
				expect(server.content).toContain("An accepted paragraph.");
				expect(server.content).not.toContain(
					"A second accepted paragraph.",
				);
			});

			it("in the single-user editor, undone back to the saved body — past the edit its autosave carries — before it was closed: the server ends on the saved body, and it records once that it was undone", async () => {
				vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
				const tab = await openTab("solo");
				await settle(200);
				await acceptBehindAutosave(tab);
				await editBackTo(tab, BODY_A);
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				await settle(100);
				expect(savesCarryingTheAccept()).toEqual([]);
				expect(server.content).not.toContain("First edit.");
				expect(server.content).toContain("Phase one, then two.");
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					UNDONE_ACCEPT_RECORD,
				);
			});

			it("in a room with the room flag off, leaves an accept's waiting save to the room on leaving: the close handling outside a room does not run there", async () => {
				harness.flags = {};
				const tab = await openTab("tab");
				await settle(200);
				const before = await acceptBehindAutosave(tab);
				await editBackTo(tab, before);
				await leaveWithinApp(tab);

				await answerAutosave();
				// The waiting save goes as it always has in such a room; the
				// close handling would have dropped it.
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).toContain(
					"An accepted paragraph.",
				);
			});

			it("in the single-user editor, undone back to the body it was accepted over before it was closed, is never saved, and records once that it was undone", async () => {
				vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
				const tab = await openTab("solo");
				await settle(200);
				const before = await acceptBehindAutosave(tab);
				await editBackTo(tab, before);
				await leaveWithinApp(tab);

				await answerAutosave();
				await settle(100);
				expect(saveCalls).toHaveLength(1);
				expect(savesCarryingTheAccept()).toEqual([]);
				expect(server.content).not.toContain("An accepted paragraph.");
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					UNDONE_ACCEPT_RECORD,
				);
			});

			it("records the save on leaving once, as applied, when it lands", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await acceptBehindAutosaveThenLeave(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).toContain(
					"An accepted paragraph.",
				);
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				});
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					SAVED_ACCEPT_RECORD,
				);
				expect(server.content).toContain("An accepted paragraph.");
				await settle(100);
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});

			it("records the save on leaving once, as a failure whose text was offered to copy, when it is refused", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await acceptBehindAutosaveThenLeave(tab);
				// The autosave lands; the save on leaving is refused.
				server.failNext = new Error("Service unavailable");

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				});
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					FAILED_OFFERED_ACCEPT_RECORD,
				);
				expect(toast.error).toHaveBeenCalledWith(
					"leaveSaveFailed",
					expect.anything(),
				);
				await settle(100);
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});

			it("in the single-user editor, records an autosave refused after it was closed once, as not saved — not as still in the editor", async () => {
				vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
				const tab = await openTab("solo");
				await settle(200);
				server.failNext = new Error("Service unavailable");
				await acceptBehindAutosaveThenLeave(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				});
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					CLOSED_ACCEPT_RECORD,
				);
				await settle(100);
				expect(saveCalls).toHaveLength(1);
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});

			it("in the single-user editor, records its own save refused after it was closed once, as not saved — not as still in the editor", async () => {
				vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
				const tab = await openTab("solo");
				await settle(200);
				await acceptBehindAutosaveThenLeave(tab);
				// The autosave lands; the accept's own save then goes, and is
				// refused.
				server.failNext = new Error("Service unavailable");

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).toContain(
					"An accepted paragraph.",
				);
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				});
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					CLOSED_ACCEPT_RECORD,
				);
				await settle(100);
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
		});

		it("records an accept that a later accept displaced while both waited behind an autosave from the later one's answer, once each", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			vi.useFakeTimers({
				toFake: ["setTimeout", "clearTimeout"],
				shouldAdvanceTime: true,
			});
			await autosaveInFlight(tab, " First edit.");
			await acceptProposal(
				tab,
				`${editorBody(tab)}\n\nA first accepted paragraph.`,
			);
			// The confirm resolves, and the assistant proposes again before
			// the autosave has been answered.
			await act(async () => {
				tab.actions.get("confirm_changes")?.renderAndWaitForResponse({
					args: {},
					respond: vi.fn(),
					status: "complete",
				});
			});
			await acceptProposal(
				tab,
				`${editorBody(tab)}\n\nA second accepted paragraph.`,
			);
			expect(harness.confirmDraft).toHaveBeenCalledTimes(2);
			expect(harness.confirmDraft.mock.calls[0]?.[0]?.draftId).not.toBe(
				harness.confirmDraft.mock.calls[1]?.[0]?.draftId,
			);
			expect(saveCalls).toHaveLength(1);
			expect(harness.recordOutcome).not.toHaveBeenCalled();

			server.holdAnswers = false;
			await answerHeld();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});
			vi.useRealTimers();
			await waitFor(() => {
				expect(saveCalls).toHaveLength(2);
			});
			expect(saveCalls[1]?.content).toContain(
				"A first accepted paragraph.",
			);
			expect(saveCalls[1]?.content).toContain(
				"A second accepted paragraph.",
			);
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(2);
			});
			expect(harness.recordOutcome).toHaveBeenNthCalledWith(
				1,
				SAVED_ACCEPT_RECORD,
			);
			expect(harness.recordOutcome).toHaveBeenNthCalledWith(
				2,
				SAVED_ACCEPT_RECORD,
			);
			const [first, second] = harness.recordOutcome.mock.calls.map(
				(call) => call[0].operationKey,
			);
			expect(first).not.toBe(second);
			await settle(100);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(2);
		});

		it("records a save refused with CONFLICT after a colleague's save as the answer of the one save sent again, not as that refusal", async () => {
			await persistRoom(BODY_A, savedStamp());
			const accepting = await openTab("accepting", { clientId: 10 });
			const colleague = await openTab("colleague", { clientId: 20 });
			await settle(200);
			await type(colleague, " A colleague's edit.");
			await waitFor(() => {
				expect(editorBody(accepting)).toContain("A colleague's edit.");
			});

			// The colleague's save lands first; the accept's, sent from the
			// same base, is refused. Both answers are held.
			server.holdAnswers = true;
			await clickSave(colleague);
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			await acceptProposal(
				accepting,
				`${editorBody(accepting)}\n\nAn accepted paragraph.`,
			);
			await waitFor(() => {
				expect(saveCalls).toHaveLength(2);
			});
			expect(saveCalls[1]).toMatchObject({
				tab: "accepting",
				expectedVersion: 7,
			});
			expect(server.version).toBe(8);

			// The refusal is answered, and the save sent again is held.
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
				tab: "accepting",
				expectedVersion: 8,
			});
			await settle(100);
			expect(harness.recordOutcome).not.toHaveBeenCalled();

			server.holdAnswers = false;
			await answerHeld();
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				SAVED_ACCEPT_RECORD,
			);
			await settle(300);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			expect(server.content).toContain("An accepted paragraph.");
			expect(server.version).toBe(9);
		});

		it("records a save refused with CONFLICT that is not sent again — the room is brought back to the saved document — once, as a failure whose text was offered to copy", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			// A server write the room has not heard of yet: the room's stamp
			// did not move, so the refusal is not sent again.
			server.content = BODY_B;
			server.version = 8;

			await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				FAILED_OFFERED_ACCEPT_RECORD,
			);
			expect(saveCalls).toHaveLength(1);
			expect(server.content).toBe(BODY_B);
			// What it says is what happened: the room takes the saved body,
			// and the accepted text is offered back.
			await waitFor(
				() => {
					expect(editorBody(tab)).toContain("rewritten by the run");
					expect(offerBackCalls()).toHaveLength(1);
				},
				{ timeout: 3000 },
			);
			await settle(100);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
		});

		it("posts both an accept's record and the record of another proposal's reject made while that accept's save was in flight", async () => {
			harness.postRecords = true;
			// The reject's record is still being sent when the accept's
			// save answers.
			harness.recordOperationResult.mockImplementation(
				(input: { outcome: string }) =>
					input.outcome === "cancelled"
						? new Promise(() => {})
						: Promise.resolve({
								messageId: "message-example",
								deduplicated: false,
							}),
			);
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			server.holdAnswers = true;

			await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
			await waitFor(() => {
				expect(server.held).toHaveLength(1);
			});
			// The confirm resolves, and the assistant proposes again.
			await act(async () => {
				tab.actions.get("confirm_changes")?.renderAndWaitForResponse({
					args: {},
					respond: vi.fn(),
					status: "complete",
				});
			});
			harness.agentState = {
				document: `${BODY_A}\n\nAn accepted paragraph.\n\nA rejected paragraph.`,
			};
			rerender(tab);
			await settle(20);
			const respondToReject = vi.fn();
			let card: any;
			await act(async () => {
				card = tab.actions
					.get("confirm_changes")
					?.renderAndWaitForResponse({
						args: {},
						respond: respondToReject,
						status: "executing",
					});
				await Promise.resolve();
			});
			await settle(50);
			await act(async () => {
				card?.props.onReject();
			});
			expect(respondToReject).toHaveBeenCalledWith({ accepted: false });
			await waitFor(() => {
				expect(harness.recordOperationResult).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOperationResult).toHaveBeenCalledWith(
				expect.objectContaining({ outcome: "cancelled" }),
			);

			server.holdAnswers = false;
			await answerHeld();
			await waitFor(() => {
				expect(harness.recordOperationResult).toHaveBeenCalledTimes(2);
			});
			const [rejectRecord, acceptRecord] =
				harness.recordOperationResult.mock.calls.map((call) => call[0]);
			expect(acceptRecord).toMatchObject({
				outcome: "success",
				summary: "Changes applied.",
				operationKey: expect.any(String),
			});
			expect(acceptRecord.operationKey).not.toBe(
				rejectRecord.operationKey,
			);
		});
	});

	describe("a refused save's toast (Fizzy #2946)", () => {
		it("carries one id for the document, and the next save that lands takes it away", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			server.failNext = new Error("Service unavailable");

			await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
			await waitFor(() => {
				expect(toast.error).toHaveBeenCalledTimes(1);
			});
			expect(toast.error).toHaveBeenCalledWith(
				"failed",
				SAVE_FAILED_TOAST,
			);
			expect(toast.dismiss).not.toHaveBeenCalled();

			await waitFor(
				() => {
					expect(saveButton(tab)).toHaveAccessibleName(
						"Save document",
					);
					expect(saveButton(tab)).not.toBeDisabled();
				},
				{ timeout: 3000 },
			);
			await clickSave(tab);
			await waitFor(() => {
				expect(server.content).toContain("An accepted paragraph.");
			});
			await waitFor(() => {
				expect(toast.dismiss).toHaveBeenCalledWith(
					SAVE_FAILED_TOAST.id,
				);
			});
			expect(toast.error).toHaveBeenCalledTimes(1);
		});
	});

	/**
	 * The chat renders the card the `confirm_changes` action returns. While
	 * its tool call is executing, the card tells the editor a proposal is
	 * under review; the chat mounts a row again when a message enters the
	 * history ahead of it (an accept's operation result, a persisted reply),
	 * which brings an answered card back (Fizzy #2946).
	 */
	describe("the chat's confirm card", () => {
		const ACCEPTED = "An accepted paragraph.";

		beforeEach(() => {
			harness.autosave.delayMs = 300;
		});

		/** The card the action renders, in a root of its own, as the chat holds it. */
		function chatFor(tab: Tab) {
			let view: ReturnType<typeof render> | null = null;
			let mountKey = 0;
			const card = (
				status: "executing" | "complete",
				respond?: unknown,
			) =>
				tab.actions.get("confirm_changes")?.renderAndWaitForResponse({
					args: {},
					respond,
					status,
					result:
						status === "complete" ? { accepted: true } : undefined,
				});
			const click = async (testId: string) => {
				await act(async () => {
					fireEvent.click(
						within(view?.container as HTMLElement).getByTestId(
							testId,
						),
					);
				});
				await settle(50);
			};
			return {
				/** The tool call is executing: the card offers Confirm and Reject. */
				async open(respond: unknown) {
					await act(async () => {
						view = render(
							<Fragment key={mountKey}>
								{card("executing", respond)}
							</Fragment>,
						);
						await Promise.resolve();
					});
					await settle(50);
				},
				confirm: () => click("confirm-button"),
				reject: () => click("reject-button"),
				/** The answered tool call, rendered in place, as CopilotKit does. */
				async complete() {
					await act(async () => {
						view?.rerender(
							<Fragment key={mountKey}>
								{card("complete")}
							</Fragment>,
						);
					});
					await settle(20);
				},
				/**
				 * The same tool call mounted again, under a new key — answered,
				 * unless it is still executing.
				 */
				async remount(
					status: "executing" | "complete" = "complete",
					respond?: unknown,
				) {
					mountKey += 1;
					await act(async () => {
						view?.rerender(
							<Fragment key={mountKey}>
								{card(status, respond)}
							</Fragment>,
						);
					});
					await settle(20);
				},
				unmount() {
					view?.unmount();
				},
			};
		}

		/** The assistant proposes the body with `ACCEPTED` added. */
		async function propose(
			tab: Tab,
			proposed = `${BODY_A}\n\n${ACCEPTED}`,
		) {
			harness.agentState = { document: proposed };
			rerender(tab);
			await settle(20);
		}

		/** Selects the last paragraph's text, then deletes it and its line. */
		async function deleteLastParagraph(tab: Tab) {
			const editor = mainEditor(tab) as Editor;
			await act(async () => {
				const size = editor.state.doc.content.size;
				const last = editor.state.doc.lastChild;
				if (last) {
					editor
						.chain()
						.deleteRange({
							from: size - last.nodeSize + 1,
							to: size - 1,
						})
						.run();
				}
			});
			await settle(20);
			await act(async () => {
				const size = editor.state.doc.content.size;
				const last = editor.state.doc.lastChild;
				if (last) {
					editor
						.chain()
						.deleteRange({ from: size - last.nodeSize, to: size })
						.run();
				}
			});
			await settle(220);
		}

		/** Whether the editor holds a proposal under review. */
		function reviewOpen(tab: Tab): boolean {
			return (
				tab.view?.container.querySelector(".streaming-diff-active") !=
				null
			);
		}

		it("after an accept whose save failed, the card mounted again and Save, deleting the accepted text is saved, and the room's stamp names the body it holds", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			// The dirty check the editor scheduled while it opened has run.
			await settle(200);
			const chat = chatFor(tab);
			server.failNext = new Error("Service unavailable");
			await propose(tab);
			const respond = vi.fn();
			await chat.open(respond);
			await chat.confirm();
			expect(respond).toHaveBeenCalledWith({ accepted: true });
			await chat.complete();
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			await settle(300);
			expect(server.content).toBe(BODY_A);
			await chat.remount();
			await clickSave(tab);
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await settle(400);
			expect(saveCalls).toHaveLength(2);

			await deleteLastParagraph(tab);
			expect(editorBody(tab)).not.toContain(ACCEPTED);
			await waitFor(
				() => {
					expect(saveCalls).toHaveLength(3);
				},
				{ timeout: 3000 },
			);
			expect(server.content).not.toContain(ACCEPTED);
			await waitFor(() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			});
			expect(await roomBody()).not.toContain(ACCEPTED);
			chat.unmount();
		});

		it("after an accept whose save landed and the card mounted again, deleting the accepted text is saved", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await settle(300);
			await chat.remount();

			await deleteLastParagraph(tab);
			expect(editorBody(tab)).not.toContain(ACCEPTED);
			await waitFor(
				() => {
					expect(saveCalls).toHaveLength(2);
				},
				{ timeout: 3000 },
			);
			expect(server.content).not.toContain(ACCEPTED);
			await waitFor(() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			});
			chat.unmount();
		});

		it("in the single-user editor, after an accept whose save landed and the card mounted again, typing is autosaved", async () => {
			vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
			const tab = await openTab("solo");
			await settle(200);
			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await settle(300);
			await chat.remount();

			await type(tab, " Typed after the accept.");
			await waitFor(
				() => {
					expect(server.content).toContain("Typed after the accept.");
				},
				{ timeout: 3000 },
			);
			chat.unmount();
		});

		it("an answered card that leaves the chat keeps a newer proposal's review open", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const first = chatFor(tab);
			await propose(tab);
			await first.open(vi.fn());
			await first.confirm();
			await first.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await settle(300);

			const second = chatFor(tab);
			await propose(tab, `${server.content}\n\nA second paragraph.`);
			await second.open(vi.fn());
			expect(reviewOpen(tab)).toBe(true);

			await act(async () => {
				first.unmount();
			});
			await settle(50);
			expect(reviewOpen(tab)).toBe(true);
			second.unmount();
		});

		it("records a human Reject once", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const chat = chatFor(tab);
			await propose(tab);
			const respond = vi.fn();
			await chat.open(respond);

			await chat.reject();
			expect(respond).toHaveBeenCalledWith({ accepted: false });
			expect(harness.confirmDraft).toHaveBeenCalledTimes(1);
			expect(harness.confirmDraft).toHaveBeenCalledWith(
				expect.objectContaining({
					surface: "document",
					verdict: "rejected",
				}),
			);
			chat.unmount();
		});
		it.each(["null", "empty"] as const)(
			"records no human verdict for %s extraction on Approve",
			async (mode) => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await settle(200);
				const chat = chatFor(tab);
				await propose(tab);
				const respond = vi.fn();
				await chat.open(respond);
				harness.serializationMode = mode;
				try {
					await chat.confirm();
				} finally {
					harness.serializationMode = null;
				}
				expect(respond).toHaveBeenCalledWith({ accepted: false });
				expect(harness.confirmDraft).not.toHaveBeenCalled();
				expect(saveCalls).toEqual([]);
				chat.unmount();
			},
		);
		it("records no human verdict for the unchanged-document machine gate", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await propose(tab, BODY_A);
			const respond = vi.fn();
			await act(async () => {
				tab.actions.get("confirm_changes")?.renderAndWaitForResponse({
					args: {},
					status: "executing",
					respond,
				});
			});
			expect(respond).toHaveBeenCalledWith({ accepted: false });
			expect(harness.confirmDraft).not.toHaveBeenCalled();
			expect(saveCalls).toEqual([]);
		});
		it("stamps the person's choice on the card's tool call, accepted or rejected, for the chat's outcome chip", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab", {
				conversationId: "conversation-example",
			});
			await settle(200);
			/** A turn whose tool call proposes the change, as the chat holds it. */
			const turn = (n: number) => [
				{ id: `user-${n}`, role: "user", content: "Add a paragraph." },
				{ id: `text-${n}`, role: "assistant", content: "Proposed." },
				{
					id: `tools-${n}`,
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: `call-${n}`,
							type: "function",
							function: {
								name: "confirm_changes",
								arguments: "{}",
							},
						},
					],
				},
			];

			harness.chatMessages = turn(1);
			const accepting = chatFor(tab);
			await propose(tab);
			await accepting.open(vi.fn());
			await accepting.confirm();
			await waitFor(() => {
				expect(harness.recordDiffOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordDiffOutcome).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId: "conversation-example",
					projectId: "proj-1",
					messageId: "text-1",
					toolCallId: "call-1",
					outcome: "accepted",
				}),
			);
			await accepting.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await settle(300);

			harness.chatMessages = [...turn(1), ...turn(2)];
			const rejecting = chatFor(tab);
			await propose(tab, `${server.content}\n\nA second paragraph.`);
			await rejecting.open(vi.fn());
			await rejecting.reject();
			await waitFor(() => {
				expect(harness.recordDiffOutcome).toHaveBeenCalledTimes(2);
			});
			expect(harness.recordDiffOutcome).toHaveBeenLastCalledWith(
				expect.objectContaining({
					messageId: "text-2",
					toolCallId: "call-2",
					outcome: "rejected",
				}),
			);
			accepting.unmount();
			rejecting.unmount();
		});

		it("stamps an Accept that could not read the editor as nothing accepted", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab", {
				conversationId: "conversation-example",
			});
			await settle(200);
			harness.chatMessages = [
				{ id: "user-1", role: "user", content: "Add a paragraph." },
				{ id: "text-1", role: "assistant", content: "Proposed." },
				{
					id: "tools-1",
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call-1",
							type: "function",
							function: {
								name: "confirm_changes",
								arguments: "{}",
							},
						},
					],
				},
			];
			const chat = chatFor(tab);
			await propose(tab);
			const respond = vi.fn();
			await chat.open(respond);
			// The editor reads back empty against the body the review began
			// from: the Accept applies nothing.
			await act(async () => {
				mainEditor(tab)?.commands.clearContent();
			});
			await chat.confirm();

			expect(respond).toHaveBeenCalledWith({ accepted: false });
			await waitFor(() => {
				expect(harness.recordDiffOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordDiffOutcome).toHaveBeenCalledWith(
				expect.objectContaining({
					toolCallId: "call-1",
					outcome: "rejected",
				}),
			);
			expect(saveCalls).toEqual([]);
			chat.unmount();
		});

		it("mounted again while its call is executing, leaves the review bar able to accept", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const chat = chatFor(tab);
			await propose(tab);
			const respond = vi.fn();
			await chat.open(respond);
			await chat.remount("executing", respond);
			expect(reviewOpen(tab)).toBe(true);

			let answered: unknown;
			await act(async () => {
				answered = harness.reviewBarProps?.onAcceptAll();
			});
			expect(answered).toBe(true);
			expect(respond).toHaveBeenCalledWith({ accepted: true });
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			chat.unmount();
		});

		it("a raw view open while a proposal is under review takes no input and nothing is saved; a Reject leaves the saved body as it was", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await toggleRawView();
			const chat = chatFor(tab);
			await propose(tab);
			const respond = vi.fn();
			await chat.open(respond);
			// The raw view follows the editor, which holds the proposal.
			expect(rawTextarea(tab).value).toContain(ACCEPTED);
			expect(rawTextarea(tab).disabled).toBe(true);

			await userEvent.type(rawTextarea(tab), " Typed during the review.");
			await settle(600);
			expect(rawTextarea(tab).value).not.toContain(
				"Typed during the review.",
			);
			expect(saveCalls).toEqual([]);

			await chat.reject();
			expect(respond).toHaveBeenCalledWith({ accepted: false });
			await settle(600);
			expect(saveCalls).toEqual([]);
			expect(server.content).toBe(BODY_A);
			expect(rawTextarea(tab).value).not.toContain(ACCEPTED);
			chat.unmount();
		});

		it("saves the typing from before a rejected proposal with the next autosave, with no run after the answer to save it", async () => {
			harness.autosave.delayMs = 1000;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await type(tab, " Typed before.");
			const chat = chatFor(tab);
			await propose(tab, `${editorBody(tab)}\n\n${ACCEPTED}`);
			const respond = vi.fn();
			await chat.open(respond);
			// The autosave falls due during the review and stands down.
			await settle(1200);
			expect(saveCalls).toEqual([]);

			// Rejected, and no assistant run follows to save first.
			await chat.reject();
			await waitFor(
				() => {
					expect(server.content).toContain("Typed before.");
				},
				{ timeout: 3000 },
			);
			expect(server.content).not.toContain(ACCEPTED);
			chat.unmount();
		});

		it("saves nothing while a proposal is under review, unsaved typing from before it included, and Save waits for the answer", async () => {
			harness.autosave.delayMs = 1000;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await type(tab, " Typed before.");
			const chat = chatFor(tab);
			await propose(tab, `${editorBody(tab)}\n\n${ACCEPTED}`);
			const respond = vi.fn();
			await chat.open(respond);
			// The autosave falls due during the review.
			await settle(1200);
			expect(saveCalls).toEqual([]);
			expect(saveButton(tab)).toBeDisabled();
			expect(saveButton(tab)).toHaveAccessibleDescription(
				"saveBlocked.proposal",
			);

			await chat.reject();
			expect(server.content).toBe(BODY_A);
			await clickSave(tab);
			await waitFor(() => {
				expect(server.content).toContain("Typed before.");
			});
			expect(server.content).not.toContain(ACCEPTED);
			chat.unmount();
		});

		/** Edits the raw view: a paragraph added at its end. */
		async function editRawView(tab: Tab) {
			const edited = `${rawTextarea(tab).value}\n\nEdited in the raw view.`;
			await act(async () => {
				fireEvent.change(rawTextarea(tab), {
					target: { value: edited },
				});
			});
		}

		/** Warnings that kept raw-view edits on a body the editor moved past. */
		function staleRawEditCalls() {
			return vi
				.mocked(toast.warning)
				.mock.calls.filter(
					([message]) => message === "rawEditsStale.message",
				);
		}

		it("raw-view edits a save carried go into the editor, so a proposal accepted later is never saved over by them", async () => {
			vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
			const tab = await openTab("solo");
			await settle(200);
			await toggleRawView();
			await editRawView(tab);
			await waitFor(() => {
				expect(server.content).toContain("Edited in the raw view.");
			});
			await settle(100);
			// The editor holds what was saved, which the assistant works from.
			expect(editorBody(tab)).toContain("Edited in the raw view.");

			const chat = chatFor(tab);
			await propose(tab, `${editorBody(tab)}\n\n${ACCEPTED}`);
			await chat.open(vi.fn());
			// The raw view follows the editor again.
			expect(rawTextarea(tab).value).toContain(ACCEPTED);
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			const saves = saveCalls.length;
			await settle(1000);

			expect(saveCalls).toHaveLength(saves);
			expect(server.content).toContain(ACCEPTED);
			expect(server.content).toContain("Edited in the raw view.");
			expect(saveButton(tab)).toBeDisabled();
			chat.unmount();
		});

		it("raw-view edits still unsaved when a proposal is accepted are not saved over it: they stay in the raw view, unsaved, and leave it offered to copy", async () => {
			vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
			harness.autosave.delayMs = 1500;
			const tab = await openTab("solo");
			await settle(200);
			await toggleRawView();
			await editRawView(tab);

			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			// Past the raw edits' autosave, due again after the accept's save.
			await settle(2000);

			expect(saveCalls).toHaveLength(1);
			expect(server.content).toContain(ACCEPTED);
			expect(server.content).not.toContain("Edited in the raw view.");
			expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
			expect(saveButton(tab)).not.toBeDisabled();
			expect(staleRawEditCalls()).toHaveLength(1);

			// Back to the rich editor: it keeps the accepted body, and the raw
			// edits are offered to copy in place of the warning that kept them.
			await toggleRawView();
			expect(editorBody(tab)).toContain(ACCEPTED);
			expect(editorBody(tab)).not.toContain("Edited in the raw view.");
			expect(offerBackCalls()).toHaveLength(1);
			expect(offerBackCalls()[0]?.[1]).toMatchObject({
				id: "raw-edits-offer:doc-1",
			});
			await settle(500);
			expect(saveCalls).toHaveLength(1);
			chat.unmount();
		});

		it("in a room, typing more in the raw view after a proposal was accepted over its edits saves nothing over it", async () => {
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await toggleRawView();
			// Edited, then the proposal arrives before the edit's autosave.
			harness.autosave.delayMs = 1500;
			await editRawView(tab);
			harness.autosave.delayMs = 300;
			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await settle(100);

			await act(async () => {
				fireEvent.change(rawTextarea(tab), {
					target: { value: `${rawTextarea(tab).value} More.` },
				});
			});
			await settle(2000);

			expect(saveCalls).toHaveLength(1);
			expect(server.content).toContain(ACCEPTED);
			expect(rawTextarea(tab).value).toContain(
				"Edited in the raw view. More.",
			);
			expect(await roomBody()).toContain(ACCEPTED);
			expect(staleRawEditCalls()).toHaveLength(1);
			chat.unmount();
		});

		/** The view switch drawn among the page's actions. */
		function viewSwitch(tab: Tab): HTMLElement {
			return within(tab.actionSlot as HTMLElement).getByRole("button", {
				name: /^(View raw markdown|Switch to rich editor)$/,
			});
		}

		/**
		 * Tries both ways to leave the raw view — the shortcut and the button —
		 * and checks that neither wrote the raw edits anywhere.
		 */
		async function triesToLeaveRawView(tab: Tab) {
			const editorBefore = editorBody(tab);
			const roomBefore = await roomBody();
			await toggleRawView();
			expect(viewSwitch(tab)).toBeDisabled();
			expect(viewSwitch(tab)).toHaveAccessibleDescription(
				/^Switching views waits/,
			);
			await act(async () => {
				fireEvent.click(viewSwitch(tab));
			});
			await settle(50);
			expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
			expect(editorBody(tab)).toBe(editorBefore);
			expect(await roomBody()).toBe(roomBefore);
			expect(editorBody(tab)).not.toContain("Edited in the raw view.");
		}

		it("the views do not switch while a proposal is under review: the editor and the room keep their body", async () => {
			harness.autosave.delayMs = 10_000;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab", { withActions: true });
			await settle(200);
			await toggleRawView();
			await editRawView(tab);
			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			expect(rawTextarea(tab).disabled).toBe(true);

			await triesToLeaveRawView(tab);
			expect(saveCalls).toEqual([]);
			chat.unmount();
		});

		it("the views do not switch while a generation run writes the document: the editor and the room keep their body", async () => {
			harness.autosave.delayMs = 10_000;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab", { withActions: true });
			await settle(200);
			await toggleRawView();
			await editRawView(tab);
			expect(viewSwitch(tab)).not.toBeDisabled();
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(tab);
			await settle(30);

			await triesToLeaveRawView(tab);
			expect(saveCalls).toEqual([]);
		});

		/** The clipboard, recording what is copied to it. */
		function stubClipboard() {
			const writeText = vi.fn(async (_text: string) => undefined);
			Object.defineProperty(window.navigator, "clipboard", {
				value: { writeText },
				configurable: true,
			});
			return writeText;
		}

		/** Clicks the copy action of a toast `call` recorded. */
		function clickCopy(call: unknown[] | undefined) {
			(call?.[1] as { action: { onClick: () => void } }).action.onClick();
		}

		it("raw-view edits typed after they went stale are what their offer copies, also after the page is left within the app", async () => {
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await toggleRawView();
			harness.autosave.delayMs = 1500;
			await editRawView(tab);
			harness.autosave.delayMs = 300;
			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			expect(staleRawEditCalls()).toHaveLength(1);
			await act(async () => {
				fireEvent.change(rawTextarea(tab), {
					target: { value: `${rawTextarea(tab).value} Typed later.` },
				});
			});
			await settle(100);
			// Still on the page, the warning copies the text as it stands.
			const copiedBefore = stubClipboard();
			clickCopy(staleRawEditCalls()[0]);
			expect(copiedBefore).toHaveBeenCalledWith(
				expect.stringContaining("Edited in the raw view. Typed later."),
			);

			// Left within the app: the editor unmounts.
			chat.unmount();
			await act(async () => {
				tab.view?.unmount();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(50);

			expect(saveCalls).toHaveLength(1);
			const left = vi
				.mocked(toast.error)
				.mock.calls.filter(
					([message]) => message === "leaveSaveFailed",
				);
			expect(left).toHaveLength(1);
			// In place of the warning that kept the edits in the raw view.
			expect(left[0]?.[1]).toMatchObject({ id: "raw-edits-offer:doc-1" });
			const writeText = stubClipboard();
			clickCopy(left[0]);
			clickCopy(staleRawEditCalls()[0]);
			expect(writeText).toHaveBeenCalledTimes(2);
			for (const [copied] of writeText.mock.calls) {
				expect(copied).toContain(
					"Edited in the raw view. Typed later.",
				);
			}
		});

		it("a raw save answered after a proposal changed the editor leaves the proposal in the editor, and the raw edits stale and unsaved", async () => {
			vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
			harness.autosave.delayMs = 300;
			const tab = await openTab("solo");
			await settle(200);
			await toggleRawView();
			server.holdAnswers = true;
			await editRawView(tab);
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			expect(server.held).toHaveLength(1);

			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			expect(editorBody(tab)).toContain(ACCEPTED);
			expect(staleRawEditCalls()).toHaveLength(1);

			server.holdAnswers = false;
			await act(async () => {
				server.held.shift()?.();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(1000);

			expect(editorBody(tab)).toContain(ACCEPTED);
			expect(editorBody(tab)).not.toContain("Edited in the raw view.");
			expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
			expect(saveCalls).toHaveLength(1);

			// Rejected: the editor goes back to the body the proposal was
			// made on, and the raw edits are still not saved over it.
			await chat.reject();
			await settle(1000);
			expect(saveCalls).toHaveLength(1);
			expect(editorBody(tab)).not.toContain(ACCEPTED);
			expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
			chat.unmount();
		});

		it("a raw save answered after a later write reached the page leaves that write in the cached document", async () => {
			vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
			harness.autosave.delayMs = 300;
			const tab = await openTab("solo");
			await settle(200);
			await toggleRawView();
			server.holdAnswers = true;
			await editRawView(tab);
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			expect(server.version).toBe(8);
			// A later write: a run's, another editor's.
			server.content = BODY_B;
			server.version = 9;
			await nudge(tab);
			await settle(50);

			server.holdAnswers = false;
			await act(async () => {
				server.held.shift()?.();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(100);

			const [[, cached]] = tab.queryClient.getQueriesData<{
				document: { content: string; version: number };
			}>({ queryKey: ["projects", "documents", "get"] });
			expect(cached?.document.version).toBe(9);
			expect(cached?.document.content).toBe(BODY_B);
		});

		it("a raw save whose body a colleague's editor put into the room before its answer leaves nothing stale: the raw view follows the editor again", async () => {
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await toggleRawView();
			server.holdAnswers = true;
			await editRawView(tab);
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			// The save wrote the document; a colleague's editor brings the
			// room to it, body and stamp together, before this tab hears the
			// answer.
			await act(async () => {
				await persistRoom(server.content, savedStamp());
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(50);

			server.holdAnswers = false;
			await act(async () => {
				server.held.shift()?.();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(100);

			expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
			expect(saveButton(tab)).toBeDisabled();
			if (staleRawEditCalls().length > 0) {
				expect(toast.dismiss).toHaveBeenCalledWith(
					"raw-edits-offer:doc-1",
				);
			}
			// It follows the editor again: a colleague's typing reaches it.
			await act(async () => {
				await persistRoom(
					`${server.content} Typed by a colleague.`,
					null,
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await waitFor(() => {
				expect(rawTextarea(tab).value).toContain(
					"Typed by a colleague.",
				);
			});
			await settle(500);
			expect(saveCalls).toHaveLength(1);
		});

		/** Raw edits made stale by an accepted proposal, then typed on. */
		async function staleRawEditsTypedOn(tab: Tab) {
			await settle(200);
			await toggleRawView();
			harness.autosave.delayMs = 1500;
			await editRawView(tab);
			harness.autosave.delayMs = 300;
			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await act(async () => {
				fireEvent.change(rawTextarea(tab), {
					target: { value: `${rawTextarea(tab).value} Typed later.` },
				});
			});
			await settle(100);
			chat.unmount();
		}

		async function leaveWithinApp(tab: Tab) {
			await act(async () => {
				tab.view?.unmount();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(50);
		}

		function leaveSaveFailedCalls() {
			return vi
				.mocked(toast.error)
				.mock.calls.filter(
					([message]) => message === "leaveSaveFailed",
				);
		}

		it("stale raw edits whose explicit Save is in flight when the page is left are not said to be unsaved once that save lands", async () => {
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await staleRawEditsTypedOn(tab);
			server.holdAnswers = true;
			await clickSave(tab);
			expect(saveCalls).toHaveLength(2);
			expect(saveCalls[1]?.content).toContain(
				"Edited in the raw view. Typed later.",
			);

			await leaveWithinApp(tab);
			expect(leaveSaveFailedCalls()).toHaveLength(0);
			server.holdAnswers = false;
			await act(async () => {
				server.held.shift()?.();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(100);

			expect(leaveSaveFailedCalls()).toHaveLength(0);
			expect(server.content).toContain(
				"Edited in the raw view. Typed later.",
			);
		});

		it("stale raw edits whose explicit Save fails after the page is left are said to be unsaved once, under the toast that kept them", async () => {
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await staleRawEditsTypedOn(tab);
			server.holdAnswers = true;
			server.failNext = new Error("Service unavailable");
			await clickSave(tab);

			await leaveWithinApp(tab);
			server.holdAnswers = false;
			await act(async () => {
				server.held.shift()?.();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(100);

			const left = leaveSaveFailedCalls();
			expect(left).toHaveLength(1);
			expect(left[0]?.[1]).toMatchObject({ id: "raw-edits-offer:doc-1" });
			expect(staleRawEditCalls()[0]?.[1]).toMatchObject({
				id: "raw-edits-offer:doc-1",
			});
			const writeText = stubClipboard();
			clickCopy(left[0]);
			expect(writeText).toHaveBeenCalledWith(
				expect.stringContaining("Edited in the raw view. Typed later."),
			);
		});

		it("raw edits the room offered back as it replaced the body leave the page under that same toast", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await toggleRawView();
			await editRawView(tab);
			// A write from outside the room: the room is brought to it.
			server.content = BODY_B;
			server.version = 8;
			await nudge(tab);
			await waitFor(
				() => {
					expect(offerBackCalls()).toHaveLength(1);
				},
				{ timeout: 3000 },
			);
			await settle(100);
			await act(async () => {
				fireEvent.change(rawTextarea(tab), {
					target: { value: `${rawTextarea(tab).value} Typed later.` },
				});
			});
			await settle(50);

			await leaveWithinApp(tab);

			expect(offerBackCalls()[0]?.[1]).toMatchObject({
				id: "raw-edits-offer:doc-1",
			});
			const left = leaveSaveFailedCalls();
			expect(left).toHaveLength(1);
			expect(left[0]?.[1]).toMatchObject({ id: "raw-edits-offer:doc-1" });
			const writeText = stubClipboard();
			clickCopy(left[0]);
			expect(writeText).toHaveBeenCalledWith(
				expect.stringContaining("Edited in the raw view. Typed later."),
			);
		});
	});
});

/**
 * An assistant proposal under review is in the room: the reviewing tab's
 * editor holds it, so every other tab shows it before anyone has answered.
 * While the reviewing tab publishes it — from its assistant's first frame —
 * every other tab that may edit holds still — no input in the editor or the
 * raw view, no saves, the view switch, Update using context, Regenerate,
 * restore and its own assistant's proposals held — and says why; the room
 * is not brought to a newer saved body underneath it. The answer, a run
 * that ends without a card, the reviewing tab leaving, or its state leaving
 * the room ends the hold (Fizzy #2946).
 */
describe("an assistant proposal under review in another tab (Fizzy #2946)", () => {
	const PROPOSED = "A paragraph the assistant proposes.";
	const TYPED = " Typed in the other tab.";

	/** The confirm card the reviewing tab's chat renders, in a root of its own. */
	function cardFor(tab: Tab) {
		let view: ReturnType<typeof render> | null = null;
		const respond = vi.fn();
		return {
			respond,
			/**
			 * The assistant proposes the body with `PROPOSED` added — unless it
			 * already streamed its proposal, which the card then holds.
			 */
			async open({ streamed = false }: { streamed?: boolean } = {}) {
				if (!streamed) {
					harness.agentState = {
						document: `${editorBody(tab)}\n\n${PROPOSED}`,
					};
					rerender(tab);
					await settle(20);
				}
				await act(async () => {
					view = render(
						tab.actions
							.get("confirm_changes")
							?.renderAndWaitForResponse({
								args: {},
								respond,
								status: "executing",
							}),
					);
					await Promise.resolve();
				});
				await settle(50);
			},
			async answer(testId: "confirm-button" | "reject-button") {
				await act(async () => {
					fireEvent.click(
						within(view?.container as HTMLElement).getByTestId(
							testId,
						),
					);
				});
				await settle(50);
			},
			/** Whether the card still offers its answers. */
			offersAnswers(): boolean {
				return (
					view !== null &&
					within(view.container).queryByTestId("confirm-button") !==
						null
				);
			},
			/** The answered call, rendered in place, as CopilotKit does. */
			async complete() {
				await act(async () => {
					view?.rerender(
						tab.actions
							.get("confirm_changes")
							?.renderAndWaitForResponse({
								args: {},
								respond,
								status: "complete",
								result: { accepted: false },
							}),
					);
				});
				await settle(20);
			},
			unmount() {
				view?.unmount();
			},
		};
	}

	/** Another editor in the room that reviews a proposal of its own. */
	const ELSEWHERE = 99;
	/**
	 * A review as an editor publishes it: when it began, then its id. By
	 * default one that began a minute ago, before any review in the test.
	 */
	function reviewBegun(at = Date.now() - 60_000) {
		return `${at}:review-elsewhere`;
	}
	function peerStartsReview(review = reviewBegun()) {
		act(() => {
			addPeer(ELSEWHERE, {
				[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
				[PROPOSAL_REVIEW_AWARENESS_FIELD]: review,
			});
		});
	}
	function peerAnswersReview() {
		act(() => {
			room.peers.delete(ELSEWHERE);
			for (const tab of room.tabs) {
				tab.awareness.view.delete(ELSEWHERE);
				notify(tab);
			}
		});
	}

	/**
	 * An update using context in `tab` shows its diff: the proposal goes into
	 * the editor, as the hook puts it there, after its review is published.
	 */
	async function showContextPreview(tab: Tab) {
		harness.contextUpdateIn = tab.name;
		rerender(tab);
		await settle(20);
		const before = editorBody(tab);
		harness.contextBaselines.set(tab.name, before);
		const options = harness.contextOptionsByTab.get(tab.name);
		await act(async () => {
			options?.beforePreview?.();
			options?.editor?.commands.setContent(
				options.fromMarkdown(`${before}\n\n${PROPOSED}`),
			);
		});
		await settle(50);
	}

	/** The assistant streams `document` into `tab`'s editor, as one frame. */
	async function stream(tab: Tab, document: string) {
		harness.chatIn = tab.name;
		harness.chatLoading = true;
		rerender(tab);
		await settle(20);
		harness.agentState = { document };
		rerender(tab);
		await settle(50);
	}

	function heldStatus(tab: Tab): HTMLElement | null {
		return within(tab.syncSlot).queryByText("proposalElsewhere");
	}

	/** The other tab holds still, and says why. */
	async function expectHeld(tab: Tab) {
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(false);
		});
		expect(heldStatus(tab)).not.toBeNull();
		expect(saveButton(tab)).toBeDisabled();
		expect(saveButton(tab)).toHaveAccessibleDescription(
			"saveBlocked.proposalElsewhere",
		);
	}

	/** The other tab takes input again, and no longer says it holds. */
	async function expectResumed(tab: Tab) {
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(true);
		});
		expect(heldStatus(tab)).toBeNull();
		expect(saveButton(tab)).not.toHaveAccessibleDescription(
			"saveBlocked.proposalElsewhere",
		);
	}

	/** The reviewing tab's state leaves the room, as on a dropped connection. */
	function leaveRoomAwareness(gone: Tab) {
		act(() => {
			for (const other of room.tabs) {
				if (other !== gone) {
					other.awareness.view.delete(gone.awareness.clientID);
					notify(other);
				}
			}
		});
	}

	async function openRoom() {
		await persistRoom(BODY_A, savedStamp());
		const reviewing = await openTab("reviewing", { clientId: 10 });
		const other = await openTab("other", { clientId: 20 });
		await settle(200);
		return { reviewing, other };
	}

	it("holds the other tab still: no input, its autosave saves nothing, Save says why, and so does the status", async () => {
		harness.autosave.delayMs = 1000;
		const { reviewing, other } = await openRoom();
		await type(other, TYPED);
		expect(editorBody(reviewing)).toContain(TYPED.trim());
		expect(saveButton(other)).not.toBeDisabled();

		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);
		expect(editorBody(other)).toContain(PROPOSED);
		// The typing's autosave falls due and stands down.
		await settle(1200);
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_A);
		await expectHeld(other);
		card.unmount();
	});

	it("holds the other tab's raw view and view switch still", async () => {
		await persistRoom(BODY_A, savedStamp());
		const other = await openTab("other", {
			clientId: 20,
			withActions: true,
		});
		await settle(200);
		await toggleRawView();
		expect(rawTextarea(other)).not.toBeDisabled();
		const reviewing = await openTab("reviewing", { clientId: 10 });
		await settle(200);

		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);
		await waitFor(() => {
			expect(rawTextarea(other)).toBeDisabled();
		});
		expect(
			within(other.actionSlot as HTMLElement).getByRole("button", {
				name: "Switch to rich editor",
			}),
		).toBeDisabled();

		await card.answer("reject-button");
		await expectResumed(other);
		expect(rawTextarea(other)).not.toBeDisabled();
		card.unmount();
	});

	it("rejected: the other tab resumes, its typing from before is kept and autosaved, and the proposal is never saved", async () => {
		harness.autosave.delayMs = 1000;
		const { reviewing, other } = await openRoom();
		await type(other, TYPED);
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);
		await settle(1200);
		expect(saveCalls).toEqual([]);

		await card.answer("reject-button");
		expect(card.respond).toHaveBeenCalledWith({ accepted: false });
		await expectResumed(other);
		expect(editorBody(other)).toContain(TYPED.trim());
		expect(editorBody(other)).not.toContain(PROPOSED);
		// The autosave that stood down goes once saves may go again.
		await waitFor(
			() => {
				expect(server.content).toContain(TYPED.trim());
			},
			{ timeout: 3000 },
		);
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({ tab: "other" });
		expect(server.content).not.toContain(PROPOSED);
		expect(server.content).toContain("Phase one, then two.");
		card.unmount();
	});

	it("rejected, with nothing typed in the other tab: nothing is saved and the server keeps the body from before the proposal", async () => {
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		await card.answer("reject-button");
		await expectResumed(other);
		expect(editorBody(other)).not.toContain(PROPOSED);
		await settle(300);
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_A);
		card.unmount();
	});

	it("accepted: the other tab resumes on the accepted body, saved once, by the reviewing tab", async () => {
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		await card.answer("confirm-button");
		expect(card.respond).toHaveBeenCalledWith({ accepted: true });
		await waitFor(() => {
			expect(server.content).toContain(PROPOSED);
		});
		await expectResumed(other);
		expect(editorBody(other)).toContain(PROPOSED);
		await settle(300);
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({ tab: "reviewing" });
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		card.unmount();
	});

	it("the reviewing tab's page left while it reviews: the other tab resumes", async () => {
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		// The page goes while the chat still holds the card unanswered.
		await act(async () => {
			reviewing.view?.unmount();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(
			reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toBeNull();
		await expectResumed(other);
		expect(saveCalls).toEqual([]);
		card.unmount();
	});

	it("the other tab's page left within the app while it holds: nothing is saved, and its unsaved typing is offered to copy, said to hold the proposal too", async () => {
		harness.autosave.delayMs = 60_000;
		const { reviewing, other } = await openRoom();
		await type(other, TYPED);
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		await act(async () => {
			other.view?.unmount();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(100);
		expect(saveCalls).toEqual([]);
		const offers = vi
			.mocked(toast.error)
			.mock.calls.filter(
				([message]) => message === "leaveWhileProposalElsewhere",
			);
		expect(offers).toHaveLength(1);
		const options = offers[0]?.[1] as {
			id: string;
			action: { onClick: () => void };
		};
		expect(options.id).toBe("raw-edits-offer:doc-1");
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		options.action.onClick();
		expect(writeText).toHaveBeenCalledWith(
			expect.stringContaining(TYPED.trim()),
		);
		card.unmount();
	});

	it("the reviewing tab's state leaves the room, as when its connection drops: the other tab resumes, and holds again when it is back", async () => {
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		leaveRoomAwareness(reviewing);
		await expectResumed(other);

		// Reconnected: its state, review included, reaches the room again.
		act(() => {
			other.awareness.view.set(
				reviewing.awareness.clientID,
				reviewing.awareness.own,
			);
			notify(other);
		});
		await expectHeld(other);
		card.unmount();
	});

	it("never holds the tab that reviews it: its own review keeps it editable, with its own reason to wait", async () => {
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();

		expect(
			reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toEqual(expect.any(String));
		await expectHeld(other);
		expect(mainEditor(reviewing)?.isEditable).toBe(true);
		expect(heldStatus(reviewing)).toBeNull();
		expect(saveButton(reviewing)).toHaveAccessibleDescription(
			"saveBlocked.proposal",
		);

		await card.answer("reject-button");
		expect(
			reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toBeNull();
		card.unmount();
	});

	it("leaves a viewer as it was: read-only, with no hold of its own to say", async () => {
		await persistRoom(BODY_A, savedStamp());
		const reviewing = await openTab("reviewing", { clientId: 10 });
		const viewer = await openTab("viewer", { clientId: 5, role: "viewer" });
		const other = await openTab("other", { clientId: 20 });
		await settle(200);
		expect(mainEditor(viewer)?.isEditable).toBe(false);

		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);
		expect(mainEditor(viewer)?.isEditable).toBe(false);
		expect(heldStatus(viewer)).toBeNull();
		expect(saveButton(viewer)).not.toHaveAccessibleDescription(
			"saveBlocked.proposalElsewhere",
		);
		card.unmount();
	});

	it("is not replaced by a newer saved body while it is under review: the room is brought to it once the proposal is answered", async () => {
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		// A write outside the room — an agent, the API — lands meanwhile.
		server.content = BODY_B;
		server.version = 8;
		await nudge(reviewing, other);
		// Not even looked at as a room behind the saved document: neither tab
		// says it is updating, and the other tab still says why it holds.
		await settle(30);
		expect(within(reviewing.syncSlot).queryByText("updating")).toBeNull();
		expect(within(other.syncSlot).queryByText("updating")).toBeNull();
		expect(heldStatus(other)).not.toBeNull();
		// Past both looks of the stale rule and every turn of the election.
		await settle(1200);
		await nudge(reviewing, other);
		await settle(1200);
		expect(editorBody(reviewing)).toContain(PROPOSED);
		expect(editorBody(other)).toContain(PROPOSED);
		expect(await roomBody()).toContain(PROPOSED);
		expect(readRoomStamp(room.doc)).toEqual({
			version: 7,
			contentHash: hashOf(BODY_A),
		});

		await card.answer("reject-button");
		await waitFor(
			() => {
				expect(editorBody(reviewing)).toContain("rewritten by the run");
				expect(editorBody(other)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		expect(editorBody(other)).not.toContain(PROPOSED);
		expect(saveCalls).toEqual([]);
		expect(offerBackCalls()).toHaveLength(0);
		card.unmount();
	});

	it("is not replaced by the saved body when the claimant of an earlier convergence went quiet before reading it back", async () => {
		harness.timings.fallThroughMs = 1500;
		await persistRoom(BODY_A, savedStamp());
		// A convergence to the saved body whose claimant left before it read
		// its body back.
		writeConvergenceClaim(room.doc, { clientId: 99, target: savedStamp() });
		const reviewing = await openTab("reviewing", { clientId: 10 });
		const other = await openTab("other", { clientId: 20 });
		const card = cardFor(reviewing);
		await card.open();
		expect(editorBody(reviewing)).toContain(PROPOSED);

		// Past the claimant's turn and every editor's after it.
		await settle(5000);
		expect(editorBody(reviewing)).toContain(PROPOSED);
		expect(editorBody(other)).toContain(PROPOSED);
		expect(await roomBody()).toContain(PROPOSED);
		await expectHeld(other);
		expect(saveCalls).toEqual([]);
		card.unmount();
	});

	it("holds the other tab, Update using context included, while an update using context is under way in the reviewing tab", async () => {
		const { reviewing, other } = await openRoom();
		// The other tab's own button: a view's queries reach every tab.
		const updateButton = () =>
			(within(other.view?.container as HTMLElement)
				.queryAllByText(/Update\s+using\s+context/)
				.map((label) => label.closest("button"))
				.find(Boolean) ?? null) as HTMLButtonElement | null;
		expect(updateButton()).not.toBeDisabled();

		harness.contextUpdateIn = "reviewing";
		rerender(reviewing);
		await expectHeld(other);
		expect(updateButton()).toBeDisabled();

		harness.contextUpdateIn = null;
		rerender(reviewing);
		await expectResumed(other);
		expect(updateButton()).not.toBeDisabled();
	});

	/**
	 * The reviewing tab's page left within the app — its Close, a link —
	 * while its proposal is unanswered rejects it on the way out: the body
	 * from before the proposal goes back into the room before the room is
	 * torn down, so the other tab's next save never carries the proposal.
	 */
	describe("the reviewing tab's page left while its proposal is unanswered", () => {
		async function leave(tab: Tab) {
			await act(async () => {
				tab.view?.unmount();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(50);
		}

		/** The other tab resumes on the body from before the proposal. */
		async function expectProposalTakenBack(other: Tab) {
			await expectResumed(other);
			expect(editorBody(other)).not.toContain(PROPOSED);
			expect(editorBody(other)).toContain("Phase one, then two.");
			expect(await roomBody()).not.toContain(PROPOSED);
			expect(await roomBody()).toContain(
				"A fixed fee for the first phase.",
			);
			// Nothing is saved on the way out, the leave's own save included.
			expect(saveCalls).toEqual([]);
			expect(server.content).toBe(BODY_A);
		}

		/** The other tab's typing autosaves without the proposal. */
		async function expectTypingSavedWithoutProposal(other: Tab) {
			await type(other, TYPED);
			await waitFor(
				() => {
					expect(server.content).toContain(TYPED.trim());
				},
				{ timeout: 3000 },
			);
			expect(saveCalls).toHaveLength(1);
			expect(saveCalls[0]).toMatchObject({ tab: "other" });
			expect(server.content).not.toContain(PROPOSED);
			expect(server.content).toContain("Phase one, then two.");
		}

		it("on its confirm card: the room gets the body from before it back, and the other tab saves its typing on that body", async () => {
			harness.autosave.delayMs = 1000;
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			expect(await roomBody()).toContain(PROPOSED);

			await leave(reviewing);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
			await expectProposalTakenBack(other);
			// The chat went with the page: its call is not answered from here.
			expect(card.respond).not.toHaveBeenCalled();
			await expectTypingSavedWithoutProposal(other);
			card.unmount();
		});

		it("while its assistant still streams it in: the same", async () => {
			harness.autosave.delayMs = 1000;
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			await expectHeld(other);
			expect(await roomBody()).toContain(PROPOSED);

			await leave(reviewing);
			await expectProposalTakenBack(other);
			await expectTypingSavedWithoutProposal(other);
		});

		it("with an update using context's diff on screen: it is rejected, and the room gets the body from before it back", async () => {
			const { reviewing, other } = await openRoom();
			await showContextPreview(reviewing);
			await expectHeld(other);
			expect(await roomBody()).toContain(PROPOSED);

			await leave(reviewing);
			expect(harness.contextReject).toHaveBeenCalledTimes(1);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
			await expectProposalTakenBack(other);
		});

		it("typing of its own from before the proposal, unsaved, is saved on the way out: the body from before it, never the proposal", async () => {
			harness.autosave.delayMs = 60_000;
			const { reviewing, other } = await openRoom();
			const OWN_TYPING = " Typed in the reviewing tab.";
			await type(reviewing, OWN_TYPING);
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			expect(saveCalls).toEqual([]);

			await leave(reviewing);
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			expect(saveCalls[0]).toMatchObject({ tab: "reviewing" });
			expect(server.content).toContain(OWN_TYPING.trim());
			expect(server.content).not.toContain(PROPOSED);
			expect(await roomBody()).not.toContain(PROPOSED);
			card.unmount();
		});

		it("typing of its own is not saved on the way out while a run writes the document", async () => {
			harness.autosave.delayMs = 60_000;
			const { reviewing, other } = await openRoom();
			await type(reviewing, " Typed in the reviewing tab.");
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			// A run started elsewhere meanwhile.
			server.status = "GENERATING";
			await nudge(reviewing, other);
			await settle(50);

			await leave(reviewing);
			await settle(100);
			expect(saveCalls).toEqual([]);
			expect(await roomBody()).not.toContain(PROPOSED);
			card.unmount();
		});

		it("the page going for good (closed or reloaded) takes it back too; kept in the back-forward cache, it does not", async () => {
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			const pageHide = (persisted: boolean) =>
				act(() => {
					const event = new Event("pagehide");
					Object.defineProperty(event, "persisted", {
						value: persisted,
					});
					window.dispatchEvent(event);
				});

			pageHide(true);
			await settle(50);
			await expectHeld(other);
			expect(await roomBody()).toContain(PROPOSED);

			pageHide(false);
			await settle(50);
			await expectProposalTakenBack(other);
			card.unmount();
		});

		it("once it was accepted, nothing is put back: the other tab keeps the accepted body", async () => {
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await card.answer("confirm-button");
			await waitFor(() => {
				expect(server.content).toContain(PROPOSED);
			});
			await expectResumed(other);
			// Typed on the accepted body, which leaving must not replace.
			await type(other, TYPED);

			await leave(reviewing);
			await settle(100);
			expect(editorBody(other)).toContain(PROPOSED);
			expect(editorBody(other)).toContain(TYPED.trim());
			expect(await roomBody()).toContain(PROPOSED);
			expect(await roomBody()).toContain(TYPED.trim());
			expect(saveCalls).toHaveLength(1);
			card.unmount();
		});

		it("a sync loss in the reviewing tab is no leaving: the room keeps what it holds", async () => {
			const { reviewing } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			expect(await roomBody()).toContain(PROPOSED);

			reviewing.synced = false;
			rerender(reviewing);
			await settle(50);
			expect(mainEditor(reviewing)).toBeNull();
			expect(await roomBody()).toContain(PROPOSED);
			expect(saveCalls).toEqual([]);
			card.unmount();
		});
	});

	/**
	 * A proposal left waiting for its answer holds the other tabs for at most
	 * the idle limit: past it, with nothing done in the reviewing tab, that
	 * tab answers it as rejected and says so. The other tabs never stop
	 * holding on their own.
	 */
	describe("a proposal left unanswered", () => {
		const LIMIT_MS = 400;

		function timedOutToasts() {
			return vi
				.mocked(toast.info)
				.mock.calls.filter(
					([message]) => message === "proposalReviewTimedOut",
				);
		}

		it("is rejected by the reviewing tab once it waited the limit with nothing done there, and the other tab resumes on the body from before it", async () => {
			harness.timings.proposalReviewIdleLimitMs = LIMIT_MS;
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);

			await settle(LIMIT_MS + 200);
			expect(card.respond).toHaveBeenCalledWith({ accepted: false });
			expect(timedOutToasts()).toHaveLength(1);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
			await expectResumed(other);
			expect(editorBody(other)).not.toContain(PROPOSED);
			expect(await roomBody()).not.toContain(PROPOSED);
			expect(saveCalls).toEqual([]);
			card.unmount();
		});

		it("waits the limit again from each key, pointer, wheel or scroll in the reviewing tab, and from the tab coming back into view", async () => {
			harness.timings.proposalReviewIdleLimitMs = LIMIT_MS;
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();

			const activity: Array<() => void> = [
				() =>
					window.dispatchEvent(
						new KeyboardEvent("keydown", { key: "ArrowDown" }),
					),
				() => window.dispatchEvent(new Event("pointerdown")),
				() => window.dispatchEvent(new Event("wheel")),
				// A scroll inside the editor reaches the window when captured.
				() => window.document.body.dispatchEvent(new Event("scroll")),
				() =>
					window.document.dispatchEvent(
						new Event("visibilitychange"),
					),
			];
			for (const act_ of activity) {
				await settle(LIMIT_MS - 150);
				act(act_);
			}
			await settle(LIMIT_MS - 150);
			expect(card.respond).not.toHaveBeenCalled();
			expect(card.offersAnswers()).toBe(true);
			await expectHeld(other);

			await settle(300);
			expect(card.respond).toHaveBeenCalledWith({ accepted: false });
			expect(timedOutToasts()).toHaveLength(1);
			card.unmount();
		});

		it("an update using context's diff left unanswered is rejected the same way", async () => {
			harness.timings.proposalReviewIdleLimitMs = LIMIT_MS;
			const { reviewing, other } = await openRoom();
			await showContextPreview(reviewing);
			await expectHeld(other);

			await settle(LIMIT_MS + 200);
			expect(harness.contextReject).toHaveBeenCalledTimes(1);
			expect(timedOutToasts()).toHaveLength(1);
			expect(await roomBody()).not.toContain(PROPOSED);
		});

		it("holds nobody, so waits, while no other editor is in the room: it starts once one joins", async () => {
			harness.timings.proposalReviewIdleLimitMs = LIMIT_MS;
			await persistRoom(BODY_A, savedStamp());
			const reviewing = await openTab("reviewing", { clientId: 10 });
			await settle(200);
			const card = cardFor(reviewing);
			await card.open();

			await settle(LIMIT_MS * 2);
			expect(card.respond).not.toHaveBeenCalled();
			expect(card.offersAnswers()).toBe(true);
			expect(timedOutToasts()).toHaveLength(0);

			const other = await openTab("other", { clientId: 20 });
			await expectHeld(other);
			await settle(LIMIT_MS + 200);
			expect(card.respond).toHaveBeenCalledWith({ accepted: false });
			await expectResumed(other);
			card.unmount();
		});

		it("is stamped on the card's tool call as rejected, as the review bar's Reject stamps it, for the chat's outcome chip", async () => {
			harness.timings.proposalReviewIdleLimitMs = LIMIT_MS;
			await persistRoom(BODY_A, savedStamp());
			harness.chatMessages = [
				{ id: "user-1", role: "user", content: "Add a paragraph." },
				{ id: "text-1", role: "assistant", content: "Proposed." },
				{
					id: "tools-1",
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call-1",
							type: "function",
							function: {
								name: "confirm_changes",
								arguments: "{}",
							},
						},
					],
				},
			];
			const reviewing = await openTab("reviewing", {
				clientId: 10,
				conversationId: "conversation-example",
			});
			await openTab("other", { clientId: 20 });
			await settle(200);
			const card = cardFor(reviewing);
			await card.open();

			await settle(LIMIT_MS + 200);
			expect(card.respond).toHaveBeenCalledWith({ accepted: false });
			await waitFor(() => {
				expect(harness.recordDiffOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordDiffOutcome).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId: "conversation-example",
					messageId: "text-1",
					toolCallId: "call-1",
					outcome: "rejected",
				}),
			);
			card.unmount();
		});

		it("never releases a tab held by another editor's review: only that editor answers it", async () => {
			harness.timings.proposalReviewIdleLimitMs = LIMIT_MS;
			const { other } = await openRoom();
			peerStartsReview();
			await expectHeld(other);

			await settle(LIMIT_MS * 3);
			await expectHeld(other);
			expect(timedOutToasts()).toHaveLength(0);
			expect(saveCalls).toEqual([]);
		});
	});

	it("says who reviews the proposal when the reviewing editor names them", async () => {
		const { other } = await openRoom();
		act(() => {
			addPeer(ELSEWHERE, {
				[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
				[PROPOSAL_REVIEW_AWARENESS_FIELD]: reviewBegun(),
				user: { name: "Example Reviewer", color: "#000" },
			});
		});
		await waitFor(() => {
			expect(
				within(other.syncSlot).queryByText("proposalElsewhereBy"),
			).not.toBeNull();
		});
		expect(heldStatus(other)).toBeNull();
		expect(mainEditor(other)?.isEditable).toBe(false);

		peerAnswersReview();
		await expectResumed(other);
		expect(
			within(other.syncSlot).queryByText("proposalElsewhereBy"),
		).toBeNull();
	});

	describe("in the order the room carries it", () => {
		/** What the reviewing tab sends the room, in order. */
		function recordSends(tab: Tab) {
			const order: string[] = [];
			const publish = tab.awareness.setLocalStateField;
			tab.awareness.setLocalStateField = (field, value) => {
				if (field === PROPOSAL_REVIEW_AWARENESS_FIELD) {
					order.push(value ? "review" : "cleared");
				}
				publish(field, value);
			};
			const onBody = () => order.push("body");
			tab.doc.on("update", onBody);
			return order;
		}

		/** The review reaches the other tab's room, not yet rendered there. */
		function reviewArrivesUnrendered(tab: Tab) {
			tab.awareness.view.set(ELSEWHERE, {
				[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
				[PROPOSAL_REVIEW_AWARENESS_FIELD]: reviewBegun(),
			});
		}

		it("the review goes before the first of a streamed proposal's body", async () => {
			const { reviewing } = await openRoom();
			const order = recordSends(reviewing);
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			expect(order.slice(0, 2)).toEqual(["review", "body"]);
		});

		it("the review goes before a confirm card's diff", async () => {
			const { reviewing } = await openRoom();
			const order = recordSends(reviewing);
			const card = cardFor(reviewing);
			await card.open();
			expect(order.slice(0, 2)).toEqual(["review", "body"]);
			card.unmount();
		});

		it("an autosave that falls due before the other tab rendered the review sends nothing", async () => {
			harness.autosave.delayMs = 300;
			const { other } = await openRoom();
			await type(other, TYPED);
			reviewArrivesUnrendered(other);
			await settle(700);
			expect(saveCalls).toEqual([]);

			act(() => {
				notify(other);
			});
			await expectHeld(other);
		});

		it("leaving before the other tab rendered the review sends nothing, and offers its typing to copy", async () => {
			harness.autosave.delayMs = 60_000;
			const { other } = await openRoom();
			await type(other, TYPED);
			reviewArrivesUnrendered(other);
			await act(async () => {
				other.view?.unmount();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(100);
			expect(saveCalls).toEqual([]);
			expect(
				vi
					.mocked(toast.error)
					.mock.calls.filter(
						([message]) =>
							message === "leaveWhileProposalElsewhere",
					),
			).toHaveLength(1);
		});

		it("an accepted proposal's save that waited behind another save is not sent once a review elsewhere began, and stays unsaved", async () => {
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await type(tab, TYPED);
			server.holdAnswers = true;
			await waitFor(
				() => {
					expect(saveCalls).toHaveLength(1);
				},
				{ timeout: 3000 },
			);
			const card = cardFor(tab);
			await card.open();
			await card.answer("confirm-button");
			expect(card.respond).toHaveBeenCalledWith({ accepted: true });

			reviewArrivesUnrendered(tab);
			server.holdAnswers = false;
			await act(async () => {
				for (const answer of server.held.splice(0)) {
					answer();
				}
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(100);
			expect(saveCalls).toHaveLength(1);
			expect(server.content).not.toContain(PROPOSED);
			expect(editorBody(tab)).toContain(PROPOSED);
			expect(toast.info).toHaveBeenCalledWith("proposalElsewhereHeld");
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				UNSAVED_ACCEPT_RECORD,
			);
			card.unmount();
		});

		it("an update using context is handed the hold as the room has it now, and says its own review before its preview goes in", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			expect(harness.contextUpdateOptions.heldElsewhere?.()).toBe(false);
			reviewArrivesUnrendered(tab);
			expect(harness.contextUpdateOptions.heldElsewhere?.()).toBe(true);
			tab.awareness.view.delete(ELSEWHERE);

			act(() => {
				harness.contextUpdateOptions.beforePreview?.();
			});
			expect(tab.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD]).toEqual(
				expect.any(String),
			);
		});
	});

	it("a convergence that applied the saved body does not apply it again over a proposal whose review and body reached its editor before it rendered that review", async () => {
		harness.timings.claimSettleMs = 1500;
		harness.timings.fallThroughMs = 60_000;
		await persistRoom(BODY_A, savedStamp());
		const reviewing = await openTab("reviewing", { clientId: 30 });
		const other = await openTab("other", { clientId: 20 });
		await settle(200);

		server.content = BODY_B;
		server.version = 8;
		await nudge(reviewing, other);
		await waitFor(
			() => {
				expect(readConvergenceClaim(room.doc)).toMatchObject({
					clientId: 20,
				});
				expect(editorBody(other)).toContain("rewritten by the run");
				expect(editorBody(reviewing)).toContain("rewritten by the run");
			},
			{ timeout: 5000 },
		);

		// The review and its body reach the claimant, which renders neither
		// before its read-back falls due.
		const listening = new Set(other.awareness.listeners);
		other.awareness.listeners.clear();
		const card = cardFor(reviewing);
		await card.open();
		expect(
			other.awareness.view.get(30)?.[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toEqual(expect.any(String));
		expect(editorBody(other)).toContain(PROPOSED);
		await settle(2500);
		expect(editorBody(other)).toContain(PROPOSED);
		expect(await roomBody()).toContain(PROPOSED);

		for (const listener of listening) {
			other.awareness.listeners.add(listener);
		}
		act(() => {
			notify(other);
		});
		await card.answer("reject-button");
		await waitFor(
			() => {
				expect(readConvergenceClaim(room.doc)).toMatchObject({
					clientId: 20,
					settled: "verified",
				});
			},
			{ timeout: 5000 },
		);
		expect(await roomBody()).not.toContain(PROPOSED);
		card.unmount();
	});

	it("two reviews begun before either tab heard of the other: the one that began first holds, the other is answered as not applied, and the room keeps the first one's proposal", async () => {
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const second = await openTab("second", { clientId: 20 });
		await settle(200);
		const OWN = "A paragraph the second tab's assistant proposes.";

		room.paused = true;
		harness.chatIn = "first";
		const firstCard = cardFor(first);
		await firstCard.open();
		harness.chatIn = "second";
		harness.agentState = { document: `${BODY_A}\n\n${OWN}` };
		rerender(second);
		await settle(20);
		const secondCard = cardFor(second);
		await secondCard.open({ streamed: true });
		expect(first.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD]).toEqual(
			expect.any(String),
		);
		expect(second.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD]).toEqual(
			expect.any(String),
		);
		await resume();
		await settle(100);

		// One review holds: the first one's.
		expect(secondCard.respond).toHaveBeenCalledWith({ accepted: false });
		expect(harness.recordOutcome).toHaveBeenCalledWith({
			accepted: false,
			summary:
				"Not applied: another tab was reviewing an assistant proposal.",
		});
		expect(
			second.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toBeNull();
		expect(firstCard.respond).not.toHaveBeenCalled();
		expect(firstCard.offersAnswers()).toBe(true);
		expect(mainEditor(first)?.isEditable).toBe(true);
		expect(heldStatus(first)).toBeNull();
		await expectHeld(second);
		await waitFor(async () => {
			const body = await roomBody();
			expect(body).toContain(PROPOSED);
			expect(body).not.toContain(OWN);
		});
		expect(editorBody(first)).not.toContain(OWN);
		expect(editorBody(second)).not.toContain(OWN);
		expect(occurrences(await roomBody(), PROPOSED)).toBe(1);
		await secondCard.complete();

		// The first one's answer goes, and nobody holds afterwards.
		await firstCard.answer("confirm-button");
		expect(firstCard.respond).toHaveBeenCalledWith({ accepted: true });
		await waitFor(() => {
			expect(server.content).toContain(PROPOSED);
		});
		expect(server.content).not.toContain(OWN);
		await expectResumed(second);
		expect(mainEditor(first)?.isEditable).toBe(true);
		expect(heldStatus(first)).toBeNull();
		firstCard.unmount();
		secondCard.unmount();
	});

	it("two reviews begun at once, the first one still streaming: it puts its streamed frame back over what the other wrote", async () => {
		harness.liveAgentState = true;
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const second = await openTab("second", { clientId: 20 });
		await settle(200);
		const OWN = "A paragraph the second tab's assistant proposes.";

		room.paused = true;
		harness.tabChats.set("first", { loading: true, state: {} });
		rerender(first);
		await settle(20);
		harness.tabChats.set("first", {
			loading: true,
			state: { document: `${BODY_A}\n\n${PROPOSED}` },
		});
		rerender(first);
		await settle(50);
		harness.tabChats.set("second", {
			loading: false,
			state: { document: `${BODY_A}\n\n${OWN}` },
		});
		rerender(second);
		await settle(20);
		const secondCard = cardFor(second);
		await secondCard.open({ streamed: true });
		// The first one's review reaches the second tab before anything else
		// does: it withdraws while its editor still holds its own diff.
		await act(async () => {
			room.queue.shift()?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(50);
		expect(secondCard.respond).toHaveBeenCalledWith({ accepted: false });
		expect(editorBody(second)).toContain(OWN);
		// Its agent works from the body before its proposal, not from that.
		expect(
			String(harness.tabChats.get("second")?.state.document),
		).not.toContain(OWN);
		await resume();
		await settle(100);

		expect(first.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD]).toEqual(
			expect.any(String),
		);
		await waitFor(async () => {
			const body = await roomBody();
			expect(body).toContain(PROPOSED);
			expect(body).not.toContain(OWN);
		});
		expect(occurrences(await roomBody(), PROPOSED)).toBe(1);
		await expectHeld(second);
		secondCard.unmount();
	});

	it("a colleague who reviews nothing and typed before hearing of the review is not written over by it", async () => {
		await persistRoom(BODY_A, savedStamp());
		const reviewing = await openTab("reviewing", { clientId: 10 });
		const other = await openTab("other", { clientId: 20 });
		await settle(200);

		room.paused = true;
		const card = cardFor(reviewing);
		await card.open();
		// The review has not reached the other tab yet.
		expect(mainEditor(other)?.isEditable).toBe(true);
		await type(other, TYPED);
		const writesBefore = reviewing.localUpdates;
		await resume();
		await settle(100);

		expect(reviewing.localUpdates).toBe(writesBefore);
		expect(editorBody(reviewing)).toContain(TYPED.trim());
		expect(editorBody(reviewing)).toContain(PROPOSED);
		expect(await roomBody()).toContain(TYPED.trim());
		await expectHeld(other);
		expect(saveCalls).toEqual([]);
		card.unmount();
	});

	it("two reviews begun at once: a Reject in the first one's tab puts its body back, and nobody holds afterwards", async () => {
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const second = await openTab("second", { clientId: 20 });
		await settle(200);
		const OWN = "A paragraph the second tab's assistant proposes.";

		room.paused = true;
		harness.chatIn = "first";
		const firstCard = cardFor(first);
		await firstCard.open();
		harness.chatIn = "second";
		harness.agentState = { document: `${BODY_A}\n\n${OWN}` };
		rerender(second);
		await settle(20);
		const secondCard = cardFor(second);
		await secondCard.open({ streamed: true });
		await resume();
		await settle(100);
		expect(secondCard.respond).toHaveBeenCalledWith({ accepted: false });
		await secondCard.complete();

		await firstCard.answer("reject-button");
		await expectResumed(second);
		await waitFor(async () => {
			const body = await roomBody();
			expect(body).not.toContain(PROPOSED);
			expect(body).not.toContain(OWN);
			expect(body).toContain("Phase one, then two.");
		});
		expect(saveCalls).toEqual([]);
		firstCard.unmount();
		secondCard.unmount();
	});

	it("a convergence that applied the saved body does not apply it again over a proposal whose review began before it read the body back, and completes once that is answered", async () => {
		// A read-back long enough to begin a review in, and no editor after
		// the first in the election stepping in meanwhile.
		harness.timings.claimSettleMs = 1500;
		harness.timings.fallThroughMs = 60_000;
		await persistRoom(BODY_A, savedStamp());
		// The other tab is first in the election, so its convergence applies.
		const reviewing = await openTab("reviewing", { clientId: 30 });
		const other = await openTab("other", { clientId: 20 });
		await settle(200);

		server.content = BODY_B;
		server.version = 8;
		await nudge(reviewing, other);
		await waitFor(
			() => {
				expect(readConvergenceClaim(room.doc)).toMatchObject({
					clientId: 20,
				});
				expect(editorBody(other)).toContain("rewritten by the run");
				expect(editorBody(reviewing)).toContain("rewritten by the run");
			},
			{ timeout: 5000 },
		);
		expect(readConvergenceClaim(room.doc)?.settled).toBeUndefined();

		// Before the body is read back, a proposal is reviewed over it.
		const card = cardFor(reviewing);
		await card.open();
		expect(editorBody(reviewing)).toContain(PROPOSED);
		// Past the read-back.
		await settle(2500);
		expect(editorBody(reviewing)).toContain(PROPOSED);
		expect(await roomBody()).toContain(PROPOSED);
		expect(readConvergenceClaim(room.doc)?.settled).toBeUndefined();

		await card.answer("reject-button");
		await waitFor(
			() => {
				expect(readConvergenceClaim(room.doc)).toMatchObject({
					clientId: 20,
					settled: "verified",
				});
			},
			{ timeout: 5000 },
		);
		expect(occurrences(await roomBody(), "rewritten by the run")).toBe(1);
		expect(await roomBody()).not.toContain(PROPOSED);
		expect(saveCalls).toEqual([]);
		card.unmount();
	});

	describe("while the reviewing tab's assistant streams it in", () => {
		it("a chat answer that writes nothing into the editor holds nobody", async () => {
			const { reviewing, other } = await openRoom();
			await stream(reviewing, BODY_A);
			await settle(100);

			expect(mainEditor(other)?.isEditable).toBe(true);
			expect(heldStatus(other)).toBeNull();
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD] ??
					null,
			).toBeNull();
		});

		it("holds the other tab from the first frame, before the confirm card, and stays one review through the card until it is answered", async () => {
			const { reviewing, other } = await openRoom();
			harness.chatIn = "reviewing";
			harness.chatLoading = true;
			rerender(reviewing);
			await settle(50);
			// Under way, with nothing written yet.
			expect(mainEditor(other)?.isEditable).toBe(true);
			expect(heldStatus(other)).toBeNull();

			harness.agentState = { document: `${BODY_A}\n\n${PROPOSED}` };
			rerender(reviewing);
			await settle(50);
			await expectHeld(other);
			expect(editorBody(other)).toContain(PROPOSED);
			const review =
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD];
			expect(review).toEqual(expect.any(String));

			// Its confirm card, then the end of the run.
			const card = cardFor(reviewing);
			await card.open({ streamed: true });
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(50);
			expect(card.offersAnswers()).toBe(true);
			// Past the wait for a card: the card holds the same review.
			await settle(2500);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBe(review);
			await expectHeld(other);

			await card.answer("reject-button");
			await expectResumed(other);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
			expect(editorBody(other)).not.toContain(PROPOSED);
			expect(saveCalls).toEqual([]);
			card.unmount();
		});

		it("answered while the run is still under way, the review ends with the answer", async () => {
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			await expectHeld(other);
			const card = cardFor(reviewing);
			await card.open({ streamed: true });

			await card.answer("reject-button");
			await expectResumed(other);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
			card.unmount();
		});

		it("a run that ends without a confirm card takes its frames back out of the room once the card had its moment: the other tab resumes on the body from before the run and never saves them", async () => {
			harness.autosave.delayMs = 1000;
			// The agent's shared state follows what the editor sets.
			harness.liveAgentState = true;
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			await expectHeld(other);
			expect(await roomBody()).toContain(PROPOSED);

			// Stopped, or failed: no card comes.
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(2500);
			await expectResumed(other);
			expect(editorBody(reviewing)).not.toContain(PROPOSED);
			expect(editorBody(other)).not.toContain(PROPOSED);
			expect(await roomBody()).not.toContain(PROPOSED);
			expect(await roomBody()).toContain("Phase one, then two.");
			// The agent's document goes back with it, and it is said.
			expect(harness.agentState.document).not.toContain(PROPOSED);
			expect(toast.info).toHaveBeenCalledWith("assistantRunTakenBack");

			await type(other, TYPED);
			await waitFor(
				() => {
					expect(server.content).toContain(TYPED.trim());
				},
				{ timeout: 3000 },
			);
			expect(saveCalls).toHaveLength(1);
			expect(server.content).not.toContain(PROPOSED);
		});

		it("a run whose confirm card comes keeps its proposal in the room past the card's moment, under review", async () => {
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			const card = cardFor(reviewing);
			await card.open({ streamed: true });
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(2500);
			expect(card.offersAnswers()).toBe(true);
			await expectHeld(other);
			expect(editorBody(reviewing)).toContain(PROPOSED);
			expect(await roomBody()).toContain(PROPOSED);
			card.unmount();
		});

		it("a card that comes after the card's moment still finds the proposal under review while the chat holds its unanswered call, and an Accept saves it", async () => {
			harness.chatMessages = [
				{ id: "user-1", role: "user", content: "Add a paragraph." },
				{
					id: "tools-1",
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call-1",
							type: "function",
							function: {
								name: "confirm_changes",
								arguments: "{}",
							},
						},
					],
				},
			];
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(2500);
			// Its call is on its way: nothing is taken back meanwhile.
			await expectHeld(other);
			expect(await roomBody()).toContain(PROPOSED);
			expect(toast.info).not.toHaveBeenCalledWith(
				"assistantRunTakenBack",
			);

			const card = cardFor(reviewing);
			await card.open({ streamed: true });
			expect(card.offersAnswers()).toBe(true);
			await card.answer("confirm-button");
			expect(card.respond).toHaveBeenCalledWith({ accepted: true });
			await waitFor(() => {
				expect(server.content).toContain(PROPOSED);
			});
			await expectResumed(other);
			card.unmount();
		});

		it("a card its chat announced that never comes is waited for only so long: past the limit the frames are taken back, the editor follows its own body again, and nothing saved the frames meanwhile", async () => {
			harness.timings.proposalCardLateLimitMs = 3000;
			harness.autosave.delayMs = 500;
			harness.liveAgentState = true;
			harness.chatMessages = [
				{ id: "user-1", role: "user", content: "Add a paragraph." },
				{
					id: "tools-1",
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call-1",
							type: "function",
							function: {
								name: "confirm_changes",
								arguments: "{}",
							},
						},
					],
				},
			];
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			// The run failed after naming its call: the call never runs.
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(300);
			// Typing here while the card is awaited autosaves nothing: the
			// editor holds the frames, unanswered.
			await type(reviewing, " Typed while the card was awaited.");
			await settle(1500);
			expect(saveCalls).toEqual([]);
			await expectHeld(other);
			expect(saveButton(reviewing)).toHaveAccessibleDescription(
				"saveBlocked.proposal",
			);

			await settle(3000);
			await expectResumed(other);
			expect(await roomBody()).not.toContain(PROPOSED);
			expect(toast.info).toHaveBeenCalledWith("assistantRunTakenBack");
			expect(saveCalls).toEqual([]);
			// The agent's document follows the editor again.
			await type(reviewing, " Typed afterwards.");
			await waitFor(() => {
				expect(harness.agentState.document).toContain(
					"Typed afterwards.",
				);
			});
			expect(harness.agentState.document).not.toContain(PROPOSED);
			for (const call of saveCalls) {
				expect(String(call.content)).not.toContain(PROPOSED);
			}
		});

		it("a second run started before the first one's frames were taken back is taken back to the body from before the first", async () => {
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(500);
			await stream(
				reviewing,
				`${BODY_A}\n\n${PROPOSED}\n\nA second paragraph.`,
			);
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(2500);

			await expectResumed(other);
			expect(await roomBody()).not.toContain(PROPOSED);
			expect(await roomBody()).not.toContain("A second paragraph.");
			expect(await roomBody()).toContain("Phase one, then two.");
			expect(saveCalls).toEqual([]);
		});

		it("a run that ends without a confirm card releases the other tab once the card had its moment", async () => {
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			await expectHeld(other);

			harness.chatLoading = false;
			rerender(reviewing);
			await settle(500);
			await expectHeld(other);
			await settle(2000);
			await expectResumed(other);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
		});
	});

	describe("what else would write the other tab's body", () => {
		const OWN = "A paragraph the other tab's assistant proposes.";

		function regenerateButton(tab: Tab): HTMLButtonElement | null {
			return (within(tab.view?.container as HTMLElement)
				.queryAllByText("Regenerate")
				.map((label) => label.closest("button"))
				.find(Boolean) ?? null) as HTMLButtonElement | null;
		}

		function regenerateFromChat(
			tab: Tab,
			status: "executing" | "complete",
		) {
			const respond = vi.fn();
			act(() => {
				tab.actions
					.get("regenerate_document")
					?.renderAndWaitForResponse({
						args: { prompt: "Rewrite it" },
						respond,
						status,
					});
			});
			return respond;
		}

		it("Regenerate waits, from its button, its confirmation and the chat, and says why; it can start once the proposal is answered", async () => {
			const { reviewing, other } = await openRoom();
			expect(regenerateButton(other)).not.toBeDisabled();
			// Asked for before the review: its confirmation is open.
			await act(async () => {
				regenerateButton(other)?.click();
			});
			const confirmRegenerate = () =>
				within(other.view?.container as HTMLElement)
					.getAllByRole("button", { name: /Regenerate/ })
					.find((button) => button !== regenerateButton(other));
			expect(confirmRegenerate()).toBeDefined();

			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			expect(regenerateButton(other)).toBeDisabled();
			expect(regenerateButton(other)).toHaveAccessibleDescription(
				"proposalElsewhereHeld",
			);
			await act(async () => {
				confirmRegenerate()?.click();
			});
			const respond = regenerateFromChat(other, "executing");
			await settle(50);
			// Answered as not started, and why.
			expect(respond).toHaveBeenCalledWith({
				accepted: false,
				reason: "heldElsewhere",
			});
			// Rendered again while its call is still executing: still none.
			regenerateFromChat(other, "executing");
			await settle(100);
			expect(toast.info).toHaveBeenCalledWith("proposalElsewhereHeld");
			expect(generate.calls).toBe(0);

			await card.answer("reject-button");
			await expectResumed(other);
			expect(regenerateButton(other)).not.toBeDisabled();
			expect(regenerateButton(other)).not.toHaveAccessibleDescription(
				"proposalElsewhereHeld",
			);
			// The call answered as not started never starts one.
			regenerateFromChat(other, "executing");
			await settle(100);
			expect(generate.calls).toBe(0);
			regenerateFromChat(other, "complete");
			regenerateFromChat(other, "executing");
			await waitFor(() => {
				expect(generate.calls).toBe(1);
			});
			card.unmount();
		});

		it("the chat's line about an answered regeneration says what became of it: not started while another tab reviewed, not applied, or completed", async () => {
			const { other } = await openRoom();
			function answered(result: unknown): string {
				const view = render(
					other.actions
						.get("regenerate_document")
						?.renderAndWaitForResponse({
							args: { prompt: "Rewrite it" },
							respond: vi.fn(),
							status: "complete",
							result,
						}),
				);
				const text = view.container.textContent ?? "";
				view.unmount();
				return text;
			}
			const held = "regenerationCall.heldElsewhere";
			expect(answered({ accepted: false, reason: "heldElsewhere" })).toBe(
				held,
			);
			// As the chat reads it back from the conversation.
			expect(
				answered(
					JSON.stringify({
						accepted: false,
						reason: "heldElsewhere",
					}),
				),
			).toBe(held);
			expect(answered({ accepted: false })).toBe(
				"regenerationCall.notApplied",
			);
			expect(answered({ accepted: true })).toBe(
				"regenerationCall.completed",
			);
			expect(answered(undefined)).toBe("regenerationCall.completed");
		});

		it("version restore waits, and says why", async () => {
			const { reviewing, other } = await openRoom();
			expect(other.versionHistoryProps?.restoreBlockedReason).toBeNull();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			expect(other.versionHistoryProps?.restoreBlockedReason).toBe(
				"proposalElsewhere",
			);
			expect(
				reviewing.versionHistoryProps?.restoreBlockedReason,
			).toBeNull();

			await card.answer("reject-button");
			await expectResumed(other);
			expect(other.versionHistoryProps?.restoreBlockedReason).toBeNull();
			card.unmount();
		});

		it("its own assistant puts nothing in: no frame reaches the room, and its confirm is answered as not applied; once the proposal is answered, a new one is put in and accepted", async () => {
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);

			await stream(other, `${BODY_A}\n\n${OWN}`);
			expect(editorBody(other)).not.toContain(OWN);
			expect(await roomBody()).not.toContain(OWN);
			expect(await roomBody()).toContain(PROPOSED);
			expect(
				other.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD] ?? null,
			).toBeNull();
			harness.chatLoading = false;
			const declined = cardFor(other);
			await declined.open({ streamed: true });
			expect(declined.respond).toHaveBeenCalledWith({ accepted: false });
			expect(declined.offersAnswers()).toBe(false);
			expect(toast.info).toHaveBeenCalledWith("proposalElsewhereHeld");
			expect(editorBody(other)).not.toContain(OWN);
			expect(mainEditor(reviewing)?.isEditable).toBe(true);
			await expectHeld(other);
			await declined.complete();

			await card.answer("reject-button");
			await expectResumed(other);
			await stream(other, `${BODY_A}\n\n${OWN}`);
			expect(editorBody(other)).toContain(OWN);
			harness.chatLoading = false;
			const accepted = cardFor(other);
			await accepted.open({ streamed: true });
			await accepted.answer("confirm-button");
			expect(accepted.respond).toHaveBeenCalledWith({ accepted: true });
			await waitFor(() => {
				expect(server.content).toContain(OWN);
			});
			expect(server.content).not.toContain(PROPOSED);
			card.unmount();
			declined.unmount();
			accepted.unmount();
		});

		it("its own assistant's final diff is not put in either", async () => {
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);

			harness.chatIn = "other";
			harness.agentState = { document: `${BODY_A}\n\n${OWN}` };
			harness.nodeName = "end";
			rerender(other);
			await settle(50);
			expect(editorBody(other)).not.toContain(OWN);
			expect(await roomBody()).not.toContain(OWN);
			expect(await roomBody()).toContain(PROPOSED);
			card.unmount();
		});

		it("its own assistant's run that began while another tab reviewed is not put in, also when its card comes after that review, nor by the run its answer resumes", async () => {
			harness.autosave.delayMs = 1000;
			harness.liveAgentState = true;
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			await stream(other, `${BODY_A}\n\n${OWN}`);

			// Answered while the other tab's run still goes on.
			await card.answer("reject-button");
			await waitFor(() => {
				expect(heldStatus(other)).toBeNull();
			});
			harness.chatLoading = false;
			const late = cardFor(other);
			await late.open({ streamed: true });
			expect(late.respond).toHaveBeenCalledWith({ accepted: false });
			expect(late.offersAnswers()).toBe(false);
			expect(harness.recordOutcome).toHaveBeenCalledWith({
				accepted: false,
				summary:
					"Not applied: another tab was reviewing an assistant proposal.",
			});
			expect(editorBody(other)).not.toContain(OWN);
			expect(await roomBody()).not.toContain(OWN);
			await settle(300);
			expect(saveCalls).toEqual([]);
			await late.complete();

			// The answer resumes the agent for one more short run.
			harness.chatLoading = true;
			rerender(other);
			await settle(100);
			expect(editorBody(other)).not.toContain(OWN);
			expect(await roomBody()).not.toContain(OWN);
			expect(
				other.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD] ?? null,
			).toBeNull();
			harness.chatLoading = false;
			rerender(other);
			await settle(100);
			expect(mainEditor(reviewing)?.isEditable).toBe(true);
			await type(reviewing, " Typed afterwards.");
			await waitFor(
				() => {
					expect(server.content).toContain("Typed afterwards.");
				},
				{ timeout: 3000 },
			);
			for (const call of saveCalls) {
				expect(String(call.content)).not.toContain(OWN);
			}
			card.unmount();
			late.unmount();
		});

		it("its own review is withdrawn when a review that began first elsewhere reaches it: an Accept in the moment before does nothing, its card is answered as not applied, and nothing is written over the room", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const card = cardFor(tab);
			await card.open();
			expect(card.offersAnswers()).toBe(true);

			// Reached the room, not rendered yet.
			tab.awareness.view.set(ELSEWHERE, {
				[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
				[PROPOSAL_REVIEW_AWARENESS_FIELD]: reviewBegun(),
			});
			await card.answer("confirm-button");
			let answered: unknown;
			act(() => {
				answered = harness.reviewBarProps?.onAcceptAll();
			});
			expect(answered).toBeNull();
			expect(card.respond).not.toHaveBeenCalled();
			expect(toast.info).toHaveBeenCalledWith("proposalElsewhereHeld");

			const writesBefore = tab.localUpdates;
			act(() => {
				notify(tab);
			});
			await waitFor(() => {
				expect(card.respond).toHaveBeenCalledWith({ accepted: false });
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith({
				accepted: false,
				summary:
					"Not applied: another tab was reviewing an assistant proposal.",
			});
			await settle(100);
			expect(tab.localUpdates).toBe(writesBefore);
			expect(
				tab.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
			await expectHeld(tab);
			expect(saveCalls).toEqual([]);
			card.unmount();
		});

		it("a Reject of its own proposal in the moment before it withdraws puts nothing back over the room", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const card = cardFor(tab);
			await card.open();

			tab.awareness.view.set(ELSEWHERE, {
				[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
				[PROPOSAL_REVIEW_AWARENESS_FIELD]: reviewBegun(),
			});
			const writesBefore = tab.localUpdates;
			await card.answer("reject-button");
			expect(card.respond).toHaveBeenCalledWith({ accepted: false });
			expect(tab.localUpdates).toBe(writesBefore);
			expect(editorBody(tab)).toContain(PROPOSED);
			card.unmount();
		});

		it("a proposal whose card armed just before a review that began first reached it does not go in", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			harness.agentState = { document: `${BODY_A}\n\n${PROPOSED}` };
			rerender(tab);
			await settle(20);
			const respond = vi.fn();
			let view: ReturnType<typeof render> | null = null;
			await act(async () => {
				const card = tab.actions
					.get("confirm_changes")
					?.renderAndWaitForResponse({
						args: {},
						respond,
						status: "executing",
					});
				// Between the card arming and its diff going in.
				tab.awareness.view.set(ELSEWHERE, {
					[ROOM_PEER_AWARENESS_FIELD]: {
						canEdit: true,
						visible: true,
					},
					[PROPOSAL_REVIEW_AWARENESS_FIELD]: reviewBegun(),
				});
				view = render(card);
				await Promise.resolve();
			});
			await settle(50);
			expect(respond).toHaveBeenCalledWith({ accepted: false });
			expect(editorBody(tab)).not.toContain(PROPOSED);
			expect(
				tab.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD] ?? null,
			).toBeNull();
			(view as ReturnType<typeof render> | null)?.unmount();
		});

		it("an update using context of its own is withdrawn when a review that began first reaches it, and put in again when one that began later wrote over it", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			harness.contextUpdateIn = "tab";
			rerender(tab);
			await settle(20);
			expect(tab.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD]).toEqual(
				expect.any(String),
			);

			// Begun later, and wrote into the room before it withdrew.
			peerStartsReview(reviewBegun(Date.now() + 60_000));
			const later = new Y.Doc();
			later.clientID = ELSEWHERE;
			Y.applyUpdate(later, Y.encodeStateAsUpdate(room.doc));
			const paragraph = new Y.XmlElement("paragraph");
			paragraph.insert(0, [
				new Y.XmlText("Written by the later review."),
			]);
			later.getXmlFragment(ROOM_BODY_FRAGMENT).insert(0, [paragraph]);
			await act(async () => {
				Y.applyUpdate(
					room.doc,
					Y.encodeStateAsUpdate(later, Y.encodeStateVector(room.doc)),
					"later",
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(20);
			expect(harness.contextReassert).toHaveBeenCalledTimes(1);
			expect(harness.contextWithdraw).not.toHaveBeenCalled();

			// Begun first.
			peerStartsReview(reviewBegun());
			await settle(20);
			expect(harness.contextWithdraw).toHaveBeenCalled();
			later.destroy();
		});

		it("a review that began after its own never holds it: its Accept answers, and is saved", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const card = cardFor(tab);
			await card.open();

			peerStartsReview(reviewBegun(Date.now() + 60_000));
			await settle(50);
			expect(mainEditor(tab)?.isEditable).toBe(true);
			expect(heldStatus(tab)).toBeNull();
			expect(card.respond).not.toHaveBeenCalled();
			await card.answer("confirm-button");
			expect(card.respond).toHaveBeenCalledWith({ accepted: true });
			await waitFor(() => {
				expect(server.content).toContain(PROPOSED);
			});
			card.unmount();
		});

		it("an image whose upload finishes while another tab reviews a proposal goes in once that is answered, never meanwhile", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			let stored: (key: string) => void = () => {};
			harness.uploadImage = () =>
				new Promise<string>((resolve) => {
					stored = resolve;
				});
			const images = () => {
				let count = 0;
				mainEditor(tab)?.state.doc.descendants((node) => {
					if (node.type.name === "image") {
						count += 1;
					}
				});
				return count;
			};
			const file = new File(
				[new Uint8Array([137, 80, 78, 71])],
				"flow.png",
				{
					type: "image/png",
				},
			);
			let uploading: Promise<void> | undefined;
			await act(async () => {
				uploading = harness.slashImageUpload?.({
					0: file,
					length: 1,
				} as unknown as FileList);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});

			peerStartsReview();
			await waitFor(() => {
				expect(mainEditor(tab)?.isEditable).toBe(false);
			});
			const roomUpdatesBefore = tab.localUpdates;
			await act(async () => {
				stored("projects/proj-1/documents/doc-1/flow.png");
				await new Promise((resolve) => setTimeout(resolve, 50));
			});
			expect(images()).toBe(0);
			expect(tab.localUpdates).toBe(roomUpdatesBefore);

			peerAnswersReview();
			await act(async () => {
				await uploading;
			});
			expect(images()).toBe(1);
		});

		it("a diagram the assistant suggests is not inserted while another tab reviews a proposal, and is once it is answered", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const suggest = () =>
				tab.actions.get("suggest_diagram")?.handler({
					mermaidCode: "graph TD; Scope-->Pricing",
					rationale: "Shows the order of the phases.",
				});

			peerStartsReview();
			await waitFor(() => {
				expect(mainEditor(tab)?.isEditable).toBe(false);
			});
			let result: unknown;
			await act(async () => {
				result = await suggest();
			});
			expect(result).toEqual(expect.stringContaining("not inserted"));
			expect(editorBody(tab)).not.toContain("Scope-->Pricing");

			peerAnswersReview();
			await waitFor(() => {
				expect(mainEditor(tab)?.isEditable).toBe(true);
			});
			await act(async () => {
				result = await suggest();
			});
			expect(result).toEqual(
				expect.stringContaining("Diagram inserted."),
			);
		});
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

	it("keeps the editor read-only through a sync loss while the Reject is unanswered, and offers back what still reached the editor before the rewind replaces it", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		server.beforeRun = { content: BODY_A, version: 7 };
		await reviewRun(tab);
		server.holdAnswers = true;
		await reject(tab);
		expect(server.held).toHaveLength(1);

		// The room drops and comes back while the Reject is out.
		tab.synced = false;
		rerender(tab);
		await settle(20);
		expect(mainEditor(tab)).toBeNull();
		tab.synced = true;
		rerender(tab);
		await waitFor(() => {
			expect(mainEditor(tab)).not.toBeNull();
		});
		// Past the review's own wind-down.
		await settle(1200);
		expect(mainEditor(tab)?.isEditable).toBe(false);
		expect(saveButton(tab)).toBeDisabled();

		// Typing that reached the editor anyway is not dropped.
		await act(async () => {
			mainEditor(tab)?.setEditable(true);
		});
		await type(tab, " Typed while the Reject was out.");

		await answerOldest();
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual({
				version: 7,
				contentHash: hashOf(BODY_A),
			});
		});
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
			expect.stringContaining("Typed while the Reject was out."),
		);
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(true);
		});
		expect(saveCalls).toEqual([]);
	});

	it("keeps the editor read-only while the Reject is unanswered, and gives it back once the answer is applied", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		server.beforeRun = { content: BODY_A, version: 7 };
		await reviewRun(tab);
		server.holdAnswers = true;

		await reject(tab);
		// Past the review's own wind-down.
		await settle(1200);
		expect(server.held).toHaveLength(1);
		expect(mainEditor(tab)?.isEditable).toBe(false);
		expect(saveButton(tab)).toBeDisabled();

		await answerOldest();
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual({
				version: 7,
				contentHash: hashOf(BODY_A),
			});
		});
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(true);
		});
		expect(editorBody(tab)).toContain("Phase one, then two.");
	});

	it("with nothing to rewind to, the earlier body is not saved over a colleague's save that landed while the Reject was unanswered: the review is said to be stale and the colleague's text stays", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		const colleague = await openTab("colleague");
		await reviewRun(tab);
		server.rejectError = noPriorVersion();
		server.holdAnswers = true;
		await reject(tab);
		expect(server.held).toHaveLength(1);

		// The colleague saves meanwhile; its answer comes first and moves
		// the room's stamp.
		await type(colleague, " Saved by a colleague.");
		await clickSave(colleague);
		await waitFor(() => {
			expect(server.held).toHaveLength(2);
		});
		await act(async () => {
			server.held.splice(1, 1)[0]?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});

		// The Reject's answer: nothing to rewind to.
		server.holdAnswers = false;
		await answerOldest();
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("rejectReviewStale");
		});
		await settle(100);
		expect(saveCalls.map((call) => call.tab)).toEqual(["colleague"]);
		expect(server.version).toBe(9);
		expect(server.content).toContain("Saved by a colleague.");
		expect(await roomBody()).toContain("Saved by a colleague.");
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(true);
		});
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
			expect(toast.error).toHaveBeenCalledWith(
				"failed",
				SAVE_FAILED_TOAST,
			);
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

describe("a regeneration's review in the single-user editor, with the room flag on (Fizzy #2946)", () => {
	const BODY_C =
		"## Scope\n\nPhase one, written after the review opened.\n\n## Pricing\n\nA fixed fee.";

	/**
	 * A run this editor started ends on BODY_B at version 8; its review is
	 * open. `beforeRun` acts on the tab before the run starts.
	 */
	async function soloReview(
		beforeRun?: (tab: Tab) => Promise<void>,
	): Promise<Tab> {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		const tab = await openTab("solo");
		await beforeRun?.(tab);
		await act(async () => {
			tab.actions.get("regenerate_document")?.renderAndWaitForResponse({
				args: { prompt: "Rewrite it" },
				respond: vi.fn(),
				status: "executing",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
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
			expect(editorBody(tab)).toContain("rewritten by the run");
		});
		return tab;
	}

	it("a review a newer saved body superseded closes onto that body, which the next save names as its base", async () => {
		const tab = await soloReview();

		server.content = BODY_C;
		server.version = 9;
		await nudge(tab);
		await waitFor(() => {
			expect(
				tab.view?.queryByTestId("regeneration-confirm-modal"),
			).toBeNull();
		});
		expect(toast.info).toHaveBeenCalledWith("reviewSuperseded");
		await waitFor(() => {
			expect(editorBody(tab)).toContain(
				"written after the review opened",
			);
		});
		expect(editorBody(tab)).not.toContain("rewritten by the run");
		// The review winds down a second after it closes.
		await settle(1200);
		expect(saveButton(tab)).toBeDisabled();

		await type(tab, " Typed after.");
		await clickSave(tab);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 9,
			expectedContentHash: hashOf(BODY_C),
		});
		expect(saveCalls[0]?.content).toContain(
			"written after the review opened",
		);
		expect(saveCalls[0]?.content).toContain("Typed after.");
		await waitFor(() => {
			expect(server.content).toContain("Typed after.");
		});
	});

	async function clickSoloReject(tab: Tab) {
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
	}

	it("ignores the view shortcut while the Reject is unanswered, keeping the raw view's edits", async () => {
		server.beforeRun = { content: BODY_A, version: 7 };
		// Edited in the raw view before the run: the views do not switch,
		// and the raw view takes no input, while it writes or is reviewed.
		const tab = await soloReview(async (solo) => {
			await toggleRawView();
			const edited = `${rawTextarea(solo).value}\n\nEdited in the raw view.`;
			await act(async () => {
				fireEvent.change(rawTextarea(solo), {
					target: { value: edited },
				});
			});
		});
		server.holdAnswers = true;
		await clickSoloReject(tab);
		await settle(1200);
		expect(server.held).toHaveLength(1);

		await toggleRawView();
		expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
		expect(editorBody(tab)).not.toContain("Edited in the raw view.");

		await act(async () => {
			server.held.shift()?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(toast.info).toHaveBeenCalledWith("regenerationRejected");
		});
		await settle(50);
		expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
		expect(saveButton(tab)).not.toBeDisabled();
	});

	it("keeps the editor read-only while the Reject is unanswered", async () => {
		server.beforeRun = { content: BODY_A, version: 7 };
		const tab = await soloReview();
		server.holdAnswers = true;

		await clickSoloReject(tab);
		await settle(1200);
		expect(server.held).toHaveLength(1);
		expect(mainEditor(tab)?.isEditable).toBe(false);
		expect(saveButton(tab)).toBeDisabled();

		await act(async () => {
			server.held.shift()?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(true);
		});
		expect(toast.info).toHaveBeenCalledWith("regenerationRejected");
	});

	it("offers back text typed after the Reject went before a stale refusal brings in the newer saved body", async () => {
		const tab = await soloReview();
		server.rejectError = Object.assign(new Error("stale"), {
			code: "CONFLICT",
			data: { code: "REJECT_REVIEW_STALE" },
		});
		server.holdAnswers = true;
		await clickSoloReject(tab);
		await settle(1200);
		// The editor is read-only meanwhile; typing that still reached it
		// is not dropped.
		await act(async () => {
			mainEditor(tab)?.setEditable(true);
		});
		await type(tab, " Typed while the Reject was out.");
		server.content = BODY_C;
		server.version = 9;

		await act(async () => {
			server.held.shift()?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("rejectReviewStale");
		});
		await waitFor(() => {
			expect(editorBody(tab)).toContain(
				"written after the review opened",
			);
		});
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
			expect.stringContaining("Typed while the Reject was out."),
		);
		expect(saveCalls).toEqual([]);
	});

	it("a Reject the server rewinds to a body other than the one the editor remembered ends on the server's body, saved", async () => {
		server.beforeRun = { content: BODY_C, version: 7 };
		const tab = await soloReview();

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
			expect(toast.info).toHaveBeenCalledWith("regenerationRejected");
		});
		await waitFor(() => {
			expect(editorBody(tab)).toContain(
				"written after the review opened",
			);
		});
		// The rewind is the choice's own doing, not a newer write.
		expect(toast.info).not.toHaveBeenCalledWith("reviewSuperseded");
		expect(editorBody(tab)).not.toContain("Phase one, then two.");
		await settle(1200);
		expect(saveButton(tab)).toBeDisabled();

		await type(tab, " Typed after.");
		await clickSave(tab);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_C),
		});
		expect(saveCalls[0]?.content).toContain(
			"written after the review opened",
		);
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
