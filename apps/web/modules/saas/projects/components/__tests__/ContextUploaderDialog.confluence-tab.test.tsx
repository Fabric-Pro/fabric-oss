import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	if (!HTMLElement.prototype.hasPointerCapture) {
		HTMLElement.prototype.hasPointerCapture = (() => false) as never;
	}
	if (!HTMLElement.prototype.scrollIntoView) {
		HTMLElement.prototype.scrollIntoView = (() => undefined) as never;
	}
});

const { mcpConfigsListMock, workflowIntegrationsListMock, contextsListMock } =
	vi.hoisted(() => ({
		mcpConfigsListMock: vi.fn(),
		workflowIntegrationsListMock: vi.fn(),
		contextsListMock: vi.fn(),
	}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				list: (input: unknown) => contextsListMock(input),
				createUploadUrl: vi.fn(),
				processFile: vi.fn(),
				processLink: vi.fn(),
			},
		},
		searchProviders: {
			getUserProviders: vi.fn().mockResolvedValue([]),
			getOrganizationProviders: vi.fn().mockResolvedValue([]),
		},
		mcp: {
			configs: {
				list: (input: unknown) => mcpConfigsListMock(input),
			},
		},
		dataConnections: {
			list: vi.fn().mockResolvedValue({ connections: [] }),
		},
		workflows: {
			integrations: {
				listStatus: (input: unknown) =>
					workflowIntegrationsListMock(input),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationSlug: "example-org",
		basePath: "/app/example-org",
	}),
	useContextPath: (p: string) => `/app/example-org/${p}`,
}));

vi.mock("@saas/settings/hooks/use-settings-return-url", () => ({
	useSettingsReturnUrl: () => (path: string) =>
		`${path}?returnTo=/projects/p1`,
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: vi.fn() }),
}));

vi.mock("../TeamsChatSelectorDialog", () => ({
	TeamsChatSelectorDialog: () => null,
}));

vi.mock("../SlackChannelSelectorDialog", () => ({
	SlackChannelSelectorDialog: () => null,
}));

vi.mock("../GoogleDocsSelectorDialog", () => ({
	GoogleDocsSelectorDialog: () => null,
}));

vi.mock("../NotionResourceBrowser", () => ({
	NotionResourceBrowser: () => null,
}));

vi.mock("../ConfluenceResourceBrowser", () => ({
	ConfluenceResourceBrowser: (props: { open: boolean }) =>
		props.open ? (
			<div data-testid="confluence-mcp-resource-browser" />
		) : null,
}));

vi.mock("../IntegrationPageBrowser", () => ({
	IntegrationPageBrowser: (props: { open: boolean; provider: string }) =>
		props.open ? (
			<div data-testid={`integration-page-browser-${props.provider}`} />
		) : null,
}));

import { ContextUploaderDialog } from "../ContextUploaderDialog";

describe("ContextUploaderDialog — Confluence Tab Priority Rendering", () => {
	let queryClient: QueryClient;

	beforeEach(() => {
		vi.clearAllMocks();
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
			},
		});
		contextsListMock.mockResolvedValue({ contexts: [] });
	});

	function renderDialog() {
		return render(
			<QueryClientProvider client={queryClient}>
				<ContextUploaderDialog
					open={true}
					onOpenChange={vi.fn()}
					projectId="proj-1"
				/>
			</QueryClientProvider>,
		);
	}

	it("Priority A: renders MCP Browse button when Confluence MCP config exists", async () => {
		mcpConfigsListMock.mockResolvedValue([
			{
				id: "mcp-cfg-conf",
				enabled: true,
				mcpServer: { key: "atlassian", name: "Atlassian Rovo" },
			},
		]);
		workflowIntegrationsListMock.mockResolvedValue({
			integrations: [
				{
					id: "int-1",
					provider: "CONFLUENCE",
					isActive: true,
				},
			],
		});

		renderDialog();

		const confluenceTabTrigger = screen.getByRole("tab", {
			name: /Confluence/i,
		});
		await userEvent.click(confluenceTabTrigger);

		const browseBtn = await screen.findByRole("button", {
			name: /Browse Confluence Pages/i,
		});
		expect(browseBtn).toBeInTheDocument();

		await userEvent.click(browseBtn);
		expect(
			screen.getByTestId("confluence-mcp-resource-browser"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("integration-page-browser-confluence"),
		).not.toBeInTheDocument();
		expect(workflowIntegrationsListMock).not.toHaveBeenCalled();
	});

	it("Priority B: renders Integration Browse button when no MCP exists but active Confluence Integration exists", async () => {
		mcpConfigsListMock.mockResolvedValue([]);
		workflowIntegrationsListMock.mockResolvedValue({
			integrations: [
				{
					id: "int-conf-1",
					provider: "CONFLUENCE",
					isActive: true,
				},
			],
		});

		renderDialog();

		const confluenceTabTrigger = screen.getByRole("tab", {
			name: /Confluence/i,
		});
		await userEvent.click(confluenceTabTrigger);

		const browseBtn = await screen.findByRole("button", {
			name: /Browse Confluence Pages/i,
		});
		expect(browseBtn).toBeInTheDocument();

		await userEvent.click(browseBtn);
		expect(
			screen.getByTestId("integration-page-browser-confluence"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("confluence-mcp-resource-browser"),
		).not.toBeInTheDocument();
	});

	it("Priority C: renders Connect Confluence message and button when neither MCP nor active Integration exists", async () => {
		mcpConfigsListMock.mockResolvedValue([]);
		workflowIntegrationsListMock.mockResolvedValue({
			integrations: [],
		});

		renderDialog();

		const confluenceTabTrigger = screen.getByRole("tab", {
			name: /Confluence/i,
		});
		await userEvent.click(confluenceTabTrigger);

		expect(
			await screen.findByText(
				"Connect Confluence under Integrations to add pages",
			),
		).toBeInTheDocument();

		const connectBtn = screen.getByRole("link", {
			name: /Connect Confluence/i,
		});
		expect(connectBtn).toHaveAttribute(
			"href",
			"/app/example-org/settings/integrations/providers/CONFLUENCE?returnTo=/projects/p1",
		);

		const configureMcpBtn = screen.getByRole("link", {
			name: /Configure MCP/i,
		});
		expect(configureMcpBtn).toHaveAttribute(
			"href",
			"/app/example-org/mcp-servers?returnTo=/projects/p1",
		);
	});

	it("The dialog with both MCP and active Integration prioritizes MCP Browse", async () => {
		mcpConfigsListMock.mockResolvedValue([
			{
				id: "mcp-cfg-conf",
				enabled: true,
				mcpServer: { key: "atlassian", name: "Confluence Server" },
			},
		]);
		workflowIntegrationsListMock.mockResolvedValue({
			integrations: [
				{
					id: "int-1",
					provider: "CONFLUENCE",
					isActive: true,
				},
			],
		});

		renderDialog();

		const confluenceTabTrigger = screen.getByRole("tab", {
			name: /Confluence/i,
		});
		await userEvent.click(confluenceTabTrigger);

		const browseBtn = await screen.findByRole("button", {
			name: /Browse Confluence Pages/i,
		});
		expect(browseBtn).toBeInTheDocument();

		await userEvent.click(browseBtn);
		expect(
			screen.getByTestId("confluence-mcp-resource-browser"),
		).toBeInTheDocument();
	});
});
