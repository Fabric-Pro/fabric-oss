import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
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
const mockDeleteConfig = vi.fn().mockResolvedValue({ success: true });
const mockUpsertConfig = vi.fn();
const mockToastSuccess = vi.fn();
const mockCheckOAuthStatuses = vi.fn();

const mockToastInfo = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		info: (...args: unknown[]) => mockToastInfo(...args),
		error: vi.fn(),
		success: (...args: unknown[]) => mockToastSuccess(...args),
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		mcp: {
			configs: {
				list: (...args: any[]) => mockListConfigs(...args),
				delete: (...args: any[]) => mockDeleteConfig(...args),
				upsert: (...args: any[]) => mockUpsertConfig(...args),
			},
			registry: {
				list: (...args: any[]) => mockListRegistry(...args),
			},
			// Tool counts load for enabled, connected servers.
			tools: {
				list: async () => ({ tools: [], errors: [] }),
			},
		},
	},
}));

vi.mock("@saas/mcp/hooks/useMcpConnection", () => ({
	useMcpConnection: () => ({
		oauthStatuses: {},
		checkOAuthStatuses: mockCheckOAuthStatuses,
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

function renderWithClient(
	ui: React.ReactElement,
	queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
		},
	}),
) {
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

describe("McpServersView — Delete on a GitLab server", () => {
	const gitlabConfig = {
		id: "cfg-official",
		enabled: true,
		authType: "OAUTH2",
		organizationId: MOCK_ORG_ID,
		displayName: null,
		status: "UNKNOWN",
		mcpServer: {
			id: "server-gitlab-official",
			key: "gitlab-official",
			name: "GitLab (Official)",
			transport: "HTTP",
		},
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockListRegistry.mockResolvedValue(mockRegistryServers);
		mockDeleteConfig.mockResolvedValue({ success: true });
	});

	it("explains that Delete disconnects GitLab and keeps the registration, then calls the server", async () => {
		mockListConfigs.mockResolvedValue([gitlabConfig]);
		renderWithClient(<McpServersView organizationId={MOCK_ORG_ID} />);

		const deleteButton = await screen.findByRole("button", {
			name: "Delete",
		});
		deleteButton.click();

		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByText(/disconnects your GitLab account/i),
		).toBeInTheDocument();
		expect(
			within(dialog).getByText(
				/Project repository links are not affected/i,
			),
		).toBeInTheDocument();

		within(dialog).getByRole("button", { name: "Delete" }).click();

		await waitFor(() => {
			expect(mockDeleteConfig).toHaveBeenCalledWith({
				id: "cfg-official",
				organizationId: MOCK_ORG_ID,
			});
		});
		await waitFor(() => {
			expect(mockToastSuccess).toHaveBeenCalledWith(
				"GitLab disconnected and the server turned off",
			);
		});
	});

	it("refreshes every view of the GitLab connection and both GitLab tiles after the Delete", async () => {
		const builtIn = {
			...gitlabConfig,
			id: "cfg-gitlab",
			mcpServer: {
				id: "server-gitlab",
				key: "gitlab",
				name: "GitLab",
				transport: "HTTP",
			},
		};
		mockListConfigs.mockResolvedValue([gitlabConfig, builtIn]);
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		renderWithClient(
			<McpServersView organizationId={MOCK_ORG_ID} />,
			queryClient,
		);

		const deleteButtons = await screen.findAllByRole("button", {
			name: "Delete",
		});
		deleteButtons[0]?.click();
		const dialog = await screen.findByRole("alertdialog");
		mockCheckOAuthStatuses.mockClear();
		within(dialog).getByRole("button", { name: "Delete" }).click();

		await waitFor(() => {
			expect(mockToastSuccess).toHaveBeenCalledWith(
				"GitLab disconnected and the server turned off",
			);
		});
		await waitFor(() => {
			const invalidated = invalidate.mock.calls.map(
				([filters]) => (filters as { queryKey: unknown[] }).queryKey,
			);
			expect(invalidated).toEqual(
				expect.arrayContaining([
					["gitlab-oauth-status"],
					["workflow-integrations"],
					["workflow-integration-status"],
					["mcp.availablePmTools"],
					["data-connections"],
					["data-connection"],
					["mcp-configs"],
					["connections", "mcp-registry"],
					["account-settings-integrations"],
				]),
			);
		});
		const checkedIds = mockCheckOAuthStatuses.mock.calls.flatMap(
			([configs]) => (configs as Array<{ id: string }>).map((c) => c.id),
		);
		expect(checkedIds).toEqual(
			expect.arrayContaining(["cfg-official", "cfg-gitlab"]),
		);
	});

	it("keeps the plain delete copy for other servers", async () => {
		mockListConfigs.mockResolvedValue([
			{
				...gitlabConfig,
				id: "cfg-linear",
				mcpServer: {
					id: "server-linear",
					key: "linear-remote",
					name: "Linear",
					transport: "HTTP",
				},
			},
		]);
		renderWithClient(<McpServersView organizationId={MOCK_ORG_ID} />);

		(await screen.findByRole("button", { name: "Delete" })).click();

		const dialog = await screen.findByRole("alertdialog");
		expect(
			within(dialog).getByText(/This action cannot be undone/i),
		).toBeInTheDocument();
	});
});

// A GitLab config saved before GitLab configs were stored as OAUTH2 can still
// name API_KEY or NONE. Its settings form is OAuth all the same: it asks for
// no API key (the API refuses one) and saves as OAUTH2.
describe("McpServersView — editing a GitLab config that names another auth type", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockListRegistry.mockResolvedValue(mockRegistryServers);
		mockUpsertConfig.mockResolvedValue({ id: "cfg-gl", enabled: true });
	});

	it.each(["API_KEY", "NONE"])(
		"saves a %s GitLab config without any credential, as OAUTH2",
		async (authType) => {
			mockListConfigs.mockResolvedValue([
				{
					id: "cfg-gl",
					mcpServerId: "server-gitlab",
					enabled: true,
					authType,
					apiKeyMethod: "BEARER",
					encryptedApiKey: null,
					organizationId: MOCK_ORG_ID,
					displayName: "GitLab",
					baseUrl: null,
					status: "HEALTHY",
					mcpServer: {
						id: "server-gitlab",
						key: "gitlab",
						name: "GitLab",
						transport: "HTTP",
						defaultUrl: "https://gitlab.com/api/v4/mcp",
						authMethods: ["OAUTH2"],
					},
				},
			]);
			renderWithClient(<McpServersView organizationId={MOCK_ORG_ID} />);

			(await screen.findByRole("button", { name: "Edit" })).click();
			const dialog = await screen.findByRole("dialog");
			expect(
				within(dialog).queryByPlaceholderText(/API key/i),
			).not.toBeInTheDocument();
			expect(
				within(dialog).getByDisplayValue("OAuth 2.0"),
			).toBeDisabled();

			within(dialog)
				.getByRole("button", { name: /Save Only/ })
				.click();

			await waitFor(() => expect(mockUpsertConfig).toHaveBeenCalled());
			const payload = mockUpsertConfig.mock.calls[0][0];
			expect(payload).toMatchObject({
				configId: "cfg-gl",
				authType: "OAUTH2",
			});
			expect(payload.apiKey).toBeUndefined();
			expect(payload.apiKeyMethod).toBeUndefined();
		},
	);
});

