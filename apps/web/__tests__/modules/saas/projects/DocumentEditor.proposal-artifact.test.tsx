/**
 * The `DocumentEditor` props a Proposal's artifact-mode page passes
 * (Fizzy #2801, Fizzy #2946), against the real editor:
 *
 * - `suppressGenerationOverlay`: the page hosts generation progress itself,
 *   so the editor's full-screen overlay stays off for a run in progress — and
 *   stays on, as before, without the prop;
 * - `promptSelectorReplacement`: rendered where the prompt selector would be,
 *   which is not mounted at all;
 * - `contentThemeProps`: the box around the editor's content becomes the
 *   Proposal theme's root, and only that box — the diff preview panes beside
 *   it and the chat stay outside, unthemed.
 *
 * Unlike the other `DocumentEditor.*` suites, `<CopilotSidebar>` renders its
 * children here, beside a stand-in for its chat window: the props act inside
 * them. Every child that is not under test is a stand-in, the same as those
 * suites stub the hooks above it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const meetingFetch = vi.hoisted(() =>
	vi.fn(async (_input: unknown) => ({ notes: [] })),
);
const meetingActions = vi.hoisted(
	() =>
		new Map<
			string,
			{
				render: (input: {
					status: string;
					result?: unknown;
				}) => React.ReactElement;
				handler: (args: {
					selectedMeetings: unknown;
				}) => Promise<unknown>;
				renderAndWaitForResponse: (input: {
					respond: ReturnType<typeof vi.fn>;
				}) => React.ReactElement<{
					onConfirm: (
						meetings: Array<{
							joinUrl: string;
							startTime?: string;
						}>,
					) => void;
					onCancel: () => void;
				}>;
			}
		>(),
);

const extensionBuilds = vi.hoisted(() => ({
	advanced: [] as { projectId?: string | null; statTiles?: boolean }[],
}));

vi.mock(
	"@saas/projects/lib/tiptap-extensions-advanced",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@saas/projects/lib/tiptap-extensions-advanced")
			>();
		return {
			...actual,
			createAdvancedExtensions: (
				options: Parameters<typeof actual.createAdvancedExtensions>[0],
			) => {
				extensionBuilds.advanced.push(options ?? {});
				return actual.createAdvancedExtensions(options);
			},
		};
	},
);

const fixture = vi.hoisted(() => ({
	showDiffPreviewPanes: false,
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
			apply(_target, _thisArg, args) {
				if (path.join(".") === "projects.documents.fetchMeetingNotes") {
					return meetingFetch(args[0]);
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
	useCopilotAction: (action: { name: string }) =>
		meetingActions.set(action.name, action as never),
	useCopilotChat: () => ({ isLoading: false, visibleMessages: [] }),
	useCopilotChatInternal: () => ({ messages: [], setMessages: vi.fn() }),
	useCopilotReadable: vi.fn(),
	useCopilotMessagesContext: () => ({ setMessages: vi.fn() }),
}));
// The props under test act inside the sidebar's children, so it renders them,
// next to where the real one puts its chat window.
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({ children }: { children?: ReactNode }) => (
		<div>
			<div data-testid="copilot-chat-window" />
			{children}
		</div>
	),
}));
vi.mock("@tiptap/react", () => ({
	EditorContent: ({ className }: { className?: string }) => (
		<div data-testid="editor-content" className={className} />
	),
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
	DiffPreviewPanes: () => <div data-testid="diff-preview-panes" />,
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
		showDiffPreviewPanes: fixture.showDiffPreviewPanes,
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

import {
	buildProposalThemeTokens,
	NEUTRAL_THEME,
	resolveThemePaint,
	themeCustomProperties,
} from "@repo/utils/proposal-artifact/theme-tokens";
import {
	DocumentEditor,
	MEETING_NOTES_SKIPPED_NONE_RESULT,
	MEETING_NOTES_SKIPPED_TOO_MANY_RESULT,
} from "@saas/projects/components/DocumentEditor";
import type { ProposalThemeRootProps } from "@saas/projects/components/proposal-artifact/use-proposal-theme";
import type { CSSProperties } from "react";

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
	fixture.showDiffPreviewPanes = false;
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

describe("DocumentEditor — stat tiles", () => {
	function buildsForThisDocument() {
		return extensionBuilds.advanced.filter(
			(options) => options.projectId === "proj-1",
		);
	}

	beforeEach(() => {
		extensionBuilds.advanced.length = 0;
	});

	it("keeps a stat-tiles fence as a code block unless the page opts in", async () => {
		renderEditor({});

		await vi.waitFor(() =>
			expect(buildsForThisDocument().length).toBeGreaterThan(0),
		);
		expect(
			buildsForThisDocument().every((options) => !options.statTiles),
		).toBe(true);
	});

	it("draws stat tiles when the page opts in", async () => {
		renderEditor({ statTiles: true });

		await vi.waitFor(() =>
			expect(buildsForThisDocument().length).toBeGreaterThan(0),
		);
		expect(
			buildsForThisDocument().every((options) => options.statTiles),
		).toBe(true);
	});
});

describe("DocumentEditor — Proposal theme root", () => {
	const THEME_ROOT_PROPS: ProposalThemeRootProps = {
		className: "proposal-theme",
		"data-proposal-theme": "live",
		style: themeCustomProperties(
			resolveThemePaint(
				buildProposalThemeTokens({
					organization: null,
					style: null,
					brandKit: null,
					recipient: null,
				}),
			),
		) as CSSProperties,
	};

	/** The editor's scroll container: the desk the paper sits on. */
	function scrollContainer(from: HTMLElement): HTMLElement {
		const desk = from.closest<HTMLElement>(".overflow-auto");
		if (!desk) {
			throw new Error("no scroll container");
		}
		return desk;
	}

	function expectUnthemedUpTo(element: HTMLElement, desk: HTMLElement) {
		for (
			let node: HTMLElement | null = element;
			node && node !== desk.parentElement;
			node = node.parentElement
		) {
			expect(node).not.toHaveClass("proposal-theme");
			expect(node).not.toHaveAttribute("data-proposal-theme");
		}
	}

	beforeEach(() => {
		fixture.document = { ...fixture.document, status: "COMPLETE" };
	});

	it("makes the box around the editor's content the theme root, with the chat outside it", async () => {
		renderEditor({ contentThemeProps: THEME_ROOT_PROPS });

		const content = await screen.findByTestId("editor-content");
		const root = content.parentElement as HTMLElement;
		expect(root).toHaveClass("proposal-theme");
		expect(root).toHaveAttribute("data-proposal-theme", "live");
		expect(root.style.getPropertyValue("--pa-surface")).toBe(
			NEUTRAL_THEME.surface,
		);
		expect(root.style.getPropertyValue("--pa-ink")).toBe(NEUTRAL_THEME.ink);
		// The paper is painted from the theme's properties alone.
		expect(root.className).not.toMatch(/(^|\s)(bg|text)-/);
		expect(root).not.toHaveClass("hidden");
		// The scroll container is the desk; the chat is not on the paper.
		const desk = scrollContainer(root);
		expect(desk).toHaveClass("bg-background");
		expect(desk).not.toHaveClass("proposal-theme");
		const chat = screen.getByTestId("copilot-chat-window");
		expect(root).not.toContainElement(chat);
		expect(chat.closest(".proposal-theme")).toBeNull();
	});

	it("keeps the diff preview panes off the paper while they show", async () => {
		fixture.showDiffPreviewPanes = true;
		renderEditor({ contentThemeProps: THEME_ROOT_PROPS });

		const panes = await screen.findByTestId("diff-preview-panes");
		const root = screen.getByTestId("editor-content")
			.parentElement as HTMLElement;
		// The content box keeps its theme and is hidden behind the panes.
		expect(root).toHaveClass("proposal-theme", "hidden");
		expect(root).not.toContainElement(panes);
		expectUnthemedUpTo(panes, scrollContainer(panes));
	});

	it("leaves the content box as it was without the prop", async () => {
		renderEditor({});

		const content = await screen.findByTestId("editor-content");
		const box = content.parentElement as HTMLElement;
		expect(box).not.toHaveAttribute("class");
		expect(box).not.toHaveAttribute("data-proposal-theme");
		expect(box).not.toHaveAttribute("style");
	});
});

