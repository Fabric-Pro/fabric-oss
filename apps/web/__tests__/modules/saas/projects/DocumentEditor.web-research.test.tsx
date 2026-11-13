/**
 * The editor's regenerate confirmation offers "Allow web research", and only
 * a tick in that confirmation, while research is available, reaches the
 * regenerate request.
 *
 * Pinned here, against the real editor:
 *   - the first Regenerate opens the confirmation, as a labelled modal
 *     dialog, with the option unticked; Regenerate from the failed-generation
 *     notice opens the same confirmation;
 *   - a tick, then Regenerate, sends `allowWebResearch: true`; Regenerate
 *     with no tick sends `allowWebResearch: false`, the confirmation having
 *     offered the choice;
 *   - a tick never outlives its confirmation: after Cancel or Escape the
 *     next opening starts unticked;
 *   - focus moves into the confirmation when it opens, onto Cancel rather
 *     than the checkbox, so a reflexive Space cannot tick it; the checkbox
 *     and the settings link are reachable with Tab (which wraps inside it),
 *     Escape cancels, and focus goes back to the Regenerate button that
 *     opened it — also when it was opened from the overflow menu, where
 *     focus taken back from the closing menu lands on Cancel too; when that
 *     button is
 *     disabled by the run it starts, or has gone, focus goes to the editor's
 *     frame rather than the page body;
 *   - a run allowed to research the web outlasts the five-minute safety
 *     timer while the server still reports it generating and recently
 *     written; a run without research gives up at five minutes as before;
 *   - with no search provider the option is `aria-disabled`, says why, and a
 *     Regenerate sends `allowWebResearch: false`, also for a tick made before
 *     the provider went away;
 *   - the assistant's regenerate action and the generate-on-mount after the
 *     create dialog never send the flag: they have no consent surface. Run
 *     here, and read from the source: of the editor's three regenerate
 *     requests, only the confirmation's names `allowWebResearch`.
 *
 * Mocking harness copied from `DocumentEditor.collab-room-regeneration.test.tsx`
 * without the collaboration room, with the generate mutation recording what
 * it was asked, and the availability query answering as a test sets it.
 * Translations echo their keys (see `vitest.setup.ts`), so the option's
 * label reads `label`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORED = "## Scope\n\nPhase one, then two.";

// ---- A fake server: one document with its run's stamps, the availability
// answer, and every generate request. With no stamps the editor reads a run
// as having just written (`resolveGenerationClock` falls back to the current
// time).
const server = {
	content: STORED,
	status: "COMPLETE",
	generationStartedAt: null as string | null,
	updatedAt: null as string | null,
	availability: { available: true, missing: [] } as {
		available: boolean;
		missing: string[];
	},
};
const generateCalls: Array<Record<string, unknown>> = [];
const availabilityInputs: unknown[] = [];

function serverDocument() {
	return {
		document: {
			id: "doc-1",
			title: "Example plan",
			type: "PRD",
			content: server.content,
			version: 3,
			status: server.status,
			generationStartedAt: server.generationStartedAt,
			updatedAt: server.updatedAt,
		},
	};
}

function cannedResponseFor(path: string[], input?: unknown): unknown {
	const joined = path.join(".");
	if (joined === "projects.documents.get") {
		return serverDocument();
	}
	if (joined === "projects.get") {
		return { project: { name: "proj-1", techStack: [], features: [] } };
	}
	if (joined === "projects.documents.webResearchAvailability") {
		availabilityInputs.push(input);
		return structuredClone(server.availability);
	}
	return {};
}

async function fakeMutation(
	path: string[],
	vars: Record<string, unknown>,
): Promise<unknown> {
	switch (path.join(".")) {
		case "projects.documents.generate":
			generateCalls.push({ ...vars });
			return {
				outcome: "started",
				workflowId: "wf-1",
				runId: "run-1",
				message: "Generation started",
			};
		case "projects.documents.update":
			return { ...serverDocument(), contentUnchanged: false };
		default:
			return cannedResponseFor(path);
	}
}

let saveMutationReady = false;

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
						queryFn: async () =>
							cannedResponseFor(path, opts?.input),
					});
				}
				if (prop === "mutationOptions") {
					return (config: Record<string, unknown>) => {
						if (path.join(".") === "projects.documents.update") {
							saveMutationReady = true;
						}
						return {
							mutationFn: (vars: Record<string, unknown>) =>
								fakeMutation(path, vars),
							...config,
						};
					};
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

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
/** The page's query string; `generate=true` is how the create dialog asks. */
const navigation = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ organizationSlug: "example-org" }),
	useSearchParams: () => new URLSearchParams(navigation.search),
	useRouter: () => router,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-example",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
		isOrgContext: true,
		isGuest: false,
		loaded: true,
	}),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1" }, session: {} }),
}));

