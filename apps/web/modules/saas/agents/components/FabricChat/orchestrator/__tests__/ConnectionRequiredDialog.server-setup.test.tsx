/**
 * A GitLab MCP server reads as connected from the person's GitLab connection
 * alone, whether or not they have a config row for it, and whether or not
 * that row is turned on; the connect info reports both separately
 * (`configProvisioned`, `configEnabled`). The dialog treats the server as
 * ready only when all three hold. Otherwise it says what is missing and
 * points to the MCP Servers page — it never adds a config for a connected
 * server, and it never asks the server about a no-organization tenant.
 *
 * The connect paths that do write (adding the server before its sign-in,
 * saving an API key) write in the organization `getConnectInfo` resolved and
 * authorized, never the chat's raw value, and write nothing when that read
 * was refused.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConnectInfoMock, upsertMock, oauthStartMock } = vi.hoisted(() => ({
	getConnectInfoMock: vi.fn(),
	upsertMock: vi.fn(),
	oauthStartMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		mcp: {
			connect: {
				getConnectInfo: (input: unknown) => getConnectInfoMock(input),
			},
			configs: { upsert: (input: unknown) => upsertMock(input) },
			oauth: { start: (input: unknown) => oauthStartMock(input) },
		},
		integrations: { oauth: { isConfigured: vi.fn() } },
	},
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: (path: string) => `/app/example-org/${path}`,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ConnectionRequiredDialog } from "../ConnectionRequiredDialog";

const GITLAB = {
	serverId: "srv-gitlab",
	serverName: "GitLab",
	reason: "Needed to list issues",
	authType: "OAUTH2" as const,
	isSystemProvided: true,
};

function connectedInfo(row: { provisioned: boolean; enabled: boolean }) {
	return {
		serverId: "srv-gitlab",
		serverName: "GitLab",
		authType: "OAUTH2",
		isConnected: true,
		needsReauth: false,
		configProvisioned: row.provisioned,
		configEnabled: row.enabled,
		configId: row.provisioned ? "cfg-gitlab" : undefined,
		defaultUrl: "https://app.example.com/api/mcp/gitlab",
		organizationId: "example-org",
	};
}

/** A server the person has not connected, as resolved in `organizationId`. */
function disconnectedInfo(
	organizationId: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		serverId: "srv-gitlab",
		serverName: "GitLab",
		authType: "OAUTH2",
		isConnected: false,
		needsReauth: false,
		configProvisioned: false,
		configEnabled: false,
		configId: undefined,
		defaultUrl: "https://app.example.com/api/mcp/gitlab",
		organizationId,
		...overrides,
	};
}

const API_KEY_SERVER = {
	serverId: "srv-keyed",
	serverName: "Keyed Server",
	reason: "Needed to read records",
	authType: "API_KEY" as const,
	isSystemProvided: true,
};

const onConnectionComplete = vi.fn();

beforeEach(() => {
	getConnectInfoMock.mockReset();
	upsertMock.mockReset();
	oauthStartMock.mockReset();
	onConnectionComplete.mockReset();
	vi.stubGlobal("open", vi.fn());
});

function renderDialog(
	organizationId: string | null = "example-org",
	connections: Array<typeof GITLAB | typeof API_KEY_SERVER> = [GITLAB],
) {
	render(
		<ConnectionRequiredDialog
			open
			onOpenChange={() => {}}
			connections={connections}
			organizationId={organizationId}
			onConnectionComplete={onConnectionComplete}
		/>,
	);
}

async function clickConnect() {
	await userEvent.click(
		screen.getByRole("button", { name: /Connect with OAuth/ }),
	);
}

/** Nothing was written, and no OAuth was started, from the dialog. */
function expectNoWrite() {
	expect(upsertMock).not.toHaveBeenCalled();
	expect(oauthStartMock).not.toHaveBeenCalled();
	expect(window.open).not.toHaveBeenCalled();
}

