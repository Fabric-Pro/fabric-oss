/**
 * Regression test for the CopilotKit AG-UI mount-time handshake toasting a
 * scary "Couldn't read the document content..." error before any AI review
 * has actually started.
 *
 * Mechanism: `useCopilotChat().isLoading` on CopilotKit 1.70 is
 * `Boolean(agent?.isRunning)`, which the AG-UI connect handshake flips true
 * on mount — with no user request behind it. `DocumentEditorInner` mounts
 * late (behind the document query, the org-context gate, and on staging the
 * Yjs connect+sync gate), and `useEditor` runs with `immediatelyRender:
 * false`, so `editor` is `null` on this component's first commit. "Effect 1:
 * Capture baseline when loading STARTS" (`DocumentEditor.tsx`, ~line 2711)
 * used to call `getEditorMarkdownForSave(editor)` regardless of whether
 * `editor` existed yet; a null editor serializes to `null`, and the
 * component reported that as a failed AI review. Worse, the effect's tail
 * unconditionally set `wasLoadingRef.current = isLoading`, so once `editor`
 * did arrive the false→true transition had already been consumed and the
 * baseline was never captured.
 *
 * The fix adds an early `if (!editor) { return; }` before both the capture
 * branch and the `wasLoadingRef` write, so the transition stays available
 * and the effect re-runs (editor is already a dependency) once the instance
 * exists. This file pins: (1) no toast while editor is null, (2) the
 * baseline IS captured once editor mounts (not skipped by a consumed
 * transition), and (3) a genuine serialization failure still toasts.
 *
 * Assertion (2) cannot rely on `editor.getHTML()`/`editor.setEditable()`
 * alone: an unrelated agent-state-init effect (`DocumentEditor.tsx:2460`)
 * also calls `getHTML` on the same render the editor first appears, and
 * Effect 1's own `setEditable` write in its tail runs unconditionally,
 * whether or not the capture branch above it executed. So a regression that
 * kept the null-toast guard but still let `wasLoadingRef` get consumed early
 * — the silent half of this bug — would pass those two checks anyway. The
 * discriminating assertion spies on `resetScrollTracking` (imported from
 * `../lib/diff-utils`), which is called from exactly one place in the whole
 * component: inside Effect 1's capture branch. It only fires if that branch
 * actually ran.
 *
 * Mocking harness copied from the sibling
 * `DocumentEditor.save-cache-key.test.tsx` — see that file for why each stub
 * exists. Only `@copilotkit/react-core`'s `useCopilotChat` and
 * `@tiptap/react`'s `useEditor` are changed here, to drive the handshake
 * `isLoading`/`editor` states under test, plus a `sonner` mock so
 * `toast.error` is a spy, and a partial `../lib/diff-utils` mock (via
 * `importOriginal`) so `resetScrollTracking` alone becomes a spy.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- orpc: generic proxy so every namespace/procedure this 5000-line
// component touches gets a safe, deterministic stub without having to
// hand-list all ~14 endpoints it calls. See the sibling
// DocumentEditor.save-cache-key.test.tsx for the full rationale.
const DOCUMENT_PAYLOAD = {
	document: {
		id: "doc-1",
		title: "Spec",
		type: "SPEC",
		content: "<p>hello</p>",
		version: 1,
	},
};
const PROJECT_PAYLOAD = {
	project: { name: "proj-1", techStack: [], features: [] },
};

function cannedResponseFor(path: string[]): unknown {
	const joined = path.join(".");
	if (joined === "projects.documents.get") {
		return DOCUMENT_PAYLOAD;
	}
	if (joined === "projects.get") {
		return PROJECT_PAYLOAD;
	}
	return {};
}

// The save mutation's lifecycle callbacks are defined as closures INSIDE
// DocumentEditorInner and handed to
// `orpc.projects.documents.update.mutationOptions({...})`. Capturing the
// config object this mock is called with is used purely as a deterministic
// "DocumentEditorInner has mounted and rendered past the document query"
// readiness signal for `waitFor` below — the mutation lifecycle itself is
// not under test in this file.
let capturedUpdateMutationConfig: Record<string, any> | undefined;

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
					return (config: Record<string, unknown>) => {
						if (path.join(".") === "projects.documents.update") {
							capturedUpdateMutationConfig = config;
						}
						return {
							mutationFn: async (_vars: unknown) =>
								cannedResponseFor(path),
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

vi.mock("next/navigation", () => ({
	useParams: () => ({ organizationSlug: "acme" }),
	useSearchParams: () => new URLSearchParams(),
	useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-acme",
		organizationSlug: "acme",
		organizationName: "Acme",
		basePath: "/app/acme",
		isOrgContext: true,
		isPersonalContext: false,
		isGuest: false,
		isOrganizationAdmin: false,
		userRole: "member",
		loaded: true,
		organization: { id: "org-acme", slug: "acme", name: "Acme" },
	}),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1" }, session: {} }),
}));

// ---- CopilotKit: the entire chat/tool-call surface is nested INSIDE
// <CopilotSidebar> in the source JSX, which is stubbed to `() => null` below
// so none of that subtree's own hooks/imports need to be touched.
//
// `useCopilotChat` is the one deliberately-live mock here: `isLoading`
// reads from a module-level mutable flag so each test can simulate the
// AG-UI handshake's mount-time `isLoading: true` (default) and the eventual
// steady state independently of the editor's own readiness.
let mockIsLoading = true;
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({ state: {}, setState: vi.fn(), nodeName: undefined }),
	useCopilotAction: vi.fn(),
	useCopilotChat: () => ({ isLoading: mockIsLoading, visibleMessages: [] }),
	useCopilotChatInternal: () => ({ messages: [], setMessages: vi.fn() }),
	useCopilotReadable: vi.fn(),
	useCopilotMessagesContext: () => ({ setMessages: vi.fn() }),
}));
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: () => null,
}));

// `useEditor` is the other deliberately-live mock: it reads a module-level
// mutable value so a test can start with `editor === null` (mirroring
// `immediatelyRender: false`'s first commit) and later swap in a fake
// editor instance to simulate TipTap finishing its mount.
let mockEditor: any = null;
vi.mock("@tiptap/react", () => ({
	EditorContent: () => null,
	useEditor: () => mockEditor,
}));

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
	},
}));

// Effect 1 ("Capture baseline when loading STARTS", DocumentEditor.tsx:2711)
// is the ONLY call site of `resetScrollTracking` in the whole component (the
// import sits at DocumentEditor.tsx:103, the sole call inside the capture
// branch at :2732). That makes it a fingerprint for "the capture branch
// actually ran" in a way `getHTML`/`setEditable` are NOT: the unrelated
// agent-state-init effect at DocumentEditor.tsx:2460 also calls
// `getEditorMarkdownForSave` (hence `getHTML`) on the very render the editor
// first appears, and Effect 1's own tail calls `editor.setEditable(...)`
// unconditionally, regardless of whether the capture branch above it ran. A
// regression that kept the null-toast guard but still let `wasLoadingRef` get
// consumed early (the silent half of the original bug) would leave
// `getHTML`/`setEditable` assertions passing while `resetScrollTracking` goes
// uncalled — so that's the assertion pinned below, not the editor calls.
// `importOriginal` keeps every other export of this module (`diffPartialText`,
// `focusOnAnchor`, `focusOnLastDiff`, `fromMarkdown`, `repairMarkdownDocument`)
// real; only `resetScrollTracking` becomes a spy.
vi.mock("@saas/projects/lib/diff-utils", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@saas/projects/lib/diff-utils")>();
	return {
		...actual,
		resetScrollTracking: vi.fn(),
	};
});

// ---- Remaining custom hooks DocumentEditorInner calls unconditionally
// before the CopilotSidebar boundary. None of these feed the handshake /
// baseline-capture logic under test; they're stubbed purely so the
// component can render without throwing.
vi.mock("@saas/projects/hooks/useDocumentAssistantHistoryEnabled", () => ({
	useDocumentAssistantHistoryEnabled: () => false,
}));
vi.mock("@saas/projects/hooks/useDocumentAssistantHistory", () => ({
	useDocumentAssistantHistoryRealtimeSync: vi.fn(),
}));
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/TiptapEditorRegistry",
	() => ({
		useRegisterTiptapEditor: vi.fn(),
	}),
);
vi.mock(
	"@saas/projects/components/excalidraw-auto-insert/usePickerIntentConsumer",
	() => ({
		usePickerIntentConsumer: vi.fn(),
	}),
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
vi.mock("../hooks/use-diff-view-mode", () => ({
	useDiffPreview: () => ({
		diffViewMode: "inline",
		setDiffViewMode: vi.fn(),
		diffViews: [],
		effectiveDiffViewMode: "inline",
		showDiffPreviewPanes: false,
	}),
}));
// These three wrap <CopilotSidebar> (mocked to `() => null` below) with
// real CopilotKit-context providers that assume a `<CopilotKit>` root is
// mounted above them (it normally is, from the app layout — not present in
// this unit test). None of the three feed the logic under test, so they're
// stubbed as pass-throughs.
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

vi.mock("./documents/useUpdateDocumentWithContext", () => ({
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
}));

import { DocumentEditor } from "@saas/projects/components/DocumentEditor";
import { resetScrollTracking } from "@saas/projects/lib/diff-utils";
import { toast } from "sonner";

const HANDSHAKE_TOAST_MESSAGE =
	"Couldn't read the document content to start this AI review — please retry.";

/**
 * A fake TipTap `Editor`. `DocumentEditorInner` touches a wide editor
 * surface (`state.doc`, `view.dom`, `commands`, `isEditable`, ...) across
 * several effects that all run once `editor` is non-null — a Proxy that
 * hands back a `vi.fn()` for anything unrecognized means those unrelated
 * effects get a harmless no-op instead of a `TypeError`. Real values are
 * only supplied where DocumentEditor's behavior under test actually reads
 * them.
 */
