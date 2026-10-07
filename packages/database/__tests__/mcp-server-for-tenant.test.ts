/**
 * `getMcpServerForTenant` — the server a config's OAuth credentials may be
 * used with: a system server, or a custom server owned by exactly this tenant
 * under the exclusive tenant filter. Another person's or organization's
 * private server is never returned.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueMock = vi.fn();

vi.mock("../prisma/client", () => ({
	Prisma: { DbNull: "DbNull" },
	db: {
		mCPServer: {
			findUnique: (...args: unknown[]) => findUniqueMock(...args),
		},
	},
}));

import { getMcpServerForTenant } from "../prisma/queries/mcp";

const custom = (userId: string, organizationId: string | null) => ({
	id: "srv_custom",
	isSystemProvided: false,
	userId,
	organizationId,
});

beforeEach(() => {
	findUniqueMock.mockReset();
});

describe("getMcpServerForTenant", () => {
	it("returns a system server to anyone", async () => {
		findUniqueMock.mockResolvedValue({
			id: "srv_sys",
			isSystemProvided: true,
		});
		await expect(
			getMcpServerForTenant("srv_sys", {
				userId: null,
				organizationId: "org-1",
			}),
		).resolves.toMatchObject({ id: "srv_sys" });
	});

	it("returns a custom server to the tenant that owns it", async () => {
		findUniqueMock.mockResolvedValue(custom("user-1", "org-1"));
		await expect(
			getMcpServerForTenant("srv_custom", {
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toMatchObject({ id: "srv_custom" });

		findUniqueMock.mockResolvedValue(custom("user-1", null));
		await expect(
			getMcpServerForTenant("srv_custom", {
				userId: "user-1",
				organizationId: null,
			}),
		).resolves.toMatchObject({ id: "srv_custom" });
	});

	it.each([
		["another organization's", custom("user-1", "org-2")],
		["another user's (same organization)", custom("user-2", "org-1")],
		[
			"the same user's personal one, asked from an organization",
			custom("user-1", null),
		],
	])("refuses %s private server", async (_label, server) => {
		findUniqueMock.mockResolvedValue(server);
		await expect(
			getMcpServerForTenant("srv_custom", {
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toBeNull();
	});

	it("refuses an organization's server in personal context, and any custom server to a tenant with no user", async () => {
		findUniqueMock.mockResolvedValue(custom("user-1", "org-1"));
		await expect(
			getMcpServerForTenant("srv_custom", {
				userId: "user-1",
				organizationId: null,
			}),
		).resolves.toBeNull();
		await expect(
			getMcpServerForTenant("srv_custom", {
				userId: null,
				organizationId: "org-1",
			}),
		).resolves.toBeNull();
	});
});
