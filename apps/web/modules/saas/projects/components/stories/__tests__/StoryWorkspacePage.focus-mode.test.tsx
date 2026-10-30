import { FocusModeProvider } from "@saas/shared/contexts/FocusModeContext";
import { SidebarCollapseProvider } from "@saas/shared/contexts/SidebarCollapseContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	type PropsWithChildren,
	type ReactNode,
	useSyncExternalStore,
} from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fakePage = vi.hoisted(() => {
	const events = new Set<() => void>();
	const agentListeners = new Set<Record<string, (args: any) => void>>();
	const page = {
		revision: 0,
		renders: vi.fn(),
		markdown: vi.fn(),
		subscribe: (fn: () => void) => {
			events.add(fn);
			return () => {
				events.delete(fn);
			};
		},
		subscribeNone: () => () => {},
		agent: {
			agentId: "project_document_generator",
			isRunning: false,
			state: {} as Record<string, unknown>,
			messages: [],
			subscribe: (listener: Record<string, (args: any) => void>) => {
				agentListeners.add(listener);
				return { unsubscribe: () => agentListeners.delete(listener) };
			},
			setState: (state: Record<string, unknown>) => {
				page.agent.state = structuredClone(state);
				page.emit();
			},
		},
		runtime: {
			agents: {} as Record<string, unknown>,
			subscribe: () => ({ unsubscribe() {} }),
		},
		emit: () => {
			page.revision++;
			for (const listener of agentListeners) {
				listener.onStateChanged?.({ state: page.agent.state });
			}
			for (const fn of events) {
				fn();
			}
		},
	};
	page.runtime.agents.project_document_generator = page.agent;
	return page;
});
const runSignal = vi.hoisted(() => ({ active: false }));
vi.mock("@saas/shared/components/copilot/use-user-run-signal", () => ({
	useUserRunSignal: () => ({
		isUserGenerationActive: runSignal.active,
		markUserRunInitiated: vi.fn(),
		clearUserRunMark: vi.fn(),
	}),
}));
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
	useEditor: () => {
		fakePage.renders();
		return null;
	},
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
vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: ({ children }: { children: ReactNode }) => children,
	useCopilotChatInternal: () => {
		useSyncExternalStore(fakePage.subscribe, () => fakePage.revision);
		return {
			messages: [],
			visibleMessages: [],
			isLoading: fakePage.agent.isRunning,
			appendMessage: async () => {},
			setMessages: () => {},
			interrupt: null,
			agent: fakePage.agent,
		};
	},
	useCopilotAction: vi.fn(),
	useCopilotReadable: vi.fn(),
}));
vi.mock("@copilotkit/react-core/v2", () => ({
	useAgent: ({ updates }: { updates?: unknown[] }) => {
		useSyncExternalStore(
			updates?.length === 0 ? fakePage.subscribeNone : fakePage.subscribe,
			() => (updates?.length === 0 ? 0 : fakePage.revision),
		);
		return { agent: fakePage.agent };
	},
	useCopilotKit: () => ({ copilotkit: fakePage.runtime }),
}));
vi.mock("@copilotkit/react-core/v2/context", () => ({
	useCopilotKit: () => ({ copilotkit: fakePage.runtime }),
}));
vi.mock("@saas/projects/lib/diff-utils", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@saas/projects/lib/diff-utils")>();
	return {
		...actual,
		fromMarkdown: (...args: Parameters<typeof actual.fromMarkdown>) => {
			fakePage.markdown(args[0]);
			return actual.fromMarkdown(...args);
		},
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

import { ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY } from "../../../hooks/useEngagementProfileExpanded";
import { StoryWorkspacePage } from "../StoryWorkspacePage";

describe("StoryWorkspacePage Focus Mode Integration", () => {
	let queryClient: QueryClient;

	beforeAll(() => {
		queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
	});

	beforeEach(() => {
		localStorage.clear();
		runSignal.active = false;
		fakePage.agent.state = {};
		fakePage.agent.isRunning = false;
		fakePage.renders.mockClear();
		fakePage.markdown.mockClear();
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

	it("real StoryWorkspace ignores unread agent/session events and receives streamed documents through real hooks", async () => {
		render(
			<StoryWorkspacePage
				projectId="p1"
				storyId="s1"
				organizationSlug="acme"
			/>,
			{ wrapper: Wrapper },
		);
		await screen.findByTestId("engagement-profile-metadata-row");
		act(() => {
			fakePage.agent.isRunning = true;
			fakePage.emit();
		});
		// Drain query/effect work before measuring event-driven page renders.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
		});
		const before = fakePage.renders.mock.calls.length;
		for (let i = 0; i < 8; i++) {
			act(() =>
				fakePage.agent.setState({
					...fakePage.agent.state,
					reasoningByTurn: { i },
				}),
			);
		}
		expect(fakePage.renders).toHaveBeenCalledTimes(before);
		act(() =>
			fakePage.agent.setState({
				...fakePage.agent.state,
				document: "Streamed document reached the page",
			}),
		);
		expect(fakePage.renders.mock.calls.length).toBeGreaterThan(before);
		expect(fakePage.markdown).toHaveBeenCalledWith(
			"Streamed document reached the page",
		);
	});

	it("keeps profile and stage nodes mounted and noninteractive across a run", async () => {
		const page = (
			<StoryWorkspacePage
				projectId="p1"
				storyId="s1"
				organizationSlug="acme"
			/>
		);
		const view = render(page, { wrapper: Wrapper });
		const profile = await screen.findByTestId(
			"engagement-profile-metadata-row",
		);
		const stage = screen.getByTestId("drafting-stage-row");
		runSignal.active = true;
		view.rerender(
			<StoryWorkspacePage
				projectId="p1"
				storyId="s1"
				organizationSlug="acme"
			/>,
		);
		expect(screen.getByTestId("engagement-profile-metadata-row")).toBe(
			profile,
		);
		expect(screen.getByTestId("drafting-stage-row")).toBe(stage);
		expect(profile).not.toBeVisible();
		expect(stage).not.toBeVisible();
		expect(profile).toHaveAttribute("inert");
		expect(stage).toHaveAttribute("inert");
		runSignal.active = false;
		view.rerender(
			<StoryWorkspacePage
				projectId="p1"
				storyId="s1"
				organizationSlug="acme"
			/>,
		);
		expect(screen.getByTestId("engagement-profile-metadata-row")).toBe(
			profile,
		);
		expect(screen.getByTestId("drafting-stage-row")).toBe(stage);
		expect(profile).toBeVisible();
		expect(stage).toBeVisible();
	});

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

	it("collapses engagement profile metadata row by default and expands/collapses via manual toggle", async () => {
		const user = userEvent.setup();
		render(
			<StoryWorkspacePage
				projectId="p1"
				storyId="s1"
				organizationSlug="acme"
			/>,
			{ wrapper: Wrapper },
		);

		await screen.findByText("Foundry Test Bench");
		const toggle = screen.getByTestId("engagement-profile-metadata-toggle");
		expect(toggle).toBeInTheDocument();
		expect(toggle).toHaveAttribute("aria-expanded", "false");

		// Delivery track selector is in the DOM (mounted) but not visible because content is hidden
		const trackSelector = screen.getByTestId("delivery-track-selector");
		expect(trackSelector).toBeInTheDocument();
		expect(trackSelector).not.toBeVisible();

		// Click toggle to expand
		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(trackSelector).toBeVisible();
		expect(
			localStorage.getItem(ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY),
		).toBe("true");

		// Click toggle again to collapse
		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(trackSelector).not.toBeVisible();
		expect(
			localStorage.getItem(ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY),
		).toBe("false");
	});

	it("preserves manual expanded state across Focus Mode enter and exit", async () => {
		const user = userEvent.setup();
		render(
			<StoryWorkspacePage
				projectId="p1"
				storyId="s1"
				organizationSlug="acme"
			/>,
			{ wrapper: Wrapper },
		);

		await screen.findByText("Foundry Test Bench");
		const toggle = screen.getByTestId("engagement-profile-metadata-toggle");
		const trackSelector = screen.getByTestId("delivery-track-selector");

		// Expand the row manually
		await user.click(toggle);
		expect(trackSelector).toBeVisible();

		// Enter Focus Mode
		const focusToggle = screen.getByRole("button", { name: "Focus Mode" });
		await user.click(focusToggle);

		// Outer row is hidden in Focus Mode
		const metadataRow = screen.getByTestId(
			"engagement-profile-metadata-row",
		);
		expect(metadataRow).not.toBeVisible();

		// Exit Focus Mode
		const exitToggle = screen.getByRole("button", {
			name: "Exit Focus Mode",
		});
		await user.click(exitToggle);

		// Outer row is visible again, and inner content remains expanded.
		expect(metadataRow).toBeVisible();
		expect(trackSelector).toBeVisible();
		expect(
			localStorage.getItem(ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY),
		).toBe("true");
	});
});
