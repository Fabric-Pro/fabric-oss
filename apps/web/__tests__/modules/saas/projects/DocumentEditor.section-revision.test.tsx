/**
 * A finding-driven revision of one section, in the document editor (Fizzy
 * #2946).
 *
 * The Internal Analysis hands the editor a `sectionRevisionRequest`; the
 * editor saves first, asks for the revision from the saved base, shows the
 * candidate as a diff in its own body, read-only, and saves an Accept as a
 * held AI accept with the `FINDING` descriptor. Pinned here, in the
 * single-user editor with the room flag on (so every save names its base):
 *   - unsaved typing is saved before the revision is asked for, from the
 *     base that save produced;
 *   - Accept sends the descriptor and the token, and every section but the
 *     target is byte-identical in the editor's serialization before the
 *     request, under review and once saved;
 *   - Reject puts back the body from before the review byte for byte and
 *     saves nothing;
 *   - an Accept the accept-time check refuses puts back the body from
 *     before the review — never the candidate — offers the refused text to
 *     copy, and is never autosaved;
 *   - under review, and until its save answers, the editor takes no input
 *     and the autosave sends nothing; the same while it is drafted, and a
 *     body that changed meanwhile drops the candidate unseen;
 *   - the page hears the request's id once its review is shown;
 *   - with the room flag off, the accept still names the body the editor
 *     loaded or last saved as its base, and is saved;
 *   - "Update using context" is not offered on a client-document Proposal,
 *     and is with the gate off.
 *
 * Harness: the single-user one from `DocumentEditor.accept-version-guard`,
 * with a fake server that keeps a body identity and can refuse a save, a
 * `reviseSection` a test answers, and the review bar's props recorded.
 */

import { sectionFingerprint } from "@repo/utils/proposal-artifact/preservation";
import { buildSectionMap } from "@repo/utils/proposal-artifact/section-hash";
import { spliceSectionBody } from "@repo/utils/proposal-artifact/section-splice";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- The fake server: one document, its version and body identity.
const server = {
	content: "",
	version: 7,
	type: "PROPOSAL",
	/** The next save is refused with this error, writing nothing. */
	refuseNext: null as Error | null,
	/** Answer saves only when a test releases them. */
	holdAnswers: false,
	held: [] as Array<() => void>,
};
const saveCalls: Array<Record<string, unknown>> = [];
const reviseSection = vi.fn();
const flags = vi.hoisted(() => ({ values: {} as Record<string, boolean> }));

function hashOf(content: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i += 1) {
		hash ^= content.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `h${hash.toString(16)}-${content.length}`;
}

function serverDocument() {
	return {
		document: {
			id: "doc-1",
			title: "Example proposal",
			type: server.type,
			content: server.content,
			version: server.version,
			contentHash: hashOf(server.content),
			status: "COMPLETED",
		},
	};
}

async function fakeUpdate(vars: Record<string, unknown>) {
	saveCalls.push({ ...vars });
	if (server.holdAnswers) {
		await new Promise<void>((resolve) => server.held.push(resolve));
	}
	const refusal = server.refuseNext;
	server.refuseNext = null;
	if (refusal) {
		throw refusal;
	}
	if (
		vars.expectedVersion !== undefined &&
		(vars.expectedVersion !== server.version ||
			(vars.expectedContentHash !== undefined &&
				vars.expectedContentHash !== hashOf(server.content)))
	) {
		throw Object.assign(new Error("Document changed"), {
			code: "CONFLICT",
		});
	}
	const unchanged = vars.content === server.content;
	if (!unchanged && typeof vars.content === "string") {
		server.content = vars.content;
		server.version += 1;
	}
	return { ...serverDocument(), contentUnchanged: unchanged };
}