// ---- CopilotKit: every action is recorded; the sidebar renders its
// children, where the toolbar and the confirmation live.
const actionConfigs = new Map<string, Record<string, any>>();
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({ state: {}, setState: vi.fn(), nodeName: undefined }),
	useCopilotAction: (config: Record<string, any>) => {
		actionConfigs.set(config.name, config);
	},
	useFrontendTool: vi.fn(),
	useCopilotChat: () => ({ isLoading: false, visibleMessages: [] }),
	useCopilotChatInternal: () => ({ messages: [], setMessages: vi.fn() }),
	useCopilotReadable: vi.fn(),
	useCopilotMessagesContext: () => ({ setMessages: vi.fn() }),
}));
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({ children }: { children?: import("react").ReactNode }) =>
		children,
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));
vi.mock("@saas/projects/components/DocumentGenerationProgress", () => ({
	DocumentGenerationProgress: () => (
		<div data-testid="generation-progress-overlay" />
	),
}));
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
vi.mock("@saas/prompts/components/PromptSelector", () => ({
	PromptSelector: () => null,
}));

let mockEditor: Editor | null = null;
vi.mock("@tiptap/react", () => ({
	EditorContent: () => null,
	useEditor: () => mockEditor,
	NodeViewWrapper: () => null,
	ReactNodeViewRenderer: () => () => null,
}));

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
		dismiss: vi.fn(),
	},
}));

vi.mock("@saas/projects/lib/diff-utils", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@saas/projects/lib/diff-utils")>();
	return {
		...actual,
		resetScrollTracking: vi.fn(),
		focusOnLastDiff: vi.fn(),
		focusOnAnchor: vi.fn(),
	};
});

