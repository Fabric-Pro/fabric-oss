/**
 * Fizzy #2048 (U7) — a type conversion tells the truth, shows its progress, and
 * lands the new body on its own.
 *
 * Before this unit the conversion surface asserted two things that stopped
 * being true the moment U5/U6 landed:
 *
 *   1. the confirmation dialog said "Card content stays as-is — no prompt
 *      re-chaining", while the conversion now REPLACES the description and the
 *      acceptance criteria through the new type's template; and
 *   2. all three entry points fired "Converted to bug" the instant the mutation
 *      resolved — which is before the rewrite has even started, because the
 *      redraft runs in a Temporal workflow for about a minute.
 *
 * These tests hold the corrected contract at two of the three entry points
 * (the board kebab and the work item detail view; the roadmap row shares the
 * same hook and the same two components) plus the dialog they share.
 *
 * SCAFFOLDING NOTE. `@tanstack/react-query` is mocked, adapting the mount
 * scaffold from `modules/saas/projects/components/stories/__tests__/StoryWorkspace.prompt-routing.test.tsx`.
 * The regeneration read is intercepted BY KEY and honours the `enabled` flag
 * the production hook computes — so a surface that is not watching this work
 * item still sees nothing, and the persistence mechanism (a per-tab watchlist
 * deciding whether to poll) is exercised for real rather than stubbed out.
 * `@shared/lib/orpc-query-utils` is deliberately NOT mocked: every invalidation
 * assertion below is written against the key the real oRPC client produces, so
 * a filter that silently matches nothing fails here.
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
import enMessages from "../../../../../../../../packages/i18n/translations/en.json";

// ---------------------------------------------------------------------------
// Hoisted state the mocks and the tests share
// ---------------------------------------------------------------------------

const {
	regenerationFixture,
	mockConvertKind,
	mockInvalidateQueries,
	mockToastSuccess,
	mockToastError,
	setEditableSpy,
	agentRef,
	editorRef,
} = vi.hoisted(() => ({
	/** Stands in for what `projects.stories.regenerationStatus` answers. */
	regenerationFixture: {
		current: null as null | {
			status: "idle" | "running" | "completed" | "failed";
			error: string | null;
			errorClass: string | null;
			startedAt: string | null;
			completedAt: string | null;
		},
	},
	mockConvertKind: vi.fn(),
	mockInvalidateQueries: vi.fn(),
	mockToastSuccess: vi.fn(),
	mockToastError: vi.fn(),
	setEditableSpy: vi.fn(),
	agentRef: { current: { isRunning: false } },
	editorRef: { current: null as unknown },
}));

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
	ResizeObserverStub;

// ---------------------------------------------------------------------------
// i18n — resolve the REAL shipped English copy so the assertions below are
// about what a user reads, not about key names.
// ---------------------------------------------------------------------------

vi.mock("next-intl", () => {
	const lookup = (path: string): string => {
		const value = path
			.split(".")
			.reduce<unknown>(
				(node, segment) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[segment]
						: undefined,
				enMessages,
			);
		return typeof value === "string" ? value : path;
	};
	const interpolate = (template: string, values?: Record<string, unknown>) =>
		values
			? template.replace(/\{(\w+)\}/g, (match, token) =>
					token in values ? String(values[token]) : match,
				)
			: template;
	const useTranslations = (namespace?: string) => {
		const t = (key: string, values?: Record<string, unknown>) =>
			interpolate(
				lookup(namespace ? `${namespace}.${key}` : key),
				values,
			);
		t.raw = (key: string) =>
			lookup(namespace ? `${namespace}.${key}` : key);
		return t;
	};
	return {
		useTranslations,
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => enMessages,
		NextIntlClientProvider: ({ children }: { children: ReactNode }) =>
			children,
	};
});

// ---------------------------------------------------------------------------
// The transport. `orpc-query-utils` stays REAL and is built over this object,
// so every query key in the assertions is a genuine oRPC key.
// ---------------------------------------------------------------------------

