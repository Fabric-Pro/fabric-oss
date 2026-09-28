/**
 * The document editor's "Glossy version" link (Fizzy #2589, U15; R1, R2,
 * R40, AE10).
 *
 * The masthead links a document to its Glossy page only when the
 * organization has the `GLOSSY_EDITION` rollout gate on and the type is
 * Glossy-eligible (Proposal, Business Case). With the gate off — or on any
 * other type — nothing renders. The Glossy page is an organization route of
 * a project document, so a live Roadmap feature and a route without an
 * organization slug get no link either.
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentDocument, flags } = vi.hoisted(() => ({
	currentDocument: { type: "BUSINESS_CASE" as string },
	flags: { glossy: true },
}));

vi.mock("next-intl", async () => {
	const en = (await import("@repo/i18n/translations/en.json")).default;
	function resolveCopy(path: string): string {
		const value = path
			.split(".")
			.reduce<unknown>(
				(node, key) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[key]
						: undefined,
				en,
			);
		if (typeof value !== "string") {
			throw new Error(`missing translation: ${path}`);
		}
		return value;
	}
	return {
		useTranslations: (namespace: string) => (key: string) =>
			resolveCopy(`${namespace}.${key}`),
	};
});

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
						title: "Rollout plan",
						type: currentDocument.type,
						content: "# Rollout",
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
	useFeatureFlag: (key: string) => key === "GLOSSY_EDITION" && flags.glossy,
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
	getDocumentTypeLabel: (type: string) => type,
}));

import { DocumentEditorPage } from "@saas/projects/components/DocumentEditorPage";

const GLOSSY_LABEL = "Glossy version";

describe("DocumentEditorPage — Glossy version link", () => {
	beforeEach(() => {
		currentDocument.type = "BUSINESS_CASE";
		flags.glossy = true;
	});

	it("links a Business Case to its Glossy page with the gate on", () => {
		render(
			<DocumentEditorPage
				projectId="proj-1"
				documentId="doc-1"
				organizationSlug="example-org"
			/>,
		);

		expect(
			screen.getByRole("link", { name: GLOSSY_LABEL }),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/proj-1/documents/doc-1/glossy",
		);
	});

	it("links a Proposal too", () => {
		currentDocument.type = "PROPOSAL";
		render(
			<DocumentEditorPage
				projectId="proj-1"
				documentId="doc-1"
				organizationSlug="example-org"
			/>,
		);

		expect(
			screen.getByRole("link", { name: GLOSSY_LABEL }),
		).toBeInTheDocument();
	});

	it("renders nothing on a Business Case with the gate off (AE10)", () => {
		flags.glossy = false;
		render(
			<DocumentEditorPage
				projectId="proj-1"
				documentId="doc-1"
				organizationSlug="example-org"
			/>,
		);

		expect(
			screen.queryByRole("link", { name: GLOSSY_LABEL }),
		).not.toBeInTheDocument();
	});

	it("renders nothing on a PRD with the gate on", () => {
		currentDocument.type = "PRD";
		render(
			<DocumentEditorPage
				projectId="proj-1"
				documentId="doc-1"
				organizationSlug="example-org"
			/>,
		);

		expect(
			screen.queryByRole("link", { name: GLOSSY_LABEL }),
		).not.toBeInTheDocument();
	});

	it("renders nothing for a live Roadmap feature", () => {
		render(
			<DocumentEditorPage
				projectId="proj-1"
				documentId="doc-1"
				organizationSlug="example-org"
				documentRefKind="USER_STORY"
			/>,
		);

		expect(
			screen.queryByRole("link", { name: GLOSSY_LABEL }),
		).not.toBeInTheDocument();
	});

	it("renders nothing without an organization route", () => {
		render(<DocumentEditorPage projectId="proj-1" documentId="doc-1" />);

		expect(
			screen.queryByRole("link", { name: GLOSSY_LABEL }),
		).not.toBeInTheDocument();
	});
});
