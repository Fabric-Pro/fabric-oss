/**
 * Regression test for Fizzy #2393 — the error-boundary fallback used to be
 * `<DocumentEditor>` rendered with no `<CopilotKit>` provider above it. On
 * CopilotKit 1.70 every hook `<DocumentEditor>` calls throws without a
 * provider, so the fallback threw too and the editor was lost either way.
 *
 * Here `<CopilotKit>` throws on render (simulating an initialization
 * failure) and the stubbed `<DocumentEditor>` throws the way the real one
 * does when rendered outside a provider. The page must land on the AI-free
 * panel showing the document's saved content — never re-mount the editor.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PROVIDER_ERROR =
	"Remember to wrap your app in a `<CopilotKit> {...} </CopilotKit>` !!!";

const { editorRenders } = vi.hoisted(() => ({
	editorRenders: { count: 0 },
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
						title: "Release plan",
						type: "PRD",
						content: "# Release plan\n\nShip on Tuesday.",
					},
				},
			};
		}
		return {
			isLoading: false,
			data: {
				project: {
					id: "proj-1",
					name: "Acme",
					organizationId: "org-acme",
				},
			},
		};
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-acme",
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

// The provider fails to initialize.
vi.mock("@copilotkit/react-core", () => ({
	CopilotKit: () => {
		throw new Error("CopilotKit failed to initialize");
	},
}));

// The real DocumentEditor calls useCopilotChat / useCoAgent unconditionally;
// outside a provider those throw. Model exactly that so a fallback that
// re-mounts the editor cannot pass.
vi.mock("@saas/projects/components/DocumentEditor", () => ({
	DocumentEditor: () => {
		editorRenders.count += 1;
		throw new Error(PROVIDER_ERROR);
	},
	getDocumentTypeLabel: () => "PRD",
}));

import { DocumentEditorPage } from "@saas/projects/components/DocumentEditorPage";

describe("DocumentEditorPage — CopilotKit initialization failure", () => {
	beforeEach(() => {
		editorRenders.count = 0;
		// React logs caught boundary errors; keep the run readable.
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("falls back to the AI-free panel with the document content, not to the editor", () => {
		render(
			<DocumentEditorPage
				projectId="proj-1"
				documentId="doc-1"
				organizationSlug="acme"
			/>,
		);

		const panel = screen.getByTestId("document-editor-ai-unavailable");
		expect(panel).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent(
			"CopilotKit failed to initialize",
		);
		expect(
			screen.getByRole("heading", { level: 1, name: "Release plan" }),
		).toBeInTheDocument();
		expect(screen.getByText("Ship on Tuesday.")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /reload page/i }),
		).toBeInTheDocument();

		// The whole point: the boundary never re-mounts DocumentEditor.
		expect(editorRenders.count).toBe(0);
	});
});