function cannedResponseFor(path: string[]): unknown {
	const joined = path.join(".");
	if (joined === "projects.documents.get") {
		return serverDocument();
	}
	if (joined === "projects.get") {
		return {
			project: {
				name: "proj-1",
				techStack: [],
				features: [],
				userRole: "owner",
			},
		};
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
						mutationFn: async (vars: Record<string, unknown>) =>
							path.join(".") === "projects.documents.update"
								? fakeUpdate(vars)
								: cannedResponseFor(path),
						...config,
					});
				}
				if (typeof prop === "symbol" || prop === "then") {
					return undefined;
				}
				return build([...path, prop]);
			},
			apply(_target, _this, args) {
				if (
					path.join(".") === "projects.proposalArtifact.reviseSection"
				) {
					return reviseSection(...args);
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
	useRouter: () => ({ push: vi.fn() }),
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
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => flags.values[key] ?? false,
}));
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({ state: {}, setState: vi.fn(), nodeName: undefined }),
	useCopilotAction: vi.fn(),
	useFrontendTool: vi.fn(),
	useCopilotChat: () => ({ isLoading: false, visibleMessages: [] }),
	useCopilotChatInternal: () => ({ messages: [], setMessages: vi.fn() }),
	useCopilotReadable: vi.fn(),
	useCopilotMessagesContext: () => ({ setMessages: vi.fn() }),
}));
// The editor's page is drawn inside the sidebar.
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: ({ children }: { children?: import("react").ReactNode }) =>
		children,
}));
vi.mock("@saas/projects/components/DocumentGenerationProgress", () => ({
	DocumentGenerationProgress: () => null,
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
vi.mock("@saas/prompts/components/PromptSelector", () => ({
	PromptSelector: () => null,
}));
const reviewBar = vi.hoisted(() => ({
	props: null as Record<string, any> | null,
}));
vi.mock("@saas/projects/components/DiffReviewBar", () => ({
	DiffReviewBar: (props: Record<string, any>) => {
		reviewBar.props = props;
		return null;
	},
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
vi.mock("@saas/projects/lib/diff-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@saas/projects/lib/diff-utils")>()),
	resetScrollTracking: vi.fn(),
	focusOnLastDiff: vi.fn(),
	focusOnAnchor: vi.fn(),
}));
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

import { DocumentEditor } from "@saas/projects/components/DocumentEditor";
import type {
	SectionRevisionOutcome,
	SectionRevisionRequest,
} from "@saas/projects/components/proposal-artifact/useSectionRevision";
import { fromMarkdown } from "@saas/projects/lib/diff-utils";
import { getEditorMarkdownForSave } from "@saas/projects/lib/editor-markdown-save";
import { createAdvancedExtensions } from "@saas/projects/lib/tiptap-extensions-advanced";
import { toast } from "sonner";

const STORED = [
	"## Approach",
	"",
	"We start with a pilot for Example Org.",
	"",
	"## Pricing",
	"",
	"A fixed fee for the first phase.",
	"",
	"## Timeline",
	"",
	"Four weeks.",
].join("\n");
const REVISED_PRICING = "A fixed fee covers both phases.";

function makeEditor(markdown: string): Editor {
	return new Editor({
		extensions: createAdvancedExtensions({
			projectId: null,
			documentId: null,
		}),
		content: fromMarkdown(markdown),
	});
}

function bodyOf(editor: Editor | null): string {
	return editor ? (getEditorMarkdownForSave(editor) ?? "") : "";
}

/** The lines of every section but `heading`'s, in order. */
function otherSections(markdown: string, heading: string): string {
	const lines = markdown.split("\n");
	return buildSectionMap(markdown)
		.sections.filter((section) => section.headingText !== heading)
		.map((section) =>
			lines.slice(section.startLine - 1, section.endLine).join("\n"),
		)
		.join("\n---\n");
}

function keyOf(markdown: string, heading: string): string {
	const found = buildSectionMap(markdown).sections.find(
		(section) => section.headingText === heading,
	);
	if (!found) {
		throw new Error(`no section ${heading}`);
	}
	return found.key;
}

function candidate() {
	return {
		status: "CANDIDATE",
		sectionKey: keyOf(STORED, "Pricing"),
		body: REVISED_PRICING,
		baseVersion: server.version,
		baseContentHash: hashOf(server.content),
		revisionToken: "token-example",
	};
}

let queryClient: QueryClient;
let saveSlot: HTMLElement;
const settled: SectionRevisionOutcome[] = [];
const shown: string[] = [];

function tree(request: SectionRevisionRequest | null) {
	return (
		<QueryClientProvider client={queryClient}>
			<DocumentEditor
				projectId="proj-1"
				documentId="doc-1"
				saveSlot={saveSlot}
				sectionRevisionRequest={request}
				onSectionRevisionSettled={(outcome) => settled.push(outcome)}
				onSectionRevisionShown={(id) => shown.push(id)}
			/>
		</QueryClientProvider>
	);
}

async function mount(stored = STORED) {
	server.content = stored;
	mockEditor = makeEditor(stored);
	const view = render(tree(null));
	await waitFor(() => {
		expect(
			screen.queryByText("Loading document..."),
		).not.toBeInTheDocument();
	});
	await settle(50);
	return view;
}

async function settle(ms = 20) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

const REQUEST: SectionRevisionRequest = {
	id: "revision-1",
	runId: "run-1",
	findingId: "finding-1",
};

/** Hands the editor the request and waits for its candidate's review. */
async function openReview(view: ReturnType<typeof render>) {
	reviseSection.mockResolvedValue(candidate());
	view.rerender(tree(REQUEST));
	await waitFor(() => {
		expect(reviewBar.props).not.toBeNull();
	});
	await settle(50);
}

beforeEach(() => {
	vi.clearAllMocks();
	flags.values = { PROPOSAL_ARTIFACT: true, DOCUMENT_ROOM_CONVERGENCE: true };
	server.content = "";
	server.version = 7;
	server.type = "PROPOSAL";
	server.refuseNext = null;
	server.holdAnswers = false;
	server.held = [];
	saveCalls.length = 0;
	settled.length = 0;
	shown.length = 0;
	reviewBar.props = null;
	reviseSection.mockReset();
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
	mockEditor?.destroy();
	mockEditor = null;
	saveSlot.remove();
});

describe("a section revision in the editor (Fizzy #2946)", () => {
	it("saves unsaved typing first and asks for the revision from the base that save produced", async () => {
		const view = await mount();
		await act(async () => {
			mockEditor?.commands.insertContentAt(
				mockEditor.state.doc.content.size - 1,
				" Typed.",
			);
		});
		const typed = bodyOf(mockEditor);
		expect(typed).toContain("Four weeks. Typed.");
		await openReview(view);

		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({
			content: typed,
			expectedVersion: 7,
			expectedContentHash: hashOf(STORED),
		});
		expect(reviseSection).toHaveBeenCalledWith({
			projectId: "proj-1",
			documentId: "doc-1",
			runId: "run-1",
			findingId: "finding-1",
			baseVersion: 8,
			baseContentHash: hashOf(typed),
		});
	});

	it("Accept sends the FINDING descriptor and its token; every other section is byte-identical along the way", async () => {
		const view = await mount();
		const before = bodyOf(mockEditor);
		await openReview(view);

		const underReview = bodyOf(mockEditor);
		expect(underReview).toContain(REVISED_PRICING);
		expect(otherSections(underReview, "Pricing")).toBe(
			otherSections(before, "Pricing"),
		);
		expect(mockEditor?.isEditable).toBe(false);

		await act(async () => {
			reviewBar.props?.onAcceptAll();
		});
		await settle(50);

		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({
			aiReview: {
				kind: "FINDING",
				runId: "run-1",
				findingId: "finding-1",
				revisionToken: "token-example",
			},
			expectedVersion: 7,
			expectedContentHash: hashOf(STORED),
		});
		const saved = saveCalls[0].content as string;
		expect(otherSections(saved, "Pricing")).toBe(
			otherSections(before, "Pricing"),
		);
		expect(otherSections(bodyOf(mockEditor), "Pricing")).toBe(
			otherSections(before, "Pricing"),
		);
		expect(server.content).toContain(REVISED_PRICING);
		expect(settled).toEqual([{ id: "revision-1", result: "accepted" }]);
		await waitFor(() => {
			expect(mockEditor?.isEditable).toBe(true);
		});
	});

	it("Reject puts back the body from before the review, byte for byte, and saves nothing", async () => {
		const view = await mount();
		const before = bodyOf(mockEditor);
		await openReview(view);
		expect(bodyOf(mockEditor)).not.toBe(before);

		await act(async () => {
			reviewBar.props?.onRejectAll();
		});
		await settle(50);

		expect(bodyOf(mockEditor)).toBe(before);
		expect(saveCalls).toEqual([]);
		expect(settled).toEqual([{ id: "revision-1", result: "rejected" }]);
		expect(mockEditor?.isEditable).toBe(true);
	});

	it("an Accept the accept-time check refuses puts back the body from before the review, offers the refused text once, and never saves it", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const view = await mount();
			const before = bodyOf(mockEditor);
			await openReview(view);
			const candidateBody = bodyOf(mockEditor);
			server.refuseNext = Object.assign(new Error("refused"), {
				code: "PRECONDITION_FAILED",
				data: { code: "REVISION_OUTSIDE_TARGET" },
			});

			await act(async () => {
				reviewBar.props?.onAcceptAll();
			});
			await settle(50);

			expect(bodyOf(mockEditor)).toBe(before);
			expect(bodyOf(mockEditor)).not.toBe(candidateBody);
			expect(settled).toEqual([
				{
					id: "revision-1",
					result: "refused",
					code: "REVISION_OUTSIDE_TARGET",
				},
			]);
			const offers = vi
				.mocked(toast.warning)
				.mock.calls.filter(([message]) => message === "offerBack");
			expect(offers).toHaveLength(1);
			// The page says the refusal beside the finding; no second toast.
			expect(toast.error).not.toHaveBeenCalledWith("notApplied");
			await waitFor(() => {
				expect(mockEditor?.isEditable).toBe(true);
			});
			// Past the autosave's delay, nothing more is sent.
			await act(async () => {
				vi.advanceTimersByTime(15_000);
			});
			await settle(50);
			expect(saveCalls).toHaveLength(1);
			expect(server.content).toBe(STORED);
		} finally {
			vi.useRealTimers();
		}
	});

	it("takes no input while its save is in flight, and Save waits for its answer", async () => {
		const view = await mount();
		await openReview(view);
		server.holdAnswers = true;
		await act(async () => {
			reviewBar.props?.onAcceptAll();
		});
		await settle(50);
		expect(saveCalls).toHaveLength(1);
		expect(mockEditor?.isEditable).toBe(false);
		expect(
			screen.queryByRole("button", { name: /^Save document$/ }),
		).toBeNull();
		expect(settled).toEqual([]);

		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
		});
		await settle(50);
		expect(settled).toEqual([{ id: "revision-1", result: "accepted" }]);
		await waitFor(() => {
			expect(mockEditor?.isEditable).toBe(true);
		});
		expect(saveCalls).toHaveLength(1);
	});

	it("tells the page once its review is shown", async () => {
		const view = await mount();
		await openReview(view);
		expect(shown).toEqual(["revision-1"]);
		expect(settled).toEqual([]);
	});

	it("takes no input and autosaves nothing while it is drafted, and drops a candidate whose body changed meanwhile", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const view = await mount();
			let answer: (value: unknown) => void = () => {};
			reviseSection.mockImplementation(
				() =>
					new Promise((resolve) => {
						answer = resolve;
					}),
			);
			view.rerender(tree(REQUEST));
			await waitFor(() => {
				expect(reviseSection).toHaveBeenCalledTimes(1);
			});
			await settle(50);
			expect(mockEditor?.isEditable).toBe(false);

			// A change that reaches the editor meanwhile, as a collaborator's
			// would: kept, and never saved by the autosave.
			await act(async () => {
				mockEditor?.commands.insertContentAt(
					mockEditor.state.doc.content.size - 1,
					" Changed meanwhile.",
				);
			});
			const changed = bodyOf(mockEditor);
			expect(changed).toContain("Four weeks. Changed meanwhile.");
			await act(async () => {
				vi.advanceTimersByTime(15_000);
			});
			await settle(50);
			expect(saveCalls).toEqual([]);

			await act(async () => {
				answer(candidate());
			});
			await settle(50);
			expect(settled).toEqual([
				{ id: "revision-1", result: "refused", code: "STALE" },
			]);
			expect(shown).toEqual([]);
			expect(reviewBar.props).toBeNull();
			expect(bodyOf(mockEditor)).toBe(changed);
			await waitFor(() => {
				expect(mockEditor?.isEditable).toBe(true);
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("Accept of a candidate that drops a linked sentence saves no empty link, as the candidate's section", async () => {
		// The deleted link text is marked inside the link in the editor; the
		// save used to keep the emptied link as `[](url)`, whose destination
		// the accept-time check counts — and refused the accept.
		const linked = STORED.replace(
			"A fixed fee for the first phase.",
			"A fixed fee for the first phase.[See the rate card](https://example.com/rates)\n\nPaid monthly.",
		);
		const view = await mount(linked);
		const key = keyOf(linked, "Pricing");
		const body = "A fixed fee for the first phase.\n\nPaid monthly.";
		reviseSection.mockResolvedValue({
			...candidate(),
			sectionKey: key,
			body,
		});
		view.rerender(tree(REQUEST));
		await waitFor(() => {
			expect(reviewBar.props).not.toBeNull();
		});
		await settle(50);

		await act(async () => {
			reviewBar.props?.onAcceptAll();
		});
		await settle(50);

		expect(saveCalls).toHaveLength(1);
		const saved = saveCalls[0].content as string;
		expect(saved).not.toContain("[](");
		expect(saved).not.toContain("https://example.com/rates");
		const reviewed = spliceSectionBody(linked, key, body);
		expect(reviewed).not.toBeNull();
		expect(sectionFingerprint(saved, key)).toBe(
			sectionFingerprint(reviewed ?? "", key),
		);
		expect(settled).toEqual([{ id: "revision-1", result: "accepted" }]);
	});

	it("answers a revision the server refuses to draft with its status, leaving the editor as it was", async () => {
		const view = await mount();
		const before = bodyOf(mockEditor);
		reviseSection.mockResolvedValue({ status: "INVALID_CANDIDATE" });
		view.rerender(tree(REQUEST));
		await waitFor(() => {
			expect(settled).toEqual([
				{
					id: "revision-1",
					result: "refused",
					code: "INVALID_CANDIDATE",
				},
			]);
		});
		expect(bodyOf(mockEditor)).toBe(before);
		expect(reviewBar.props).toBeNull();
		expect(mockEditor?.isEditable).toBe(true);
	});
});

describe("Update using context on a Proposal (Fizzy #2946)", () => {
	it("is not offered on a client-document Proposal", async () => {
		await mount();
		expect(screen.queryAllByText(/Update\s+using\s+context/)).toEqual([]);
	});

	it("is offered with the gate off", async () => {
		flags.values = { DOCUMENT_ROOM_CONVERGENCE: true };
		await mount();
		expect(
			screen.queryAllByText(/Update\s+using\s+context/).length,
		).toBeGreaterThan(0);
	});
});

describe("a section revision with the room flag off (Fizzy #2946)", () => {
	beforeEach(() => {
		flags.values = {
			PROPOSAL_ARTIFACT: true,
			DOCUMENT_ROOM_CONVERGENCE: false,
		};
	});

	it("asks from the body the editor saved and saves its Accept from that base", async () => {
		const view = await mount();
		await act(async () => {
			mockEditor?.commands.insertContentAt(
				mockEditor.state.doc.content.size - 1,
				" Typed.",
			);
		});
		const typed = bodyOf(mockEditor);
		await openReview(view);

		// The editor's own save names no base with the flag off.
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).not.toHaveProperty("expectedContentHash");
		expect(reviseSection).toHaveBeenCalledWith(
			expect.objectContaining({
				baseVersion: 8,
				baseContentHash: hashOf(typed),
			}),
		);

		await act(async () => {
			reviewBar.props?.onAcceptAll();
		});
		await settle(50);

		expect(saveCalls).toHaveLength(2);
		expect(saveCalls[1]).toMatchObject({
			aiReview: { kind: "FINDING", findingId: "finding-1" },
			expectedVersion: 8,
			expectedContentHash: hashOf(typed),
		});
		expect(server.content).toContain(REVISED_PRICING);
		expect(settled).toEqual([{ id: "revision-1", result: "accepted" }]);
	});
});

// Page-agent behavior is covered by page-agent-render-cost; retain this harness's agent fixture.
vi.mock("@saas/shared/components/copilot/use-page-agent", async () => {
	const core = await import("@copilotkit/react-core");
	return {
		usePageAgent: (name: string, initialState: object) =>
			core.useCoAgent({ name, initialState }),
	};
});

// These editor harnesses predate the enclosing page's session provider.
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