vi.mock("@saas/projects/hooks/useDocumentAssistantHistoryEnabled", () => ({
	useDocumentAssistantHistoryEnabled: () => false,
}));
vi.mock("@saas/projects/hooks/useDocumentAssistantHistory", () => ({
	useDocumentAssistantHistoryRealtimeSync: vi.fn(),
	useRecordDocumentAssistantDiffOutcome: () => ({ mutateAsync: vi.fn() }),
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
	AttachmentRegistryProvider: ({
		children,
	}: {
		children?: import("react").ReactNode;
	}) => children,
}));
vi.mock(
	"@saas/projects/components/copilot/DocumentAssistantOutcomesProvider",
	() => ({
		DocumentAssistantOutcomesProvider: ({
			children,
		}: {
			children?: import("react").ReactNode;
		}) => children,
	}),
);
vi.mock("@saas/projects/components/copilot/HydratedMessagesContext", () => ({
	HydratedMessagesProvider: ({
		children,
	}: {
		children?: import("react").ReactNode;
	}) => children,
}));
vi.mock(
	"@saas/projects/components/documents/useUpdateDocumentWithContext",
	() => ({
		useUpdateDocumentWithContext: () => ({
			isActive: false,
			showingDiff: false,
			isApplying: false,
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

// Page-agent behavior is covered elsewhere; this harness uses the plain
// agent stub above.
vi.mock("@saas/shared/components/copilot/use-page-agent", async () => {
	const core = await import("@copilotkit/react-core");
	return {
		usePageAgent: (name: string, initialState: object) =>
			core.useCoAgent({ name, initialState }),
	};
});

// The editor predates the enclosing page's session provider.
vi.mock(
	"@saas/shared/components/copilot/CopilotChatSessionProvider",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@saas/shared/components/copilot/CopilotChatSessionProvider")
			>();
		const core = await import("@copilotkit/react-core");
		return {
			...actual,
			useCopilotChatSessionSelector: (
				select: (session: object) => unknown,
			) =>
				select({
					...core.useCopilotChatInternal(),
					...core.useCopilotChat(),
				}),
			useCopilotChatSessionActions: () => core.useCopilotChatInternal(),
		};
	},
);

import { DocumentEditor } from "@saas/projects/components/DocumentEditor";
import { fromMarkdown } from "@saas/projects/lib/diff-utils";
import { createAdvancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { toast } from "sonner";

const DIALOG_NAME = "Regenerate this document?";

let queryClient: QueryClient;
let saveSlot: HTMLElement;
const editors: Editor[] = [];

function makeEditor(markdown: string): Editor {
	const editor = new Editor({
		extensions: createAdvancedExtensions({
			projectId: null,
			documentId: null,
		}),
		content: fromMarkdown(markdown),
	});
	editors.push(editor);
	return editor;
}

function tree() {
	return (
		<QueryClientProvider client={queryClient}>
			<DocumentEditor
				projectId="proj-1"
				documentId="doc-1"
				saveSlot={saveSlot}
			/>
		</QueryClientProvider>
	);
}

async function mount() {
	mockEditor = makeEditor(STORED);
	const view = render(tree());
	await waitFor(() => {
		expect(saveMutationReady).toBe(true);
	});
	await flush();
	return view;
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

/** The toolbar's Regenerate, which opens the confirmation. */
function toolbarRegenerate(): HTMLElement {
	const [button] = screen
		.getAllByRole("button", { name: "Regenerate" })
		.filter((candidate) => !candidate.closest('[role="dialog"]'));
	if (!button) {
		throw new Error("No toolbar Regenerate button");
	}
	return button;
}

function confirmation() {
	return screen.queryByRole("dialog", { name: DIALOG_NAME });
}

/** Opens the confirmation from the toolbar's Regenerate. */
async function openConfirmation(user: ReturnType<typeof userEvent.setup>) {
	await user.click(toolbarRegenerate());
	return screen.findByRole("dialog", { name: DIALOG_NAME });
}

function optionIn(dialog: HTMLElement) {
	return within(dialog).getByRole("checkbox", { name: "label" });
}

/** The option once the availability answer has arrived. */
async function answeredOption(dialog: HTMLElement) {
	await waitFor(() => {
		expect(within(dialog).queryByText("checking")).not.toBeInTheDocument();
	});
	return optionIn(dialog);
}

async function confirmIn(
	user: ReturnType<typeof userEvent.setup>,
	dialog: HTMLElement,
) {
	await user.click(
		within(dialog).getByRole("button", { name: "Regenerate" }),
	);
	await waitFor(() => {
		expect(generateCalls).toHaveLength(1);
	});
	return generateCalls[0];
}

/**
 * Focus sits on the editor's frame — the container that holds its toolbar —
 * and not on the page body.
 */
function expectFocusOnEditorFrame() {
	const focused = window.document.activeElement;
	expect(focused).not.toBe(window.document.body);
	expect(focused).toHaveAttribute("tabindex", "-1");
	expect(focused).toContainElement(
		screen.getByRole("button", { name: "More document actions" }),
	);
}

const TAKING_LONGER =
	"Document generation is taking longer than expected. Refresh the page to check for the latest version.";
const REGENERATED = "## Scope\n\nPhase one, two, then three.";
const NOW = Date.parse("2026-10-19T12:00:00.000Z");

/** A server stamp `minutes` before `NOW`. */
function minutesBeforeNow(minutes: number): string {
	return new Date(NOW - minutes * 60 * 1000).toISOString();
}

/** The server's document changes, and the editor reads it. */
async function serverReports(
	snapshot: Partial<
		Pick<
			typeof server,
			"content" | "status" | "generationStartedAt" | "updatedAt"
		>
	>,
) {
	Object.assign(server, snapshot);
	await act(async () => {
		await queryClient.refetchQueries();
	});
	await flush();
}

beforeEach(() => {
	vi.clearAllMocks();
	actionConfigs.clear();
	generateCalls.length = 0;
	availabilityInputs.length = 0;
	saveMutationReady = false;
	navigation.search = "";
	server.content = STORED;
	server.status = "COMPLETE";
	server.generationStartedAt = null;
	server.updatedAt = null;
	server.availability = { available: true, missing: [] };
	saveSlot = window.document.createElement("div");
	window.document.body.appendChild(saveSlot);
	queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
});

afterEach(() => {
	vi.useRealTimers();
	for (const editor of editors.splice(0)) {
		editor.destroy();
	}
	mockEditor = null;
	saveSlot.remove();
});

describe("DocumentEditor — Allow web research in the regenerate confirmation", () => {
	it("opens the confirmation as a labelled modal dialog with the option unticked, and asks for availability only then", async () => {
		const user = userEvent.setup();
		await mount();
		expect(confirmation()).not.toBeInTheDocument();
		expect(availabilityInputs).toEqual([]);

		const dialog = await openConfirmation(user);

		expect(dialog).toHaveAttribute("aria-modal", "true");
		expect(dialog).toHaveAccessibleDescription(
			expect.stringContaining("Regenerating will replace"),
		);
		const option = await answeredOption(dialog);
		expect(option).toHaveAttribute("aria-checked", "false");
		expect(option).not.toHaveAttribute("aria-disabled");
		expect(availabilityInputs).toEqual([{ projectId: "proj-1" }]);
		expect(generateCalls).toEqual([]);
	});

	it("sends allowWebResearch: true after a tick and Regenerate", async () => {
		const user = userEvent.setup();
		await mount();
		const dialog = await openConfirmation(user);
		await user.click(await answeredOption(dialog));
		expect(optionIn(dialog)).toHaveAttribute("aria-checked", "true");

		const request = await confirmIn(user, dialog);

		expect(request).toMatchObject({ id: "doc-1", allowWebResearch: true });
		expect(confirmation()).not.toBeInTheDocument();
	});

	it("sends allowWebResearch: false when Regenerate is confirmed without a tick", async () => {
		const user = userEvent.setup();
		await mount();
		const dialog = await openConfirmation(user);
		await answeredOption(dialog);

		const request = await confirmIn(user, dialog);

		expect(request).toMatchObject({
			id: "doc-1",
			prompt: "",
			allowWebResearch: false,
		});
	});

	it("does not carry a tick past Cancel: the next opening starts unticked", async () => {
		const user = userEvent.setup();
		await mount();
		let dialog = await openConfirmation(user);
		await user.click(await answeredOption(dialog));
		expect(optionIn(dialog)).toHaveAttribute("aria-checked", "true");

		await user.click(
			within(dialog).getByRole("button", { name: "Cancel" }),
		);
		expect(confirmation()).not.toBeInTheDocument();

		dialog = await openConfirmation(user);
		expect(optionIn(dialog)).toHaveAttribute("aria-checked", "false");
		const request = await confirmIn(user, dialog);
		expect(request).toMatchObject({ allowWebResearch: false });
	});

	it("moves focus in onto Cancel, reaches the checkbox and the settings link with Tab, cancels on Escape, and gives focus back to Regenerate", async () => {
		server.availability = { available: false, missing: ["search"] };
		const user = userEvent.setup();
		await mount();
		const opener = toolbarRegenerate();

		await user.click(opener);
		const dialog = await screen.findByRole("dialog", { name: DIALOG_NAME });
		await answeredOption(dialog);
		const option = optionIn(dialog);
		const settings = within(dialog).getByRole("link", {
			name: "settingsLink",
		});
		const cancel = within(dialog).getByRole("button", { name: "Cancel" });
		const confirm = within(dialog).getByRole("button", {
			name: "Regenerate",
		});
		// The least destructive control, not the checkbox a reflexive Space
		// would tick.
		expect(cancel).toHaveFocus();

		await user.tab();
		expect(confirm).toHaveFocus();
		// Tab wraps inside the dialog, both ways.
		await user.tab();
		expect(option).toHaveFocus();
		await user.tab();
		expect(settings).toHaveFocus();
		await user.tab();
		expect(cancel).toHaveFocus();
		await user.tab({ shift: true });
		expect(settings).toHaveFocus();
		await user.tab({ shift: true });
		expect(option).toHaveFocus();
		await user.tab({ shift: true });
		expect(confirm).toHaveFocus();

		await user.keyboard("{Escape}");

		expect(confirmation()).not.toBeInTheDocument();
		expect(opener).toHaveFocus();
		expect(generateCalls).toEqual([]);
	});

	it("does not carry a tick past Escape", async () => {
		const user = userEvent.setup();
		await mount();
		let dialog = await openConfirmation(user);
		await user.click(await answeredOption(dialog));
		await user.keyboard("{Escape}");
		expect(confirmation()).not.toBeInTheDocument();

		dialog = await openConfirmation(user);
		expect(optionIn(dialog)).toHaveAttribute("aria-checked", "false");
	});

	it("keeps focus in the confirmation opened from the overflow menu, and gives it back to the menu's button", async () => {
		const user = userEvent.setup();
		await mount();
		const more = screen.getByRole("button", {
			name: "More document actions",
		});

		await user.click(more);
		await user.click(
			await screen.findByRole("menuitem", { name: "Regenerate" }),
		);
		const dialog = await screen.findByRole("dialog", { name: DIALOG_NAME });
		// The menu hands focus back to its button as it closes; the
		// confirmation takes it back, onto Cancel as when it opened.
		await flush();
		expect(dialog).toContainElement(
			window.document.activeElement as HTMLElement,
		);
		expect(
			within(dialog).getByRole("button", { name: "Cancel" }),
		).toHaveFocus();

		await user.keyboard("{Escape}");

		expect(confirmation()).not.toBeInTheDocument();
		expect(more).toHaveFocus();
	});

	it("gives focus to the editor's frame, not the page body, when the Regenerate that opened it is disabled by the run it starts", async () => {
		const user = userEvent.setup();
		await mount();
		const opener = toolbarRegenerate();
		await user.click(opener);
		const dialog = await screen.findByRole("dialog", { name: DIALOG_NAME });
		await answeredOption(dialog);

		await confirmIn(user, dialog);

		expect(confirmation()).not.toBeInTheDocument();
		expect(opener).toBeDisabled();
		expectFocusOnEditorFrame();
	});

	it("gives focus to the editor's frame on Escape when the failed-generation notice's Regenerate that opened it has gone", async () => {
		server.status = "FAILED";
		const user = userEvent.setup();
		await mount();
		const notice = screen
			.getByText("Generation failed")
			.closest("div.fixed") as HTMLElement;
		const opener = within(notice).getByRole("button", {
			name: "Regenerate",
		});
		await user.click(opener);
		const dialog = await screen.findByRole("dialog", { name: DIALOG_NAME });
		await answeredOption(dialog);
		expect(opener).not.toBeInTheDocument();

		await user.keyboard("{Escape}");

		expect(confirmation()).not.toBeInTheDocument();
		expectFocusOnEditorFrame();
		expect(generateCalls).toEqual([]);
	});

	it("with no search provider, leaves the option aria-disabled with the reason, ignores a click, and sends allowWebResearch: false", async () => {
		server.availability = { available: false, missing: ["search"] };
		const user = userEvent.setup();
		await mount();
		const dialog = await openConfirmation(user);
		const option = await answeredOption(dialog);

		expect(option).toHaveAttribute("aria-disabled", "true");
		expect(option).toHaveAccessibleDescription(
			expect.stringContaining("missingSearch"),
		);
		await user.click(option);
		expect(option).toHaveAttribute("aria-checked", "false");

		const request = await confirmIn(user, dialog);
		expect(request).toMatchObject({ allowWebResearch: false });
	});

	it("sends allowWebResearch: false for a tick made while research was available once it no longer is", async () => {
		const user = userEvent.setup();
		await mount();
		const dialog = await openConfirmation(user);
		await user.click(await answeredOption(dialog));
		expect(optionIn(dialog)).toHaveAttribute("aria-checked", "true");

		// The organization's search provider goes away while the
		// confirmation is open.
		server.availability = { available: false, missing: ["search"] };
		await act(async () => {
			await queryClient.refetchQueries();
		});
		await waitFor(() => {
			expect(optionIn(dialog)).toHaveAttribute("aria-disabled", "true");
		});

		const request = await confirmIn(user, dialog);
		expect(request).toMatchObject({ allowWebResearch: false });
	});

	it("opens the same confirmation from the failed-generation notice's Regenerate", async () => {
		server.status = "FAILED";
		const user = userEvent.setup();
		await mount();
		const notice = screen
			.getByText("Generation failed")
			.closest("div.fixed") as HTMLElement;

		await user.click(
			within(notice).getByRole("button", { name: "Regenerate" }),
		);

		const dialog = await screen.findByRole("dialog", { name: DIALOG_NAME });
		await user.click(await answeredOption(dialog));
		const request = await confirmIn(user, dialog);
		expect(request).toMatchObject({ allowWebResearch: true });
	});

	it("never sends allowWebResearch from the assistant's regenerate action, even after a tick in the confirmation", async () => {
		const user = userEvent.setup();
		const view = await mount();
		// A tick left in a cancelled confirmation.
		const dialog = await openConfirmation(user);
		await user.click(await answeredOption(dialog));
		await user.click(
			within(dialog).getByRole("button", { name: "Cancel" }),
		);

		await act(async () => {
			actionConfigs.get("regenerate_document")?.renderAndWaitForResponse({
				args: { prompt: "Rewrite it" },
				respond: vi.fn(),
				status: "executing",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		view.rerender(tree());
		await waitFor(() => {
			expect(generateCalls).toHaveLength(1);
		});

		expect(generateCalls[0]).toMatchObject({ prompt: "Rewrite it" });
		expect(generateCalls[0]).not.toHaveProperty("allowWebResearch");
	});

	it("never sends allowWebResearch from the generate-on-mount that follows the create dialog", async () => {
		navigation.search = "generate=true";
		await mount();

		await waitFor(
			() => {
				expect(generateCalls).toHaveLength(1);
			},
			{ timeout: 3000 },
		);

		expect(generateCalls[0]).toMatchObject({ prompt: STORED });
		expect(generateCalls[0]).not.toHaveProperty("allowWebResearch");
		expect(confirmation()).not.toBeInTheDocument();
	});
});

/**
 * A run allowed to research the web can write for up to ten minutes, past
 * the editor's five-minute safety timer. While the server still reports it
 * generating, and recently written, the editor keeps waiting for it; any
 * other run gives up at five minutes as before.
 */
describe("DocumentEditor — the five-minute safety timer for a run that may research the web", () => {
	/**
	 * Confirms a regenerate on the fixed clock, with or without the tick. The
	 * server then reports the run GENERATING, last written
	 * `lastWriteMinutesBefore` minutes before that report, and six minutes
	 * pass, the timer firing at five.
	 */
	async function runForSixMinutes({
		research,
		lastWriteMinutesBefore,
	}: {
		research: boolean;
		lastWriteMinutesBefore: number;
	}) {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(NOW);
		const user = userEvent.setup({
			advanceTimers: vi.advanceTimersByTime,
		});
		await mount();
		const dialog = await openConfirmation(user);
		const option = await answeredOption(dialog);
		if (research) {
			await user.click(option);
		}
		const request = await confirmIn(user, dialog);
		expect(request.allowWebResearch).toBe(research);

		await serverReports({
			status: "GENERATING",
			generationStartedAt: minutesBeforeNow(lastWriteMinutesBefore),
			updatedAt: minutesBeforeNow(lastWriteMinutesBefore),
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
		});
		await flush();
	}

	/** The progress overlay, shown while the editor is regenerating. */
	function progressOverlay() {
		return screen.queryByTestId("generation-progress-overlay");
	}

	it("keeps waiting for a research run that is still live: no notice, still regenerating, and the review still opens", async () => {
		// Last written as it was reported: five minutes silent when the
		// timer fires, inside the ten minutes the editor still polls.
		await runForSixMinutes({ research: true, lastWriteMinutesBefore: 0 });

		expect(toast.info).not.toHaveBeenCalledWith(TAKING_LONGER);
		expect(progressOverlay()).toBeInTheDocument();

		await serverReports({ content: REGENERATED, status: "COMPLETE" });
		expect(
			await screen.findByTestId("regeneration-confirm-modal"),
		).toBeInTheDocument();
	});

	it("gives up on a research run silent for longer than the editor polls", async () => {
		// Last written six minutes before it was reported: eleven minutes
		// silent when the timer fires.
		await runForSixMinutes({ research: true, lastWriteMinutesBefore: 6 });

		expect(toast.info).toHaveBeenCalledWith(TAKING_LONGER);
		expect(progressOverlay()).not.toBeInTheDocument();
	});

	it("without research, gives up after five minutes as before", async () => {
		await runForSixMinutes({ research: false, lastWriteMinutesBefore: 0 });

		expect(toast.info).toHaveBeenCalledWith(TAKING_LONGER);
		expect(progressOverlay()).not.toBeInTheDocument();
	});
});

/**
 * The editor's regenerate requests, read from its source: the confirmation's
 * is the only one that may name `allowWebResearch`. The assistant's
 * regenerate action and the generate-on-mount after the create dialog have
 * no consent surface at the moment they run.
 */
describe("DocumentEditor — which regenerate requests may carry web research", () => {
	const source = readFileSync(
		resolve(
			__dirname,
			"../../../../modules/saas/projects/components/DocumentEditor.tsx",
		),
		"utf8",
	)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

	/** The argument text of every `regenerateMutation.mutate(...)` call. */
	function mutateCalls(): string[] {
		const calls: string[] = [];
		const marker = "regenerateMutation.mutate(";
		let from = source.indexOf(marker);
		while (from !== -1) {
			let depth = 0;
			let end = from + marker.length - 1;
			for (; end < source.length; end++) {
				const char = source[end];
				if (char === "(") {
					depth += 1;
				} else if (char === ")") {
					depth -= 1;
					if (depth === 0) {
						break;
					}
				}
			}
			calls.push(source.slice(from, end + 1));
			from = source.indexOf(marker, end);
		}
		return calls;
	}

	it("names allowWebResearch in exactly one of the three, the confirmed one with the empty prompt", () => {
		const calls = mutateCalls();
		expect(calls).toHaveLength(3);
		const naming = calls.filter((call) =>
			call.includes("allowWebResearch"),
		);
		expect(naming).toHaveLength(1);
		expect(naming[0]).toContain('prompt: ""');
		expect(naming[0]).toContain("sendWebResearch");
	});
});
