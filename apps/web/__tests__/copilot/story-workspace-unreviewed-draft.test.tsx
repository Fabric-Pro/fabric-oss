/**
 * A run that ends with no review — the server failed it, or the user stopped
 * it — leaves its draft's diff marks in the editor with nothing to accept or
 * reject them. The workspace waits `UNREVIEWED_DRAFT_CHECK_DELAY_MS` for a
 * late review, then puts the pre-run text back. The predicate behind that
 * check (`hasUnreviewedDraft`) has unit tests of its own; this file covers the
 * effect that acts on it, end to end, and the window before it fires.
 *
 * The workspace cannot tell a failed run from a stopped one: both are a run
 * that stops loading without a `confirm_changes` review. The two cases below
 * differ in what the draft looked like when the run ended — a final draft
 * painted at `nodeName === "end"`, or a partial one mid-stream.
 *
 * Same harness shape as `story-workspace-tab-mount.test.tsx`: the REAL
 * `@tiptap/react`, markdown round trip and diff pipeline, with CopilotKit
 * stubbed statefully (`copilotStore` plus a `rerender()` to publish a change).
 * `useMutation` records every write, and the hook-level options it was built
 * with, so a test can fail a save the way the server would.
 */

import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render as rtlRender,
	screen,
	waitFor,
} from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function render(ui: Parameters<typeof rtlRender>[0]) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return rtlRender(ui, {
		wrapper: ({ children }) => (
			<QueryClientProvider client={queryClient}>
				<CopilotChatSessionProvider>
					{children}
				</CopilotChatSessionProvider>
			</QueryClientProvider>
		),
	});
}

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
	copilotStore,
	capturedAction,
	capturedEditor,
	capturedInput,
	capturedApply,
	mutationStore,
	mockUseHistoryEnabled,
	proposalReviewStore,
} = vi.hoisted(() => ({
	/**
	 * Stands in for the CopilotKit agent run. The mocked hooks read this during
	 * render, so mutating it and re-rendering is a streaming event landing.
	 */
	copilotStore: {
		isLoading: false,
		agentDocument: "",
		nodeName: undefined as string | undefined,
	},
	/** The last `confirm_changes` action config StoryWorkspace registered. */
	capturedAction: {
		current: null as {
			renderAndWaitForResponse: (payload: {
				args: unknown;
				respond?: (value: unknown) => void;
				status: string;
			}) => unknown;
		} | null,
	},
	/** The live TipTap instance, captured through the editor registry hook. */
	capturedEditor: { current: null as Editor | null },
	/** The editor's "Apply to document" handler, as the launcher receives it. */
	capturedApply: { current: null as ((content: string) => void) | null },
	/** The chat input's config, whose `onBeforeSend` runs before every send. */
	capturedInput: {
		current: null as { onBeforeSend?: () => void } | null,
	},
	/**
	 * Every `mutate()` the workspace fires, with the variables it sent and the
	 * `onError` its `useMutation` was built with. Nothing settles a write unless
	 * a test does.
	 */
	mutationStore: {
		calls: [] as Array<{
			variables: { description?: unknown } | undefined;
			onError?: (
				error: Error,
				variables: unknown,
				context: unknown,
			) => void;
		}>,
	},
	mockUseHistoryEnabled: vi.fn(),
	/** Reports a Proposal Inbox review as open on the ticket. */
	proposalReviewStore: { active: false },
}));

vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({
		state: { document: copilotStore.agentDocument },
		setState: (next: unknown) => {
			const value =
				typeof next === "function"
					? (next as (prev: unknown) => { document?: string })({
							document: copilotStore.agentDocument,
						})
					: (next as { document?: string });
			copilotStore.agentDocument = value?.document ?? "";
		},
		running: copilotStore.isLoading,
		nodeName: copilotStore.nodeName,
	}),
	useCopilotAction: (config: unknown) => {
		capturedAction.current = config as typeof capturedAction.current;
	},
	useCopilotChat: () => ({
		isLoading: copilotStore.isLoading,
		visibleMessages: [],
		appendMessage: vi.fn(),
	}),
	useCopilotChatInternal: () => ({
		messages: [],
		isLoading: copilotStore.isLoading,
		setMessages: vi.fn(),
	}),
	useCopilotReadable: vi.fn(),
}));

