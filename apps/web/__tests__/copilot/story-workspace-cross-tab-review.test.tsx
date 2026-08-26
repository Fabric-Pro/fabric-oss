/**
 * Reaching a pending AI draft from a maturation tab that is not Clean
 * Specification (Fizzy #1929, R7–R9).
 *
 * Its sibling `story-workspace-tab-mount.test.tsx` established what is NOT
 * broken: the draft itself survives a tab round trip, because the TipTap
 * instance and the confirmation state both live above the tab gate. What that
 * file also records — and this one fixes — is that *reach* does not survive.
 * With Summary & Questions active the Clean Spec region is unrendered, so the
 * review bar's accept / reject controls are absent from the DOM and from the
 * accessibility tree. A product owner who steps over to answer an open question
 * cannot approve the waiting draft from where they are, and nothing on that tab
 * says one is waiting at all.
 *
 * The subject here is the cross-tab banner that closes that gap: one mounted
 * copy above the tab bar, resolving the SAME draft through the same callback
 * pair the review bar calls, plus the permission gate that now covers both
 * surfaces and the polite live region that announces the draft's arrival.
 *
 * Same harness shape as the tab-mount file, and for the same reason: the REAL
 * `@tiptap/react`, the real markdown round trip, the real `diffPartialText`
 * pipeline and the real `<DiffReviewBar>` — stubbing any of them would
 * characterize the stub. CopilotKit is stubbed statefully (`copilotStore` plus
 * a `rerender()` to publish a change), and `useQuery` / `useMutation` are
 * keyed / switched from hoisted stores so a test can put the editor into a
 * specific server state without reaching for a network layer.
 */

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
	copilotStore,
	queryStore,
	serverStore,
	mutationStore,
	queryClientSpies,
	spliceFailure,
	capturedAction,
	capturedEditor,
	respondSpy,
	mockUseHistoryEnabled,
} = vi.hoisted(() => ({
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
	/**
	 * `useQuery` results by dotted oRPC path — the proxy below records the path
	 * it was walked down, so one query can be answered without answering all of
	 * them (the maturation editor state is the only one these tests need).
	 */
	queryStore: { byPath: {} as Record<string, unknown> },
	/**
	 * The SERVER's copy of the story, as `queryClient.fetchQuery` returns it —
	 * deliberately separate from the `story` prop, which is the React Query
	 * CACHE. Keeping the two apart is what makes "the answer landed on the
	 * server but its invalidation has not come back yet" expressible at all.
	 *
	 * `gate` holds the read open so a test can look at the world between the
	 * click and the read coming back; `failure` makes the read throw.
	 */
	serverStore: {
		description: null as string | null,
		gate: null as Promise<void> | null,
		failure: null as string | null,
		fetchCount: 0,
	},
	/**
	 * Every `mutate()` the workspace fires, with the variables it sent. The
	 * accept path's whole job is choosing WHAT to persist, and this is the only
	 * place that choice is observable — the editor is reset to the same content
	 * either way.
	 */
	mutationStore: {
		calls: [] as Array<{ key: string | null; variables: unknown }>,
		optionsByKey: {} as Record<
			string,
			{ onError?: (error: unknown) => void }
		>,
	},
	/** Shared across every `useQueryClient()` call so assertions can see them. */
	queryClientSpies: {
		invalidateQueries: vi.fn(),
		setQueryData: vi.fn(),
		getQueryData: vi.fn(),
	},
	/**
	 * When set, `restorePendingDecisions` throws with this message. It is the
	 * first thing `handleAccept` calls after reading the editor, so a throw
	 * there is a resolution that failed BEFORE anything was written — the case
	 * the banner has to survive rather than dismiss itself on.
	 */
	spliceFailure: { message: null as string | null },
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
	/** CopilotKit's HITL callback — how the agent learns the decision. */
	respondSpy: vi.fn(),
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
// The splice `handleAccept` performs before it writes. Delegates to the real
// implementation unless a test arms a failure.
// ---------------------------------------------------------------------------

vi.mock(
	"../../modules/saas/projects/lib/stories/pending-decisions-preserve",
	async () => {
		const actual = await vi.importActual<
			typeof import("../../modules/saas/projects/lib/stories/pending-decisions-preserve")
		>("../../modules/saas/projects/lib/stories/pending-decisions-preserve");
		return {
			...actual,
			restorePendingDecisions: (
				input: Parameters<typeof actual.restorePendingDecisions>[0],
			) => {
				if (spliceFailure.message) {
					throw new Error(spliceFailure.message);
				}
				return actual.restorePendingDecisions(input);
			},
		};
	},
);

// ---------------------------------------------------------------------------
// Capture the live editor instance — the only seam that hands us the instance
// no matter which tab is active. Everything else in the module stays real.
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
	// like `orpc.projects.get.queryOptions({ ... })` resolves cleanly. Unlike
	// the tab-mount file's copy, this one REMEMBERS the path it was walked
	// down and reports it as the query key, so `useQuery` below can answer one
	// procedure without answering every procedure the workspace calls.
	const makeProxy = (path: readonly string[] = []): unknown => {
		const key = path.join(".");
		// The caller's own options are MERGED through rather than dropped:
		// `mutationOptions({ onSuccess, onError })` is how the workspace
		// declares what happens on a failed answer, and a leaf that swallowed
		// them would make that handler untestable from here.
		const leaf = (options?: unknown) => ({
			queryKey: [key],
			queryFn: async () => ({}),
			mutationFn: async () => ({}),
			...(options && typeof options === "object" ? options : {}),
		});
		return new Proxy(() => undefined, {
			get: (_t, prop) => {
				if (prop === "queryOptions" || prop === "mutationOptions") {
					return leaf;
				}
				if (prop === "queryKey" || prop === "key") {
					return () => [key];
				}
				return makeProxy([...path, String(prop)]);
			},
			apply: () => ({ queryKey: [key], queryFn: async () => ({}) }),
		});
	};
	return { orpc: makeProxy() };
});

vi.mock("@tanstack/react-query", async () => {
	const actual = await vi.importActual<
		typeof import("@tanstack/react-query")
	>("@tanstack/react-query");
	return {
		...actual,
		useMutation: (options?: {
			queryKey?: unknown[];
			onError?: (error: unknown) => void;
		}) => {
			const key = Array.isArray(options?.queryKey)
				? String(options.queryKey[0])
				: null;
			if (key) {
				mutationStore.optionsByKey[key] = options as {
					onError?: (error: unknown) => void;
				};
			}
			return {
				mutate: (variables: unknown) => {
					mutationStore.calls.push({ key, variables });
				},
				mutateAsync: vi.fn(),
				isPending: false,
			};
		},
		useQuery: (options?: { queryKey?: unknown[] }) => ({
			data: queryStore.byPath[String(options?.queryKey?.[0] ?? "")],
			isLoading: false,
			refetch: vi.fn(),
		}),
		useQueryClient: () => ({
			...queryClientSpies,
			// The fresh read every resolution takes before it splices. Answers
			// from `serverStore`, NOT from the story prop — see that store.
			fetchQuery: async () => {
				serverStore.fetchCount++;
				if (serverStore.gate) {
					await serverStore.gate;
				}
				if (serverStore.failure) {
					throw new Error(serverStore.failure);
				}
				return { story: { description: serverStore.description } };
			},
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
		warning: vi.fn(),
		info: vi.fn(),
	},
}));

// ---------------------------------------------------------------------------
// Stub the heavy sub-components that aren't relevant here. `<DiffReviewBar>` is
// deliberately NOT stubbed — its accept / reject buttons are half of what the
// reachability and permission assertions read out of the accessibility tree.
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

import { toast } from "sonner";
import { StoryWorkspace } from "../../modules/saas/projects/components/stories/StoryWorkspace";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ORIGINAL_SPEC = "The exporter writes a CSV file once a day.";
const AI_SPEC = "The exporter writes a CSV file once an hour.";
const MATURATION_QUERY_PATH = "projects.stories.maturation.getEditorState";
const ANSWER_MUTATION_PATH = "projects.stories.maturation.answerQuestion";
const STORY_QUERY_PATH = "projects.stories.get";

/**
 * A question answered WHILE the draft above was being generated. The server
 * appends it to the spec body immediately, under the shared appendix heading —
 * the only channel by which a later run learns the decision. The pre-run
 * baseline the model was handed therefore does not contain it, and neither does
 * the draft the model returned.
 */
const ANSWERED_QUESTION = "Should the export run hourly";
const APPENDIX_HEADING = "Resolved Decisions (pending integration)";

/**
 * The other half of the appendix lifecycle: a question answered BEFORE the run,
 * so its bullet is in the body the model was handed. The model folds it into
 * the prose and deletes the heading — and the server still holds the appendix,
 * because it is pruned only when the run's result is saved. Restoring this one
 * would file the same decision twice.
 */
const INTEGRATED_QUESTION = "Should the archive include attachments";
const SPEC_WITH_INTEGRATED_ANSWER = [
	ORIGINAL_SPEC,
	"",
	`## ${APPENDIX_HEADING}`,
	"",
	`- **Q:** ${INTEGRATED_QUESTION}`,
	"  **Decided:** Yes, attachments travel with the archive.",
].join("\n");
/** That decision folded into the body, appendix deleted — as instructed. */
const AI_SPEC_WITH_DECISION_FOLDED_IN =
	"The exporter writes a CSV file once an hour, with attachments attached.";
const SERVER_SPEC_WITH_ANSWER = [
	ORIGINAL_SPEC,
	"",
	`## ${APPENDIX_HEADING}`,
	"",
	`- **Q:** ${ANSWERED_QUESTION}`,
	"  **Decided:** Yes, hourly. Nightly was too slow for auditors.",
].join("\n");

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

function workspace({
	canEdit = true,
	// The story prop is React Query CACHE data. Tests that want the cache to
	// lag the server (the window #1929 lives in) simply leave it alone.
	description = ORIGINAL_SPEC,
}: {
	canEdit?: boolean;
	description?: string;
} = {}) {
	return (
		<StoryWorkspace
			story={{ ...baseStory, description } as StoryProp}
			canEdit={canEdit}
			projectId="proj-1"
			projectName="Test Project"
			maturationV2
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

/** The spec tab's own bulk accept / reject, as exposed to assistive technology. */
function specTabReviewControls(): HTMLElement[] {
	return [
		...screen.queryAllByRole("button", { name: "approveAll" }),
		...screen.queryAllByRole("button", { name: "rejectAll" }),
	];
}

/** The cross-tab banner's approve / reject. */
function bannerReviewControls(): HTMLElement[] {
	return [
		...screen.queryAllByRole("button", {
			name: "pendingReview.approveAria",
		}),
		...screen.queryAllByRole("button", {
			name: "pendingReview.rejectAria",
		}),
	];
}

function bannerButton(name: string): HTMLElement {
	return within(screen.getByTestId("cross-tab-review-banner")).getByRole(
		"button",
		{ name },
	);
}

/**
 * Every spec body the workspace asked to persist, in order. Both writers of the
 * description column (the accept path's own `updateMutation.mutate`, and
 * `handleSave`'s) send a `description` string; nothing else the workspace
 * mutates does.
 */
function savedDescriptions(): string[] {
	return mutationStore.calls
		.map((call) => call.variables as { description?: unknown } | null)
		.map((variables) => variables?.description)
		.filter((description): description is string => {
			return typeof description === "string";
		});
}

function lastSavedDescription(): string | undefined {
	return savedDescriptions().at(-1);
}

/**
 * Hold the server read open. Returns the release. Between the click and the
 * release the resolution is suspended exactly where production suspends it:
 * after the decision to resolve, before anything is written.
 */
function gateServerRead(): () => void {
	let release: () => void = () => undefined;
	serverStore.gate = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	return () => {
		serverStore.gate = null;
		release();
	};
}

/**
 * Drive one full agent run through the same effects production uses:
 * Effect 1 captures the baseline when loading starts, Effect 3 paints the
 * streaming diff, Effect 2 repaints the final diff at `nodeName === "end"`.
 */
async function runAgent(
	rerender: (ui: React.ReactElement) => void,
	current: () => React.ReactElement,
): Promise<void> {
	copilotStore.isLoading = true;
	await act(async () => {
		rerender(current());
	});

	copilotStore.agentDocument = AI_SPEC;
	await act(async () => {
		rerender(current());
	});

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
			respond: respondSpy,
			status: "executing",
		});
	});
}

