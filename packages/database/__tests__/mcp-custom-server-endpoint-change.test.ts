/**
 * Changing where a custom MCP server's OAuth flows go — its URL, discovery
 * document, endpoints or registration endpoint — wipes the tokens and the
 * binding of every config inheriting it, in the same transaction as the
 * server update, so nothing is refreshed against an authorization server the
 * server no longer names.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirstMock = vi.fn();
const serverUpdateMock = vi.fn();
const txServerUpdateMock = vi.fn();
const txConfigUpdateManyMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("../prisma/client", () => ({
	Prisma: { DbNull: "DbNull" },
	db: {
		mCPServer: {
			findFirst: (...args: unknown[]) => findFirstMock(...args),
			update: (...args: unknown[]) => serverUpdateMock(...args),
		},
		$transaction: (...args: unknown[]) => transactionMock(...args),
	},
}));

import { updateCustomMcpServer } from "../prisma/queries/mcp";

const existing = {
	id: "srv_custom",
	isSystemProvided: false,
	userId: "user_1",
	organizationId: null,
	defaultUrl: "https://mcp.example.com/mcp",
	oauthDiscoveryUrl: null,
	oauthAuthorizationEndpoint: null,
	oauthTokenEndpoint: "https://as.example.com/token",
	dcrRegistrationEndpoint: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	findFirstMock.mockResolvedValue(existing);
	serverUpdateMock.mockResolvedValue(existing);
	txServerUpdateMock.mockResolvedValue(existing);
	txConfigUpdateManyMock.mockResolvedValue({ count: 2 });
	transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) =>
		fn({
			mCPServer: { update: txServerUpdateMock },
			mCPConfig: { updateMany: txConfigUpdateManyMock },
		}),
	);
});

function wipe() {
	expect(txConfigUpdateManyMock).toHaveBeenCalledOnce();
	return txConfigUpdateManyMock.mock.calls[0]?.[0] as {
		where: Record<string, unknown>;
		data: Record<string, unknown>;
	};
}

describe("updateCustomMcpServer — OAuth endpoints", () => {
	it("wipes tokens and bindings of every config of the server when the token endpoint changes", async () => {
		await updateCustomMcpServer({
			id: "srv_custom",
			userId: "user_1",
			data: { oauthTokenEndpoint: "https://other.example.com/token" },
		});

		expect(serverUpdateMock).not.toHaveBeenCalled();
		expect(txServerUpdateMock).toHaveBeenCalledOnce();
		const { where, data } = wipe();
		expect(where.mcpServerId).toBe("srv_custom");
		expect(JSON.stringify(where)).not.toContain("baseUrl");
		expect(data).toMatchObject({
			encryptedAccessToken: null,
			accessTokenHash: null,
			encryptedRefreshToken: null,
			tokenExpiresAt: null,
			oauthBinding: "DbNull",
			oauthGrantGeneration: { increment: 1 },
		});
	});

	it("removes the client registration with them: a client for the old endpoints is never presented to the new ones", async () => {
		await updateCustomMcpServer({
			id: "srv_custom",
			userId: "user_1",
			data: { oauthTokenEndpoint: "https://other.example.com/token" },
		});

		expect(wipe().data).toMatchObject({
			oauthClientId: null,
			encryptedOauthClientSecret: null,
			dcrClientMetadata: "DbNull",
			dcrRegistrationEndpoint: null,
			dcrRegisteredAt: null,
		});
	});

	it("moves the generation of EVERY config inheriting the change, including ones holding no token or binding", async () => {
		await updateCustomMcpServer({
			id: "srv_custom",
			userId: "user_1",
			data: { defaultUrl: "https://moved.example.com/mcp" },
		});

		// No filter on what the config currently holds: a config with only a
		// client (an OAuth flow may be in flight on it) is fenced too.
		const where = JSON.stringify(wipe().where);
		for (const column of [
			"encryptedAccessToken",
			"encryptedRefreshToken",
			"oauthBinding",
			"oauthClientId",
		]) {
			expect(where).not.toContain(column);
		}
		expect(wipe().data.oauthGrantGeneration).toEqual({ increment: 1 });
	});

	it.each([
		["oauthDiscoveryUrl", "https://other.example.com/.well-known/x"],
		["oauthAuthorizationEndpoint", "https://other.example.com/authorize"],
		["dcrRegistrationEndpoint", "https://other.example.com/register"],
	])("does the same when %s changes", async (field, value) => {
		await updateCustomMcpServer({
			id: "srv_custom",
			userId: "user_1",
			data: { [field]: value },
		});

		expect(wipe().data).toMatchObject({ oauthBinding: "DbNull" });
	});

	it("on a URL change, wipes only the configs that inherit the server's URL", async () => {
		await updateCustomMcpServer({
			id: "srv_custom",
			userId: "user_1",
			data: { defaultUrl: "https://moved.example.com/mcp" },
		});

		const { where } = wipe();
		expect(JSON.stringify(where)).toContain(
			'{"baseUrl":"https://mcp.example.com/mcp"}',
		);
		expect(JSON.stringify(where)).toContain('{"baseUrl":null}');
	});

	it("leaves credentials alone for any other edit, or an unchanged value", async () => {
		await updateCustomMcpServer({
			id: "srv_custom",
			userId: "user_1",
			data: {
				name: "Renamed",
				oauthTokenEndpoint: "https://as.example.com/token",
			},
		});

		expect(serverUpdateMock).toHaveBeenCalledOnce();
		expect(transactionMock).not.toHaveBeenCalled();
		expect(txConfigUpdateManyMock).not.toHaveBeenCalled();
	});
});
