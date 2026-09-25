import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MOCK_ORG_ID = "example-org";

const mockRegistryServers = [
	{
		id: "server-pg",
		key: "postgres",
		name: "PostgreSQL",
		description: "PostgreSQL database connector",
		transport: "HTTP",
		defaultUrl: "https://example.com/mcp/postgres",
		authType: "API_KEY",
		apiKeyMethod: "BEARER",
	},
	{
		id: "server-gh",
		key: "github",
		name: "GitHub",
		description: "GitHub MCP connector",
		transport: "HTTP",
		defaultUrl: "https://example.com/mcp/github",
		authType: "OAUTH2",
	},
	{
		id: "server-excalidraw",
		key: "excalidraw",
		name: "Excalidraw",
		description: "Managed diagramming tool",
		transport: "HTTP",
		defaultEnabled: true,
	},
	{
		id: "server-stdio",
		key: "filesystem",
		name: "Local Filesystem",
		description: "Local files via CLI",
		transport: "STDIO",
		docsUrl: "https://example.com/docs/filesystem",
	},
];

const mockListConfigs = vi.fn().mockResolvedValue([]);
const mockListRegistry = vi.fn().mockResolvedValue(mockRegistryServers);

const mockToastInfo = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		info: (...args: unknown[]) => mockToastInfo(...args),
		error: vi.fn(),
		success: vi.fn(),
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		mcp: {
			configs: {
				list: (...args: any[]) => mockListConfigs(...args),
			},
			registry: {
				list: (...args: any[]) => mockListRegistry(...args),
			},
		},
	},
}));

vi.mock("@saas/mcp/hooks/useMcpConnection", () => ({
	useMcpConnection: () => ({
		oauthStatuses: {},
		checkOAuthStatuses: vi.fn(),
		testMutation: { mutateAsync: vi.fn() },
		handleConnect: vi.fn(),
		refreshMutation: { mutateAsync: vi.fn() },
		revokeMutation: { mutateAsync: vi.fn() },
		toggleMutation: { mutateAsync: vi.fn() },
		refreshToolsMutation: { mutateAsync: vi.fn() },
		loadingStates: {},
	}),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
	FeatureFlagProvider: ({ children }: { children: React.ReactNode }) =>
		children,
}));

import { McpServersView } from "../McpServersView";

function renderWithClient(ui: React.ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
	);
}

