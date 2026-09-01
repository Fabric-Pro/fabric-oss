/**
 * Regression test for Fizzy #1187 — mentioned-document 404.
 *
 * The document editor must fetch the document using the org context derived
 * from the ROUTE (the org whose slug is in the URL), not the viewer's session
 * active-org. A mentioned user frequently opens the doc while their active org
 * differs; before the fix the document query omitted `organizationId`, so the
 * API's `resolveOrganizationId` fell back to the wrong session org and the
 * fetch was denied → "Document not found" (the reported 404). This pins the
 * query input, which is the single thing the fix changes.
 *
 * Both queries are forced into the loading state so the component returns its
 * skeleton early and never mounts CopilotKit / TipTap (heavy, jsdom-hostile).
 * The assertion is on the queryOptions builder call args.
 */

import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { docQueryOptions, projectQueryOptions, mockOrganizationId } = vi.hoisted(
	() => ({
		docQueryOptions: vi.fn((opts: unknown) => ({
			queryKey: ["documents.get", opts],
			queryFn: async () => undefined,
		})),
		projectQueryOptions: vi.fn((opts: unknown) => ({
			queryKey: ["projects.get", opts],
			queryFn: async () => undefined,
		})),
		mockOrganizationId: { current: "org-acme" as string | null },
	}),
);

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: { queryOptions: projectQueryOptions },
			documents: { get: { queryOptions: docQueryOptions } },
		},
	},
}));

// Both queries report loading → component short-circuits to the skeleton.
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ data: undefined, isLoading: true }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: mockOrganizationId.current,
	}),
}));

vi.mock("@saas/shared/contexts/FullscreenContext", () => ({
	useFullscreen: () => ({ setIsFullscreen: vi.fn() }),
}));

// The masthead's `DocumentAutoRefreshToggle` reads its feature flag from
// `FeatureFlagProvider`, and that hook THROWS when the provider is absent —
// deliberately, so a forgotten provider cannot masquerade as a disabled
// feature (Fizzy #2210). This suite renders no provider: it only reaches the
// skeleton path today because both queries are forced into loading, so the
// masthead never mounts. Stub the hook rather than leave the suite standing on
// that coincidence.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@saas/shared/components/copilot/use-copilot-error-handler", () => ({
	useCopilotErrorHandler: () => vi.fn(),
}));

vi.mock("@saas/projects/hooks", () => ({
	useProjectPresence: () => ({ activeUsers: [], isConnected: false }),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));

// Heavy children — never rendered on the skeleton path, but imported at module
// load, so stub them to keep the jsdom module graph light.
vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: ({ children }: { children: ReactNode }) => <>{children}</>,
	useCopilotChat: () => ({ isLoading: false, visibleMessages: [] }),
}));
vi.mock("@saas/projects/components/DocumentEditor", () => ({
	DocumentEditor: () => null,
	getDocumentTypeLabel: () => "PRD",
}));
vi.mock("@saas/projects/components/DocumentTitleInlineEdit", () => ({
	DocumentTitleInlineEdit: () => null,
}));

import { DocumentEditorPage } from "@saas/projects/components/DocumentEditorPage";

describe("DocumentEditorPage — mentioned-document org context", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockOrganizationId.current = "org-acme";
	});

	it("passes the route organizationId into the document query (org route)", () => {
		render(
			<DocumentEditorPage
				projectId="proj-1"
				documentId="doc-1"
				organizationSlug="acme"
			/>,
		);

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
		render(<DocumentEditorPage projectId="proj-1" documentId="doc-1" />);

		expect(docQueryOptions).toHaveBeenCalledWith({
			input: {
				id: "doc-1",
				projectId: "proj-1",
				organizationId: null,
			},
		});
	});
});