describe("ConnectionRequiredDialog — a connected GitLab server", () => {
	it("says the server has not been added, links to MCP Servers, and writes nothing", async () => {
		getConnectInfoMock.mockResolvedValue(
			connectedInfo({ provisioned: false, enabled: false }),
		);
		renderDialog();

		await clickConnect();

		expect(
			await screen.findByText(/has not been added as an MCP server/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: /Open MCP Servers/ }),
		).toHaveAttribute("href", "/app/example-org/connections?tab=mcp");
		expect(screen.queryByText("Connected")).toBeNull();
		expect(onConnectionComplete).not.toHaveBeenCalled();
		expectNoWrite();
	});

	it("reports a turned-off server as not ready, with the link", async () => {
		getConnectInfoMock.mockResolvedValue(
			connectedInfo({ provisioned: true, enabled: false }),
		);
		renderDialog();

		await clickConnect();

		expect(await screen.findByText(/is turned off/)).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: /Open MCP Servers/ }),
		).toHaveAttribute("href", "/app/example-org/connections?tab=mcp");
		expect(screen.queryByText("Connected")).toBeNull();
		expect(onConnectionComplete).not.toHaveBeenCalled();
		expectNoWrite();
	});

	it("is ready once the server is added and on", async () => {
		getConnectInfoMock.mockResolvedValue(
			connectedInfo({ provisioned: true, enabled: true }),
		);
		renderDialog();

		await clickConnect();

		expect(await screen.findByText("Connected")).toBeInTheDocument();
		expectNoWrite();
	});

	it("does not complete for a dialog that is gone before the completion delay", async () => {
		getConnectInfoMock.mockResolvedValue(
			connectedInfo({ provisioned: true, enabled: true }),
		);
		const { unmount } = render(
			<ConnectionRequiredDialog
				open
				onOpenChange={() => {}}
				connections={[GITLAB]}
				organizationId="example-org"
				onConnectionComplete={onConnectionComplete}
			/>,
		);

		await clickConnect();
		expect(await screen.findByText("Connected")).toBeInTheDocument();
		unmount();

		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(onConnectionComplete).not.toHaveBeenCalled();
	});

	it("asks in the chat's organization", async () => {
		getConnectInfoMock.mockResolvedValue(
			connectedInfo({ provisioned: true, enabled: true }),
		);
		renderDialog();

		await clickConnect();

		await waitFor(() =>
			expect(getConnectInfoMock).toHaveBeenCalledWith({
				serverId: "srv-gitlab",
				organizationId: "example-org",
			}),
		);
	});

	it("with no organization, never asks about the no-organization tenant", async () => {
		// The server refuses a request that resolves no organization.
		getConnectInfoMock.mockRejectedValue(
			new Error("This operation requires an organization context"),
		);
		renderDialog(null);

		await clickConnect();

		await waitFor(() => expect(getConnectInfoMock).toHaveBeenCalled());
		for (const [input] of getConnectInfoMock.mock.calls) {
			// Omitted, so the server resolves the session's organization;
			// never an explicit null, which would name no organization.
			expect(input).toEqual({
				serverId: "srv-gitlab",
				organizationId: undefined,
			});
		}
		// It stays not connected, with the connect path to retry.
		expect(
			await screen.findByText(
				"This operation requires an organization context",
			),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Retry/ })).toBeEnabled();
		expect(screen.queryByText("Connected")).toBeNull();
		expectNoWrite();
	});
});

