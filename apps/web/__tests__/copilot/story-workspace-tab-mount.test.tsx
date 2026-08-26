/**
 * CHARACTERIZATION — does a pending AI draft survive a Feature Maturation V2
 * tab round trip?
 *
 * In v2 the Clean Specification region is rendered only while
 * `maturationTab === "cleanSpec"` (StoryWorkspace.tsx ~6112), so switching to
 * Summary & Questions unmounts `<EditorContent>` and the `<DiffReviewBar>`.
 * The open question this file answers — before any production change is made —
 * is whether that unmount *destroys* the pending review:
 *
 *   1. the TipTap instance is created at component top level via
 *      `useEditor(..., [])`, not inside the tab gate, and
 *   2. `@tiptap/react`'s `PureEditorContent.componentWillUnmount` moves the
 *      editor DOM into a detached `<div>` and never destroys the view, and
 *   3. `isAwaitingConfirmation` / `confirmCallbacksRef` are component-level
 *      React state, unrelated to the active tab.
 *
 * The answer these tests record is that it does NOT: the document, its diff
 * marks and the pending confirmation all come back intact, and the instance is
 * the same object it was before the trip. No mounting change was made on the
 * strength of this file — it exists to keep that true. (Confirmed by
 * falsification: scoping `useEditor`'s deps to the active tab turns three of
 * these red.)
 *
 * What demonstrably does NOT survive is *reach*: the accept / reject controls
 * are absent from the DOM entirely while another tab is active (asserted
 * below), which is the gap the cross-tab review banner closes.
 *
 * Unlike its neighbours in this directory, this file runs the REAL
 * `@tiptap/react`, the real Turndown/markdown round trip, the real
 * `diffPartialText` pipeline and the real `<DiffReviewBar>` — stubbing any of
 * them would characterize the stub instead of the editor. CopilotKit is still
 * stubbed, but statefully: `copilotStore` stands in for the agent run, and a
 * `rerender()` is what publishes a store change to the component (the mocked
 * hooks read the store during render).
 *
 * Mount scaffold derived from story-workspace-history-mount.test.tsx.
 */

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { copilotStore, capturedAction, capturedEditor, mockUseHistoryEnabled } =
	vi.hoisted(() => ({
		/**
		 * Stands in for the CopilotKit agent run. The mocked `useCopilotChat` /
		 * `useCoAgent` read this during render, so mutating it and re-rendering
		 * is equivalent to a streaming event landing.
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
		capturedEditor: { current: null as { getHTML: () => string } | null },
		mockUseHistoryEnabled: vi.fn(),
	}));

// ---------------------------------------------------------------------------
// Mock CopilotKit and its UI — the runtime requires a real provider; we
// stub the sidebar so children render directly into the harness.
// ---------------------------------------------------------------------------

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
	// Capture the `confirm_changes` config so the test can invoke the HITL
	// renderer at the same seam CopilotKit does.
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

vi.mock("@copilotkit/runtime-client-gql", () => ({
	MessageRole: { User: "user", Assistant: "assistant", System: "system" },
	TextMessage: class {},
}));

// ---------------------------------------------------------------------------
// Capture the live editor instance. `useRegisterTiptapEditor` is called at
// StoryWorkspace's top level (outside the tab gate), which makes it the only
// seam that hands us the instance no matter which tab is active. Everything
// else in the module stays real.
// ---------------------------------------------------------------------------

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
			useRegisterTiptapEditor: ({ editor }: { editor: unknown }) => {
				if (editor) {
					capturedEditor.current = editor as {
						getHTML: () => string;
					};
				}
			},
		};
	},
);

// ---------------------------------------------------------------------------
// Mock the feature-flag hook + the copilot chrome that needs a provider.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mocks for unrelated dependencies pulled in by StoryWorkspace.
// ---------------------------------------------------------------------------

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
		registerDocumentEditor: () => () => undefined,
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
	createCopilotSidebarInput: () => () => null,
}));

vi.mock("@shared/hooks/use-is-overflowing", () => ({
	useIsOverflowing: () => [vi.fn(), false] as const,
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	// Recursive Proxy that returns a callable on the leaf so chained access
	// like `orpc.projects.get.queryOptions({ ... })` resolves cleanly.
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
		useMutation: () => ({
			mutate: vi.fn(),
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
		// `createPortal` runs into jsdom container issues — render inline.
		createPortal: (node: ReactNode) => node,
		flushSync: (fn: () => void) => fn(),
	};
});

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		loading: vi.fn(),
	},
}));

// ---------------------------------------------------------------------------
// Stub the heavy sub-components that aren't relevant here. `<DiffReviewBar>` is
// deliberately NOT stubbed — its accept / reject buttons are exactly what the
// reachability assertions read out of the accessibility tree.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Import StoryWorkspace AFTER all mocks are registered.
// ---------------------------------------------------------------------------

import { StoryWorkspace } from "../../modules/saas/projects/components/stories/StoryWorkspace";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ORIGINAL_SPEC = "The exporter writes a CSV file once a day.";
const AI_SPEC = "The exporter writes a CSV file once an hour.";
/** What an answered open question appends to the spec body server-side. */
const ANSWERED_SPEC = `${ORIGINAL_SPEC}\n\n## Pending decisions\n\n- Retention stays at ninety days.`;

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

function workspace(description = ORIGINAL_SPEC, maturationV2 = true) {
	return (
		<StoryWorkspace
			story={{ ...baseStory, description } as StoryProp}
			canEdit
			projectId="proj-1"
			projectName="Test Project"
			maturationV2={maturationV2}
			onClose={vi.fn()}
		/>
	);
}

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/** The live editor's HTML — readable whether or not `<EditorContent>` is mounted. */
function editorHtml(): string {
	return capturedEditor.current?.getHTML() ?? "";
}

/** True when the editor document carries pending AI diff marks. */
function hasDiffMarks(): boolean {
	const html = editorHtml();
	return html.includes("diff-insert") || html.includes("diff-del");
}

function tab(name: RegExp): HTMLElement {
	return screen.getByRole("tab", { name });
}

/** Accept-all / reject-all controls, as exposed to assistive technology. */
function reviewControls(): HTMLElement[] {
	return [
		...screen.queryAllByRole("button", { name: "approveAll" }),
		...screen.queryAllByRole("button", { name: "rejectAll" }),
	];
}

/**
 * Drive one full agent run through the same effects production uses:
 * Effect 1 captures the baseline when loading starts, Effect 3 paints the
 * streaming diff, Effect 2 repaints the final diff at `nodeName === "end"`.
 * `duringStream` runs while the run is still in flight.
 */
async function runAgent(
	rerender: (ui: React.ReactElement) => void,
	current: () => React.ReactElement,
	duringStream?: () => void,
): Promise<void> {
	copilotStore.isLoading = true;
	await act(async () => {
		rerender(current());
	});

	copilotStore.agentDocument = AI_SPEC;
	await act(async () => {
		rerender(current());
	});

	duringStream?.();

	copilotStore.isLoading = false;
	copilotStore.nodeName = "end";
	await act(async () => {
		rerender(current());
	});
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
 * Radix `TabsTrigger` activates on mousedown, not click — a bare `.click()`
 * leaves the tab state untouched and every assertion after it meaningless.
 */
async function clickTab(element: HTMLElement): Promise<void> {
	await act(async () => {
		fireEvent.mouseDown(element, { button: 0 });
	});
	await waitFor(() =>
		expect(element).toHaveAttribute("aria-selected", "true"),
	);
}

/**
 * V2 opens on Summary & Questions, so every test that wants the editor region
 * on screen has to walk to it first — which is also why a pending draft has to
 * survive the trip back.
 */
async function openCleanSpecTab(): Promise<void> {
	await clickTab(tab(/tabs\.cleanSpec/));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StoryWorkspace — maturation tab round trip with a pending draft", () => {
	beforeEach(() => {
		mockUseHistoryEnabled.mockReturnValue(false);
		copilotStore.isLoading = false;
		copilotStore.agentDocument = "";
		copilotStore.nodeName = undefined;
		capturedAction.current = null;
		capturedEditor.current = null;
	});

	it("keeps the diff marks and the pending confirmation across a tab round trip", async () => {
		const { rerender } = render(workspace());
		await waitFor(() => expect(capturedEditor.current).not.toBeNull());
		const editorAtMount = capturedEditor.current;
		await openCleanSpecTab();

		await runAgent(rerender, () => workspace());
		await arriveAtConfirmation();

		// Precondition: a real diff is painted and a real review is pending.
		expect(hasDiffMarks()).toBe(true);
		expect(editorHtml()).toContain("hour");
		expect(reviewControls().length).toBeGreaterThan(0);
		const htmlBeforeTrip = editorHtml();

		// Away to Summary & Questions, then back to Clean Specification.
		await clickTab(tab(/tabs\.summaryQuestions/));
		await clickTab(tab(/tabs\.cleanSpec/));

		// The instance was never re-created — `useEditor(..., [])` sits above
		// the tab gate, so only `<EditorContent>` came and went.
		expect(capturedEditor.current).toBe(editorAtMount);
		// The document, its diff marks, and the review controls all came back.
		expect(editorHtml()).toBe(htmlBeforeTrip);
		expect(hasDiffMarks()).toBe(true);
		expect(reviewControls().length).toBeGreaterThan(0);
	});

	it("still paints the diff and reaches a confirmation when an answer lands mid-run", async () => {
		// Answering an open question writes a pending-decisions appendix to the
		// spec server-side and invalidates `stories.get`, so the `story`
		// prop changes underneath a streaming run. Effect 5 must defer that
		// sync — see `shouldDeferStoryPropSync`.
		let description = ORIGINAL_SPEC;
		const { rerender } = render(workspace(description));
		await waitFor(() => expect(capturedEditor.current).not.toBeNull());
		await openCleanSpecTab();

		await runAgent(
			rerender,
			() => workspace(description),
			() => {
				description = ANSWERED_SPEC;
			},
		);
		await arriveAtConfirmation();

		expect(hasDiffMarks()).toBe(true);
		expect(editorHtml()).toContain("hour");
		expect(reviewControls().length).toBeGreaterThan(0);

		// The refetched story text did NOT rebuild the editor over the diff.
		expect(editorHtml()).not.toContain("ninety days");
	});

	it("keeps a diff painted while another tab is active, and shows it on return", async () => {
		const { rerender } = render(workspace());
		await waitFor(() => expect(capturedEditor.current).not.toBeNull());

		// Never leave Summary & Questions while the run streams.
		await runAgent(rerender, () => workspace());
		await arriveAtConfirmation();

		// Painted with the Clean Spec region unmounted.
		expect(hasDiffMarks()).toBe(true);

		await openCleanSpecTab();

		expect(hasDiffMarks()).toBe(true);
		expect(editorHtml()).toContain("hour");
		expect(reviewControls().length).toBeGreaterThan(0);
	});

	it("takes the accept/reject controls out of the accessibility tree entirely while a non-spec tab is active", async () => {
		const { rerender } = render(workspace());
		await waitFor(() => expect(capturedEditor.current).not.toBeNull());
		await openCleanSpecTab();

		await runAgent(rerender, () => workspace());
		await arriveAtConfirmation();

		// The controls exist and take focus while the spec tab is on screen.
		const [approveBeforeTrip] = reviewControls();
		expect(approveBeforeTrip).toBeDefined();
		// Wrapped in `act` because focusing opens the button's Radix tooltip.
		await act(async () => {
			approveBeforeTrip.focus();
		});
		expect(approveBeforeTrip).toHaveFocus();

		await clickTab(tab(/tabs\.summaryQuestions/));

		// Today the region is unrendered rather than hidden: the controls are
		// detached from the document, so they are neither focusable nor exposed
		// to assistive technology. A `hidden` (display:none) wrapper would keep
		// this property; `visibility`, opacity or off-screen positioning would
		// NOT — they leave the node in the tab order and the a11y tree.
		expect(reviewControls()).toHaveLength(0);
		expect(document.body).not.toContainElement(approveBeforeTrip);

		// The review itself is still pending — what is lost is reach, not state.
		expect(hasDiffMarks()).toBe(true);
	});

	it("keeps the v1 classic path free of tab chrome, with the editor region always mounted", async () => {
		// The v1 branch renders the editor as a bare fragment — no DOM wrapper —
		// because the absence of one is load-bearing for the height chain. Any
		// future container added for the v2 tab gate must not reach v1.
		const { rerender } = render(workspace(ORIGINAL_SPEC, false));
		await waitFor(() => expect(capturedEditor.current).not.toBeNull());

		expect(screen.queryAllByRole("tab")).toHaveLength(0);

		await runAgent(rerender, () => workspace(ORIGINAL_SPEC, false));
		await arriveAtConfirmation();

		// No tab to walk to: the review is on screen the moment it exists.
		expect(hasDiffMarks()).toBe(true);
		expect(reviewControls().length).toBeGreaterThan(0);
	});
});