vi.mock("@shared/lib/orpc-client", () => {
	// A recursive proxy: `createTanstackQueryUtils` walks the client by path,
	// so every procedure the detail view touches has to exist. Only the one
	// procedure this unit drives is a real spy; everything else answers `{}`.
	const overrides: Record<string, (...args: unknown[]) => unknown> = {
		"projects.stories.convertKind": mockConvertKind,
	};
	const make = (path: string[]): unknown =>
		new Proxy(() => undefined, {
			get: (_target, prop) =>
				typeof prop === "string" ? make([...path, prop]) : undefined,
			apply: (_target, _thisArg, args) => {
				const override = overrides[path.join(".")];
				return override
					? override(...args)
					: Promise.resolve({} as unknown);
			},
		});
	return { orpcClient: make([]) };
});

// ---------------------------------------------------------------------------
// react-query. Everything real except the two hooks the flow drives.
// ---------------------------------------------------------------------------

vi.mock("@tanstack/react-query", async () => {
	const actual = await vi.importActual<
		typeof import("@tanstack/react-query")
	>("@tanstack/react-query");
	const React = await vi.importActual<typeof import("react")>("react");

	const isRegenerationKey = (queryKey: unknown): boolean =>
		Array.isArray(queryKey) &&
		Array.isArray(queryKey[0]) &&
		(queryKey[0] as string[]).join(".") ===
			"projects.stories.regenerationStatus";

	return {
		...actual,
		useQuery: (options: { queryKey?: unknown; enabled?: boolean }) => {
			if (isRegenerationKey(options?.queryKey)) {
				// Honour the production `enabled` gate — a surface that is not
				// watching this work item must not see a status at all.
				return {
					data:
						options.enabled === false
							? undefined
							: (regenerationFixture.current ?? undefined),
					isLoading: false,
					refetch: vi.fn(),
				};
			}
			return { data: undefined, isLoading: false, refetch: vi.fn() };
		},
		useMutation: (options: {
			mutationFn?: (vars: unknown) => Promise<unknown>;
			onSuccess?: (data: unknown, vars: unknown, ctx: unknown) => unknown;
			onError?: (err: unknown, vars: unknown, ctx: unknown) => unknown;
			onSettled?: () => unknown;
		}) => {
			const [isPending, setIsPending] = React.useState(false);
			const run = async (vars: unknown) => {
				setIsPending(true);
				try {
					const data = await options.mutationFn?.(vars);
					await options.onSuccess?.(data, vars, undefined);
					return data;
				} catch (error) {
					await options.onError?.(error, vars, undefined);
					return undefined;
				} finally {
					setIsPending(false);
					await options.onSettled?.();
				}
			};
			return {
				isPending,
				mutate: (vars?: unknown) => {
					void run(vars);
				},
				mutateAsync: run,
				variables: undefined,
			};
		},
		useQueryClient: () => ({
			invalidateQueries: mockInvalidateQueries,
			setQueryData: vi.fn(),
			getQueryData: vi.fn(),
			cancelQueries: vi.fn(async () => undefined),
		}),
	};
});

// ---------------------------------------------------------------------------
// Radix menus never open in jsdom without pointer plumbing — render inline.
// ---------------------------------------------------------------------------

