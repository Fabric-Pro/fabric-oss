import { FocusModeProvider } from "@saas/shared/contexts/FocusModeContext";
import { SidebarCollapseProvider } from "@saas/shared/contexts/SidebarCollapseContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren, ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { stories: { listAttachments: vi.fn() } } },
}));
vi.mock("../editor/ProvenanceSection", () => ({
	ProvenanceSection: () => <div data-testid="provenance">prov</div>,
}));
vi.mock("../../../hooks/useFeatureMaturationV2Enabled", () => ({
	useFeatureMaturationV2Enabled: () => false,
}));
vi.mock("@copilotkit/react-ui", () => ({
	useChatContext: () => ({ setOpen: vi.fn() }),
	CopilotSidebar: ({ children }: { children?: ReactNode }) => (
		<div data-testid="copilot-sidebar">{children}</div>
	),
}));
vi.mock("@saas/projects/hooks/useDocumentAssistantHistoryEnabled", () => ({
	useDocumentAssistantHistoryEnabled: () => false,
}));
vi.mock("@saas/projects/hooks/useDocumentAssistantHistory", () => ({
	useDocumentAssistantHistoryRealtimeSync: vi.fn(),
	useActiveDocumentAssistantConversation: () => ({
		data: undefined,
		isLoading: false,
	}),
}));
vi.mock(
	"@saas/projects/components/copilot/DocumentAssistantOutcomesProvider",
	() => ({
		DocumentAssistantOutcomesProvider: ({
			children,
		}: {
			children: ReactNode;
		}) => children,
	}),
);
vi.mock("@saas/projects/components/copilot/HydratedMessagesContext", () => ({
	HydratedMessagesProvider: ({ children }: { children: ReactNode }) =>
		children,
	useHydratedMessages: () => ({ hydratedMessages: [] }),
}));
vi.mock("@tiptap/react", () => ({
	useEditor: () => null,
	EditorContent: () => null,
}));
vi.mock("@saas/subscriptions/components/SubscribeToggle", () => ({
	SubscribeToggle: () => null,
}));
vi.mock("@saas/agents/hooks/useDefaultMcpInlineRender", () => ({
	useDefaultMcpInlineRender: vi.fn(),
}));
vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useFabricAgentLauncher: () => ({ launch: vi.fn() }),
	useRegisterFabricAgentContext: vi.fn(),
}));
vi.mock("@saas/agents/hooks/useCodeContextLauncher", () => ({
	useCodeContextLauncher: () => ({ launch: vi.fn() }),
}));
vi.mock("@saas/agents/hooks/useFabricMention", () => ({
	useFabricMention: () => ({ extension: null, suggestion: {} }),
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", name: "Test User" } }),
}));
vi.mock("../DeliveryTrackSelector", () => ({
	DeliveryTrackSelector: () => <div data-testid="delivery-track-selector" />,
}));
vi.mock("../EstimateConfidenceSelector", () => ({
	EstimateConfidenceSelector: () => (
		<div data-testid="estimate-confidence-selector" />
	),
}));
vi.mock("../ReadinessPanel", () => ({
	ReadinessPanel: () => <div data-testid="readiness-panel" />,
}));
vi.mock("../DiscoveryPanel", () => ({
	DiscoveryPanel: () => <div data-testid="discovery-panel" />,
}));
vi.mock("../StoryEvidence", () => ({
	StoryEvidence: () => <div data-testid="story-evidence" />,
}));
// `<CopilotChatSessionProvider>` (mounted by the page inside `<CopilotKit>`)
// calls `useCopilotChatInternal()` once for the whole surface, so the mock has
// to expose it. The session object is built inside the factory and returned by
// reference — a fresh literal per call would hand every consumer a new value on
// every render.
vi.mock("@copilotkit/react-core", () => {
	const session = {
		messages: [],
		visibleMessages: [],
		isLoading: false,
		appendMessage: async () => {},
		setMessages: () => {},
		interrupt: null,
		agent: undefined,
	};
	return {
		CopilotKit: ({ children }: { children: ReactNode }) => children,
		useCopilotChatInternal: () => session,
		useCoAgent: () => ({
			state: { document: "" },
			setState: vi.fn(),
			running: false,
			nodeName: undefined,
		}),
		useCopilotAction: vi.fn(),
		useCopilotReadable: vi.fn(),
	};
});
vi.mock("@copilotkit/react-ui/styles.css", () => ({}));
vi.mock("@saas/agents/components/AgentErrorBoundary", () => ({
	AgentErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../pm-sync/PmSyncChip", () => ({ PmSyncChip: () => null }));
vi.mock("../StartWorkButton", () => ({ StartWorkButton: () => null }));
vi.mock("../StoryDownloadDropdown", () => ({
	StoryDownloadDropdown: () => null,
}));
vi.mock("../NeedsMoreInfoBadge", () => ({ NeedsMoreInfoBadge: () => null }));
vi.mock("../StoryKindIcon", () => ({ StoryKindIcon: () => null }));
vi.mock("../StoryCommentsButton", () => ({ StoryCommentsButton: () => null }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/acme",
	}),
}));
vi.mock("@saas/shared/contexts/FullscreenContext", () => ({
	useFullscreen: () => ({ setIsFullscreen: vi.fn() }),
}));
vi.mock("@saas/shared/components/copilot/use-copilot-error-handler", () => ({
	useCopilotErrorHandler: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	usePathname: () => "/app/acme/projects/p1/stories/s1",
	useParams: () => ({}),
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../../../lib/stories/types", async (importActual) => {
	const actual = await importActual<Record<string, unknown>>();
	return {
		...actual,
		transformStory: (s: { id: string }) => ({
			id: s.id,
			title: "Focus mode test feature",
			kind: "STORY",
			priority: "MEDIUM",
			identifier: "F-100",
			createdById: "u1",
			tasks: [],
		}),
		getPriorityLabel: () => "Medium",
	};
});

vi.mock("@shared/lib/orpc-query-utils", () => {
	const stub = (data: unknown) => ({
		queryOptions: (opts: { input: unknown }) => ({
			queryKey: ["stub", opts?.input],
			queryFn: async () => data,
		}),
		queryKey: (opts?: { input?: unknown }) => ["stub", opts?.input],
		key: () => ["stub"],
		mutationOptions: () => ({
			queryKey: ["stub"],
			mutationFn: async () => ({}),
		}),
	});
	const makeProxy = (path: string[]): unknown =>
		new Proxy(() => undefined, {
			get: (_t, prop) => {
				const fullPath = [...path, String(prop)].join(".");
				if (fullPath === "projects.get") {
					return stub({
						project: {
							id: "p1",
							name: "Foundry Test Bench",
							organizationId: "org-1",
						},
					});
				}
				if (fullPath === "projects.stories.get") {
					return stub({
						story: {
							id: "s1",
							identifier: "F-100",
							title: "Focus mode test feature",
							kind: "STORY",
							priority: "MEDIUM",
						},
						canEdit: true,
						canAddTags: true,
						canManageAllTags: true,
					});
				}
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

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => {
		const dict: Record<string, string> = {
			enterFocusMode: "Focus Mode",
			enterFocusModeHint: "Hide surrounding headers (F)",
			exitFocusMode: "Exit Focus Mode",
			exitFocusModeHint: "Restore standard header (F)",
		};
		return dict[key] ?? key;
	},
}));

import { StoryWorkspacePage } from "../StoryWorkspacePage";

describe("StoryWorkspacePage Focus Mode Integration", () => {
	let queryClient: QueryClient;

	beforeAll(() => {
		queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
	});

	function Wrapper({ children }: PropsWithChildren) {
		return (
			<QueryClientProvider client={queryClient}>
				<SidebarCollapseProvider>
					<FocusModeProvider>{children}</FocusModeProvider>
				</SidebarCollapseProvider>
			</QueryClientProvider>
		);
	}

	it("hides header chrome and collapses engagement profile metadata row in Focus Mode and restores on exit", async () => {
		const user = userEvent.setup();
		render(
			<StoryWorkspacePage
				projectId="p1"
				storyId="s1"
				organizationSlug="acme"
			/>,
			{ wrapper: Wrapper },
		);

		// Initially, the breadcrumb trail is visible in the header and engagement profile row is visible in workspace
		expect(
			await screen.findByText("Foundry Test Bench"),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("engagement-profile-metadata-row"),
		).toBeVisible();

		// Focus Mode toggle is available in workspace
		const focusToggle = screen.getByRole("button", { name: "Focus Mode" });
		expect(focusToggle).toBeInTheDocument();

		// Activate Focus Mode
		await user.click(focusToggle);

		// Header breadcrumb "Foundry Test Bench" should be hidden
		expect(
			screen.queryByText("Foundry Test Bench"),
		).not.toBeInTheDocument();
		// Engagement profile metadata row remains mounted but hidden via CSS/accessibility attributes
		const metadataRow = screen.getByTestId(
			"engagement-profile-metadata-row",
		);
		expect(metadataRow).not.toBeVisible();
		expect(metadataRow).toHaveClass("hidden");
		expect(metadataRow).toHaveAttribute("aria-hidden", "true");

		// Exit Focus Mode
		const exitToggle = screen.getByRole("button", {
			name: "Exit Focus Mode",
		});
		await user.click(exitToggle);

		// Header breadcrumb restores
		expect(
			await screen.findByText("Foundry Test Bench"),
		).toBeInTheDocument();
		// Engagement profile metadata row restores to visible
		expect(metadataRow).toBeVisible();
		expect(metadataRow).not.toHaveClass("hidden");
		expect(metadataRow).toHaveAttribute("aria-hidden", "false");
	});
});
