/**
 * The Features document type is deprecated: feature recommendations live in
 * Roadmap now, and an existing Features document is a historical snapshot.
 *
 * The editor page is where someone meets one of those snapshots, so it carries
 * the replacement notice and marks the type chip. Two things are pinned here:
 *
 *  - The marker reaches a screen reader. The chip names itself through
 *    `aria-label`, which REPLACES its text content, so a visible badge alone
 *    would be silent; the label has to say "deprecated" too.
 *  - Both marks key on the ref kind as well as the type. The page also takes
 *    `documentRefKind="USER_STORY"` for a live Roadmap feature, and labelling
 *    one of those a historical snapshot would tell people their current work
 *    is stale.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentDocument } = vi.hoisted(() => ({
	currentDocument: { type: "USER_STORY" as string },
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryOptions: (opts: unknown) => ({
					queryKey: ["projects.get", opts],
				}),
			},
			documents: {
				get: {
					queryOptions: (opts: unknown) => ({
						queryKey: ["documents.get", opts],
					}),
				},
			},
		},
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey }: { queryKey: [string, unknown] }) => {
		if (queryKey[0] === "documents.get") {
			return {
				isLoading: false,
				data: {
					document: {
						id: "doc-1",
						title: "Checkout features",
						type: currentDocument.type,
						content: "# EPIC-001: Checkout",
					},
				},
			};
		}
		return {
			isLoading: false,
			data: {
				project: {
					id: "proj-1",
					name: "Example project",
					organizationId: "org-1",
				},
			},
		};
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		isLoading: false,
	}),
}));
vi.mock("@saas/shared/contexts/FullscreenContext", () => ({
	useFullscreen: () => ({ setIsFullscreen: vi.fn() }),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));
vi.mock("@saas/shared/components/copilot/use-copilot-error-handler", () => ({
	useCopilotErrorHandler: () => vi.fn(),
}));
vi.mock("@saas/shared/components/copilot/ai-sidebar-layout", () => ({
	AI_SIDEBAR_CONTENT_SHIFT_CLASS: "",
	useAiSidebarExpanded: () => false,
}));
vi.mock("@saas/shared/components/copilot/CopilotChatSessionProvider", () => ({
	CopilotChatSessionProvider: ({ children }: { children: ReactNode }) => (
		<>{children}</>
	),
}));
vi.mock("@saas/projects/hooks", () => ({
	useProjectPresence: () => ({ activeUsers: [], isConnected: false }),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@saas/subscriptions/components/SubscribeToggle", () => ({
	SubscribeToggle: () => null,
}));
vi.mock("@saas/projects/components/DocumentAutoRefreshToggle", () => ({
	DocumentAutoRefreshToggle: () => null,
}));
vi.mock("@saas/projects/components/DocumentTitleInlineEdit", () => ({
	DocumentTitleInlineEdit: () => null,
}));
vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@saas/projects/components/DocumentEditor", () => ({
	DocumentEditor: () => null,
	getDocumentTypeLabel: (type: string) =>
		type === "USER_STORY" ? "Features" : type,
}));

import { DocumentEditorPage } from "@saas/projects/components/DocumentEditorPage";

describe("DocumentEditorPage — deprecated Features documents", () => {
	beforeEach(() => {
		currentDocument.type = "USER_STORY";
	});

	it("shows the notice on a Features project document, linking to Roadmap", () => {
		render(
			<DocumentEditorPage
				projectId="proj-1"
				documentId="doc-1"
				organizationSlug="example-org"
			/>,
		);

		expect(screen.getByRole("note")).toHaveTextContent("message");
		expect(
			screen.getByRole("link", { name: "roadmapLink" }),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/proj-1?tab=stories",
		);
	});

	it("announces the deprecation with the type, not just paints it", () => {
		render(
			<DocumentEditorPage
				projectId="proj-1"
				documentId="doc-1"
				organizationSlug="example-org"
			/>,
		);

		expect(
			screen.getByLabelText("Document type: Features (deprecated)"),
		).toHaveTextContent("badge");
	});

	it("never labels a live Roadmap feature", () => {
		render(
			<DocumentEditorPage
				projectId="proj-1"
				documentId="doc-1"
				organizationSlug="example-org"
				documentRefKind="USER_STORY"
			/>,
		);

		expect(screen.queryByRole("note")).toBeNull();
		expect(
			screen.getByLabelText("Document type: Features"),
		).not.toHaveTextContent("badge");
	});

	it("leaves every other document type alone", () => {
		currentDocument.type = "PRD";
		render(
			<DocumentEditorPage
				projectId="proj-1"
				documentId="doc-1"
				organizationSlug="example-org"
			/>,
		);

		expect(screen.queryByRole("note")).toBeNull();
		expect(
			screen.getByLabelText("Document type: PRD"),
		).not.toHaveTextContent("badge");
	});
});