vi.mock("@ui/components/dropdown-menu", () => {
	const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
	const Item = ({
		children,
		onSelect,
		onClick,
		disabled,
	}: {
		children?: ReactNode;
		onSelect?: () => void;
		onClick?: (e: unknown) => void;
		disabled?: boolean;
	}) => (
		<button
			type="button"
			disabled={disabled}
			onClick={(e) => {
				onClick?.({ ...e, stopPropagation: () => {} });
				onSelect?.();
			}}
		>
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

// The global setup mock has no `useParams`, which the detail view reads.
vi.mock("next/navigation", () => ({
	useParams: () => ({}),
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/app/projects/proj-1/stories/story-1",
	useSearchParams: () => new URLSearchParams(),
}));

// `posthog-js` is not installed in the test environment.
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: mockToastSuccess,
		error: mockToastError,
		info: vi.fn(),
		loading: vi.fn(),
	}),
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

// ---------------------------------------------------------------------------
// Everything the work item detail view drags in. Adapted from the
// prompt-routing scaffold; only the TipTap stub is new, because the read-only
// assertion needs a real `setEditable` call to observe.
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
		appendMessage: vi.fn(),
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
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/TiptapEditorRegistry",
	() => ({
		useRegisterTiptapEditor: vi.fn(),
	}),
);
vi.mock("@saas/projects/lib/editor-markdown-save", () => ({
	getEditorMarkdownForSave: () => "",
	getTurndownService: () => ({ turndown: () => "" }),
}));
vi.mock("@saas/projects/lib/use-clipboard-image-paste", () => ({
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
vi.mock("@saas/projects/components/DiffReviewBar", () => ({
	DiffReviewBar: () => null,
}));
vi.mock("@saas/projects/components/EditorToolbar", () => ({
	EditorToolbar: () => null,
}));
vi.mock("@saas/projects/components/stories/FeatureVersionHistory", () => ({
	FeatureVersionHistory: () => null,
}));
vi.mock("@saas/projects/components/stories/FeatureTransitionDialog", () => ({
	FeatureTransitionDialog: () => null,
}));

vi.mock("@tiptap/react", () => ({
	// A stub rather than `null`: the read-only assertion is about the workspace
	// calling `setEditable(false)` on the real editor instance. Cached so the
	// instance identity is stable across renders, like the real hook's.
	useEditor: () => {
		if (!editorRef.current) {
			editorRef.current = {
				isEditable: true,
				setEditable: setEditableSpy,
				commands: { setContent: vi.fn(), focus: vi.fn() },
				state: { doc: { descendants: () => undefined } },
				view: { dom: document.createElement("div") },
				getHTML: () => "",
				getJSON: () => ({}),
				isDestroyed: false,
				isActive: () => false,
				can: () => ({
					chain: () => ({ focus: () => ({ run: () => false }) }),
				}),
				chain: () => ({ focus: () => ({ run: () => true }) }),
				on: vi.fn(),
				off: vi.fn(),
			};
		}
		return editorRef.current;
	},
	EditorContent: () => null,
}));

import { ConvertKindConfirmDialog } from "@saas/projects/components/stories/ConvertKindConfirmDialog";
import { StoryActionsMenu } from "@saas/projects/components/stories/StoryActionsMenu";
import { StoryWorkspace } from "@saas/projects/components/stories/StoryWorkspace";
import { resetStoryKindRegenerationWatchlist } from "@saas/projects/components/stories/useStoryKindRegeneration";
import type { UserStory } from "@saas/projects/lib/stories/types";
// Import AFTER every mock is registered.
import { orpc } from "@shared/lib/orpc-query-utils";

const convertKindCopy = enMessages.projects.stories.convertKind;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = () => new Date().toISOString();

function running() {
	return {
		status: "running" as const,
		error: null,
		errorClass: null,
		startedAt: NOW(),
		completedAt: null,
	};
}

function completed() {
	return {
		status: "completed" as const,
		error: null,
		errorClass: null,
		startedAt: NOW(),
		completedAt: NOW(),
	};
}

function failed(error: string) {
	return {
		status: "failed" as const,
		error,
		errorClass: "RegenerationEmpty",
		startedAt: NOW(),
		completedAt: NOW(),
	};
}

function cardStory(overrides: Partial<UserStory> = {}): UserStory {
	return {
		id: "story-1",
		identifier: "F-001",
		title: "Work item",
		statusId: "status-open",
		kind: "FEATURE",
		priority: "P2_MEDIUM",
		draftingStage: "DRAFT",
		blocked: false,
		tags: [],
		tasks: [],
		...overrides,
	} as UserStory;
}

const detailStory = {
	id: "story-1",
	identifier: "F-001",
	title: "Work item",
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
	draftingStage: "DRAFT",
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

function renderMenu(story: UserStory = cardStory()) {
	return render(
		<StoryActionsMenu
			story={story}
			projectId="proj-1"
			organizationId={null}
		/>,
	);
}

function renderWorkspace() {
	return render(
		<StoryWorkspace
			story={detailStory as Parameters<typeof StoryWorkspace>[0]["story"]}
			canEdit
			projectId="proj-1"
			projectName="Test Project"
			maturationV2={false}
			onClose={vi.fn()}
		/>,
	);
}

/** Walks the board kebab all the way through the confirmation dialog. */
async function convertFromMenu() {
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: /change to bug/i }));
	});
	const confirm = await screen.findByRole("button", {
		name: new RegExp(`^${convertKindCopy.confirmBug}$`, "i"),
	});
	await act(async () => {
		fireEvent.click(confirm);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	regenerationFixture.current = null;
	resetStoryKindRegenerationWatchlist();
	mockConvertKind.mockResolvedValue({
		story: { id: "story-1", kind: "BUG" },
		regeneration: {
			started: true,
			workflowId: "regenerate-body-for-kind-story-1",
		},
	});
});

