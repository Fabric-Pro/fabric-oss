/**
 * Regression test for Fizzy #1187 — mentioned-document 404.
 *
 * `DocumentEditorPage` was fixed to pass the ROUTE org into its document
 * query (see the sibling `DocumentEditorPage.mention-org-context.test.tsx`),
 * but `DocumentEditorPage` mounts `<DocumentEditor>`, which runs its OWN
 * `projects.documents.get` (and `projects.get`) query — and that query also
 * omitted `organizationId`. Without it, the API's `resolveOrganizationId`
 * falls back to the viewer's session active-org, which 404s for a mentioned
 * user whose active org differs from the route. This is the other half of
 * the fix, applied directly to `DocumentEditor.tsx`.
 *
 * A second, subtler regression this pins: both queries are gated with
 * `enabled: orgContextReady` so they don't fire with a stale/undefined org.
 * A DISABLED react-query query never reports `isLoading: true`, so a naive
 * `if (isLoading)` guard would fall through to the `!document` branch and
 * render "Document not found" on every org-route load while the org context
 * is still resolving. The component guards this with
 * `if (isLoading || !orgContextReady)` — the last test below pins that.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	docQueryOptions,
	projectQueryOptions,
	mockOrganizationId,
	mockUseQuery,
} = vi.hoisted(() => ({
	docQueryOptions: vi.fn((opts: unknown) => ({
		queryKey: ["documents.get", opts],
		queryFn: async () => undefined,
	})),
	projectQueryOptions: vi.fn((opts: unknown) => ({
		queryKey: ["projects.get", opts],
		queryFn: async () => undefined,
	})),
	mockOrganizationId: { current: "org-acme" as string | null | undefined },
	// Both `useQuery` calls in `DocumentEditor` share this mock — loading
	// state is the same for the document and project queries in every case
	// this suite needs.
	mockUseQuery: vi.fn(() => ({ data: undefined, isLoading: true })),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: { queryOptions: projectQueryOptions },
			documents: { get: { queryOptions: docQueryOptions } },
		},
	},
}));

// `DocumentEditor` also imports `useMutation`/`useQueryClient` from this
// module, but only `DocumentEditorInner` (never mounted here) calls them.
vi.mock("@tanstack/react-query", () => ({
	useQuery: mockUseQuery,
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useQueryClient: () => ({
		invalidateQueries: vi.fn(),
		setQueryData: vi.fn(),
	}),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: mockOrganizationId.current,
	}),
}));

// `DocumentEditor` reads `params.organizationSlug` directly via
// `useParams()` to decide whether it's on an org route — this mock is what
// drives the `isOrgRoute` branch in the third test below.
const mockParams = vi.hoisted(() => ({
	current: { organizationSlug: "acme" } as Record<string, string>,
}));
vi.mock("next/navigation", () => ({
	useParams: () => mockParams.current,
	useSearchParams: () => new URLSearchParams(),
	useRouter: () => ({ push: vi.fn() }),
}));

// Heavy modules imported at module load by DocumentEditor.tsx (~6300 lines,
// large import graph) but never reached on the early-return paths exercised
// here. Stubbed to keep the jsdom module graph light; see the file docblock.
vi.mock("@copilotkit/react-core", () => ({
	useCoAgent: vi.fn(),
	useCopilotAction: vi.fn(),
	useCopilotChat: vi.fn(() => ({ isLoading: false, visibleMessages: [] })),
	useCopilotChatInternal: vi.fn(() => ({})),
	useCopilotReadable: vi.fn(),
}));
vi.mock("@copilotkit/react-ui", () => ({
	CopilotSidebar: () => null,
}));
vi.mock("@tiptap/react", () => ({
	EditorContent: () => null,
	useEditor: () => null,
}));

import { DocumentEditor } from "@saas/projects/components/DocumentEditor";

describe("DocumentEditor — mentioned-document org context", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockOrganizationId.current = "org-acme";
		mockParams.current = { organizationSlug: "acme" };
		mockUseQuery.mockReturnValue({ data: undefined, isLoading: true });
	});

	it("passes the route organizationId into the document query (org route)", () => {
		render(<DocumentEditor projectId="proj-1" documentId="doc-1" />);

		expect(docQueryOptions).toHaveBeenCalledWith({
			input: {
				id: "doc-1",
				projectId: "proj-1",
				organizationId: "org-acme",
			},
		});
	});

	it("passes null organizationId in personal context", () => {
		mockOrganizationId.current = null;
		mockParams.current = {};
		render(<DocumentEditor projectId="proj-1" documentId="doc-1" />);

		expect(docQueryOptions).toHaveBeenCalledWith({
			input: {
				id: "doc-1",
				projectId: "proj-1",
				organizationId: null,
			},
		});
	});

	it("shows the loading skeleton (not 'Document not found') while the org context is still resolving on an org route", () => {
		// Org route, but `useOrganizationContext()` hasn't resolved yet — the
		// real hook returns `undefined` in this window, not `null` (`null` is
		// the resolved personal-context value). Both queries are therefore
		// disabled (`enabled: orgContextReady` is false) and react-query
		// reports `isLoading: false` for a disabled query, which is why the
		// component needs `|| !orgContextReady` rather than `isLoading` alone.
		mockOrganizationId.current = undefined;
		mockParams.current = { organizationSlug: "acme" };
		mockUseQuery.mockReturnValue({ data: undefined, isLoading: false });

		render(<DocumentEditor projectId="proj-1" documentId="doc-1" />);

		expect(screen.getByText("Loading document...")).toBeInTheDocument();
		expect(
			screen.queryByText("Document not found"),
		).not.toBeInTheDocument();
	});
});