function createFakeEditor(overrides: Record<string, unknown> = {}): any {
	const dom = window.document.createElement("div");
	const base: Record<string, unknown> = {
		getHTML: vi.fn(() => "<p>Fake editor content</p>"),
		setEditable: vi.fn(),
		isEditable: true,
		view: { dom },
		state: { doc: { textContent: "" } },
		...overrides,
	};
	return new Proxy(base, {
		get(target, prop, receiver) {
			if (prop in target) {
				return Reflect.get(target, prop, receiver);
			}
			if (prop === "then" || typeof prop === "symbol") {
				return undefined;
			}
			// Unmodeled surface (commands, chain, can, storage, on/off, ...):
			// hand back a no-op function so an unrelated effect calling it
			// doesn't throw.
			return vi.fn();
		},
	});
}

function renderDocumentEditor(queryClient: QueryClient) {
	return render(
		<QueryClientProvider client={queryClient}>
			<DocumentEditor projectId="proj-1" documentId="doc-1" />
		</QueryClientProvider>,
	);
}

async function waitForInnerMount() {
	// DocumentEditorInner sits behind the document query and the
	// org-context gate; waiting for its save mutation config to be handed
	// to our mocked `mutationOptions` is a deterministic proxy for "the
	// component behind those gates has rendered".
	await waitFor(() => {
		expect(capturedUpdateMutationConfig?.onMutate).toBeTypeOf("function");
	});
}

