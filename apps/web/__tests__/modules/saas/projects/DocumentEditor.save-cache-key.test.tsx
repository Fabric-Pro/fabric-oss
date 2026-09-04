/**
 * Attempt to pin: the query key the save mutation's optimistic update /
 * rollback uses (`documentGetQueryKey`, built inside `DocumentEditorInner`)
 * must be the SAME key the `documents.get` query reads from — otherwise
 * `setQueryData`/`getQueryData` (exact-match) silently operate on a
 * phantom cache entry when `organizationId` is dropped from one builder.
 *
 * This requires mounting `DocumentEditorInner`, which is not exported and
 * sits below `DocumentEditor`'s early returns. See the file docblock in
 * `DocumentEditor.mention-org-context.test.tsx` for why that component is
 * normally never mounted in this suite.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- orpc: generic proxy so every namespace/procedure this 5000-line
// component touches gets a safe, deterministic stub without having to
// hand-list all ~14 endpoints it calls. `queryKey`/`queryOptions` key on
// the procedure PATH plus the exact `input` object (JSON-serialized) —
// mirroring how the real oRPC tanstack-query integration builds keys, and
// exactly the property under test: two call sites for the same procedure
// only collide in the cache if their `input` (including `organizationId`)
// is identical.
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

// The save mutation's lifecycle callbacks (onMutate/onError/onSuccess/
// onSettled) are defined as closures INSIDE DocumentEditorInner and handed
// to `orpc.projects.documents.update.mutationOptions({...})` — they aren't
// exported anywhere. Capturing the config object this mock is called with
// is the only way to reach the real closures under test (as opposed to
// re-implementing what we THINK they do).
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

// ---- CopilotKit: the entire chat/tool-call surface (EditorToolbar,
// DocumentTocRail, EditorContent, DiffPreviewPanes, MeetingSelector...) is
// nested INSIDE <CopilotSidebar> in the source JSX (DocumentEditor.tsx
// ~4867-5844). Stubbing CopilotSidebar to `() => null` means React never
// reconciles those children, so none of that subtree's own hooks/imports
// need to be touched.
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: () => ({ state: {}, setState: vi.fn(), nodeName: undefined }),
	useCopilotAction: vi.fn(),
	useCopilotChat: () => ({ isLoading: false, visibleMessages: [] }),
	useCopilotChatInternal: () => ({ messages: [], setMessages: vi.fn() }),
	useCopilotReadable: vi.fn(),
	useCopilotMessagesContext: () => ({ setMessages: vi.fn() }),
}));
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: () => null,
}));
vi.mock("@tiptap/react", () => ({
	EditorContent: () => null,
	useEditor: () => null,
}));

// ---- Remaining custom hooks DocumentEditorInner calls unconditionally
// before the CopilotSidebar boundary. None of these feed the save-mutation
// cache-key logic under test; they're stubbed purely so the component can
// render without throwing.
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
// this unit test). None of the three feed the save-mutation cache-key
// logic under test, so they're stubbed as pass-throughs.
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
import { orpc } from "@shared/lib/orpc-query-utils";

// The exact key the `documents.get` query reads from — built the same way
// DocumentEditorPage/DocumentEditor build it, with `organizationId` in the
// input. If `documentGetQueryKey` (built separately, inside
// DocumentEditorInner) omits `organizationId`, `setQueryData`/
// `getQueryData` — which match a key EXACTLY, unlike `invalidateQueries`/
// `cancelQueries` — will silently miss this key.
const documentQueryKey = orpc.projects.documents.get.queryKey({
	input: { id: "doc-1", projectId: "proj-1", organizationId: "org-acme" },
});

describe("DocumentEditor save mutation — cache key consistency", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedUpdateMutationConfig = undefined;
	});

	it("optimistic save and error rollback operate on the exact key the document query reads from", async () => {
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});

		render(
			<QueryClientProvider client={queryClient}>
				<DocumentEditor projectId="proj-1" documentId="doc-1" />
			</QueryClientProvider>,
		);

		// Wait for the real `documents.get` query to resolve and populate the
		// cache, and for DocumentEditorInner's render to have handed its save
		// mutation's onMutate/onError to our mock.
		await waitFor(() => {
			expect(capturedUpdateMutationConfig?.onMutate).toBeTypeOf(
				"function",
			);
		});

		// Sanity: the query actually cached the document under the key we
		// independently computed above — proves the two builders agree
		// BEFORE we exercise the mutation lifecycle.
		const seeded = queryClient.getQueryData(documentQueryKey) as
			| { document: { content: string } }
			| undefined;
		expect(seeded?.document?.content).toBe("<p>hello</p>");

		// Exercise the optimistic update.
		let context: { previous: unknown } | undefined;
		await act(async () => {
			context = await capturedUpdateMutationConfig?.onMutate({
				projectId: "proj-1",
				id: "doc-1",
				content: "<p>edited content</p>",
			});
		});

		const afterMutate = queryClient.getQueryData(documentQueryKey) as
			| { document: { content: string } }
			| undefined;
		expect(afterMutate?.document?.content).toBe("<p>edited content</p>");
		expect(afterMutate).not.toBe(seeded);

		// Exercise the rollback.
		await act(async () => {
			capturedUpdateMutationConfig?.onError(
				new Error("simulated save failure"),
				{
					projectId: "proj-1",
					id: "doc-1",
					content: "<p>edited content</p>",
				},
				context,
			);
		});

		const afterError = queryClient.getQueryData(documentQueryKey);
		expect(afterError).toEqual(seeded);
	});
});