// The page reads its agent state through `usePageAgent`; route it to the
// stateful `useCoAgent` fixture above.
vi.mock("@saas/shared/components/copilot/use-page-agent", async () => {
	const core = await import("@copilotkit/react-core");
	return {
		usePageAgent: (name: string, initialState: object) =>
			core.useCoAgent({ name, initialState }),
	};
});

vi.mock("@copilotkit/react-ui", () => ({
	useChatContext: () => ({ setOpen: vi.fn() }),
	CopilotSidebar: ({
		children,
		Header,
	}: {
		children?: ReactNode;
		Header?: React.ComponentType;
	}) => (
		<div data-testid="copilot-sidebar">
			{Header ? <Header /> : null}
			{children}
		</div>
	),
}));

vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/TiptapEditorRegistry",
	async () => {
		const actual = await vi.importActual<
			typeof import("@saas/projects/components/excalidraw-auto-insert/TiptapEditorRegistry")
		>(
			"@saas/projects/components/excalidraw-auto-insert/TiptapEditorRegistry",
		);
		return {
			...actual,
			useRegisterTiptapEditor: ({
				editor,
			}: {
				editor: Editor | null;
			}) => {
				if (editor) {
					capturedEditor.current = editor;
				}
			},
		};
	},
);

vi.mock("@saas/projects/hooks/useDocumentAssistantHistoryEnabled", () => ({
	useDocumentAssistantHistoryEnabled: () => mockUseHistoryEnabled(),
}));

vi.mock("@saas/projects/components/copilot/CopilotSidebarHeader", () => ({
	createCopilotSidebarHeader: () => () => null,
}));

vi.mock("@saas/projects/components/copilot/CopilotHistoryDrawer", () => ({
	CopilotHistoryDrawer: () => null,
}));

vi.mock("@saas/projects/components/copilot/CopilotPersistenceHook", () => ({
	CopilotPersistenceHook: () => null,
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", name: "Test User" } }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/org",
		isOrgContext: true,
	}),
}));

vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useFabricAgentLauncher: () => ({
		launch: vi.fn(),
		registerDocumentEditor: (apply: (content: string) => void) => {
			capturedApply.current = apply;
			return () => undefined;
		},
	}),
	useRegisterFabricAgentContext: vi.fn(),
}));

vi.mock("@saas/agents/hooks/useCodeContextLauncher", () => ({
	useCodeContextLauncher: () => ({ launch: vi.fn() }),
}));

vi.mock("@saas/agents/hooks/useDefaultMcpInlineRender", () => ({
	useDefaultMcpInlineRender: vi.fn(),
}));

vi.mock("@saas/agents/hooks/useFabricMention", () => ({
	useFabricMention: () => ({ extension: null, suggestion: {} }),
}));

vi.mock("@saas/shared/components/copilot/CopilotAssistantMessage", () => ({
	CopilotAssistantMessage: () => null,
}));

vi.mock("@saas/shared/components/copilot/CopilotUserMessage", () => ({
	CopilotUserMessage: () => null,
}));

vi.mock("@saas/shared/components/copilot/CopilotSidebarInput", () => ({
	createCopilotSidebarInput: (config: { onBeforeSend?: () => void }) => {
		capturedInput.current = config;
		return () => null;
	},
}));

