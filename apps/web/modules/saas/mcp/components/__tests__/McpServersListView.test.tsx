import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpServersListView } from "../McpServersListView";

/**
 * A GitLab config saved before GitLab configs were stored as OAUTH2 can still
 * name API_KEY or NONE. The list row reads its state from the person's GitLab
 * connection all the same, never from a stale transport `status`.
 */
function renderRow(
	config: Record<string, unknown>,
	oauthStatus?: unknown,
	onChat?: (config: unknown) => void,
) {
	return render(
		<McpServersListView
			configs={[config]}
			oauthStatuses={
				oauthStatus ? { [String(config.id)]: oauthStatus } : {}
			}
			loadingStates={{}}
			onEdit={vi.fn()}
			onDelete={vi.fn()}
			onToggle={vi.fn()}
			onTest={vi.fn()}
			onChat={onChat}
		/>,
	);
}

describe("McpServersListView — a GitLab config that names another auth type", () => {
	it.each(["API_KEY", "NONE"])(
		"shows a disconnected %s GitLab config as Not Connected despite a HEALTHY status",
		(authType) => {
			renderRow(
				{
					id: "cfg-gl",
					enabled: true,
					authType,
					status: "HEALTHY",
					mcpServer: {
						key: "gitlab",
						name: "GitLab",
						transport: "HTTP",
					},
				},
				{
					authenticated: false,
					needsReauth: false,
					tokenExpired: false,
				},
			);

			expect(screen.getByText("Not Connected")).toBeInTheDocument();
			expect(screen.queryByText("Connected")).not.toBeInTheDocument();
			expect(screen.getByText("OAuth2")).toBeInTheDocument();
			expect(screen.queryByText("API Key")).not.toBeInTheDocument();
		},
	);

	it("still shows another server's API-key config by its transport health (control)", () => {
		renderRow({
			id: "cfg-linear",
			enabled: true,
			authType: "API_KEY",
			status: "HEALTHY",
			mcpServer: { key: "linear", name: "Linear", transport: "HTTP" },
		});

		expect(screen.getByText("Connected")).toBeInTheDocument();
		expect(screen.getByText("API Key")).toBeInTheDocument();
	});
});

describe("McpServersListView — Try MCP follows the same connection state as the tile", () => {
	const gitlab = {
		id: "cfg-gl",
		enabled: true,
		authType: "OAUTH2",
		mcpServer: {
			key: "gitlab-official",
			name: "GitLab",
			transport: "HTTP",
		},
	};

	it("hides Try MCP for a disconnected GitLab config whose last health check was HEALTHY", () => {
		renderRow(
			{ ...gitlab, status: "HEALTHY" },
			{ authenticated: false, needsReauth: false, tokenExpired: false },
			vi.fn(),
		);

		expect(
			screen.queryByRole("button", { name: "Try MCP" }),
		).not.toBeInTheDocument();
	});

	it("offers Try MCP for a connected GitLab config whose last health check failed", () => {
		renderRow(
			{ ...gitlab, status: "UNHEALTHY" },
			{ authenticated: true, needsReauth: false, tokenExpired: false },
			vi.fn(),
		);

		expect(
			screen.getByRole("button", { name: "Try MCP" }),
		).toBeInTheDocument();
	});

	it("still gates another server's API-key config on its health (control)", () => {
		renderRow(
			{
				id: "cfg-linear",
				enabled: true,
				authType: "API_KEY",
				status: "HEALTHY",
				mcpServer: { key: "linear", name: "Linear", transport: "HTTP" },
			},
			undefined,
			vi.fn(),
		);

		expect(
			screen.getByRole("button", { name: "Try MCP" }),
		).toBeInTheDocument();
	});
});
