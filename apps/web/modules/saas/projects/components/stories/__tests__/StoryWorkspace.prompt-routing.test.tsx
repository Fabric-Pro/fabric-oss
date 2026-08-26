/**
 * Fizzy #2048 (U2) — the work item detail view no longer picks its own
 * template.
 *
 * Before this change the component decided in three places: it read
 * `story.kind` out of its own React Query cache, derived the agent name in the
 * browser, and asked the prompt library to resolve THAT name. Kind can be
 * changed from surfaces that do not share this cache (the roadmap card kebab,
 * the actions menu), so a reviewer who converted from one surface and
 * regenerated from this one got the previous kind's template. The third place
 * fetched a hand-picked prompt by id, so nothing server-side ever compared the
 * chosen prompt's kind scope to the item it was about to rewrite.
 *
 * All three now go through `projects.stories.resolvePrompt`, which takes the
 * work item and reads the kind off the stored row. These tests hold the line by
 * mounting the REAL workspace with a DELIBERATELY STALE cached kind
 * (`kind: "FEATURE"`) and a server that answers `BUG` — every assertion below
 * would pass trivially if the two agreed.
 *
 * Mount scaffold adapted from `__tests__/copilot/story-workspace-priority-draft-sync.test.tsx`.
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
// Hoisted captures
// ---------------------------------------------------------------------------

const {
	mockResolvePrompt,
	mockPromptById,
	mockBoundPrompt,
	mockSpecContext,
	mockAppendMessage,
	mockInvalidateQueries,
	mockToastError,
	mockEnhanceMutate,
	agentRef,
} = vi.hoisted(() => ({
	mockResolvePrompt: vi.fn(),
	mockPromptById: vi.fn(),
	mockBoundPrompt: vi.fn(),
	mockSpecContext: vi.fn(),
	mockAppendMessage: vi.fn(),
	mockInvalidateQueries: vi.fn(),
	mockToastError: vi.fn(),
	mockEnhanceMutate: vi.fn(),
	// Mutable stand-in for the AG-UI agent instance the in-flight latch reads
	// synchronously (`agent.isRunning`).
	agentRef: { current: { isRunning: false } },
}));

// ---------------------------------------------------------------------------
// CopilotKit — the runtime needs a provider; stub the sidebar so children
// render inline and capture `appendMessage`, which is how a run is started.
// ---------------------------------------------------------------------------

vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({
		state: { document: "" },
		setState: vi.fn(),
		running: false,
		nodeName: undefined,
	}),
	useCopilotAction: vi.fn(),
	useCopilotChat: () => ({
		isLoading: false,
		visibleMessages: [],
		appendMessage: mockAppendMessage,
	}),
	useCopilotChatInternal: () => ({
		messages: [],
		isLoading: false,
		setMessages: vi.fn(),
		agent: agentRef.current,
	}),
	useCopilotReadable: vi.fn(),
}));

vi.mock("@copilotkit/react-ui", () => ({
	// The workspace closes the assistant on a phone-width viewport through this
	// hook. jsdom reports a wide window, so the effect is a no-op here.
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
	// Keeps the props so a test can read the message text that was posted.
	TextMessage: class {
		role: string;
		content: string;
		constructor(props: { role: string; content: string }) {
			this.role = props.role;
			this.content = props.content;
		}
	},
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

vi.mock("@saas/projects/hooks/useDocumentAssistantHistoryEnabled", () => ({
	useDocumentAssistantHistoryEnabled: () => false,
}));

// ---------------------------------------------------------------------------
// The two seams the tests drive
// ---------------------------------------------------------------------------

// The transition dialog is a real dialog with its own prompt picker; stub it at
// its `onEnhance` seam so a test can fire the default path and the
// reviewer-picked-a-prompt path directly.
vi.mock("../FeatureTransitionDialog", () => ({
	FeatureTransitionDialog: ({
		targetStage,
		onEnhance,
	}: {
		targetStage: string;
		onEnhance: (stage: string, promptId?: string) => void;
	}) => (
		<div>
			<button
				type="button"
				data-testid="enhance-default"
				onClick={() => onEnhance(targetStage)}
			>
				enhance
			</button>
			<button
				type="button"
				data-testid="enhance-picked-prompt"
				onClick={() => onEnhance(targetStage, "prompt-picked-1")}
			>
				enhance with chosen prompt
			</button>
		</div>
	),
}));

// Radix menus never open in jsdom without pointer plumbing. Render every menu
// inline and turn items into plain buttons so the stage picker (which sets the
// pending target stage the Enhance button needs) is reachable.
vi.mock("@ui/components/dropdown-menu", () => {
	const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
	const Item = ({
		children,
		onSelect,
		disabled,
	}: {
		children?: ReactNode;
		onSelect?: () => void;
		disabled?: boolean;
	}) => (
		<button type="button" disabled={disabled} onClick={() => onSelect?.()}>
			{children}
		</button>
	);
	return {
		DropdownMenu: Pass,
		DropdownMenuTrigger: Pass,
		DropdownMenuContent: Pass,
		DropdownMenuGroup: Pass,
		DropdownMenuPortal: Pass,
		DropdownMenuSub: Pass,
		DropdownMenuSubTrigger: Pass,
		DropdownMenuSubContent: Pass,
		DropdownMenuRadioGroup: Pass,
		DropdownMenuRadioItem: Item,
		DropdownMenuCheckboxItem: Item,
		DropdownMenuItem: Item,
		DropdownMenuLabel: Pass,
		DropdownMenuSeparator: () => null,
		DropdownMenuShortcut: Pass,
	};
});

// ---------------------------------------------------------------------------
// The oRPC client. `prompts.get.byId` and `prompts.agents.bound` are present
// but must never be called — they are the browser-side template decisions this
// unit removed, and a silent regression would otherwise just re-resolve the
// same prompt and look fine.
// ---------------------------------------------------------------------------

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			specContext: mockSpecContext,
			stories: {
				resolvePrompt: mockResolvePrompt,
				resolveMediaForAgent: vi.fn().mockResolvedValue({ items: [] }),
				resolveAttachmentContextForAgent: vi
					.fn()
					.mockResolvedValue({ items: [] }),
			},
		},
		prompts: {
			get: { byId: mockPromptById },
			agents: { bound: mockBoundPrompt },
		},
		agents: {
			conversations: { archiveForDocument: vi.fn() },
		},
	},
}));

// ---------------------------------------------------------------------------
// Unrelated dependencies pulled in by the workspace
// ---------------------------------------------------------------------------

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", name: "Test User" } }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/example-org",
		isOrgContext: true,
	}),
}));

vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useFabricAgentLauncher: () => ({ launch: vi.fn() }),
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
	// Recursive Proxy so chained access (`orpc.projects.stories.get.queryKey`)
	// resolves; `queryKey` returns a readable array so an invalidation
	// assertion can tell the story-detail key apart from anything else.
	const makeProxy = (path: string[]): unknown =>
		new Proxy(() => undefined, {
			get: (_t, prop) => {
				if (prop === "queryKey") {
					return (opts?: { input?: unknown }) => [
						...path,
						opts?.input,
					];
				}
				if (prop === "key") {
					return () => [...path];
				}
				if (prop === "queryOptions" || prop === "mutationOptions") {
					return () => ({
						queryKey: [...path],
						queryFn: async () => ({}),
						mutationFn: async () => ({}),
					});
				}
				return makeProxy([...path, String(prop)]);
			},
			apply: () => ({
				queryKey: [...path],
				queryFn: async () => ({}),
			}),
		});
	return { orpc: makeProxy([]) };
});

vi.mock("@tanstack/react-query", async () => {
	const actual = await vi.importActual<
		typeof import("@tanstack/react-query")
	>("@tanstack/react-query");
	return {
		...actual,
		// Every mutation in the workspace shares one `mutate` spy. Only the
		// stage-enhance fallback asserts on it, and it is the only mutation
		// these tests can reach.
		useMutation: () => ({
			mutate: mockEnhanceMutate,
			mutateAsync: vi.fn(),
			isPending: false,
		}),
		useQuery: () => ({
			data: undefined,
			isLoading: false,
			refetch: vi.fn(),
		}),
		useQueryClient: () => ({
			invalidateQueries: mockInvalidateQueries,
			setQueryData: vi.fn(),
			getQueryData: vi.fn(),
			cancelQueries: vi.fn(),
		}),
	};
});

vi.mock("@tiptap/react", () => ({
	useEditor: () => null,
	EditorContent: () => null,
}));

vi.mock("next/navigation", () => ({
	useParams: () => ({}),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	usePathname: () => "/app/projects/proj-1/stories/story-1",
	useSearchParams: () => new URLSearchParams(),
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
		error: mockToastError,
		loading: vi.fn(),
	},
}));

vi.mock("../../../lib/use-clipboard-image-paste", () => ({
	useClipboardImagePaste: () => ({
		handlePaste: vi.fn(),
		handleDrop: vi.fn(),
	}),
}));

vi.mock("turndown", () => ({
	default: class {
		turndown = () => "";
		addRule = () => this;
		use = () => this;
	},
}));

vi.mock("turndown-plugin-gfm", () => ({ gfm: vi.fn() }));

vi.mock("../../DiffReviewBar", () => ({ DiffReviewBar: () => null }));
vi.mock("../../EditorToolbar", () => ({ EditorToolbar: () => null }));
vi.mock("../ConvertKindConfirmDialog", () => ({
	ConvertKindConfirmDialog: () => null,
}));
vi.mock("../FeatureVersionHistory", () => ({
	FeatureVersionHistory: () => null,
}));

// Import AFTER every mock is registered.
import { StoryWorkspace } from "../StoryWorkspace";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FEATURE_PROMPT = "FEATURE TEMPLATE — user story narrative";
const BUG_PROMPT = "BUG TEMPLATE — steps to reproduce, root cause";
const PICKED_PROMPT = "HAND-PICKED TEMPLATE — chosen by the reviewer";

/**
 * The cache is a conversion behind: this item is stored as a BUG, but the
 * detail view still holds the FEATURE row it was opened with.
 */
