/**
 * Smoke test for the StoryWorkspace USER_STORY parity hotfix.
 *
 * Group H originally mounted the document-assistant chat-history UI only on
 * the PROJECT_DOCUMENT surface (`DocumentEditor.tsx`). This test asserts that
 * the StoryWorkspace surface — which also receives Group D's hydrated
 * `initialAssistantConversationId` and `documentRefKind: "USER_STORY"` —
 * mounts the same three components with matching props:
 *
 *   - `createCopilotSidebarHeader(...)` → wired as `<CopilotSidebar Header>`
 *   - `<CopilotHistoryDrawer>`           → opens via the header's history icon
 *   - `<CopilotPersistenceHook>`         → mounted inside `<CopilotSidebar>`
 *
 * We mock the three components to capture the props they receive AND the
 * factory so we can read what `createCopilotSidebarHeader` was called with.
 * The full integration (visibility chip flip → API call, drawer query
 * fetch, persistence-on-stream-completion) is covered by the dedicated
 * Group E/F/H test files; this is a wiring-only smoke check.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
	mockCreateHeader,
	mockHistoryDrawer,
	mockPersistenceHook,
	mockUseHistoryEnabled,
	mockSetCopilotMessages,
} = vi.hoisted(() => ({
	mockCreateHeader: vi.fn(),
	mockHistoryDrawer: vi.fn(),
	mockPersistenceHook: vi.fn(),
	mockUseHistoryEnabled: vi.fn(),
	mockSetCopilotMessages: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock CopilotKit and its UI — the runtime requires a real provider; we
// stub the sidebar so children render directly into the smoke harness.
// ---------------------------------------------------------------------------

vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({
		state: { document: "" },
		setState: vi.fn(),
		running: false,
		nodeName: undefined,
	}),
	useCopilotAction: vi.fn(),
	// CopilotKit 1.52: the free `useCopilotChat()` Omits `messages` from
	// its public return type — only `isLoading`, `appendMessage`,
	// `visibleMessages` (legacy alias), etc. remain. We mirror that shape.
	useCopilotChat: () => ({
		isLoading: false,
		visibleMessages: [],
		appendMessage: vi.fn(),
	}),
	// `useCopilotChatInternal` is the supported read/write hook the sidebar
	// itself uses (see `react-ui/.../Messages.tsx` line ~1529).
	// StoryWorkspace
	// reads `setMessages` from it for the "+ New conversation" clear, and
	// `CopilotPersistenceHook` reads `messages` + `isLoading` from it for
	// stream-completion persistence. The mock exposes the captured
	// `setMessages` so the test can assert "+ New conversation" wiring.
	useCopilotChatInternal: () => ({
		messages: [],
		isLoading: false,
		setMessages: mockSetCopilotMessages,
	}),
	useCopilotReadable: vi.fn(),
}));

vi.mock("@copilotkit/react-ui", () => ({
	// The workspace closes the assistant on a phone-width viewport through this
	// hook. jsdom reports a wide window, so the effect is a no-op here.
	useChatContext: () => ({ setOpen: vi.fn() }),
	// Rendering children directly drops the persistence hook into the smoke
	// harness so we can assert its mount + props.
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
// Mock the three components under test so we can capture props.
// ---------------------------------------------------------------------------

vi.mock("@saas/projects/components/copilot/CopilotSidebarHeader", () => ({
	createCopilotSidebarHeader: (config: unknown) => {
		mockCreateHeader(config);
		return function MockedHeader() {
			return (
				<div data-testid="copilot-sidebar-header">
					<button
						type="button"
						data-testid="open-history-button"
						onClick={() =>
							(
								config as { onOpenHistory: () => void }
							).onOpenHistory()
						}
					>
						history
					</button>
				</div>
			);
		};
	},
}));

vi.mock("@saas/projects/components/copilot/CopilotHistoryDrawer", () => ({
	CopilotHistoryDrawer: (props: { open: boolean }) => {
		mockHistoryDrawer(props);
		return props.open ? (
			<div data-testid="copilot-history-drawer">drawer-open</div>
		) : (
			<div data-testid="copilot-history-drawer-closed" />
		);
	},
}));

vi.mock("@saas/projects/components/copilot/CopilotPersistenceHook", () => ({
	CopilotPersistenceHook: (props: Record<string, unknown>) => {
		mockPersistenceHook(props);
		return <div data-testid="copilot-persistence-hook" />;
	},
}));

// ---------------------------------------------------------------------------
// Mock the feature-flag hook.
// ---------------------------------------------------------------------------

vi.mock("@saas/projects/hooks/useDocumentAssistantHistoryEnabled", () => ({
	useDocumentAssistantHistoryEnabled: () => mockUseHistoryEnabled(),
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
	// Returns `[setRef, isOverflowing]` — the smoke test never measures
	// overflow, so the ref setter is a no-op and the flag is always false.
	useIsOverflowing: () => [vi.fn(), false] as const,
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	// Recursive Proxy that returns a callable on the leaf so chained access
	// like `orpc.projects.get.queryOptions({ ... })` resolves cleanly. Each
	// non-leaf get returns another Proxy; the leaf — `queryOptions` /
	// `mutationOptions` / etc. — returns a no-op function with the shape
	// TanStack Query expects.
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
					prop === "queryKey"
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

vi.mock("@tiptap/react", () => ({
	useEditor: () => null,
	EditorContent: () => null,
}));

vi.mock("next/navigation", () => ({
	useParams: () => ({}),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	// The workspace consumes `?storyTab=` to land on a specific maturation tab,
	// which needs the location as well as the router.
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

vi.mock("../../shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: {
			conversations: {
				archiveForDocument: vi.fn(),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		loading: vi.fn(),
	},
}));

vi.mock("./useUpdateWithContext", () => ({
	useUpdateWithContext: () => ({
		mutate: vi.fn(),
		isPending: false,
		loadingStage: "",
		elapsedSeconds: 0,
	}),
}));

vi.mock("../../lib/use-clipboard-image-paste", () => ({
	useClipboardImagePaste: vi.fn(),
}));

vi.mock("../../lib/story-content", () => ({
	parseStoryContent: (s: unknown) => ({
		description: typeof s === "string" ? s : "",
		acceptanceCriteria: "",
	}),
	formatStoryContent: () => "",
}));

vi.mock("turndown", () => ({
	default: class {
		turndown = () => "";
		addRule = () => this;
		use = () => this;
	},
}));

vi.mock("turndown-plugin-gfm", () => ({ gfm: vi.fn() }));

// ---------------------------------------------------------------------------
// Stub the heavy sub-components StoryWorkspace renders that aren't relevant
// to the smoke check (their internals require deeper fixtures).
// ---------------------------------------------------------------------------

vi.mock("../../components/DiffReviewBar", () => ({
	DiffReviewBar: () => null,
}));

vi.mock("../../components/EditorToolbar", () => ({
	EditorToolbar: () => null,
}));

vi.mock("../../components/stories/ConvertKindConfirmDialog", () => ({
	ConvertKindConfirmDialog: () => null,
}));

vi.mock("../../components/stories/FeatureTransitionDialog", () => ({
	FeatureTransitionDialog: () => null,
}));

vi.mock("../../components/stories/FeatureVersionHistory", () => ({
	FeatureVersionHistory: () => null,
}));

// ---------------------------------------------------------------------------
// Import StoryWorkspace AFTER all mocks are registered.
// ---------------------------------------------------------------------------

import { StoryWorkspace } from "../../modules/saas/projects/components/stories/StoryWorkspace";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const baseStory = {
	id: "story-1",
	identifier: "F-001",
	title: "Test feature",
	description: "Initial description",
	acceptanceCriteria: "",
	statusId: "status-1",
	priority: "MEDIUM",
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

function renderWorkspace() {
	return render(
		<StoryWorkspace
			story={baseStory as Parameters<typeof StoryWorkspace>[0]["story"]}
			canEdit
			projectId="proj-1"
			projectName="Test Project"
			onClose={vi.fn()}
		/>,
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StoryWorkspace — document-assistant history wiring (USER_STORY parity)", () => {
	beforeEach(() => {
		mockCreateHeader.mockReset();
		mockHistoryDrawer.mockReset();
		mockPersistenceHook.mockReset();
		mockUseHistoryEnabled.mockReset();
		mockSetCopilotMessages.mockReset();
	});

	it("mounts the sidebar header, history drawer, and persistence hook when the feature flag is ON", () => {
		mockUseHistoryEnabled.mockReturnValue(true);

		renderWorkspace();

		// 1. Header was assembled with USER_STORY scope.
		expect(mockCreateHeader).toHaveBeenCalledTimes(1);
		const headerConfig = mockCreateHeader.mock.calls[0][0];
		expect(headerConfig).toMatchObject({
			documentRefKind: "USER_STORY",
			documentRefId: "story-1",
			projectId: "proj-1",
			organizationId: "org-1",
		});
		expect(typeof headerConfig.onNewConversation).toBe("function");
		expect(typeof headerConfig.onOpenHistory).toBe("function");

		// 2. Drawer is mounted (rendered closed initially).
		expect(mockHistoryDrawer).toHaveBeenCalled();
		const drawerProps = mockHistoryDrawer.mock.calls[0][0];
		expect(drawerProps).toMatchObject({
			open: false,
			documentRefKind: "USER_STORY",
			documentRefId: "story-1",
			projectId: "proj-1",
			organizationId: "org-1",
			currentUserId: "user-1",
		});

		// 3. Persistence hook is mounted with USER_STORY scope and the
		//    feature-assistant agent id.
		expect(mockPersistenceHook).toHaveBeenCalled();
		const hookProps = mockPersistenceHook.mock.calls[0][0];
		expect(hookProps).toMatchObject({
			documentRefKind: "USER_STORY",
			documentRefId: "story-1",
			projectId: "proj-1",
			organizationId: "org-1",
			agentId: "project_document_generator",
			requestedVisibility: "SHARED",
		});

		// The DOM markers each mocked component exposes are present.
		expect(
			screen.getByTestId("copilot-sidebar-header"),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("copilot-persistence-hook"),
		).toBeInTheDocument();
	});

	it("does NOT mount the new header, drawer, or persistence hook when the feature flag is OFF", () => {
		mockUseHistoryEnabled.mockReturnValue(false);

		renderWorkspace();

		// Header factory not invoked → CopilotSidebar gets undefined Header
		// and falls back to the CopilotKit default.
		expect(mockCreateHeader).not.toHaveBeenCalled();
		// Drawer / persistence-hook gated on the same flag.
		expect(mockHistoryDrawer).not.toHaveBeenCalled();
		expect(mockPersistenceHook).not.toHaveBeenCalled();
		expect(
			screen.queryByTestId("copilot-sidebar-header"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("copilot-persistence-hook"),
		).not.toBeInTheDocument();
	});

	it("opens the history drawer when the header's `onOpenHistory` callback fires", () => {
		mockUseHistoryEnabled.mockReturnValue(true);

		renderWorkspace();

		// Drawer renders closed initially (mocked component renders the
		// `-closed` marker when `open === false`).
		expect(
			screen.queryByTestId("copilot-history-drawer"),
		).not.toBeInTheDocument();
		expect(
			screen.getByTestId("copilot-history-drawer-closed"),
		).toBeInTheDocument();

		// Click the mocked header's "open history" button — which invokes
		// the real `onOpenHistory` callback closed over by the factory call.
		act(() => {
			fireEvent.click(screen.getByTestId("open-history-button"));
		});

		// Drawer now rendered open (and the closed marker is gone).
		expect(
			screen.getByTestId("copilot-history-drawer"),
		).toBeInTheDocument();
	});
});