vi.mock("@shared/hooks/use-is-overflowing", () => ({
	useIsOverflowing: () => [vi.fn(), false] as const,
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const makeLeaf = () => () => ({
		queryKey: [],
		queryFn: async () => ({}),
		mutationFn: async () => ({}),
	});
	const makeProxy = (): unknown =>
		new Proxy(() => undefined, {
			get: (_t, prop) => {
				if (
					prop === "queryOptions" ||
					prop === "mutationOptions" ||
					prop === "queryKey" ||
					prop === "key"
				) {
					return makeLeaf();
				}
				return makeProxy();
			},
			apply: () => ({
				queryKey: [],
				queryFn: async () => ({}),
			}),
		});
	return { orpc: makeProxy() };
});

vi.mock("@tanstack/react-query", async () => {
	const actual = await vi.importActual<
		typeof import("@tanstack/react-query")
	>("@tanstack/react-query");
	return {
		...actual,
		useMutation: (options?: {
			onError?: (
				error: Error,
				variables: unknown,
				context: unknown,
			) => void;
		}) => ({
			mutate: (variables: { description?: unknown } | undefined) => {
				mutationStore.calls.push({
					variables,
					onError: options?.onError,
				});
			},
			mutateAsync: vi.fn(),
			isPending: false,
		}),
		useQuery: () => ({
			data: undefined,
			isLoading: false,
			refetch: vi.fn(),
		}),
		useQueryClient: () => ({
			invalidateQueries: vi.fn(),
			setQueryData: vi.fn(),
			getQueryData: vi.fn(),
		}),
	};
});

vi.mock("next/navigation", () => ({
	useParams: () => ({}),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	usePathname: () => "/app/projects/p-1/stories/s-1",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (k: string) => k,
}));

vi.mock("react-dom", async () => {
	const actual =
		await vi.importActual<typeof import("react-dom")>("react-dom");
	return {
		...actual,
		createPortal: (node: ReactNode) => node,
		flushSync: (fn: () => void) => fn(),
	};
});

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		loading: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("../../modules/saas/projects/components/EditorToolbar", () => ({
	EditorToolbar: () => null,
}));

vi.mock(
	"../../modules/saas/projects/components/stories/ConvertKindConfirmDialog",
	() => ({ ConvertKindConfirmDialog: () => null }),
);

vi.mock(
	"../../modules/saas/projects/components/stories/FeatureTransitionDialog",
	() => ({ FeatureTransitionDialog: () => null }),
);

vi.mock(
	"../../modules/saas/projects/components/stories/FeatureVersionHistory",
	() => ({ FeatureVersionHistory: () => null }),
);

// The real review hook, reported open while `proposalReviewStore.active`.
vi.mock(
	"../../modules/saas/projects/components/stories/useProposalTicketReview",
	async () => {
		const actual = await vi.importActual<
			typeof import("../../modules/saas/projects/components/stories/useProposalTicketReview")
		>(
			"../../modules/saas/projects/components/stories/useProposalTicketReview",
		);
		return {
			useProposalTicketReview: (
				params: Parameters<typeof actual.useProposalTicketReview>[0],
			) => {
				const review = actual.useProposalTicketReview(params);
				return proposalReviewStore.active
					? { ...review, isActive: true }
					: review;
			},
		};
	},
);

// ---------------------------------------------------------------------------
// Import StoryWorkspace AFTER all mocks are registered.
// ---------------------------------------------------------------------------

import { toast } from "sonner";
import { StoryWorkspace } from "../../modules/saas/projects/components/stories/StoryWorkspace";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGINAL_SPEC = "The exporter writes a CSV file once a day.";
/** The final draft of a run that failed between its draft and its review. */
const FINAL_DRAFT = "The exporter writes a CSV file once an hour.";
/** What a stopped run had streamed so far. */
const PARTIAL_DRAFT = "The exporter writes a JSON file once a day.";
const RESTORE_TOAST =
	"The assistant stopped before its draft was ready for review. Your specification is unchanged.";
/** `UNREVIEWED_DRAFT_CHECK_DELAY_MS` in StoryWorkspace. */
const CHECK_DELAY_MS = 1500;
/** The workspace's autosave debounce. */
const AUTOSAVE_DELAY_MS = 10000;

const baseStory = {
	id: "story-1",
	identifier: "F-001",
	title: "Test feature",
	description: ORIGINAL_SPEC,
	acceptanceCriteria: "",
	statusId: "status-1",
	priority: "P2_MEDIUM",
	size: "M",
	storyPoints: null,
	order: 0,
	roadmapOrder: 0,
	tasks: [],
	assigneeId: null,
	createdById: "user-1",
	createdAt: new Date(),
	updatedAt: new Date(),
	draftingStage: "DRAFTING",
	kind: "FEATURE",
	pmAutoSyncEnabled: false,
	externalId: null,
	externalUrl: null,
	externalMcpServerId: null,
	lastPmSyncStatus: null,
	lastPmSyncError: null,
	lastPmSyncAttemptAt: null,
	lastSyncedAt: null,
	pipelineExecutionId: null,
	source: "USER",
	aiGeneratedTitle: false,
	titleSource: null,
	version: 1,
	draftingStageUpdatedAt: null,
	needsMoreInfo: false,
	reporterName: null,
	reporterSource: null,
	reporterSourceUrl: null,
	isSelectedForSync: false,
	externalSyncStatus: null,
	latestCodingRun: null,
	latestKanbanQueue: null,
};

type StoryProp = Parameters<typeof StoryWorkspace>[0]["story"];

/** Where the page mounts the Save buttons; `createPortal` renders inline here. */
const saveSlot = document.createElement("div");

/** Whether the member on screen has STORY_UPDATE; a viewer's is false. */
const permission = { canEdit: true };

function workspace() {
	return (
		<StoryWorkspace
			story={baseStory as StoryProp}
			canEdit={permission.canEdit}
			projectId="proj-1"
			projectName="Test Project"
			maturationV2
			onClose={vi.fn()}
			saveSlot={saveSlot}
		/>
	);
}

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

type Rerender = (ui: React.ReactElement) => void;

function liveEditor(): Editor {
	const editor = capturedEditor.current;
	if (!editor) {
		throw new Error("the editor was never registered");
	}
	return editor;
}

function hasDiffMarks(): boolean {
	const html = liveEditor().getHTML();
	return html.includes("diff-insert") || html.includes("diff-del");
}

/** The text the editor shows as a draft's insertions. */
function insertedText(): string {
	return Array.from(
		liveEditor().view.dom.querySelectorAll("ins"),
		(node) => node.textContent ?? "",
	).join(" ");
}

/** Every spec body the workspace asked to persist, in order. */
function savedDescriptions(): string[] {
	return mutationStore.calls
		.map((call) => call.variables?.description)
		.filter((description): description is string => {
			return typeof description === "string";
		});
}

async function publish(rerender: Rerender): Promise<void> {
	await act(async () => {
		rerender(workspace());
	});
}

async function advance(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

async function startRun(rerender: Rerender): Promise<void> {
	copilotStore.isLoading = true;
	await publish(rerender);
}

async function streamDraft(
	rerender: Rerender,
	draft: string,
	nodeName?: string,
): Promise<void> {
	copilotStore.agentDocument = draft;
	copilotStore.nodeName = nodeName;
	await publish(rerender);
}

/** The chat input's pre-send sync, then the render that publishes it. */
async function sendChatMessage(rerender: Rerender): Promise<void> {
	const onBeforeSend = capturedInput.current?.onBeforeSend;
	if (!onBeforeSend) {
		throw new Error("the chat input was never created");
	}
	await act(async () => {
		onBeforeSend();
	});
	await publish(rerender);
}

/** The run stops loading and no `confirm_changes` review follows. */
async function endRunWithoutReview(rerender: Rerender): Promise<void> {
	copilotStore.isLoading = false;
	await publish(rerender);
}

/** Invoke the `confirm_changes` HITL renderer the way CopilotKit does. */
async function arriveAtConfirmation(): Promise<void> {
	await act(async () => {
		capturedAction.current?.renderAndWaitForResponse({
			args: {},
			respond: vi.fn(),
			status: "executing",
		});
	});
}

/**
 * Mount on real timers (the editor is created in an effect and the harness
 * waits for it), then hand every later `setTimeout` to the test.
 */
async function mount(): Promise<{ rerender: Rerender; unmount: () => void }> {
	const { rerender, unmount } = render(workspace());
	await waitFor(() => expect(capturedEditor.current).not.toBeNull());
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	return { rerender, unmount };
}

/**
 * An edit made before the run, saved by the run's start, and that save
 * failing: the story is left with unsaved changes the run never saw. Insert
 * twice: the workspace skips the first editor update it sees, and that may be
 * this one.
 */
async function editThenFailTheRunStartSave(rerender: Rerender): Promise<void> {
	await act(async () => {
		liveEditor().commands.insertContent("Edited by hand. ");
		liveEditor().commands.insertContent("Reviewed. ");
	});
	await startRun(rerender);
	const flush = mutationStore.calls.find(
		(call) => typeof call.variables?.description === "string",
	);
	if (!flush?.onError) {
		throw new Error("the run's start flushed no save");
	}
	const failSave = flush.onError;
	await act(async () => {
		failSave(new Error("Network error"), flush.variables, undefined);
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StoryWorkspace — a run that ends without a review", () => {
	beforeEach(() => {
		mockUseHistoryEnabled.mockReturnValue(false);
		copilotStore.isLoading = false;
		copilotStore.agentDocument = "";
		copilotStore.nodeName = undefined;
		capturedAction.current = null;
		capturedEditor.current = null;
		capturedInput.current = null;
		capturedApply.current = null;
		mutationStore.calls = [];
		vi.mocked(toast.info).mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		{
			outcome: "fails on the server after its final draft",
			draft: FINAL_DRAFT,
			nodeName: "end",
			draftWord: "hour",
		},
		{
			outcome: "is stopped part way through its draft",
			draft: PARTIAL_DRAFT,
			nodeName: "chat_node",
			draftWord: "JSON",
		},
	])(
		"puts the pre-run text back when the run $outcome, and saves nothing",
		async ({ draft, nodeName, draftWord }) => {
			const { rerender } = await mount();

			await startRun(rerender);
			await streamDraft(rerender, draft, nodeName);
			await endRunWithoutReview(rerender);

			// Precondition: the draft is on screen with nothing to resolve it.
			expect(hasDiffMarks()).toBe(true);
			expect(liveEditor().getHTML()).toContain(draftWord);

			// A late review could still arrive: nothing changes before the delay.
			await advance(CHECK_DELAY_MS - 1);
			expect(hasDiffMarks()).toBe(true);
			expect(toast.info).not.toHaveBeenCalled();

			await advance(1);
			expect(hasDiffMarks()).toBe(false);
			expect(liveEditor().getHTML()).toContain("once a day");
			expect(liveEditor().getHTML()).not.toContain(draftWord);
			expect(copilotStore.agentDocument).toContain("once a day");
			expect(copilotStore.agentDocument).not.toContain(draftWord);
			expect(toast.info).toHaveBeenCalledTimes(1);
			expect(toast.info).toHaveBeenCalledWith(RESTORE_TOAST);
			expect(liveEditor().isEditable).toBe(true);

			// The restored text is what the server holds, so no autosave follows.
			await advance(AUTOSAVE_DELAY_MS * 2);
			expect(savedDescriptions()).toEqual([]);
		},
	);

	it("keeps the editor read-only until the draft is put back, so nothing typed is overwritten", async () => {
		const { rerender } = await mount();
		expect(liveEditor().isEditable).toBe(true);

		await startRun(rerender);
		await streamDraft(rerender, PARTIAL_DRAFT, "chat_node");
		await endRunWithoutReview(rerender);

		// The run is over, but the draft is about to be replaced: a keystroke
		// now would be lost to the restore.
		expect(hasDiffMarks()).toBe(true);
		expect(liveEditor().isEditable).toBe(false);

		await advance(CHECK_DELAY_MS);
		expect(hasDiffMarks()).toBe(false);
		expect(liveEditor().isEditable).toBe(true);
	});

	it("hands the draft to a review that arrives during the wait, without putting the pre-run text back", async () => {
		const { rerender } = await mount();

		await startRun(rerender);
		await streamDraft(rerender, FINAL_DRAFT, "end");
		await endRunWithoutReview(rerender);
		expect(liveEditor().isEditable).toBe(false);

		await arriveAtConfirmation();
		expect(liveEditor().isEditable).toBe(true);

		await advance(CHECK_DELAY_MS * 2);
		expect(hasDiffMarks()).toBe(true);
		expect(liveEditor().getHTML()).toContain("hour");
		expect(toast.info).not.toHaveBeenCalled();
	});

	it("holds an autosave that comes due before the draft is put back, then saves the restored text", async () => {
		const { rerender } = await mount();

		// The failed save re-arms autosave for one debounce later.
		await editThenFailTheRunStartSave(rerender);

		await streamDraft(rerender, PARTIAL_DRAFT, "chat_node");
		await advance(AUTOSAVE_DELAY_MS - 1000);
		await endRunWithoutReview(rerender);
		expect(hasDiffMarks()).toBe(true);
		const savesBeforeWindow = savedDescriptions().length;

		// The re-armed autosave comes due while the draft is still on screen.
		await advance(1000);
		expect(savedDescriptions()).toHaveLength(savesBeforeWindow);

		await advance(CHECK_DELAY_MS - 1000);
		expect(hasDiffMarks()).toBe(false);

		// It runs once the pre-run text is back, and saves that text.
		await advance(AUTOSAVE_DELAY_MS);
		const saved = savedDescriptions();
		expect(saved).toHaveLength(savesBeforeWindow + 1);
		expect(saved.at(-1)).toContain("Edited by hand.");
		expect(saved.at(-1)).not.toContain("JSON");
	});

	it("holds Ctrl+S and the Save button while the draft waits to be put back, then saves the pre-run text", async () => {
		const { rerender } = await mount();
		await editThenFailTheRunStartSave(rerender);
		await streamDraft(rerender, PARTIAL_DRAFT, "chat_node");
		await endRunWithoutReview(rerender);
		expect(hasDiffMarks()).toBe(true);
		const savesBeforeWindow = savedDescriptions().length;
		const pressSaveShortcut = () =>
			act(async () => {
				fireEvent.keyDown(window, { key: "s", ctrlKey: true });
			});

		// The story has unsaved changes, but what is on screen is the draft.
		expect(
			screen.getByRole("button", { name: "Save story" }),
		).toBeDisabled();
		await pressSaveShortcut();
		expect(savedDescriptions()).toHaveLength(savesBeforeWindow);

		await advance(CHECK_DELAY_MS);
		expect(hasDiffMarks()).toBe(false);
		expect(
			screen.getByRole("button", { name: "Save story" }),
		).toBeEnabled();

		await pressSaveShortcut();
		const saved = savedDescriptions();
		expect(saved).toHaveLength(savesBeforeWindow + 1);
		expect(saved.at(-1)).toContain("Edited by hand.");
		expect(saved.at(-1)).not.toContain("JSON");
	});

	it("starts the wait when the draft is painted after the run has ended", async () => {
		const { rerender } = await mount();
		await startRun(rerender);
		await endRunWithoutReview(rerender);
		expect(hasDiffMarks()).toBe(false);
		expect(liveEditor().isEditable).toBe(true);

		// The run's final state lands after its loading state has ended.
		await streamDraft(rerender, FINAL_DRAFT, "end");
		expect(hasDiffMarks()).toBe(true);
		expect(liveEditor().isEditable).toBe(false);

		await advance(CHECK_DELAY_MS);
		expect(hasDiffMarks()).toBe(false);
		expect(liveEditor().isEditable).toBe(true);
		expect(liveEditor().getHTML()).toContain("CSV file once a day");
	});

	it("saves the pre-run text, not the draft, when the editor closes during the wait", async () => {
		const { rerender, unmount } = await mount();
		await editThenFailTheRunStartSave(rerender);
		await streamDraft(rerender, PARTIAL_DRAFT, "chat_node");
		await endRunWithoutReview(rerender);
		expect(hasDiffMarks()).toBe(true);
		const savesBeforeClose = savedDescriptions().length;

		unmount();

		const saved = savedDescriptions();
		expect(saved).toHaveLength(savesBeforeClose + 1);
		expect(saved.at(-1)).toContain("Edited by hand.");
		expect(saved.at(-1)).not.toContain("JSON");
	});

	it("saves nothing when the editor closes during the wait with the pre-run text already saved", async () => {
		const { rerender, unmount } = await mount();
		await startRun(rerender);
		await streamDraft(rerender, PARTIAL_DRAFT, "chat_node");
		await endRunWithoutReview(rerender);
		expect(hasDiffMarks()).toBe(true);

		unmount();

		expect(savedDescriptions()).toEqual([]);
	});

	it("starts a run begun during the wait from the pre-run text, not the draft", async () => {
		const { rerender } = await mount();

		await startRun(rerender);
		await streamDraft(rerender, PARTIAL_DRAFT, "chat_node");
		await endRunWithoutReview(rerender);
		expect(hasDiffMarks()).toBe(true);

		// A second run starts before the first run's draft is put back.
		await startRun(rerender);
		expect(toast.info).toHaveBeenCalledWith(RESTORE_TOAST);
		expect(copilotStore.agentDocument).toContain("CSV file once a day");

		// Its draft is diffed against the pre-run text, and when it too ends
		// without a review, the pre-run text is what comes back.
		await streamDraft(rerender, FINAL_DRAFT, "end");
		expect(liveEditor().getHTML()).toContain("hour");
		expect(liveEditor().getHTML()).not.toContain("JSON");
		await endRunWithoutReview(rerender);
		await advance(CHECK_DELAY_MS);
		expect(hasDiffMarks()).toBe(false);
		expect(liveEditor().getHTML()).toContain("CSV file once a day");
		expect(liveEditor().getHTML()).not.toContain("JSON");
		expect(savedDescriptions()).toEqual([]);
	});

	it("keeps text typed just before a send in the run's baseline and its save, not in its draft", async () => {
		const { rerender } = await mount();
		// A previous run that changed nothing leaves `nodeName` at "end".
		await startRun(rerender);
		await streamDraft(rerender, copilotStore.agentDocument, "end");
		await endRunWithoutReview(rerender);
		await advance(CHECK_DELAY_MS);
		expect(hasDiffMarks()).toBe(false);

		// The first edit marks the story unsaved and re-renders the workspace;
		// the second changes only the editor.
		await act(async () => {
			liveEditor().commands.insertContent("Edited by hand. ");
		});
		await act(async () => {
			liveEditor().commands.insertContent("Typed before sending. ");
		});

		await sendChatMessage(rerender);
		expect(hasDiffMarks()).toBe(false);

		await startRun(rerender);
		expect(toast.info).not.toHaveBeenCalled();
		expect(savedDescriptions().at(-1)).toContain("Typed before sending.");

		// The run changes one word, and only that change is its draft.
		await streamDraft(
			rerender,
			copilotStore.agentDocument.replace("once a day", "once an hour"),
			"end",
		);
		expect(insertedText()).toContain("hour");
		expect(insertedText()).not.toContain("Typed before sending.");

		// With no review, the draft goes and the typed text stays.
		await endRunWithoutReview(rerender);
		await advance(CHECK_DELAY_MS);
		expect(hasDiffMarks()).toBe(false);
		expect(liveEditor().getHTML()).toContain("Typed before sending.");
		expect(liveEditor().getHTML()).toContain("once a day");
	});

	it("keeps text applied to the document as a direct edit, not a draft to put back", async () => {
		const { rerender } = await mount();
		// A previous run that changed nothing leaves `nodeName` at "end".
		await startRun(rerender);
		await streamDraft(rerender, copilotStore.agentDocument, "end");
		await endRunWithoutReview(rerender);
		await advance(CHECK_DELAY_MS);
		expect(hasDiffMarks()).toBe(false);
		const apply = capturedApply.current;
		if (!apply) {
			throw new Error(
				"the editor never registered for Apply to document",
			);
		}

		await act(async () => {
			apply(`${ORIGINAL_SPEC}\n\nApplied from the agent.`);
		});
		await publish(rerender);

		expect(hasDiffMarks()).toBe(false);
		expect(liveEditor().isEditable).toBe(true);

		await advance(CHECK_DELAY_MS);
		expect(toast.info).not.toHaveBeenCalled();
		expect(liveEditor().getHTML()).toContain("Applied from the agent.");

		// The next run's start saves the applied text.
		await startRun(rerender);
		expect(savedDescriptions().at(-1)).toContain("Applied from the agent.");
	});
});

/**
 * While a Proposal Inbox update is under review on the ticket, the editor
 * holds changes nobody accepted yet: the body stays read-only, and no edit,
 * autosave or Save writes it.
 */
describe("StoryWorkspace — while a Proposal Inbox update is under review", () => {
	beforeEach(() => {
		mockUseHistoryEnabled.mockReturnValue(false);
		copilotStore.isLoading = false;
		copilotStore.agentDocument = "";
		copilotStore.nodeName = undefined;
		capturedAction.current = null;
		capturedEditor.current = null;
		capturedInput.current = null;
		capturedApply.current = null;
		mutationStore.calls = [];
		proposalReviewStore.active = false;
	});

	afterEach(() => {
		vi.useRealTimers();
		proposalReviewStore.active = false;
	});

	async function setReviewOpen(rerender: Rerender, open: boolean) {
		proposalReviewStore.active = open;
		await publish(rerender);
	}

	it("keeps the body read-only through an AI run, until the review ends", async () => {
		const { rerender } = await mount();

		await setReviewOpen(rerender, true);
		expect(liveEditor().isEditable).toBe(false);

		await startRun(rerender);
		await endRunWithoutReview(rerender);
		expect(liveEditor().isEditable).toBe(false);

		await setReviewOpen(rerender, false);
		expect(liveEditor().isEditable).toBe(true);
	});

	it("does not take a change in the body as an edit", async () => {
		const { rerender } = await mount();
		await setReviewOpen(rerender, true);

		// Even when something makes the body editable again.
		await act(async () => {
			liveEditor().setEditable(true);
			liveEditor().commands.insertContent("Typed during the review. ");
			liveEditor().commands.insertContent("Again. ");
		});
		await advance(AUTOSAVE_DELAY_MS * 2);

		expect(savedDescriptions()).toEqual([]);
		expect(
			screen.getByRole("button", {
				name: "Story saved, no changes to save",
			}),
		).toBeDisabled();
	});

	it("holds an autosave and Ctrl+S that come due while it is open", async () => {
		const { rerender } = await mount();
		// Insert twice: the workspace skips the first editor update it sees.
		await act(async () => {
			liveEditor().commands.insertContent("Edited by hand. ");
			liveEditor().commands.insertContent("Reviewed. ");
		});
		await setReviewOpen(rerender, true);

		await advance(AUTOSAVE_DELAY_MS * 2);
		await act(async () => {
			fireEvent.keyDown(window, { key: "s", ctrlKey: true });
		});

		expect(savedDescriptions()).toEqual([]);
		expect(
			screen.getByRole("button", { name: "Save story" }),
		).toBeDisabled();
	});
});

/**
 * A member without STORY_UPDATE, such as a project viewer, reads the story:
 * the body stays read-only, and no edit, autosave or Save writes it (the
 * server would refuse each one).
 */
describe("StoryWorkspace — for a member who cannot edit the story", () => {
	beforeEach(() => {
		mockUseHistoryEnabled.mockReturnValue(false);
		copilotStore.isLoading = false;
		copilotStore.agentDocument = "";
		copilotStore.nodeName = undefined;
		capturedAction.current = null;
		capturedEditor.current = null;
		capturedInput.current = null;
		capturedApply.current = null;
		mutationStore.calls = [];
		permission.canEdit = false;
	});

	afterEach(() => {
		vi.useRealTimers();
		permission.canEdit = true;
	});

	it("keeps the body read-only, also once an AI run ends", async () => {
		const { rerender } = await mount();
		expect(liveEditor().isEditable).toBe(false);

		await startRun(rerender);
		await endRunWithoutReview(rerender);

		expect(liveEditor().isEditable).toBe(false);
	});

	it("saves nothing by autosave, Ctrl+S or the Save button", async () => {
		await mount();

		// Even when something makes the body editable.
		await act(async () => {
			liveEditor().setEditable(true);
			liveEditor().commands.insertContent("Typed by a viewer. ");
			liveEditor().commands.insertContent("Again. ");
		});
		await advance(AUTOSAVE_DELAY_MS * 2);
		await act(async () => {
			fireEvent.keyDown(window, { key: "s", ctrlKey: true });
		});

		expect(savedDescriptions()).toEqual([]);
		expect(
			screen.getByRole("button", { name: "Save story" }),
		).toBeDisabled();
	});
});