// ---------------------------------------------------------------------------
// 1. The dialog names the consequence
// ---------------------------------------------------------------------------

describe("ConvertKindConfirmDialog — the copy names what actually happens", () => {
	function renderDialog(targetKind: "BUG" | "FEATURE") {
		return render(
			<ConvertKindConfirmDialog
				open
				onOpenChange={vi.fn()}
				targetKind={targetKind}
				isPending={false}
				onConfirm={vi.fn()}
			/>,
		);
	}

	it.each(["BUG", "FEATURE"] as const)(
		"says the description and acceptance criteria are REPLACED (%s)",
		(targetKind) => {
			renderDialog(targetKind);
			const body = screen.getByText(
				/description and acceptance criteria/i,
			);
			expect(body.textContent).toMatch(/replaced/i);
		},
	);

	it("says the current content is only a reference, not something kept", () => {
		renderDialog("BUG");
		const body = screen.getByText(/description and acceptance criteria/i);
		expect(body.textContent).toMatch(/only as reference/i);
		expect(body.textContent).toMatch(/carried over word for word/i);
	});

	it("says the previous version is recoverable from version history", () => {
		renderDialog("BUG");
		const body = screen.getByText(/description and acceptance criteria/i);
		expect(body.textContent).toMatch(/version history/i);
		expect(body.textContent).toMatch(/restore/i);
	});

	it("no longer claims the content stays as-is or that nothing is re-chained", () => {
		renderDialog("BUG");
		expect(document.body.textContent).not.toMatch(/stays as-is/i);
		expect(document.body.textContent).not.toMatch(/no prompt re-chaining/i);
	});
});

// ---------------------------------------------------------------------------
// 2. The board kebab — an entry point with no body region of its own
// ---------------------------------------------------------------------------

