/**
 * Tests for the project-setup-wizard PM tool picker.
 *
 * Mocks `orpcClient.mcp.availablePmTools.list` and exercises:
 *   - default render with no MCP configs (just the platform defaults)
 *   - "None" sentinel mapping to nulls
 *   - default-only selection → mcpConfigId: null, mcpServerId: <id>
 *   - configured selection → both ids non-null
 *   - helper text only appears for default-only selections
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const availablePmToolsList = vi.fn();
const gitlabStart = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		mcp: {
			availablePmTools: {
				list: (...args: unknown[]) => availablePmToolsList(...args),
			},
		},
		integrations: {
			gitlab: {
				start: (...args: unknown[]) => gitlabStart(...args),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
	},
}));

import { orpcClient } from "@shared/lib/orpc-client";
import { toast } from "sonner";
import { PMToolSelect } from "../pm-tool-select";

function wrapper({ children }: { children: React.ReactNode }) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return (
		<QueryClientProvider client={queryClient}>
			{children}
		</QueryClientProvider>
	);
}

const THREE_DEFAULTS = [
	{
		key: "fizzy",
		displayName: "Fizzy",
		iconKey: "fizzy",
		isDefault: true,
		isConfigured: false,
		mcpServerId: "srv_fizzy",
		mcpConfigId: null,
		configDisplayName: null,
		transport: null,
	},
	{
		key: "azure-devops",
		displayName: "Azure DevOps",
		iconKey: "azure-devops",
		isDefault: true,
		isConfigured: false,
		mcpServerId: "srv_ado",
		mcpConfigId: null,
		configDisplayName: null,
		transport: null,
	},
	{
		key: "atlassian",
		displayName: "Jira",
		iconKey: "jira",
		isDefault: true,
		isConfigured: false,
		mcpServerId: "srv_atlassian",
		mcpConfigId: null,
		configDisplayName: null,
		transport: null,
	},
];

const CONFIGURED_LINEAR = {
	key: "linear-remote",
	displayName: "Linear",
	iconKey: "linear-remote",
	isDefault: false,
	isConfigured: true,
	mcpServerId: "srv_linear",
	mcpConfigId: "cfg_linear",
	configDisplayName: "Linear (work)",
	transport: "mcp" as const,
};

describe("PMToolSelect", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders the three default options when no configs exist", async () => {
		availablePmToolsList.mockResolvedValue(THREE_DEFAULTS);
		const user = userEvent.setup();
		render(
			<PMToolSelect
				organizationId={null}
				selectedMcpConfigId={null}
				selectedMcpServerId={null}
				onChange={vi.fn()}
				mcpSettingsUrl="/app/settings/mcp"
			/>,
			{ wrapper },
		);

		await waitFor(() => {
			expect(availablePmToolsList).toHaveBeenCalledTimes(1);
		});

		const trigger = screen.getByRole("combobox", {
			name: "Project Management Tool",
		});
		await user.click(trigger);

		expect(screen.getByText("Fizzy")).toBeInTheDocument();
		expect(screen.getByText("Azure DevOps")).toBeInTheDocument();
		expect(screen.getByText("Jira")).toBeInTheDocument();
	});

	it("passes organizationId through to the procedure", async () => {
		availablePmToolsList.mockResolvedValue(THREE_DEFAULTS);
		render(
			<PMToolSelect
				organizationId="org_abc"
				selectedMcpConfigId={null}
				selectedMcpServerId={null}
				onChange={vi.fn()}
				mcpSettingsUrl="/app/settings/mcp"
			/>,
			{ wrapper },
		);

		await waitFor(() => {
			expect(availablePmToolsList).toHaveBeenCalledWith({
				organizationId: "org_abc",
			});
		});
	});

	it("selecting a default-only stub fires onChange with mcpConfigId: null + mcpServerId set", async () => {
		availablePmToolsList.mockResolvedValue(THREE_DEFAULTS);
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<PMToolSelect
				organizationId={null}
				selectedMcpConfigId={null}
				selectedMcpServerId={null}
				onChange={onChange}
				mcpSettingsUrl="/app/settings/mcp"
			/>,
			{ wrapper },
		);

		await waitFor(() => {
			expect(availablePmToolsList).toHaveBeenCalled();
		});

		await user.click(
			screen.getByRole("combobox", { name: "Project Management Tool" }),
		);
		await user.click(screen.getByRole("option", { name: /Jira/ }));

		expect(onChange).toHaveBeenCalledWith({
			mcpConfigId: null,
			mcpServerId: "srv_atlassian",
			isDefault: true,
			isConfigured: false,
			transport: null,
		});
	});

	it("selecting a configured option fires onChange with both ids set", async () => {
		availablePmToolsList.mockResolvedValue([
			CONFIGURED_LINEAR,
			...THREE_DEFAULTS,
		]);
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<PMToolSelect
				organizationId={null}
				selectedMcpConfigId={null}
				selectedMcpServerId={null}
				onChange={onChange}
				mcpSettingsUrl="/app/settings/mcp"
			/>,
			{ wrapper },
		);

		await waitFor(() => {
			expect(availablePmToolsList).toHaveBeenCalled();
		});

		await user.click(
			screen.getByRole("combobox", { name: "Project Management Tool" }),
		);
		await user.click(screen.getByRole("option", { name: /Linear/ }));

		expect(onChange).toHaveBeenCalledWith({
			mcpConfigId: "cfg_linear",
			mcpServerId: "srv_linear",
			isDefault: false,
			isConfigured: true,
			transport: "mcp",
		});
	});

	it("selecting None fires onChange with all nulls", async () => {
		availablePmToolsList.mockResolvedValue(THREE_DEFAULTS);
		const onChange = vi.fn();
		const user = userEvent.setup();
		render(
			<PMToolSelect
				organizationId={null}
				selectedMcpConfigId={null}
				selectedMcpServerId="srv_fizzy"
				onChange={onChange}
				mcpSettingsUrl="/app/settings/mcp"
			/>,
			{ wrapper },
		);

		await waitFor(() => {
			expect(availablePmToolsList).toHaveBeenCalled();
		});

		await user.click(
			screen.getByRole("combobox", { name: "Project Management Tool" }),
		);
		await user.click(screen.getByRole("option", { name: /^None$/ }));

		expect(onChange).toHaveBeenCalledWith({
			mcpConfigId: null,
			mcpServerId: null,
			isDefault: false,
			isConfigured: false,
			transport: null,
		});
	});

	it("renders the 'You'll configure X after setup' helper for a default-only selection", async () => {
		availablePmToolsList.mockResolvedValue(THREE_DEFAULTS);
		render(
			<PMToolSelect
				organizationId={null}
				selectedMcpConfigId={null}
				selectedMcpServerId="srv_atlassian"
				onChange={vi.fn()}
				mcpSettingsUrl="/app/settings/mcp"
			/>,
			{ wrapper },
		);

		await waitFor(() => {
			expect(
				screen.getByText(/You'll configure Jira after setup/i),
			).toBeInTheDocument();
		});
	});

	it("does NOT render the helper for a configured selection", async () => {
		availablePmToolsList.mockResolvedValue([
			CONFIGURED_LINEAR,
			...THREE_DEFAULTS,
		]);
		render(
			<PMToolSelect
				organizationId={null}
				selectedMcpConfigId="cfg_linear"
				selectedMcpServerId="srv_linear"
				onChange={vi.fn()}
				mcpSettingsUrl="/app/settings/mcp"
			/>,
			{ wrapper },
		);

		await waitFor(() => {
			expect(availablePmToolsList).toHaveBeenCalled();
		});

		expect(screen.queryByText(/after setup/i)).not.toBeInTheDocument();
	});

	it("renders an error message when the query fails", async () => {
		availablePmToolsList.mockRejectedValue(new Error("network"));
		render(
			<PMToolSelect
				organizationId={null}
				selectedMcpConfigId={null}
				selectedMcpServerId={null}
				onChange={vi.fn()}
				mcpSettingsUrl="/app/settings/mcp"
			/>,
			{ wrapper },
		);

		await waitFor(() => {
			expect(
				screen.getByText("Failed to load PM tools."),
			).toBeInTheDocument();
		});
	});

	describe("GitLab REST entry", () => {
		const REST_OPTION = {
			key: "gitlab-official",
			displayName: "GitLab",
			iconKey: "gitlab",
			isDefault: true,
			isConfigured: true,
			mcpServerId: "srv_gitlab_official",
			mcpConfigId: null,
			configDisplayName: "GitLab (REST)",
			transport: "rest" as const,
		};

		it("renders a REST chip on the GitLab REST entry", async () => {
			availablePmToolsList.mockResolvedValue([REST_OPTION]);
			render(
				<PMToolSelect
					organizationId={null}
					selectedMcpConfigId={null}
					selectedMcpServerId={null}
					onChange={() => {}}
					mcpSettingsUrl="/settings/mcp"
				/>,
				{ wrapper },
			);

			await userEvent.click(
				await screen.findByRole("combobox", {
					name: /project management/i,
				}),
			);
			// Both chips should be visible in the open dropdown
			expect(await screen.findByText(/configured/i)).toBeVisible();
			expect(await screen.findByText(/^rest$/i)).toBeVisible();
		});

		it("does NOT render the Configure now helper when REST entry is selected", async () => {
			availablePmToolsList.mockResolvedValue([REST_OPTION]);
			render(
				<PMToolSelect
					organizationId={null}
					selectedMcpConfigId={null}
					selectedMcpServerId="srv_gitlab_official"
					onChange={() => {}}
					mcpSettingsUrl="/settings/mcp"
				/>,
				{ wrapper },
			);

			await waitFor(() => {
				expect(
					screen.queryByText(/you'll configure/i),
				).not.toBeInTheDocument();
				expect(
					screen.queryByRole("link", { name: /configure now/i }),
				).not.toBeInTheDocument();
			});
		});

		it("emits onChange payload with mcpConfigId=null and isConfigured=true when REST entry chosen", async () => {
			availablePmToolsList.mockResolvedValue([REST_OPTION]);
			const onChange = vi.fn();
			render(
				<PMToolSelect
					organizationId={null}
					selectedMcpConfigId={null}
					selectedMcpServerId={null}
					onChange={onChange}
					mcpSettingsUrl="/settings/mcp"
				/>,
				{ wrapper },
			);

			await userEvent.click(
				await screen.findByRole("combobox", {
					name: /project management/i,
				}),
			);
			await userEvent.click(
				await screen.findByRole("option", { name: /gitlab/i }),
			);

			expect(onChange).toHaveBeenCalledWith({
				mcpConfigId: null,
				mcpServerId: "srv_gitlab_official",
				isDefault: true,
				isConfigured: true,
				transport: "rest",
			});
		});

		it("displays the REST entry as selected when parent passes selectedMcpServerId with null mcpConfigId", async () => {
			availablePmToolsList.mockResolvedValue([REST_OPTION]);
			render(
				<PMToolSelect
					organizationId={null}
					selectedMcpConfigId={null}
					selectedMcpServerId="srv_gitlab_official"
					onChange={() => {}}
					mcpSettingsUrl="/settings/mcp"
				/>,
				{ wrapper },
			);

			// Trigger should show the GitLab label, not the "Select a tool…" placeholder
			const trigger = await screen.findByRole("combobox", {
				name: /project management/i,
			});
			await waitFor(() => {
				expect(trigger).toHaveTextContent(/gitlab/i);
				expect(trigger).not.toHaveTextContent(/select a tool/i);
			});
		});
	});

	describe("personal-scope GitLab CTA", () => {
		const PERSONAL_SCOPE_OPTION = {
			key: "gitlab-official",
			displayName: "GitLab",
			iconKey: "gitlab",
			isDefault: true,
			isConfigured: false,
			mcpServerId: "srv_gitlab",
			mcpConfigId: null,
			configDisplayName: null,
			transport: null,
			connectedInPersonalScope: true,
		};

		it("renders the 'Connected in personal' chip and inline CTA when option has connectedInPersonalScope=true", async () => {
			availablePmToolsList.mockResolvedValue([PERSONAL_SCOPE_OPTION]);
			const user = userEvent.setup();
			render(
				<PMToolSelect
					organizationId="org_1"
					organizationName="Acme Co"
					selectedMcpConfigId={null}
					selectedMcpServerId="srv_gitlab"
					onChange={vi.fn()}
					mcpSettingsUrl="/app/settings/integrations"
				/>,
				{ wrapper },
			);

			// CTA is rendered next to the trigger when the resolved selection
			// is the personal-scope GitLab stub. No dropdown interaction
			// needed to assert it.
			expect(
				await screen.findByRole("button", {
					name: /Connect for Acme Co/i,
				}),
			).toBeInTheDocument();

			// The chip is visible on the closed trigger because Radix renders
			// the selected option's children inside SelectValue.
			await user.click(
				await screen.findByRole("combobox", {
					name: /project management/i,
				}),
			);
			const chips = await screen.findAllByText(/Connected in personal/i);
			expect(chips.length).toBeGreaterThanOrEqual(1);
		});

		it("starts the GitLab OAuth flow with the active organizationId when the CTA is clicked", async () => {
			availablePmToolsList.mockResolvedValue([PERSONAL_SCOPE_OPTION]);
			gitlabStart.mockResolvedValue({
				authorizationUrl: "https://gitlab.com/oauth/authorize?...",
			});
			const openMock = vi
				.spyOn(window, "open")
				.mockImplementation(() => null as never);

			const user = userEvent.setup();
			render(
				<PMToolSelect
					organizationId="org_1"
					organizationName="Acme Co"
					selectedMcpConfigId={null}
					selectedMcpServerId="srv_gitlab"
					onChange={vi.fn()}
					mcpSettingsUrl="/app/settings/integrations"
				/>,
				{ wrapper },
			);

			const cta = await screen.findByRole("button", {
				name: /Connect for Acme Co/i,
			});
			await user.click(cta);

			await waitFor(() => {
				expect(gitlabStart).toHaveBeenCalledWith({
					redirectUri: expect.stringContaining(
						"/api/integrations/gitlab/oauth/callback",
					),
					returnUrl: expect.any(String),
					organizationId: "org_1",
				});
			});
			expect(openMock).toHaveBeenCalledWith(
				"https://gitlab.com/oauth/authorize?...",
				"gitlab-oauth",
				expect.stringContaining("width=600"),
			);

			openMock.mockRestore();
		});

		it("shows a toast.error when the OAuth start mutation fails", async () => {
			availablePmToolsList.mockResolvedValue([PERSONAL_SCOPE_OPTION]);
			gitlabStart.mockRejectedValueOnce(new Error("Network error"));

			const user = userEvent.setup();
			render(
				<PMToolSelect
					organizationId="org_1"
					organizationName="Acme Co"
					selectedMcpConfigId={null}
					selectedMcpServerId="srv_gitlab"
					onChange={vi.fn()}
					mcpSettingsUrl="/app/settings/integrations"
				/>,
				{ wrapper },
			);

			const cta = await screen.findByRole("button", {
				name: /Connect for Acme Co/i,
			});
			await user.click(cta);

			await waitFor(() => {
				expect(toast.error).toHaveBeenCalledWith("Network error");
			});
		});
	});
});

// Touch the imported orpcClient so the side-effect-only import isn't elided
// by tree-shaking in case future test additions want to vi.mocked() it.
void orpcClient;