describe("McpServersView — initialRegistrySearch handoff (#2612)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockListConfigs.mockResolvedValue([]);
		mockListRegistry.mockResolvedValue(mockRegistryServers);
	});

	it("automatically opens setup dialog when initialRegistrySearch matches a registry server", async () => {
		const onConsumed = vi.fn();

		renderWithClient(
			<McpServersView
				organizationId={MOCK_ORG_ID}
				initialRegistrySearch="PostgreSQL"
				onServerParamConsumed={onConsumed}
			/>,
		);

		// Registry should be queried with includeAll: true
		await waitFor(() => {
			expect(mockListRegistry).toHaveBeenCalledWith(
				expect.objectContaining({
					organizationId: MOCK_ORG_ID,
					includeAll: true,
				}),
			);
		});

		// Configuration dialog should open with PostgreSQL pre-filled
		await waitFor(() => {
			expect(
				screen.getByRole("dialog", { name: /add postgresql/i }),
			).toBeInTheDocument();
		});

		expect(
			screen.getByDisplayValue("https://example.com/mcp/postgres"),
		).toBeInTheDocument();
		expect(onConsumed).toHaveBeenCalledTimes(1);
	});

	it("falls back to opening the registry dialog with search prefilled when server name is unknown", async () => {
		const onConsumed = vi.fn();

		renderWithClient(
			<McpServersView
				organizationId={MOCK_ORG_ID}
				initialRegistrySearch="NonExistentCustomTool"
				onServerParamConsumed={onConsumed}
			/>,
		);

		// Registry dialog should open
		const dialog = await screen.findByRole("dialog", {
			name: /add mcp server from registry/i,
		});
		expect(dialog).toBeInTheDocument();

		const searchInput = within(dialog).getByPlaceholderText(
			"Search MCP servers...",
		);
		expect(searchInput).toHaveValue("NonExistentCustomTool");
		expect(onConsumed).toHaveBeenCalledTimes(1);
	});

	it("does not open dialogs or call onServerParamConsumed when initialRegistrySearch is empty", async () => {
		const onConsumed = vi.fn();

		renderWithClient(
			<McpServersView
				organizationId={MOCK_ORG_ID}
				initialRegistrySearch=""
				onServerParamConsumed={onConsumed}
			/>,
		);

		await waitFor(() => {
			expect(mockListConfigs).toHaveBeenCalled();
		});

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(onConsumed).not.toHaveBeenCalled();
	});

	it("reacts to initialRegistrySearch prop update while already mounted", async () => {
		const onConsumed = vi.fn();

		const { rerender } = renderWithClient(
			<McpServersView
				organizationId={MOCK_ORG_ID}
				initialRegistrySearch=""
				onServerParamConsumed={onConsumed}
			/>,
		);

		await waitFor(() => {
			expect(mockListConfigs).toHaveBeenCalled();
		});

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		// Update prop with server name
		rerender(
			<QueryClientProvider
				client={
					new QueryClient({
						defaultOptions: { queries: { retry: false } },
					})
				}
			>
				<McpServersView
					organizationId={MOCK_ORG_ID}
					initialRegistrySearch="GitHub"
					onServerParamConsumed={onConsumed}
				/>
			</QueryClientProvider>,
		);

		await waitFor(() => {
			expect(
				screen.getByRole("dialog", { name: /add github/i }),
			).toBeInTheDocument();
		});

		expect(
			screen.getByDisplayValue("https://example.com/mcp/github"),
		).toBeInTheDocument();
		expect(onConsumed).toHaveBeenCalledTimes(1);
	});

	it("shows info toast and does not open Add dialog when server is defaultEnabled (managed / always on)", async () => {
		const onConsumed = vi.fn();

		renderWithClient(
			<McpServersView
				organizationId={MOCK_ORG_ID}
				initialRegistrySearch="Excalidraw"
				onServerParamConsumed={onConsumed}
			/>,
		);

		await waitFor(() => {
			expect(mockToastInfo).toHaveBeenCalledWith(
				expect.stringMatching(/always enabled/i),
			);
		});

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(onConsumed).toHaveBeenCalledTimes(1);
	});

	it("shows info toast with docs action when server is STDIO without command", async () => {
		const onConsumed = vi.fn();

		renderWithClient(
			<McpServersView
				organizationId={MOCK_ORG_ID}
				initialRegistrySearch="filesystem"
				onServerParamConsumed={onConsumed}
			/>,
		);

		await waitFor(() => {
			expect(mockToastInfo).toHaveBeenCalledWith(
				"This server requires local setup",
				expect.objectContaining({
					action: expect.objectContaining({
						label: "View docs",
					}),
				}),
			);
		});

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(onConsumed).toHaveBeenCalledTimes(1);
	});

	it("matches server by id", async () => {
		const onConsumed = vi.fn();

		renderWithClient(
			<McpServersView
				organizationId={MOCK_ORG_ID}
				initialRegistrySearch="server-pg"
				onServerParamConsumed={onConsumed}
			/>,
		);

		await waitFor(() => {
			expect(
				screen.getByRole("dialog", { name: /add postgresql/i }),
			).toBeInTheDocument();
		});

		expect(
			screen.getByDisplayValue("https://example.com/mcp/postgres"),
		).toBeInTheDocument();
		expect(onConsumed).toHaveBeenCalledTimes(1);
	});

	it("matches server by key", async () => {
		const onConsumed = vi.fn();

		renderWithClient(
			<McpServersView
				organizationId={MOCK_ORG_ID}
				initialRegistrySearch="postgres"
				onServerParamConsumed={onConsumed}
			/>,
		);

		await waitFor(() => {
			expect(
				screen.getByRole("dialog", { name: /add postgresql/i }),
			).toBeInTheDocument();
		});

		expect(
			screen.getByDisplayValue("https://example.com/mcp/postgres"),
		).toBeInTheDocument();
		expect(onConsumed).toHaveBeenCalledTimes(1);
	});
});
