import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteManyMock = vi.hoisted(() => vi.fn());
const createMock = vi.hoisted(() => vi.fn());
vi.mock("../prisma/client", () => ({
	db: { mCPOAuthState: { create: createMock, deleteMany: deleteManyMock } },
}));

import { consumeOauthState, createOauthState } from "../prisma/queries/mcp";

const state = {
	id: "example-state-row",
	state: "example-state",
	configId: "example-config",
	userId: "example-user",
	organizationId: "example-org",
};

beforeEach(() => {
	deleteManyMock.mockReset();
	createMock.mockReset();
});

describe("consumeOauthState", () => {
	it("creates a UUID state that the Google callback routes as MCP", async () => {
		const token = await createOauthState({
			mcpServerId: "example-server",
			configId: "example-config",
			userId: "example-user",
		});
		expect(token).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		);
		expect(createMock).toHaveBeenCalledWith({
			data: expect.objectContaining({ state: token }),
		});
	});

	it("conditionally deletes the exact live state in one write", async () => {
		deleteManyMock.mockResolvedValue({ count: 1 });
		expect(await consumeOauthState(state)).toBe(true);
		expect(deleteManyMock).toHaveBeenCalledTimes(1);
		const where = deleteManyMock.mock.calls[0]?.[0]?.where;
		expect(where).toMatchObject(state);
		expect(where.expiresAt.gt).toBeInstanceOf(Date);
		expect(where.expiresAt.gt.getTime()).toBeGreaterThanOrEqual(
			Date.now() - 1000,
		);
	});

	it("returns false when the conditional delete matches no row", async () => {
		deleteManyMock.mockResolvedValue({ count: 0 });
		expect(await consumeOauthState(state)).toBe(false);
	});

	it("does not treat a failed state write as success", async () => {
		deleteManyMock.mockRejectedValue(new Error("unavailable"));
		await expect(consumeOauthState(state)).rejects.toThrow("unavailable");
	});
});