describe("DocumentEditor — AG-UI handshake baseline capture", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedUpdateMutationConfig = undefined;
		mockIsLoading = true;
		mockEditor = null;
	});

	it("never toasts the failed-read error while the editor has not mounted yet", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});

		renderDocumentEditor(queryClient);
		await waitForInnerMount();

		expect(toast.error).not.toHaveBeenCalledWith(HANDSHAKE_TOAST_MESSAGE);
		// The capture branch itself must not have run at all while editor is
		// null — resetScrollTracking is called nowhere else in the component.
		expect(resetScrollTracking).not.toHaveBeenCalled();
	});

	it("captures the baseline once the editor mounts, without the transition being consumed first", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});

		const { rerender } = renderDocumentEditor(queryClient);
		await waitForInnerMount();

		// Sanity: nothing has read the (still-null) editor yet.
		expect(toast.error).not.toHaveBeenCalledWith(HANDSHAKE_TOAST_MESSAGE);

		// Isolate the resetScrollTracking assertion below to THIS transition
		// (editor arriving), not to anything from the initial editor === null
		// render: the pre-fix code calls resetScrollTracking() before
		// checking whether `editor` is truthy at all, so a reverted fix
		// already fires it once during that first render. Without this
		// clear, `toHaveBeenCalled()` below would trivially pass on a revert
		// too — it would just be seeing that stale call — instead of
		// specifically proving the transition survived into this render.
		vi.mocked(resetScrollTracking).mockClear();

		// TipTap finishes mounting. `isLoading` is unchanged (still true,
		// from the handshake) — without the early `if (!editor) return;`,
		// `wasLoadingRef` would already have been set to `true` on the prior
		// render and this transition would be lost forever.
		const fakeEditor = createFakeEditor();
		mockEditor = fakeEditor;

		rerender(
			<QueryClientProvider client={queryClient}>
				<DocumentEditor projectId="proj-1" documentId="doc-1" />
			</QueryClientProvider>,
		);

		// getEditorMarkdownForSave(editor) -> editor.getHTML() is the
		// baseline capture; setEditable(false) is the effect's tail write,
		// gated on the same `isLoading`/`isRegenerating` values. Neither of
		// these two is on its own proof that the capture BRANCH ran, though:
		// the unrelated agent-state-init effect (DocumentEditor.tsx:2460)
		// also calls getHTML on this same render, and setEditable fires
		// unconditionally in Effect 1's tail whether or not the branch above
		// it executed.
		expect(fakeEditor.getHTML).toHaveBeenCalled();
		expect(fakeEditor.setEditable).toHaveBeenCalledWith(false);
		expect(toast.error).not.toHaveBeenCalledWith(HANDSHAKE_TOAST_MESSAGE);
		// This is the assertion that actually pins transition-preservation:
		// resetScrollTracking is called from nowhere but Effect 1's capture
		// branch, so it only fires here if `wasLoadingRef` was NOT already
		// consumed on the prior (editor === null) render. A regression that
		// kept the null-toast guard but still let the transition get consumed
		// early would leave the two assertions above passing while this one
		// goes uncalled.
		expect(resetScrollTracking).toHaveBeenCalled();
	});

	it("still toasts the failed-read error when the editor exists but serialization throws", async () => {
		const throwingEditor = createFakeEditor({
			getHTML: vi.fn(() => {
				throw new Error("simulated Turndown failure");
			}),
		});
		mockEditor = throwingEditor;

		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});

		renderDocumentEditor(queryClient);
		await waitForInnerMount();

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(HANDSHAKE_TOAST_MESSAGE);
		});
	});
});