// The registry's list view draws its own auth badge (the grid uses
// McpServerCard). A GitLab server is OAuth through the person's connection,
// so its badge says OAuth whatever its registry row advertises.
describe("McpServersView — registry list badge for a GitLab server", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockListConfigs.mockResolvedValue([]);
		mockListRegistry.mockResolvedValue([
			{
				id: "server-gitlab",
				key: "gitlab",
				name: "GitLab",
				transport: "HTTP",
				authMethods: ["API_KEY"],
			},
			{
				id: "server-pg",
				key: "postgres",
				name: "PostgreSQL",
				transport: "HTTP",
				authMethods: ["API_KEY"],
			},
		]);
	});

	it("shows OAuth for GitLab and keeps API Key for any other server", async () => {
		renderWithClient(
			<McpServersView
				organizationId={MOCK_ORG_ID}
				initialRegistrySearch="NonExistentCustomTool"
			/>,
		);

		const dialog = await screen.findByRole("dialog", {
			name: /add mcp server from registry/i,
		});
		fireEvent.change(
			within(dialog).getByPlaceholderText("Search MCP servers..."),
			{ target: { value: "" } },
		);
		fireEvent.click(
			within(dialog).getByRole("button", { name: "List view" }),
		);

		const row = (name: string) => {
			const element = within(dialog)
				.getByText(name)
				.closest("div.rounded-lg");
			if (!(element instanceof HTMLElement)) {
				throw new Error(`no registry row for ${name}`);
			}
			return within(element);
		};
		await waitFor(() =>
			expect(row("GitLab").getByText("OAuth")).toBeTruthy(),
		);
		expect(row("GitLab").queryByText("API Key")).not.toBeInTheDocument();
		expect(row("PostgreSQL").getByText("API Key")).toBeInTheDocument();
	});
});