describe("DocumentEditor meeting selections", () => {
	beforeEach(() => {
		meetingActions.clear();
		meetingFetch.mockClear();
	});
	const confirmed = [
		{
			joinUrl: "https://example.com/meeting",
			startTime: "2026-10-20T10:00:00Z",
		},
	];
	function selector() {
		const action = meetingActions.get("select_meetings");
		if (!action) {
			throw new Error("Missing select_meetings action");
		}
		return action.renderAndWaitForResponse({ respond: vi.fn() }).props;
	}
	async function fetch(selectedMeetings: unknown) {
		const action = meetingActions.get("fetchMeetingNotes");
		if (!action) {
			throw new Error("Missing fetchMeetingNotes action");
		}
		return action.handler({ selectedMeetings });
	}
	it.each([
		{
			count: 0,
			expectedResult: MEETING_NOTES_SKIPPED_NONE_RESULT,
			message:
				"No meetings were selected. Meeting notes were not fetched.",
		},
		{
			count: 11,
			expectedResult: MEETING_NOTES_SKIPPED_TOO_MANY_RESULT,
			message:
				"Meeting notes were not fetched. Select at most 10 meetings.",
		},
	])(
		"renders a neutral skipped-fetch card for $count meetings",
		async ({ count, message, expectedResult }) => {
			renderEditor({});
			await waitFor(() =>
				expect(meetingActions.has("select_meetings")).toBe(true),
			);
			selector().onConfirm(
				Array.from({ length: count }, (_, index) => ({
					joinUrl: `https://example.com/meeting/${index}`,
				})),
			);
			let result: unknown;
			await act(async () => {
				result = await fetch([{}]);
			});
			const action = meetingActions.get("fetchMeetingNotes");
			if (!action) {
				throw new Error("Missing fetchMeetingNotes action");
			}
			expect(result).toBe(expectedResult);
			const card = render(action.render({ status: "complete", result }));
			expect(card.getByText(message)).toBeTruthy();
			expect(
				card.queryByText("Meeting notes fetched successfully."),
			).toBeNull();
			expect(meetingFetch).not.toHaveBeenCalled();
		},
	);

	it("keeps two meeting-note cards tied to their own results", async () => {
		renderEditor({});
		await waitFor(() =>
			expect(meetingActions.has("fetchMeetingNotes")).toBe(true),
		);
		let success: unknown;
		let skipped: unknown;
		await act(async () => {
			success = await fetch(confirmed);
			skipped = await fetch([]);
		});
		const action = meetingActions.get("fetchMeetingNotes");
		if (!action) {
			throw new Error("Missing fetchMeetingNotes action");
		}
		const cards = render(
			<>
				{action.render({ status: "complete", result: success })}
				{action.render({ status: "complete", result: skipped })}
			</>,
		);
		expect(
			cards.getByText("Meeting notes fetched successfully."),
		).toBeTruthy();
		expect(
			cards.getByText(
				"No meetings were selected. Meeting notes were not fetched.",
			),
		).toBeTruthy();
	});

	it("renders a failed meeting-note card for a completed tool error", async () => {
		renderEditor({});
		await waitFor(() =>
			expect(meetingActions.has("fetchMeetingNotes")).toBe(true),
		);
		const action = meetingActions.get("fetchMeetingNotes");
		if (!action) {
			throw new Error("Missing fetchMeetingNotes action");
		}
		const card = render(
			action.render({
				status: "complete",
				result: "Error: Meeting service unavailable",
			}),
		);
		expect(card.getByText("Failed to fetch meeting notes.")).toBeTruthy();
		expect(
			card.queryByText("Meeting notes fetched successfully."),
		).toBeNull();
	});

	it("renders a restored successful meeting-note card without running a handler", async () => {
		renderEditor({});
		await waitFor(() =>
			expect(meetingActions.has("fetchMeetingNotes")).toBe(true),
		);
		const action = meetingActions.get("fetchMeetingNotes");
		if (!action) {
			throw new Error("Missing fetchMeetingNotes action");
		}
		const card = render(
			action.render({
				status: "complete",
				result: "MEETING TRANSCRIPTS (reference material): example notes",
			}),
		);
		expect(
			card.getByText("Meeting notes fetched successfully."),
		).toBeTruthy();
		expect(meetingFetch).not.toHaveBeenCalled();
	});

	it("uses confirmed meetings when the model supplies empty objects", async () => {
		renderEditor({});
		await waitFor(() =>
			expect(meetingActions.has("select_meetings")).toBe(true),
		);
		selector().onConfirm(confirmed);
		await act(async () => {
			await fetch([{}]);
		});
		expect(meetingFetch).toHaveBeenCalledWith(
			expect.objectContaining({ selectedMeetings: confirmed }),
		);
	});
	it("does not fetch when the user cancels even if the model supplies meetings", async () => {
		renderEditor({});
		await waitFor(() =>
			expect(meetingActions.has("select_meetings")).toBe(true),
		);
		selector().onConfirm(confirmed);
		selector().onCancel();
		let result: unknown;
		await act(async () => {
			result = await fetch(confirmed);
		});
		expect(result).toMatch(/no meetings were selected/i);
		expect(meetingFetch).not.toHaveBeenCalled();
	});
	it.each([undefined, []])(
		"does not inject confirmed meetings when the model passes no selection: %j",
		async (meetings) => {
			renderEditor({});
			await waitFor(() =>
				expect(meetingActions.has("select_meetings")).toBe(true),
			);
			selector().onConfirm(confirmed);
			let result: unknown;
			await act(async () => {
				result = await fetch(meetings);
			});
			expect(result).toMatch(/no meetings were selected/i);
			expect(meetingFetch).not.toHaveBeenCalled();
		},
	);
	it("asks for fewer meetings when more than ten are selected", async () => {
		renderEditor({});
		await waitFor(() =>
			expect(meetingActions.has("select_meetings")).toBe(true),
		);
		selector().onConfirm(
			Array.from({ length: 11 }, (_, index) => ({
				joinUrl: `https://example.com/meeting/${index}`,
			})),
		);
		let result: unknown;
		await act(async () => {
			result = await fetch([{}]);
		});
		expect(result).toMatch(/at most 10 meetings/i);
		expect(result).toMatch(/pick fewer/i);
		expect(meetingFetch).not.toHaveBeenCalled();
	});

	it("filters invalid fallback meetings and skips the API when none remain", async () => {
		renderEditor({});
		await waitFor(() =>
			expect(meetingActions.has("select_meetings")).toBe(true),
		);
		let result: unknown;
		await act(async () => {
			result = await fetch([{}]);
		});
		expect(result).toMatch(/no meetings were selected/i);
		expect(meetingFetch).not.toHaveBeenCalled();
		await act(async () => {
			await fetch([
				{ joinUrl: "https://example.com/fallback", startTime: 1 },
			]);
		});
		expect(meetingFetch).toHaveBeenCalledWith(
			expect.objectContaining({
				selectedMeetings: [{ joinUrl: "https://example.com/fallback" }],
			}),
		);
	});
});