const staleCachedStory = {
	id: "story-1",
	identifier: "F-001",
	title: "Test work item",
	description: "Initial description",
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
	draftingStage: "PLACEHOLDER",
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

/** What the server answers once it has read the stored row. */
function serverSaysBug(content: string, source = "bound") {
	return {
		resolved: true,
		content,
		promptKey: "bug_clean_spec",
		source,
		kind: "BUG",
		kindWord: "bug",
	};
}

function renderWorkspace(maturationV2: boolean) {
	return render(
		<StoryWorkspace
			story={
				staleCachedStory as Parameters<
					typeof StoryWorkspace
				>[0]["story"]
			}
			canEdit
			projectId="proj-1"
			projectName="Test Project"
			maturationV2={maturationV2}
			onClose={vi.fn()}
		/>,
	);
}

/** The message text posted into the agent thread, or "" if none was. */
function postedMessage(): string {
	const call = mockAppendMessage.mock.calls[0];
	return (call?.[0] as { content?: string } | undefined)?.content ?? "";
}

async function clickUpdateFullSpec() {
	const button = await screen.findByRole("button", {
		name: /update full spec/i,
	});
	await act(async () => {
		fireEvent.click(button);
	});
}

/**
 * Drives the V1 stage bar: pick a pending target stage, open the transition
 * dialog, then fire its `onEnhance` seam.
 */
async function runStageEnhance(testId: string) {
	const draftItem = screen
		.getAllByRole("button")
		.find((el) => el.textContent?.trim() === "Draft");
	expect(draftItem).toBeDefined();
	await act(async () => {
		fireEvent.click(draftItem as HTMLElement);
	});

	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: /^enhance$/i }));
	});

	const trigger = await screen.findByTestId(testId);
	await act(async () => {
		fireEvent.click(trigger);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	agentRef.current.isRunning = false;
	mockSpecContext.mockResolvedValue({ contexts: [] });
	mockAppendMessage.mockResolvedValue(undefined);
	mockResolvePrompt.mockResolvedValue(serverSaysBug(BUG_PROMPT));
	mockPromptById.mockResolvedValue({
		versions: [{ content: FEATURE_PROMPT }],
	});
	mockBoundPrompt.mockResolvedValue({ version: { content: FEATURE_PROMPT } });
});

