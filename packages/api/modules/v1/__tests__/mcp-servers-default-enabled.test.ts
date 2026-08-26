/**
 * Integration tests for `GET /mcp/servers` — `defaultEnabled` payload field.
 *
 * The response shape changed additively when default-enabled MCP routing
 * landed: every system row now carries `defaultEnabled` (read from
 * `MCPServer.defaultEnabled`) and every custom row carries the constant
 * `defaultEnabled: false` (custom servers cannot be promoted to default
 * in v1).
 *
 * This test mocks the Prisma loaders (`listSystemMcpServers`,
 * `listCustomMcpServersForTenant`) and exercises the actual Hono handler
 * registered by `registerMcpRoutes`. No live DB. The auth + scope
 * middleware is bypassed via the `requireScope` mock so the test stays
 * focused on the payload contract.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListCustomMcpServersForTenant = vi.fn();
const mockListSystemMcpServers = vi.fn();
const mockListMcpConfigsForTenant = vi.fn();
const mockGetMcpConfigById = vi.fn();
const mockDeleteMcpConfig = vi.fn();
const mockGetValidAccessToken = vi.fn();

vi.mock("@repo/database", () => ({
	listCustomMcpServersForTenant: (...args: unknown[]) =>
		mockListCustomMcpServersForTenant(...args),
	listSystemMcpServers: (...args: unknown[]) =>
		mockListSystemMcpServers(...args),
	listMcpConfigsForTenant: (...args: unknown[]) =>
		mockListMcpConfigsForTenant(...args),
	getMcpConfigById: (...args: unknown[]) => mockGetMcpConfigById(...args),
	deleteMcpConfig: (...args: unknown[]) => mockDeleteMcpConfig(...args),
	getValidAccessToken: (...args: unknown[]) =>
		mockGetValidAccessToken(...args),
	// `resolveV1Context` calls `db.organization.findFirst` / `db.member.findFirst`
	// when the request supplies `?org=<slug>`. We only test personal context
	// here, so a no-op `db` is sufficient.
	db: {
		organization: { findFirst: vi.fn() },
		member: { findFirst: vi.fn() },
	},
}));

vi.mock("@repo/logs", () => ({
	logDataEvent: vi.fn().mockResolvedValue(undefined),
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => `decrypted:${value}`,
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

import { registerMcpRoutes } from "../mcp";

function buildSystemServer(overrides: Record<string, unknown> = {}) {
	return {
		id: "srv-system-1",
		key: "linear",
		name: "Linear",
		description: "Linear MCP",
		transport: "HTTP",
		defaultUrl: "https://mcp.linear.app/mcp",
		docsUrl: null,
		author: null,
		category: null,
		tags: [],
		defaultEnabled: false,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}

function buildCustomServer(overrides: Record<string, unknown> = {}) {
	return {
		id: "srv-custom-1",
		key: "custom-server",
		name: "My Custom Server",
		description: "A custom server",
		transport: "HTTP",
		defaultUrl: "https://custom.example.com/mcp",
		docsUrl: null,
		author: null,
		category: null,
		tags: [],
		createdAt: new Date("2026-02-01T00:00:00.000Z"),
		...overrides,
	};
}

function buildApp() {
	const app = new Hono<{
		Variables: {
			externalApiContext: {
				keyType: "personal";
				keyId: string;
				keyPrefix: string;
				userId: string;
				organizationId: undefined;
				scopes: string[];
			};
		};
	}>();

	app.use("*", async (c, next) => {
		c.set("externalApiContext", {
			keyType: "personal",
			keyId: "key-1",
			keyPrefix: "fab_test",
			userId: "user-1",
			organizationId: undefined,
			scopes: ["mcp:read"],
		});
		await next();
	});

	registerMcpRoutes(app as never);
	return app;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("GET /mcp/servers — defaultEnabled payload field", () => {
	it("includes defaultEnabled: true for the system Excalidraw row", async () => {
		// Mirrors the post-migration state: Excalidraw is flipped to
		// `defaultEnabled: true` by step 2 of the backfill SQL.
		mockListSystemMcpServers.mockResolvedValue([
			buildSystemServer({
				id: "srv-excalidraw",
				key: "excalidraw",
				name: "Excalidraw",
				defaultEnabled: true,
			}),
		]);
		mockListCustomMcpServersForTenant.mockResolvedValue([]);

		const res = await buildApp().request("/mcp/servers", {
			method: "GET",
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		const servers = body.data as Array<Record<string, unknown>>;
		expect(servers).toHaveLength(1);
		expect(servers[0]).toMatchObject({
			key: "excalidraw",
			isSystemProvided: true,
			defaultEnabled: true,
		});
	});

	it("includes defaultEnabled: false for every other system row", async () => {
		mockListSystemMcpServers.mockResolvedValue([
			buildSystemServer({
				id: "srv-excalidraw",
				key: "excalidraw",
				name: "Excalidraw",
				defaultEnabled: true,
			}),
			buildSystemServer({
				id: "srv-linear",
				key: "linear",
				name: "Linear",
				defaultEnabled: false,
			}),
			buildSystemServer({
				id: "srv-github",
				key: "github",
				name: "GitHub",
				defaultEnabled: false,
			}),
		]);
		mockListCustomMcpServersForTenant.mockResolvedValue([]);

		const res = await buildApp().request("/mcp/servers", {
			method: "GET",
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		const servers = body.data as Array<Record<string, unknown>>;
		const byKey = Object.fromEntries(servers.map((s) => [s.key, s]));
		expect(byKey.excalidraw).toMatchObject({ defaultEnabled: true });
		expect(byKey.linear).toMatchObject({ defaultEnabled: false });
		expect(byKey.github).toMatchObject({ defaultEnabled: false });
	});

	it("forces defaultEnabled: false for every custom (tenant-installed) row", async () => {
		// Custom servers CANNOT be default-enabled in v1. The handler
		// stamps the constant regardless of any field the DB row happens
		// to carry, so a misconfigured row never accidentally
		// shows up as Always-on in the registry UI.
		mockListSystemMcpServers.mockResolvedValue([]);
		mockListCustomMcpServersForTenant.mockResolvedValue([
			buildCustomServer({ id: "srv-custom-1", key: "custom-a" }),
			buildCustomServer({ id: "srv-custom-2", key: "custom-b" }),
		]);

		const res = await buildApp().request("/mcp/servers", {
			method: "GET",
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		const servers = body.data as Array<Record<string, unknown>>;
		expect(servers).toHaveLength(2);
		for (const server of servers) {
			expect(server.isSystemProvided).toBe(false);
			expect(server.defaultEnabled).toBe(false);
		}
	});

	it("mixed system + custom servers — every row carries the field with the right value", async () => {
		mockListSystemMcpServers.mockResolvedValue([
			buildSystemServer({
				id: "srv-excalidraw",
				key: "excalidraw",
				name: "Excalidraw",
				defaultEnabled: true,
			}),
			buildSystemServer({
				id: "srv-github",
				key: "github",
				name: "GitHub",
				defaultEnabled: false,
			}),
		]);
		mockListCustomMcpServersForTenant.mockResolvedValue([
			buildCustomServer({ id: "srv-custom", key: "my-thing" }),
		]);

		const res = await buildApp().request("/mcp/servers", {
			method: "GET",
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		const servers = body.data as Array<Record<string, unknown>>;
		expect(servers).toHaveLength(3);

		// Every row carries the field — no `undefined`s slipping through.
		for (const server of servers) {
			expect(typeof server.defaultEnabled).toBe("boolean");
		}
	});
});
