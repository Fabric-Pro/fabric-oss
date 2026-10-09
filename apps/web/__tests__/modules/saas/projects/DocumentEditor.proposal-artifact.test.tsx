/**
 * The two `DocumentEditor` props a Proposal's artifact-mode page passes
 * (Fizzy #2801), against the real editor:
 *
 * - `suppressGenerationOverlay`: the page hosts generation progress itself,
 *   so the editor's full-screen overlay stays off for a run in progress — and
 *   stays on, as before, without the prop;
 * - `promptSelectorReplacement`: rendered where the prompt selector would be,
 *   which is not mounted at all.
 *
 * Unlike the other `DocumentEditor.*` suites, `<CopilotSidebar>` renders its
 * children here: both props act inside it. Every child that is not under test
 * is a stand-in, the same as those suites stub the hooks above it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	document: {
		id: "doc-1",
		title: "Example proposal",
		type: "PROPOSAL",
		status: "GENERATING",
		content: "",
		version: 1,
		generationProgress: 40,
		generationStartedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	} as Record<string, unknown>,
}));

function cannedResponseFor(path: string[]): unknown {
	const joined = path.join(".");
	if (joined === "projects.documents.get") {
		return { document: fixture.document };
	}
	if (joined === "projects.get") {
		return { project: { name: "proj-1", techStack: [], features: [] } };
	}
	return {};
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
						queryFn: async () => cannedResponseFor(path),
					});
				}
				if (prop === "mutationOptions") {
					return (config: Record<string, unknown>) => ({
						mutationFn: async () => cannedResponseFor(path),
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
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
		isOrgContext: true,
		loaded: true,
	}),
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1" }, session: {} }),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({ state: {}, setState: vi.fn(), nodeName: undefined }),
	useCopilotAction: vi.fn(),
	useCopilotChat: () => ({ isLoading: false, visibleMessages: [] }),
	useCopilotChatInternal: () => ({ messages: [], setMessages: vi.fn() }),
	useCopilotReadable: vi.fn(),
	useCopilotMessagesContext: () => ({ setMessages: vi.fn() }),
}));
// The props under test act inside the sidebar's children, so it renders them.
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@tiptap/react", () => ({
	EditorContent: () => null,
	useEditor: () => null,
}));

vi.mock("@saas/prompts/components/PromptSelector", () => ({
	PromptSelector: () => <select aria-label="Prompt selector" />,
}));
vi.mock("@saas/projects/components/DocumentGenerationProgress", () => ({
	DocumentGenerationProgress: () => (
		<div data-testid="generation-progress-overlay" />
	),
}));

// Children of the sidebar that are not under test.
vi.mock("@saas/projects/components/EditorToolbar", () => ({
	EditorToolbar: () => null,
}));
vi.mock("@saas/projects/components/DocumentTocRail", () => ({
	DocumentTocRail: () => null,
}));
vi.mock("@saas/projects/components/DocumentVersionHistory", () => ({
	DocumentVersionHistory: () => null,
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
	CollaborationStatus: () => null,
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
		useUpdateDocumentWithContext: () => ({
			isActive: false,
			showingDiff: false,
			isLoading: false,
			loadingStage: null,
			elapsedSeconds: 0,
			preview: null,
			start: vi.fn(),
			confirm: vi.fn(),
			reject: vi.fn(),
		}),
	}),
);

import { DocumentEditor } from "@saas/projects/components/DocumentEditor";

function renderEditor(props: Partial<Parameters<typeof DocumentEditor>[0]>) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<DocumentEditor projectId="proj-1" documentId="doc-1" {...props} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	fixture.document = {
		...fixture.document,
		status: "GENERATING",
		content: "",
	};
});

describe("DocumentEditor — generation overlay", () => {
	it("shows its overlay for a run in progress, as before", async () => {
		renderEditor({});

		expect(
			await screen.findByTestId("generation-progress-overlay"),
		).toBeInTheDocument();
	});

	it("keeps the overlay off when the page hosts the progress", async () => {
		renderEditor({ suppressGenerationOverlay: true });

		// The editor rendered its body: the prompt row is there.
		expect(
			await screen.findByRole("combobox", { name: "Prompt selector" }),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("generation-progress-overlay"),
		).not.toBeInTheDocument();
	});
});

describe("DocumentEditor — prompt selector replacement", () => {
	it("renders the replacement where the selector was, and no selector", async () => {
		fixture.document = { ...fixture.document, status: "COMPLETE" };
		renderEditor({
			promptSelectorReplacement: (
				<span>Client proposal prompt from the library</span>
			),
		});

		expect(
			await screen.findByText("Client proposal prompt from the library"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("combobox", { name: "Prompt selector" }),
		).not.toBeInTheDocument();
	});

	it("keeps the selector without a replacement", async () => {
		fixture.document = { ...fixture.document, status: "COMPLETE" };
		renderEditor({});

		expect(
			await screen.findByRole("combobox", { name: "Prompt selector" }),
		).toBeInTheDocument();
	});
});