// ---------------------------------------------------------------------------
// Clean Spec refresh — "Update Full Spec"
// ---------------------------------------------------------------------------

describe("StoryWorkspace — Clean Spec refresh resolves its prompt server-side", () => {
	it("sends the server's prompt when the cached kind disagrees (AE1)", async () => {
		renderWorkspace(true);
		await clickUpdateFullSpec();

		await waitFor(() => expect(mockAppendMessage).toHaveBeenCalled());
		expect(postedMessage()).toContain(BUG_PROMPT);
		expect(postedMessage()).not.toContain(FEATURE_PROMPT);
	});

	it("supplies the work item, and neither a kind nor an agent name (R2)", async () => {
		renderWorkspace(true);
		await clickUpdateFullSpec();

		await waitFor(() => expect(mockResolvePrompt).toHaveBeenCalled());
		const input = mockResolvePrompt.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(input).toMatchObject({
			projectId: "proj-1",
			storyId: "story-1",
			organizationId: "org-1",
		});
		expect(Object.keys(input)).not.toContain("storyKind");
		expect(Object.keys(input)).not.toContain("agentName");
		expect(JSON.stringify(input)).not.toContain("clean_spec_generator");
		// The two browser-side resolutions this unit removed.
		expect(mockBoundPrompt).not.toHaveBeenCalled();
		expect(mockPromptById).not.toHaveBeenCalled();
	});

	it("words the message with the kind the server resolved, not the cached one", async () => {
		renderWorkspace(true);
		await clickUpdateFullSpec();

		await waitFor(() => expect(mockAppendMessage).toHaveBeenCalled());
		expect(postedMessage()).toContain("Refresh the Full Spec for this bug");
		expect(postedMessage()).not.toContain("for this feature");
	});

	it("invalidates the work item query before posting when the kind drifted", async () => {
		renderWorkspace(true);
		await clickUpdateFullSpec();

		await waitFor(() => expect(mockAppendMessage).toHaveBeenCalled());
		// Fizzy #2048 (U7): the expected value used to be the hand-built
		// literal `["projects", "stories", "list", "proj-1"]`. That key matched
		// none of the three shapes this repository registers, so the
		// invalidation it pinned was a silent no-op — see
		// `docs/solutions/conventions/derive-query-invalidation-keys-never-hand-build-them.md`.
		// The workspace now derives the key from the oRPC client, and this
		// assertion follows it there rather than preserving the broken literal.
		const listInvalidation = mockInvalidateQueries.mock.calls.find(
			(call) =>
				JSON.stringify(
					(call[0] as { queryKey?: unknown[] })?.queryKey,
				) === JSON.stringify(["projects", "stories", "list"]),
		);
		expect(listInvalidation).toBeDefined();
		// The chrome must stop contradicting the spec being generated, so the
		// refresh has to land before the run is posted.
		expect(
			Math.min(...mockInvalidateQueries.mock.invocationCallOrder),
		).toBeLessThan(mockAppendMessage.mock.invocationCallOrder[0]);
	});

	it("leaves the cache alone when the server agrees with it", async () => {
		mockResolvePrompt.mockResolvedValue({
			resolved: true,
			content: FEATURE_PROMPT,
			promptKey: "feature_clean_spec",
			source: "bound",
			kind: "FEATURE",
			kindWord: "feature",
		});
		renderWorkspace(true);
		await clickUpdateFullSpec();

		await waitFor(() => expect(mockAppendMessage).toHaveBeenCalled());
		expect(mockInvalidateQueries).not.toHaveBeenCalled();
		expect(postedMessage()).toContain(
			"Refresh the Full Spec for this feature",
		);
	});

	it("surfaces the existing error and starts no run when nothing is bound (AE7)", async () => {
		mockResolvePrompt.mockResolvedValue({
			resolved: false,
			content: null,
			promptKey: null,
			source: null,
			kind: "BUG",
			kindWord: "bug",
		});
		renderWorkspace(true);
		await clickUpdateFullSpec();

		await waitFor(() =>
			expect(mockToastError).toHaveBeenCalledWith(
				"cleanSpecRefreshError",
			),
		);
		expect(mockAppendMessage).not.toHaveBeenCalled();
		// No cross-kind substitution is attempted in the browser either.
		expect(mockBoundPrompt).not.toHaveBeenCalled();
	});

	it("blocks a second concurrent run while the first is still resolving", async () => {
		let release: ((value: unknown) => void) | undefined;
		mockResolvePrompt.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		renderWorkspace(true);

		const button = await screen.findByRole("button", {
			name: /update full spec/i,
		});
		await act(async () => {
			fireEvent.click(button);
			fireEvent.click(button);
		});

		expect(mockResolvePrompt).toHaveBeenCalledTimes(1);

		await act(async () => {
			release?.(serverSaysBug(BUG_PROMPT));
		});
		await waitFor(() => expect(mockAppendMessage).toHaveBeenCalledTimes(1));
	});

	it("starts no run when the agent is already running", async () => {
		agentRef.current.isRunning = true;
		renderWorkspace(true);
		await clickUpdateFullSpec();

		expect(mockResolvePrompt).not.toHaveBeenCalled();
		expect(mockAppendMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Stage-transition Enhance
// ---------------------------------------------------------------------------

describe("StoryWorkspace — stage Enhance resolves its prompt server-side", () => {
	it("sends the server's prompt when the cached kind disagrees (AE1)", async () => {
		renderWorkspace(false);
		await runStageEnhance("enhance-default");

		await waitFor(() => expect(mockAppendMessage).toHaveBeenCalled());
		const input = mockResolvePrompt.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(input).toMatchObject({
			projectId: "proj-1",
			storyId: "story-1",
			targetStage: "DRAFT",
		});
		expect(Object.keys(input)).not.toContain("storyKind");
		expect(Object.keys(input)).not.toContain("agentName");
		expect(mockBoundPrompt).not.toHaveBeenCalled();
		expect(postedMessage()).toContain(BUG_PROMPT);
		expect(postedMessage()).not.toContain(FEATURE_PROMPT);
	});

	it("resolves a hand-picked prompt through the server rather than by id", async () => {
		mockResolvePrompt.mockResolvedValue(
			serverSaysBug(PICKED_PROMPT, "explicitPrompt"),
		);
		renderWorkspace(false);
		await runStageEnhance("enhance-picked-prompt");

		await waitFor(() => expect(mockAppendMessage).toHaveBeenCalled());
		expect(mockPromptById).not.toHaveBeenCalled();
		expect(mockResolvePrompt.mock.calls[0][0]).toMatchObject({
			storyId: "story-1",
			promptId: "prompt-picked-1",
			targetStage: "DRAFT",
		});
		expect(postedMessage()).toContain(PICKED_PROMPT);
	});

	it("invalidates the work item query before posting when the kind drifted", async () => {
		renderWorkspace(false);
		await runStageEnhance("enhance-default");

		await waitFor(() => expect(mockAppendMessage).toHaveBeenCalled());
		expect(mockInvalidateQueries).toHaveBeenCalled();
		expect(
			Math.min(...mockInvalidateQueries.mock.invocationCallOrder),
		).toBeLessThan(mockAppendMessage.mock.invocationCallOrder[0]);
	});

	it("falls back to the sync stage update and starts no run when nothing resolves (AE7)", async () => {
		mockResolvePrompt.mockResolvedValue({
			resolved: false,
			content: null,
			promptKey: null,
			source: null,
			kind: "BUG",
			kindWord: "bug",
		});
		renderWorkspace(false);
		await runStageEnhance("enhance-default");

		await waitFor(() => expect(mockEnhanceMutate).toHaveBeenCalled());
		expect(mockAppendMessage).not.toHaveBeenCalled();
		expect(mockBoundPrompt).not.toHaveBeenCalled();
		expect(mockPromptById).not.toHaveBeenCalled();
	});
});