/**
 * Mount what the HITL renderer hands back — the confirm card CopilotKit shows
 * inside the chat sidebar. The workspace harness stubs the sidebar itself away,
 * so the card is reachable only through the renderer's return value; it is a
 * third control for the same draft and needs the same permission gate.
 */
async function renderChatConfirmCard(): Promise<HTMLElement> {
	let element: React.ReactElement | null = null;
	await act(async () => {
		element = capturedAction.current?.renderAndWaitForResponse({
			args: {},
			respond: respondSpy,
			status: "executing",
		}) as React.ReactElement;
	});
	if (!element) {
		throw new Error("the confirm_changes renderer returned nothing");
	}
	return render(element).container;
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

async function click(element: HTMLElement): Promise<void> {
	await act(async () => {
		fireEvent.click(element);
	});
}

/**
 * Mount, walk the editor to a painted diff awaiting a decision, and leave the
 * user on Summary & Questions — the tab they would be on to answer an open
 * question, and the one the review bar is unreachable from.
 */
async function pendingReviewOnQuestionsTab(
	options: { canEdit?: boolean } = {},
): Promise<{
	rerender: (ui: React.ReactElement) => void;
	unmount: () => void;
}> {
	const { rerender, unmount } = render(workspace(options));
	await waitFor(() => expect(capturedEditor.current).not.toBeNull());
	await runAgent(rerender, () => workspace(options));
	await arriveAtConfirmation();
	expect(tab(/tabs\.summaryQuestions/)).toHaveAttribute(
		"aria-selected",
		"true",
	);
	expect(hasDiffMarks()).toBe(true);
	return { rerender, unmount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StoryWorkspace — reaching a pending review from any maturation tab", () => {
	beforeEach(() => {
		mockUseHistoryEnabled.mockReturnValue(false);
		copilotStore.isLoading = false;
		copilotStore.agentDocument = "";
		copilotStore.nodeName = undefined;
		queryStore.byPath = {};
		serverStore.description = ORIGINAL_SPEC;
		serverStore.gate = null;
		serverStore.failure = null;
		serverStore.fetchCount = 0;
		mutationStore.calls = [];
		mutationStore.optionsByKey = {};
		queryClientSpies.invalidateQueries.mockClear();
		queryClientSpies.setQueryData.mockClear();
		queryClientSpies.getQueryData.mockClear();
		vi.mocked(toast.warning).mockClear();
		vi.mocked(toast.error).mockClear();
		spliceFailure.message = null;
		capturedAction.current = null;
		capturedEditor.current = null;
		respondSpy.mockClear();
	});

	it("offers approve, reject and review-changes from the questions tab", async () => {
		await pendingReviewOnQuestionsTab();

		// The spec tab's own bar is genuinely out of reach from here — that is
		// the gap, and the banner is what stands in for it.
		expect(specTabReviewControls()).toHaveLength(0);

		const banner = screen.getByTestId("cross-tab-review-banner");
		expect(
			within(banner).getByRole("button", {
				name: "pendingReview.approveAria",
			}),
		).toBeInTheDocument();
		expect(
			within(banner).getByRole("button", {
				name: "pendingReview.rejectAria",
			}),
		).toBeInTheDocument();
		expect(
			within(banner).getByRole("button", {
				name: "pendingReview.reviewAria",
			}),
		).toBeInTheDocument();
	});

	it("renders no approve or reject control on any tab without edit permission", async () => {
		await pendingReviewOnQuestionsTab({ canEdit: false });

		expect(bannerReviewControls()).toHaveLength(0);
		expect(screen.queryByTestId("cross-tab-review-banner")).toBeNull();

		// Including on the Clean Specification tab, where the review bar used to
		// render for anyone the confirmation reached.
		await clickTab(tab(/tabs\.cleanSpec/));
		expect(specTabReviewControls()).toHaveLength(0);
		expect(bannerReviewControls()).toHaveLength(0);

		// Not vacuous: the draft really is pending, it is only unactionable.
		expect(hasDiffMarks()).toBe(true);
	});

	it("renders no banner on any tab while no draft is pending", async () => {
		render(workspace());
		await waitFor(() => expect(capturedEditor.current).not.toBeNull());

		for (const name of [
			/tabs\.summaryQuestions/,
			/tabs\.decisionLog/,
			/tabs\.cleanSpec/,
		]) {
			await clickTab(tab(name));
			expect(screen.queryByTestId("cross-tab-review-banner")).toBeNull();
			expect(bannerReviewControls()).toHaveLength(0);
		}
	});

	it("mounts exactly one banner, and leaves the spec tab's own review bar in place", async () => {
		await pendingReviewOnQuestionsTab();

		expect(screen.getAllByTestId("cross-tab-review-banner")).toHaveLength(
			1,
		);

		await clickTab(tab(/tabs\.cleanSpec/));

		// Two mounted copies would race to resolve the same draft. One banner,
		// on every tab — plus the review bar, which is NOT relocated.
		expect(screen.getAllByTestId("cross-tab-review-banner")).toHaveLength(
			1,
		);
		expect(
			screen.getByTestId("spec-tab-review-region"),
		).toBeInTheDocument();
		expect(specTabReviewControls().length).toBeGreaterThan(0);
	});

	it("routes review-changes to the Clean Spec tab with the diff on screen and focus on the review bar", async () => {
		await pendingReviewOnQuestionsTab();

		await click(bannerButton("pendingReview.reviewAria"));

		await waitFor(() =>
			expect(tab(/tabs\.cleanSpec/)).toHaveAttribute(
				"aria-selected",
				"true",
			),
		);
		// Approving a whole-spec rewrite from a tab showing no diff is a blind
		// confirm; this action exists so the diff is on screen first.
		expect(hasDiffMarks()).toBe(true);
		expect(specTabReviewControls().length).toBeGreaterThan(0);
		expect(screen.getByTestId("spec-tab-review-region")).toHaveFocus();
	});

	it("resolves the same draft from the questions tab as from the spec tab", async () => {
		// Path A — approve from the banner, questions tab active.
		const { unmount } = await pendingReviewOnQuestionsTab();
		await click(bannerButton("pendingReview.approveAria"));

		const fromBanner = editorHtml();
		expect(respondSpy).toHaveBeenCalledWith({ accepted: true });
		expect(hasDiffMarks()).toBe(false);
		expect(fromBanner).toContain("hour");

		// Path B — the same draft, resolved through the spec tab's review bar.
		// Both go through `confirmCallbacksRef`, so "the same draft" is provable
		// as the same document and the same answer handed back to the agent.
		unmount();
		capturedEditor.current = null;
		respondSpy.mockClear();
		copilotStore.agentDocument = "";
		copilotStore.nodeName = undefined;

		const { rerender } = render(workspace());
		await waitFor(() => expect(capturedEditor.current).not.toBeNull());
		await clickTab(tab(/tabs\.cleanSpec/));
		await runAgent(rerender, () => workspace());
		await arriveAtConfirmation();
		await click(screen.getByRole("button", { name: "approveAll" }));

		expect(respondSpy).toHaveBeenCalledWith({ accepted: true });
		expect(editorHtml()).toBe(fromBanner);
	});

	it("keeps the polite live region mounted before the draft arrives and fills it after", async () => {
		const { rerender } = render(workspace());
		await waitFor(() => expect(capturedEditor.current).not.toBeNull());

		// Mounted, and empty. A region that appears already carrying its text is
		// unreliably announced, which is why it cannot come and go with the draft.
		const region = screen.getByTestId("pending-review-announcement");
		expect(region).toHaveAttribute("aria-live", "polite");
		expect(region).toBeEmptyDOMElement();

		await runAgent(rerender, () => workspace());
		await arriveAtConfirmation();

		expect(
			screen.getByTestId("pending-review-announcement"),
		).toHaveTextContent("pendingReview.announcePending");
	});

	it("disables both controls under a pending label while the resolution's write is in flight", async () => {
		await pendingReviewOnQuestionsTab();

		await click(bannerButton("pendingReview.approveAria"));

		// The accept started a save that has not come back (this harness never
		// resolves the mutation), so the decision is still in flight — the banner
		// stays, saying so, and neither control can start a second write.
		const banner = screen.getByTestId("cross-tab-review-banner");
		expect(banner).toHaveTextContent("pendingReview.resolving");
		expect(bannerButton("pendingReview.approveAria")).toBeDisabled();
		expect(bannerButton("pendingReview.rejectAria")).toBeDisabled();
	});

	it("keeps the banner mounted with an inline error when the accept path throws", async () => {
		await pendingReviewOnQuestionsTab();

		spliceFailure.message = "pending-decision splice failed";
		await click(bannerButton("pendingReview.approveAria"));

		// Nothing was written, so the draft still needs a decision — dismissing
		// the banner here would strand it on a tab with no other control.
		const banner = screen.getByTestId("cross-tab-review-banner");
		expect(
			within(banner).getByTestId("cross-tab-review-error"),
		).toHaveTextContent("pendingReview.resolveFailed");
		expect(respondSpy).not.toHaveBeenCalled();
		expect(hasDiffMarks()).toBe(true);
		expect(bannerButton("pendingReview.approveAria")).toBeEnabled();
	});

	it("moves focus to the active tab trigger when a resolution completes", async () => {
		await pendingReviewOnQuestionsTab();

		await click(bannerButton("pendingReview.rejectAria"));

		// The banner the click landed in is gone; focus must not fall to <body>.
		// The wait spans `REVIEW_RESOLUTION_SETTLE_GRACE_MS` — the window that
		// keeps the pending label up across a deferred save's re-arm.
		await waitFor(
			() =>
				expect(
					screen.queryByTestId("cross-tab-review-banner"),
				).toBeNull(),
			{ timeout: 4000 },
		);
		expect(tab(/tabs\.summaryQuestions/)).toHaveFocus();
	});

	it("makes the pending-decision bar's refresh unactionable while a review is pending", async () => {
		queryStore.byPath[MATURATION_QUERY_PATH] = {
			pendingDecisionCount: 2,
			openQuestions: [],
			possiblyResolvedQuestions: [],
			decisionLog: [],
		};

		const { rerender } = render(workspace());
		await waitFor(() => expect(capturedEditor.current).not.toBeNull());

		// Actionable while nothing is waiting on a decision.
		expect(
			screen.getByRole("button", { name: "newDecisions.cta" }),
		).toBeEnabled();

		await runAgent(rerender, () => workspace());
		await arriveAtConfirmation();

		// A refresh now would draft over the draft already awaiting approval.
		expect(
			screen.getByRole("button", { name: "newDecisions.cta" }),
		).toBeDisabled();
		expect(
			screen.getByText("pendingReview.refreshBlocked"),
		).toBeInTheDocument();
	});

	// ── The decision that was answered mid-run (Fizzy #1929) ─────────────

	/**
	 * The bug itself, asserted on the only artefact that can prove it: the
	 * content handed to the save.
	 *
	 * Everything else about an accept looks identical whether or not the
	 * mid-run answer survives — the diff clears, the editor ends up showing the
	 * AI's text, the agent is told `accepted: true`. A reviewer neutered the
	 * `restorePendingDecisions` call in `handleAccept` and fifteen of sixteen
	 * tests here still passed. This one reads the persisted body.
	 */
	it("saves the mid-run answer the run never saw, spliced into the accepted content", async () => {
		const { rerender } = await pendingReviewOnQuestionsTab();

		// The product owner answers an open question while the draft waits. The
		// server writes it into the spec body's appendix immediately; the cache
		// catches up when the invalidation lands.
		serverStore.description = SERVER_SPEC_WITH_ANSWER;
		await act(async () => {
			rerender(workspace({ description: SERVER_SPEC_WITH_ANSWER }));
		});

		await click(bannerButton("pendingReview.approveAria"));

		const saved = lastSavedDescription();
		// The draft was applied…
		expect(saved).toContain("once an hour");
		// …without taking the answer with it. The heading matters as much as
		// the bullet: it is what a later run matches on, and bullets left
		// without it are stranded in exactly the same way.
		expect(saved).toContain(APPENDIX_HEADING);
		expect(saved).toContain(ANSWERED_QUESTION);
	});

	it("resolves against a fresh read of the story, not the cache the answer has not reached yet", async () => {
		await pendingReviewOnQuestionsTab();

		// The answer is on the server. The story prop — React Query cache data,
		// refreshed by an invalidation nobody awaited — still holds the
		// pre-answer body. Resolving against it is the original data loss,
		// reached through the code path that exists to prevent it.
		serverStore.description = SERVER_SPEC_WITH_ANSWER;
		const releaseServerRead = gateServerRead();

		await click(bannerButton("pendingReview.approveAria"));

		// Suspended on the read: nothing written, nothing answered to the
		// agent, the diff still on screen.
		expect(serverStore.fetchCount).toBe(1);
		expect(savedDescriptions()).toHaveLength(0);
		expect(respondSpy).not.toHaveBeenCalled();
		expect(hasDiffMarks()).toBe(true);

		await act(async () => {
			releaseServerRead();
		});
		await waitFor(() =>
			expect(respondSpy).toHaveBeenCalledWith({ accepted: true }),
		);

		const saved = lastSavedDescription();
		expect(saved).toContain(ANSWERED_QUESTION);
		expect(saved).toContain("once an hour");
	});

	it("keeps the banner mounted with an inline error when the fresh read fails", async () => {
		await pendingReviewOnQuestionsTab();

		serverStore.failure = "the story could not be read";
		await click(bannerButton("pendingReview.approveAria"));

		// Resolving against text known to be stale is the failure mode, so a
		// read that did not come back cannot be shrugged off — the draft stays
		// pending and says why.
		const banner = screen.getByTestId("cross-tab-review-banner");
		expect(
			within(banner).getByTestId("cross-tab-review-error"),
		).toHaveTextContent("pendingReview.resolveFailed");
		expect(savedDescriptions()).toHaveLength(0);
		expect(respondSpy).not.toHaveBeenCalled();
		expect(hasDiffMarks()).toBe(true);
	});

	it("reports a failed resolution the same way from the spec tab's own controls", async () => {
		await pendingReviewOnQuestionsTab();
		await clickTab(tab(/tabs\.cleanSpec/));

		spliceFailure.message = "pending-decision splice failed";
		await click(screen.getByRole("button", { name: "approveAll" }));

		// One resolution path, two surfaces. Called straight at the callbacks,
		// this throw escapes a click handler with the review already cleared
		// behind it — no control left on any tab to try again.
		const banner = screen.getByTestId("cross-tab-review-banner");
		expect(
			within(banner).getByTestId("cross-tab-review-error"),
		).toHaveTextContent("pendingReview.resolveFailed");
		expect(respondSpy).not.toHaveBeenCalled();
		expect(hasDiffMarks()).toBe(true);
		expect(specTabReviewControls().length).toBeGreaterThan(0);
	});

	it("flushes a save after a reject that put a mid-run answer back", async () => {
		await pendingReviewOnQuestionsTab();

		// Same window as the accept case: answered on the server, not yet in
		// the cache the editor's baseline came from.
		serverStore.description = SERVER_SPEC_WITH_ANSWER;

		await click(bannerButton("pendingReview.rejectAria"));

		await waitFor(() =>
			expect(respondSpy).toHaveBeenCalledWith({ accepted: false }),
		);

		// Flagging the editor dirty and stopping there latches it: a dirty
		// editor blocks the story-prop sync indefinitely, so the restored
		// answer sits unsaved AND later server content can never be adopted.
		const saved = lastSavedDescription();
		expect(saved).toContain(ANSWERED_QUESTION);
		// The draft itself was rejected — this is the baseline plus the answer.
		expect(saved).not.toContain("once an hour");
	});

	it("leaves focus where the user put it when the resolution settles late", async () => {
		await pendingReviewOnQuestionsTab();

		await click(bannerButton("pendingReview.rejectAria"));

		// The settle window runs more than a second past the click. The user
		// does not wait for it — they move on and start typing.
		const elsewhere = document.createElement("input");
		document.body.append(elsewhere);
		elsewhere.focus();

		await waitFor(
			() =>
				expect(
					screen.queryByTestId("cross-tab-review-banner"),
				).toBeNull(),
			{ timeout: 4000 },
		);

		expect(elsewhere).toHaveFocus();
		elsewhere.remove();
	});

	/**
	 * The other direction, and the reason the splice is a baseline DIFFERENCE
	 * rather than "re-add whatever the server holds": an entry the run already
	 * integrated must not come back. The server still holds the appendix at
	 * resolution time — it is pruned only when the run's result is saved — so a
	 * splice that skipped the comparison would file every decision twice, on
	 * every accept.
	 */
	it("does not resurrect a decision the run already integrated", async () => {
		serverStore.description = SPEC_WITH_INTEGRATED_ANSWER;
		const ui = () =>
			workspace({ description: SPEC_WITH_INTEGRATED_ANSWER });
		const { rerender } = render(ui());
		await waitFor(() => expect(capturedEditor.current).not.toBeNull());

		// The run is handed a body that already carries the appendix entry…
		copilotStore.isLoading = true;
		await act(async () => {
			rerender(ui());
		});
		// …and returns it folded into the prose, heading deleted, as instructed.
		copilotStore.agentDocument = AI_SPEC_WITH_DECISION_FOLDED_IN;
		await act(async () => {
			rerender(ui());
		});
		copilotStore.isLoading = false;
		copilotStore.nodeName = "end";
		await act(async () => {
			rerender(ui());
		});
		await arriveAtConfirmation();
		expect(hasDiffMarks()).toBe(true);

		await click(bannerButton("pendingReview.approveAria"));

		const saved = lastSavedDescription();
		expect(saved).toContain("attachments");
		expect(saved).not.toContain(APPENDIX_HEADING);
		expect(saved).not.toContain(INTEGRATED_QUESTION);
	});

	it("gates the chat sidebar's confirm card on edit permission too", async () => {
		const { rerender } = render(workspace({ canEdit: false }));
		await waitFor(() => expect(capturedEditor.current).not.toBeNull());

		// Same draft, third surface — and the one that stays reachable from
		// every tab. Ungated, the permission rule would hold on two surfaces
		// out of three.
		const viewerCard = await renderChatConfirmCard();
		expect(within(viewerCard).queryByTestId("confirm-button")).toBeNull();
		expect(within(viewerCard).queryByTestId("reject-button")).toBeNull();
		expect(
			within(viewerCard).getByTestId("confirm-changes-readonly"),
		).toBeInTheDocument();

		// Not vacuous: an editor still gets the card's controls.
		await act(async () => {
			rerender(workspace({ canEdit: true }));
		});
		const editorCard = await renderChatConfirmCard();
		expect(
			within(editorCard).getByTestId("confirm-button"),
		).toBeInTheDocument();
		expect(
			within(editorCard).getByTestId("reject-button"),
		).toBeInTheDocument();
	});

	/**
	 * The third surface, and the last one that resolved a draft by calling the
	 * accept/reject callbacks directly (Fizzy #1929).
	 *
	 * Called direct, the card splices against `serverDescriptionRef` as the
	 * React Query cache last left it — so approving from the chat a beat after
	 * answering a question restores nothing and saves the answer away. That is
	 * the original bug, on the one surface reachable from every tab.
	 *
	 * The story prop is deliberately left at the pre-answer body: that is the
	 * window #1929 lives in, and it is what makes the appendix in the saved
	 * content attributable to the fresh read rather than to a prop that caught
	 * up on its own. Only the persisted body can tell the two paths apart —
	 * everything else about the accept looks identical either way.
	 */
	it("saves the mid-run answer when the draft is resolved from the chat sidebar card", async () => {
		await pendingReviewOnQuestionsTab();

		// Answered while the draft waits. The server holds it; the story prop —
		// React Query cache data, refreshed by an invalidation nobody awaited —
		// still holds the pre-answer body, and so does the mirror every splice
		// reads. Nothing but a fresh read can see this.
		serverStore.description = SERVER_SPEC_WITH_ANSWER;

		const card = await renderChatConfirmCard();
		const releaseServerRead = gateServerRead();
		await click(within(card).getByTestId("confirm-button"));

		// The card's own state machine is async-aware now: suspended on the
		// read, it shows the write in flight rather than looking idle (a second
		// click would start a second write) or already resolved (the resolution
		// can still fail).
		expect(
			within(card).getByTestId("confirm-changes-pending"),
		).toBeInTheDocument();
		expect(within(card).getByTestId("confirm-button")).toBeDisabled();
		expect(within(card).getByTestId("reject-button")).toBeDisabled();
		expect(within(card).queryByTestId("status-display")).toBeNull();
		expect(savedDescriptions()).toHaveLength(0);

		await act(async () => {
			releaseServerRead();
		});
		await waitFor(() =>
			expect(respondSpy).toHaveBeenCalledWith({ accepted: true }),
		);

		const saved = lastSavedDescription();
		// The draft was applied…
		expect(saved).toContain("once an hour");
		// …and the answer the run never saw travelled with it. Only a fresh
		// read can produce this: the story prop the card's closure sees is the
		// pre-answer body on the render the card was built from.
		expect(saved).toContain(APPENDIX_HEADING);
		expect(saved).toContain(ANSWERED_QUESTION);

		// Landed, so the card may finally say so.
		await waitFor(() =>
			expect(
				within(card).getByTestId("status-display"),
			).toHaveTextContent("Accepted"),
		);
	});

	it("leaves the chat card retryable when its resolution fails, instead of latching resolved", async () => {
		await pendingReviewOnQuestionsTab();
		const card = await renderChatConfirmCard();

		serverStore.failure = "the story could not be read";
		await click(within(card).getByTestId("confirm-button"));

		// Nothing was written, so the draft still needs a decision. A card that
		// latched "✓ Accepted" here would auto-dismiss two seconds later and
		// take the chat's only control for this draft with it.
		expect(within(card).queryByTestId("status-display")).toBeNull();
		expect(within(card).getByTestId("confirm-button")).toBeEnabled();
		expect(within(card).getByTestId("reject-button")).toBeEnabled();
		expect(
			within(card).queryByTestId("confirm-changes-pending"),
		).toBeNull();
		expect(respondSpy).not.toHaveBeenCalled();
		expect(savedDescriptions()).toHaveLength(0);
		expect(hasDiffMarks()).toBe(true);

		// And the failure is reported — the card routes through the same
		// resolution path as the other two surfaces, so the banner's inline
		// error covers it rather than the throw escaping a click handler.
		const banner = screen.getByTestId("cross-tab-review-banner");
		expect(
			within(banner).getByTestId("cross-tab-review-error"),
		).toHaveTextContent("pendingReview.resolveFailed");

		// Retryable in place, not just enabled-looking: the callbacks were put
		// back, so the second attempt resolves the same draft.
		serverStore.failure = null;
		serverStore.description = SERVER_SPEC_WITH_ANSWER;
		await click(within(card).getByTestId("confirm-button"));

		await waitFor(() =>
			expect(respondSpy).toHaveBeenCalledWith({ accepted: true }),
		);
		expect(lastSavedDescription()).toContain(ANSWERED_QUESTION);
		expect(hasDiffMarks()).toBe(false);
	});

	it("says what actually happened when an answer's spec write loses its race", async () => {
		render(workspace());
		await waitFor(() => expect(capturedEditor.current).not.toBeNull());

		const onError =
			mutationStore.optionsByKey[ANSWER_MUTATION_PATH]?.onError;
		expect(onError).toBeTypeOf("function");

		await act(async () => {
			onError?.(
				Object.assign(new Error("story version conflict"), {
					code: "CONFLICT",
				}),
			);
		});

		// CONFLICT from this procedure is not "your answer wasn't saved" — the
		// decision IS committed to the Decision Log, and only its integration
		// into the spec failed. Telling the user to try again sends them back
		// to a question that is no longer open.
		expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
			"answerConflictTitle",
			expect.objectContaining({ description: "answerConflictBody" }),
		);
		expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
		// Both views moved underneath the user: the question left the open
		// list, and the description is whatever won the race.
		expect(queryClientSpies.invalidateQueries).toHaveBeenCalledWith({
			queryKey: [MATURATION_QUERY_PATH],
		});
		expect(queryClientSpies.invalidateQueries).toHaveBeenCalledWith({
			queryKey: [STORY_QUERY_PATH],
		});

		// Not a blanket rewrite of the error path: anything else still reads as
		// a failure to save the answer.
		vi.mocked(toast.warning).mockClear();
		await act(async () => {
			onError?.(new Error("network down"));
		});
		expect(vi.mocked(toast.error)).toHaveBeenCalledWith("answerError");
		expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
	});
});