describe("StoryActionsMenu — the conversion reports a rewrite that is only starting", () => {
	it("shows no regeneration state for an item nobody converted", () => {
		regenerationFixture.current = running();
		renderMenu();
		expect(
			screen.queryByTestId("story-kind-regeneration-badge"),
		).not.toBeInTheDocument();
	});

	it("shows the refresh in progress on the card once the change is confirmed", async () => {
		regenerationFixture.current = running();
		renderMenu();
		await convertFromMenu();

		const badge = await screen.findByTestId(
			"story-kind-regeneration-badge",
		);
		expect(badge).toHaveAttribute("data-state", "running");
		expect(badge).toHaveTextContent(convertKindCopy.badgeRunning);
	});

	it("no longer toasts a finished conversion", async () => {
		regenerationFixture.current = running();
		renderMenu();
		await convertFromMenu();

		await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
		const [title, options] = mockToastSuccess.mock.calls[0] as [
			string,
			{ description?: string },
		];
		// The retired copy asserted a completed conversion.
		expect(title).not.toBe("Converted to bug");
		expect(title).toBe(convertKindCopy.startedBug);
		expect(options?.description).toBe(convertKindCopy.startedDescription);
		expect(options?.description).toMatch(/being redrafted/i);
	});

	it("still shows the in-flight state after the surface unmounts and comes back", async () => {
		regenerationFixture.current = running();
		const view = renderMenu();
		await convertFromMenu();
		await screen.findByTestId("story-kind-regeneration-badge");

		// Navigating away and back is an unmount and a fresh mount. A
		// `useState` flag would be gone; the persisted watch is not.
		view.unmount();
		renderMenu(cardStory({ kind: "BUG" }));

		const badge = await screen.findByTestId(
			"story-kind-regeneration-badge",
		);
		expect(badge).toHaveAttribute("data-state", "running");
	});

	it("surfaces a refused rewrite as content that was NOT changed", async () => {
		regenerationFixture.current = running();
		const view = renderMenu();
		await convertFromMenu();
		await screen.findByTestId("story-kind-regeneration-badge");

		regenerationFixture.current = failed("The rewrite came back empty.");
		view.rerender(
			<StoryActionsMenu
				story={cardStory({ kind: "BUG" })}
				projectId="proj-1"
				organizationId={null}
			/>,
		);

		const badge = await screen.findByTestId(
			"story-kind-regeneration-badge",
		);
		expect(badge).toHaveAttribute("data-state", "failed");
		expect(badge).toHaveTextContent(convertKindCopy.badgeFailed);
		expect(badge.getAttribute("aria-label")).toMatch(
			/was not rewritten|previous content was kept/i,
		);
	});

	it("refreshes the roadmap under the DERIVED list key when the rewrite lands", async () => {
		regenerationFixture.current = running();
		const view = renderMenu();
		await convertFromMenu();
		await screen.findByTestId("story-kind-regeneration-badge");

		mockInvalidateQueries.mockClear();
		regenerationFixture.current = completed();
		view.rerender(
			<StoryActionsMenu
				story={cardStory({ kind: "BUG" })}
				projectId="proj-1"
				organizationId={null}
			/>,
		);

		// Asserted as the EXPANDED key rather than as a call to the helper:
		// a hand-authored filter matches nothing and fails nothing, so the
		// shape is the thing worth pinning.
		await waitFor(() => {
			expect(mockInvalidateQueries).toHaveBeenCalledWith({
				queryKey: orpc.projects.stories.list.key({
					input: { projectId: "proj-1" },
				}),
			});
		});
		expect(mockInvalidateQueries).toHaveBeenCalledWith({
			queryKey: orpc.projects.stories.get.key({
				input: {
					projectId: "proj-1",
					storyId: "story-1",
					organizationId: null,
				},
			}),
		});
		expect(
			screen.queryByTestId("story-kind-regeneration-badge"),
		).not.toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------
// 3. The work item detail view — the surface that actually renders the body
// ---------------------------------------------------------------------------

describe("StoryWorkspace — the body region shows and protects the rewrite", () => {
	it("shows the in-flight state over the body region", async () => {
		regenerationFixture.current = running();
		renderWorkspace();

		const notice = await screen.findByTestId(
			"story-kind-regeneration-notice",
		);
		expect(notice).toHaveAttribute("data-tone", "running");
		expect(notice).toHaveTextContent(convertKindCopy.inFlightTitle);
		expect(notice).toHaveAttribute("aria-busy", "true");
	});

	it("wraps the in-flight spinner in motion-safe: and announces politely", async () => {
		regenerationFixture.current = running();
		const { container } = renderWorkspace();

		await screen.findByTestId("story-kind-regeneration-notice");
		expect(
			container.querySelector(".motion-safe\\:animate-spin"),
		).not.toBeNull();
		const liveRegion = container.querySelector('[aria-live="polite"]');
		expect(liveRegion?.textContent).toBe(convertKindCopy.announceStarted);
	});

	it("makes the body editors read-only while the refresh is in flight", async () => {
		regenerationFixture.current = running();
		renderWorkspace();

		await screen.findByTestId("story-kind-regeneration-notice");
		await waitFor(() => expect(setEditableSpy).toHaveBeenCalledWith(false));
	});

	it("hands the body back when there is no rewrite in flight", async () => {
		regenerationFixture.current = null;
		renderWorkspace();

		await waitFor(() => expect(setEditableSpy).toHaveBeenCalledWith(true));
		expect(setEditableSpy).not.toHaveBeenCalledWith(false);
	});

	it("announces completion, refreshes the body, and moves focus to its heading", async () => {
		regenerationFixture.current = running();
		const view = renderWorkspace();
		await screen.findByTestId("story-kind-regeneration-notice");

		mockInvalidateQueries.mockClear();
		regenerationFixture.current = completed();
		await act(async () => {
			view.rerender(
				<StoryWorkspace
					story={
						detailStory as Parameters<
							typeof StoryWorkspace
						>[0]["story"]
					}
					canEdit
					projectId="proj-1"
					projectName="Test Project"
					maturationV2={false}
					onClose={vi.fn()}
				/>,
			);
		});

		const notice = await screen.findByTestId(
			"story-kind-regeneration-notice",
		);
		expect(notice).toHaveAttribute("data-tone", "completed");

		// The regenerated body arrives through an invalidation of the story
		// read, not through the user reloading the page.
		await waitFor(() => {
			expect(mockInvalidateQueries).toHaveBeenCalledWith({
				queryKey: orpc.projects.stories.get.key({
					input: {
						projectId: "proj-1",
						storyId: "story-1",
						organizationId: "org-1",
					},
				}),
			});
		});

		const liveRegion = view.container.querySelector('[aria-live="polite"]');
		expect(liveRegion?.textContent).toBe(convertKindCopy.announceCompleted);

		const heading = screen.getByRole("heading", {
			name: convertKindCopy.completedTitle,
		});
		expect(document.activeElement).toBe(heading);
	});

	it("tells the user the content was NOT rewritten when the refresh fails", async () => {
		regenerationFixture.current = running();
		const view = renderWorkspace();
		await screen.findByTestId("story-kind-regeneration-notice");

		regenerationFixture.current = failed("The rewrite came back empty.");
		await act(async () => {
			view.rerender(
				<StoryWorkspace
					story={
						detailStory as Parameters<
							typeof StoryWorkspace
						>[0]["story"]
					}
					canEdit
					projectId="proj-1"
					projectName="Test Project"
					maturationV2={false}
					onClose={vi.fn()}
				/>,
			);
		});

		const notice = await screen.findByTestId(
			"story-kind-regeneration-notice",
		);
		expect(notice).toHaveAttribute("data-tone", "failed");
		expect(notice).toHaveTextContent(convertKindCopy.failedTitle);
		expect(notice.textContent).toMatch(/kept exactly as they were/i);
		expect(notice).toHaveTextContent("The rewrite came back empty.");

		const liveRegion = view.container.querySelector('[aria-live="polite"]');
		expect(liveRegion?.textContent).toBe(convertKindCopy.announceFailed);
	});

	it("releases the body once the refresh reaches a terminal state", async () => {
		regenerationFixture.current = running();
		const view = renderWorkspace();
		await waitFor(() => expect(setEditableSpy).toHaveBeenCalledWith(false));

		setEditableSpy.mockClear();
		regenerationFixture.current = completed();
		await act(async () => {
			view.rerender(
				<StoryWorkspace
					story={
						detailStory as Parameters<
							typeof StoryWorkspace
						>[0]["story"]
					}
					canEdit
					projectId="proj-1"
					projectName="Test Project"
					maturationV2={false}
					onClose={vi.fn()}
				/>,
			);
		});

		await waitFor(() => expect(setEditableSpy).toHaveBeenCalledWith(true));
	});
});
