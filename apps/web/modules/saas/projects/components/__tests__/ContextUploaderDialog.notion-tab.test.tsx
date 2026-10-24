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

const { mcpConfigsListMock, dataConnectionsListMock, contextsListMock } =
	vi.hoisted(() => ({
		mcpConfigsListMock: vi.fn(),
		dataConnectionsListMock: vi.fn(),
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
			list: (input: unknown) => dataConnectionsListMock(input),
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

vi.mock("../ConfluenceResourceBrowser", () => ({
	ConfluenceResourceBrowser: () => null,
}));

vi.mock("../NotionResourceBrowser", () => ({
	NotionResourceBrowser: (props: { open: boolean }) =>
		props.open ? <div data-testid="mcp-resource-browser" /> : null,
}));

vi.mock("../NotionIntegrationPageBrowser", () => ({
	NotionIntegrationPageBrowser: (props: { open: boolean }) =>
		props.open ? <div data-testid="integration-page-browser" /> : null,
}));

import { ContextUploaderDialog } from "../ContextUploaderDialog";

describe("ContextUploaderDialog — Notion Tab Priority Rendering", () => {
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

	it("Priority A: renders MCP Browse button when Notion MCP config exists", async () => {
		mcpConfigsListMock.mockResolvedValue([
			{
				id: "mcp-cfg-1",
				enabled: true,
				mcpServer: { key: "notion-server", name: "Notion MCP" },
			},
		]);
		dataConnectionsListMock.mockResolvedValue({
			connections: [
				{
					id: "conn-1",
					provider: "NOTION",
					status: "CONNECTED",
				},
			],
		});

		renderDialog();

		const notionTabTrigger = screen.getByRole("tab", { name: /Notion/i });
		await userEvent.click(notionTabTrigger);

		const browseBtn = await screen.findByRole("button", {
			name: /Browse Notion Pages/i,
		});
		expect(browseBtn).toBeInTheDocument();

		await userEvent.click(browseBtn);
		expect(screen.getByTestId("mcp-resource-browser")).toBeInTheDocument();
		expect(
			screen.queryByTestId("integration-page-browser"),
		).not.toBeInTheDocument();
	});

	it("Priority B: renders Integration Browse button when no MCP exists but Notion Integration is CONNECTED", async () => {
		mcpConfigsListMock.mockResolvedValue([]);
		dataConnectionsListMock.mockResolvedValue({
			connections: [
				{
					id: "conn-notion-1",
					provider: "NOTION",
					status: "CONNECTED",
				},
			],
		});

		renderDialog();

		const notionTabTrigger = screen.getByRole("tab", { name: /Notion/i });
		await userEvent.click(notionTabTrigger);

		const browseBtn = await screen.findByRole("button", {
			name: /Browse Notion Pages/i,
		});
		expect(browseBtn).toBeInTheDocument();

		await userEvent.click(browseBtn);
		expect(
			screen.getByTestId("integration-page-browser"),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("mcp-resource-browser"),
		).not.toBeInTheDocument();
	});

	it("Priority C: renders Connect Notion message and button when neither MCP nor Integration is set up", async () => {
		mcpConfigsListMock.mockResolvedValue([]);
		dataConnectionsListMock.mockResolvedValue({
			connections: [],
		});

		renderDialog();

		const notionTabTrigger = screen.getByRole("tab", { name: /Notion/i });
		await userEvent.click(notionTabTrigger);

		expect(
			await screen.findByText(
				"Connect Notion under Integrations to add pages",
			),
		).toBeInTheDocument();

		const connectBtn = screen.getByRole("link", {
			name: /Connect Notion/i,
		});
		expect(connectBtn).toHaveAttribute(
			"href",
			"/app/example-org/settings/integrations/providers/NOTION?returnTo=/projects/p1",
		);

		const configureMcpBtn = screen.getByRole("link", {
			name: /Configure MCP/i,
		});
		expect(configureMcpBtn).toHaveAttribute(
			"href",
			"/app/example-org/mcp-servers?returnTo=/projects/p1",
		);
	});

	it("The dialog with both MCP and an Integration shows the MCP button", async () => {
		mcpConfigsListMock.mockResolvedValue([
			{
				id: "mcp-cfg-1",
				enabled: true,
				mcpServer: { key: "notion-server", name: "Notion MCP" },
			},
		]);
		dataConnectionsListMock.mockResolvedValue({
			connections: [
				{
					id: "conn-1",
					provider: "NOTION",
					status: "CONNECTED",
				},
			],
		});

		renderDialog();

		const notionTabTrigger = screen.getByRole("tab", { name: /Notion/i });
		await userEvent.click(notionTabTrigger);

		const browseBtn = await screen.findByRole("button", {
			name: /Browse Notion Pages/i,
		});
		expect(browseBtn).toBeInTheDocument();

		await userEvent.click(browseBtn);
		// Verified: MCP resource browser opens, NOT integration page browser
		expect(screen.getByTestId("mcp-resource-browser")).toBeInTheDocument();
		expect(
			screen.queryByTestId("integration-page-browser"),
		).not.toBeInTheDocument();
	});
});
