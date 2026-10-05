import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { McpConfigTile } from "../McpConfigTile";

const gitlabConfig = {
	id: "cfg-official",
	enabled: true,
	authType: "OAUTH2",
	organizationId: "example-org",
	displayName: null,
	mcpServer: {
		key: "gitlab-official",
		name: "GitLab (Official)",
		transport: "HTTP",
	},
};

function renderTile(
	oauthStatus: Parameters<typeof McpConfigTile>[0]["oauthStatus"],
	handlers: { onRevoke?: () => void; onConnect?: () => void } = {},
) {
	return render(
		<McpConfigTile
			config={gitlabConfig}
			oauthStatus={oauthStatus}
			onEdit={vi.fn()}
			onDelete={vi.fn()}
			onToggle={vi.fn()}
			onTest={vi.fn()}
			onRevoke={handlers.onRevoke}
			onConnect={handlers.onConnect}
		/>,
	);
}

describe("McpConfigTile OAuth status", () => {
	it("shows a connection that needs reconnecting as such, and still offers Revoke access", () => {
		// A dead grant is still a connection the person may want gone: hiding
		// Revoke here left a needs-reconnect GitLab with no way to disconnect
		// it from this tile.
		const onConnect = vi.fn();
		const onRevoke = vi.fn();
		renderTile(
			{
				authenticated: false,
				needsReauth: true,
				tokenExpired: false,
				refreshTokenExpired: false,
				hasRefreshToken: true,
			},
			{ onConnect, onRevoke },
		);

		expect(screen.getByText("Reconnect needed")).toBeInTheDocument();
		expect(screen.queryByText("Not Connected")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
		expect(onRevoke).toHaveBeenCalledWith(gitlabConfig);
	});

	it("does not offer Revoke access when there is nothing to revoke", () => {
		renderTile(
			{
				authenticated: false,
				needsReauth: false,
				tokenExpired: false,
				refreshTokenExpired: false,
				hasRefreshToken: false,
			},
			{ onRevoke: vi.fn() },
		);
		expect(
			screen.queryByRole("button", { name: "Revoke access" }),
		).not.toBeInTheDocument();
	});

	it("shows Not Connected when there is no connection", () => {
		renderTile({
			authenticated: false,
			needsReauth: false,
			tokenExpired: false,
			refreshTokenExpired: false,
			hasRefreshToken: false,
		});
		expect(screen.getByText("Not Connected")).toBeInTheDocument();
	});

	it("offers Revoke access on a connected server and hands it the config", () => {
		const onRevoke = vi.fn();
		renderTile(
			{
				authenticated: true,
				tokenExpired: false,
				refreshTokenExpired: false,
				hasRefreshToken: true,
			},
			{ onRevoke },
		);

		expect(screen.getByText("Connected")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
		expect(onRevoke).toHaveBeenCalledWith(gitlabConfig);
	});

	it("colours a reconnect-needed badge as a warning even when the config's stored transport status is HEALTHY", () => {
		render(
			<McpConfigTile
				config={{ ...gitlabConfig, status: "HEALTHY" }}
				oauthStatus={{
					authenticated: false,
					needsReauth: true,
					tokenExpired: false,
					refreshTokenExpired: false,
					hasRefreshToken: true,
				}}
				onEdit={vi.fn()}
				onDelete={vi.fn()}
				onToggle={vi.fn()}
				onTest={vi.fn()}
			/>,
		);

		const badge = screen.getByText("Reconnect needed");
		expect(badge.className).toContain("text-highlight");
		expect(badge.className).not.toContain("text-success");
	});
});

// A GitLab config saved before GitLab configs were stored as OAUTH2 can still
// name API_KEY or NONE. Its state is the person's GitLab connection all the
// same: a stale transport `status: "HEALTHY"` (left from before a disconnect)
// must not paint it connected, and its connect and reconnect actions stay.
describe("McpConfigTile — a GitLab config that names another auth type", () => {
	for (const authType of ["API_KEY", "NONE"]) {
		it(`shows a disconnected ${authType} GitLab config as Not Connected despite a HEALTHY status, and offers Connect`, () => {
			const config = {
				...gitlabConfig,
				authType,
				status: "HEALTHY",
				mcpServer: { ...gitlabConfig.mcpServer, key: "gitlab" },
			};
			const onConnect = vi.fn();
			render(
				<McpConfigTile
					config={config}
					oauthStatus={{
						authenticated: false,
						needsReauth: false,
						tokenExpired: false,
						refreshTokenExpired: false,
						hasRefreshToken: false,
					}}
					onEdit={vi.fn()}
					onDelete={vi.fn()}
					onToggle={vi.fn()}
					onTest={vi.fn()}
					onConnect={onConnect}
				/>,
			);

			expect(screen.getByText("Not Connected")).toBeInTheDocument();
			expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
			fireEvent.click(
				screen.getByRole("button", { name: "Connect with OAuth" }),
			);
			expect(onConnect).toHaveBeenCalledWith(config);
		});

		it(`shows a ${authType} GitLab config needing a reconnect as such and keeps Revoke access`, () => {
			const config = {
				...gitlabConfig,
				authType,
				status: "HEALTHY",
			};
			const onRevoke = vi.fn();
			render(
				<McpConfigTile
					config={config}
					oauthStatus={{
						authenticated: false,
						needsReauth: true,
						tokenExpired: false,
						refreshTokenExpired: false,
						hasRefreshToken: true,
					}}
					onEdit={vi.fn()}
					onDelete={vi.fn()}
					onToggle={vi.fn()}
					onTest={vi.fn()}
					onRevoke={onRevoke}
				/>,
			);

			expect(screen.getByText("Reconnect needed")).toBeInTheDocument();
			fireEvent.click(
				screen.getByRole("button", { name: "Revoke access" }),
			);
			expect(onRevoke).toHaveBeenCalledWith(config);
		});
	}

	it("still shows another server's API-key config by its transport health (control)", () => {
		render(
			<McpConfigTile
				config={{
					...gitlabConfig,
					authType: "API_KEY",
					status: "HEALTHY",
					mcpServer: {
						key: "linear",
						name: "Linear",
						transport: "HTTP",
					},
				}}
				onEdit={vi.fn()}
				onDelete={vi.fn()}
				onToggle={vi.fn()}
				onTest={vi.fn()}
			/>,
		);
		expect(screen.getByText("Healthy")).toBeInTheDocument();
	});
});