describe("ConnectionRequiredDialog — writes use the organization the read authorized", () => {
	it("adds the server, before its sign-in, in the session's organization when the chat names none", async () => {
		// No chat organization: the server resolved and authorized the
		// session's ("org-a") and says so.
		getConnectInfoMock.mockResolvedValue(disconnectedInfo("org-a"));
		upsertMock.mockResolvedValue({ id: "cfg-new" });
		oauthStartMock.mockResolvedValue({
			authorizationUrl: "https://gitlab.example.com/oauth/authorize",
			state: "s",
		});
		vi.stubGlobal(
			"open",
			vi.fn(() => ({ closed: false, close: vi.fn() })),
		);
		renderDialog(null);

		await clickConnect();

		await waitFor(() => expect(oauthStartMock).toHaveBeenCalled());
		expect(upsertMock).toHaveBeenCalledTimes(1);
		expect(upsertMock.mock.calls[0][0]).toMatchObject({
			mcpServerId: "srv-gitlab",
			organizationId: "org-a",
		});
		expect(oauthStartMock.mock.calls[0][0]).toMatchObject({
			configId: "cfg-new",
		});
	});

	it("saves an API key in the session's organization when the chat names none", async () => {
		getConnectInfoMock.mockResolvedValue(
			disconnectedInfo("org-a", {
				serverId: "srv-keyed",
				authType: "API_KEY",
			}),
		);
		upsertMock.mockResolvedValue({ id: "cfg-keyed" });
		renderDialog(null, [API_KEY_SERVER]);

		const input = screen.getByPlaceholderText("Enter API key...");
		await userEvent.type(input, "example-key");
		const buttons = within(
			input.parentElement?.parentElement as HTMLElement,
		).getAllByRole("button");
		await userEvent.click(buttons[buttons.length - 1]);

		await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
		expect(upsertMock.mock.calls[0][0]).toMatchObject({
			mcpServerId: "srv-keyed",
			authType: "API_KEY",
			organizationId: "org-a",
		});
	});

	it("writes nothing when the read is refused", async () => {
		getConnectInfoMock.mockRejectedValue(
			new Error("This operation requires an organization context"),
		);
		renderDialog(null, [GITLAB, API_KEY_SERVER]);

		await clickConnect();
		const input = screen.getByPlaceholderText("Enter API key...");
		await userEvent.type(input, "example-key");
		const buttons = within(
			input.parentElement?.parentElement as HTMLElement,
		).getAllByRole("button");
		await userEvent.click(buttons[buttons.length - 1]);

		await waitFor(() =>
			expect(getConnectInfoMock).toHaveBeenCalledTimes(2),
		);
		expect(
			await screen.findAllByText(
				"This operation requires an organization context",
			),
		).toHaveLength(2);
		expectNoWrite();
	});
});

describe("ConnectionRequiredDialog — a completed sign-in", () => {
	it("is not ready while the server's row is turned off", async () => {
		// Disconnected, with the row a tile Delete kept (turned off).
		getConnectInfoMock.mockResolvedValueOnce(
			disconnectedInfo("org-a", {
				configProvisioned: true,
				configId: "cfg-gitlab",
			}),
		);
		oauthStartMock.mockResolvedValue({
			authorizationUrl: "https://gitlab.example.com/oauth/authorize",
			state: "s",
		});
		vi.stubGlobal(
			"open",
			vi.fn(() => ({ closed: false, close: vi.fn() })),
		);
		renderDialog(null);

		await clickConnect();
		await waitFor(() => expect(oauthStartMock).toHaveBeenCalled());

		// The sign-in completed; the row is still off.
		getConnectInfoMock.mockResolvedValue({
			...connectedInfo({ provisioned: true, enabled: false }),
			organizationId: "org-a",
		});
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: window.location.origin,
					data: { type: "oauth_success" },
				}),
			);
		});

		expect(await screen.findByText(/is turned off/)).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: /Open MCP Servers/ }),
		).toHaveAttribute("href", "/app/example-org/connections?tab=mcp");
		expect(screen.queryByText("Connected")).toBeNull();
		expect(onConnectionComplete).not.toHaveBeenCalled();
		// Re-read in the organization the first read authorized.
		expect(getConnectInfoMock).toHaveBeenLastCalledWith({
			serverId: "srv-gitlab",
			organizationId: "org-a",
		});
		expect(upsertMock).not.toHaveBeenCalled();
	});
});
