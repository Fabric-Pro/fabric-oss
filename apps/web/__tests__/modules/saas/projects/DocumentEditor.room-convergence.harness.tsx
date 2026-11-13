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
 *     underneath it; the answer, a run that ends without a card or the
 *     reviewing tab leaving ends the hold, and nothing the other tab typed
 *     before is lost;
 *   - a proposal the room holds that nobody reviews — its tab died, its
 *     state stayed out of the room, or its tab lost the sync — holds every
 *     tab that may edit the same way, saying so, for the card's late limit;
 *     a review back in time holds them as before, and past it the proposal
 *     is rejected where it stands, typing around it kept, by however many
 *     tabs at once, and nothing of it is ever saved; a reviewing tab whose
 *     proposal was rejected under it answers its card as not applied;
 *   - with the flag off the editor seeds, saves and converges as before.
 *
 * Harness: one room Y.Doc and one Y.Doc per tab, linked by a relay a test
 * can pause; the collaboration hook returns the tab's real document and a
 * sync flag; the editor is a real TipTap editor bound to that document by
 * the real collaboration extension (the caret is left out: it needs a
 * y-protocols awareness, which does not resolve from apps/web, so awareness
 * is a hand-linked fake carried by the same relay). Each tab has its own
 * query client; the fake server tells tabs apart by it.
 *
 * Layout (Fizzy #3560): these tests were one file that ran ~261s on a single
 * Vitest worker and set @repo/web's CI wall clock. They are now split by
 * whole top-level `describe` blocks into DocumentEditor.room-convergence.
 * {run-end,accepted-proposals,peer-review,group-1..5}.test.tsx so Vitest can
 * run them on separate workers; the group files hold several unrelated
 * blocks, balanced by duration. This module holds the one copy of the
 * mocks, state, helpers and per-test hooks. A split file must import
 * everything at runtime, vitest included, from this module only: a direct
 * import of a mocked module sorts above this one and can load the real
 * module before the mocks are registered.
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
		/** The server's `projects.proposalArtifact.reviseSection`. */
		reviseSection: vi.fn(),
		/** The section revision handed to a tab's editor, by tab. */
		sectionRevisionRequests: new Map<
			string,
			{ id: string; runId: string; findingId: string }
		>(),
		/** What the editors said of their section revisions. */
		sectionRevisionOutcomes: [] as Array<Record<string, unknown>>,
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
	// The regenerate confirmation asks whether web research is available.
	if (joined === "projects.documents.webResearchAvailability") {
		return { available: false, missing: ["search", "read"] };
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
					path.join(".") === "projects.proposalArtifact.reviseSection"
				) {
					return harness.reviseSection(args[0]);
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
		useFrontendTool: () => {},
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
import { diffPartialText, fromMarkdown } from "@saas/projects/lib/diff-utils";
import {
	acceptChange,
	type DiffRange,
	findDiffRanges,
} from "@saas/projects/lib/editor-diff-marks";

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

import { buildSectionMap } from "@repo/utils/proposal-artifact/section-hash";
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
					sectionRevisionRequest={
						harness.sectionRevisionRequests.get(tab.name) ?? null
					}
					onSectionRevisionSettled={(outcome) =>
						harness.sectionRevisionOutcomes.push({
							tab: tab.name,
							...outcome,
						})
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
	harness.reviseSection.mockReset();
	harness.sectionRevisionRequests = new Map();
	harness.sectionRevisionOutcomes = [];
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

/** The editor's own undo, as Cmd+Z runs it. */
async function undo(tab: Tab) {
	await act(async () => {
		mainEditor(tab)?.commands.undo();
	});
	await settle(220);
}

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
// Capture imported bindings after mock registration and module initialization.
// Re-exporting imports directly can evaluate them before the async hoisted harness.
const shared_act = act;
const shared_waitFor = waitFor;
const shared_within = within;
const shared_Editor = Editor;
const shared_describe = describe;
const shared_expect = expect;
const shared_it = it;
const shared_vi = vi;
const shared_Y = Y;
const shared_GENERATION_RUN_AWARENESS_FIELD = GENERATION_RUN_AWARENESS_FIELD;
const shared_ROOM_META_MAP = ROOM_META_MAP;
const shared_ROOM_SAVE_AWARENESS_FIELD = ROOM_SAVE_AWARENESS_FIELD;
const shared_readConvergenceClaim = readConvergenceClaim;
const shared_readRoomStamp = readRoomStamp;
const shared_transactionTouches = transactionTouches;
const shared_ROOM_BODY_FRAGMENT = ROOM_BODY_FRAGMENT;
const shared_toast = toast;
const shared_fireEvent = fireEvent;
const shared_beforeEach = beforeEach;
const shared_render = render;
const shared_Fragment = Fragment;
const shared_fromMarkdown = fromMarkdown;
const shared_PROPOSAL_REVIEW_AWARENESS_FIELD = PROPOSAL_REVIEW_AWARENESS_FIELD;
const shared_ROOM_PEER_AWARENESS_FIELD = ROOM_PEER_AWARENESS_FIELD;
const shared_writeConvergenceClaim = writeConvergenceClaim;
const shared_acceptChange = acceptChange;
type SharedDiffRange = DiffRange;
const shared_findDiffRanges = findDiffRanges;
const shared_isRoomBodyEmpty = isRoomBodyEmpty;
const shared_useCopilotReadable = useCopilotReadable;
const shared_diffPartialText = diffPartialText;
const shared_buildSectionMap = buildSectionMap;
const shared_createCollaborativeExtensions = createCollaborativeExtensions;
const shared_userEvent = userEvent;
type shared_Editor = Editor;
export {
	shared_act as act,
	shared_waitFor as waitFor,
	shared_within as within,
	shared_Editor as Editor,
	shared_describe as describe,
	shared_expect as expect,
	shared_it as it,
	shared_vi as vi,
	shared_Y as Y,
	type Tab,
	harness,
	server,
	saveCalls,
	hashOf,
	savedStamp,
	shared_GENERATION_RUN_AWARENESS_FIELD as GENERATION_RUN_AWARENESS_FIELD,
	shared_ROOM_META_MAP as ROOM_META_MAP,
	shared_ROOM_SAVE_AWARENESS_FIELD as ROOM_SAVE_AWARENESS_FIELD,
	shared_readConvergenceClaim as readConvergenceClaim,
	shared_readRoomStamp as readRoomStamp,
	shared_transactionTouches as transactionTouches,
	shared_ROOM_BODY_FRAGMENT as ROOM_BODY_FRAGMENT,
	shared_toast as toast,
	BODY_A,
	BODY_B,
	room,
	resume,
	persistRoom,
	roomBody,
	occurrences,
	openTab,
	mainEditor,
	editorBody,
	settle,
	rerender,
	nudge,
	type,
	saveButton,
	roomEditorContent,
	savedBodyViewText,
	toggleRawView,
	rawTextarea,
	offerBackCalls,
	shared_fireEvent as fireEvent,
	shared_beforeEach as beforeEach,
	SAVE_FAILED_TOAST,
	clickSave,
	showsSavedBody,
	shared_render as render,
	shared_userEvent as userEvent,
	shared_Fragment as Fragment,
	shared_fromMarkdown as fromMarkdown,
	SAVED_ACCEPT_RECORD,
	FAILED_ACCEPT_RECORD,
	FAILED_OFFERED_ACCEPT_RECORD,
	UNDONE_ACCEPT_RECORD,
	CLOSED_ACCEPT_RECORD,
	UNSAVED_ACCEPT_RECORD,
	undo,
	generate,
	shared_PROPOSAL_REVIEW_AWARENESS_FIELD as PROPOSAL_REVIEW_AWARENESS_FIELD,
	shared_ROOM_PEER_AWARENESS_FIELD as ROOM_PEER_AWARENESS_FIELD,
	shared_writeConvergenceClaim as writeConvergenceClaim,
	shared_acceptChange as acceptChange,
	type SharedDiffRange as DiffRange,
	shared_findDiffRanges as findDiffRanges,
	notify,
	addPeer,
	shared_isRoomBodyEmpty as isRoomBodyEmpty,
	shared_useCopilotReadable as useCopilotReadable,
	shared_diffPartialText as diffPartialText,
	shared_buildSectionMap as buildSectionMap,
	shared_createCollaborativeExtensions as createCollaborativeExtensions,
};
