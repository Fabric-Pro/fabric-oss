/**
 * Unit tests for `getProjectPMServerKey`'s sentinel-aware resolution.
 *
 * `listAvailablePmTools` may emit `key:<server-key>` sentinel ids when
 * the matching `MCPServer` catalog row is missing (seed drift). This
 * resolver must recognise the sentinel shape and return the key without
 * hitting the DB — otherwise GitLab projects created against a
 * misconfigured environment would resolve to `null` and the PM
 * dispatch would silently skip the GitLab branch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUniqueMock } = vi.hoisted(() => ({
	findUniqueMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		mCPServer: { findUnique: findUniqueMock },
	},
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (s: string) => s,
}));

import { getProjectPMServerKey } from "../../src/gitlab/pm-adapter";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getProjectPMServerKey", () => {
	it("returns null when no id is provided", async () => {
		const result = await getProjectPMServerKey(null);
		expect(result).toBeNull();
		expect(findUniqueMock).not.toHaveBeenCalled();
	});

	it("resolves the key from the catalog row in the normal case", async () => {
		findUniqueMock.mockResolvedValue({ key: "gitlab-official" });
		const result = await getProjectPMServerKey("ckabc123");
		expect(result).toBe("gitlab-official");
		expect(findUniqueMock).toHaveBeenCalledWith({
			where: { id: "ckabc123" },
			select: { key: true },
		});
	});

	it("returns null when the catalog row is missing for a cuid-shaped id", async () => {
		findUniqueMock.mockResolvedValue(null);
		const result = await getProjectPMServerKey("ckmissing");
		expect(result).toBeNull();
	});

	// Regression: when the picker emits a key-sentinel id (seed drift),
	// the resolver must read the key directly without touching the DB.
	it("resolves the key from a key:-sentinel id without hitting the DB", async () => {
		const result = await getProjectPMServerKey("key:gitlab-official");
		expect(result).toBe("gitlab-official");
		expect(findUniqueMock).not.toHaveBeenCalled();
	});

	it("handles a key-sentinel id for any default key, not only gitlab", async () => {
		const result = await getProjectPMServerKey("key:atlassian");
		expect(result).toBe("atlassian");
		expect(findUniqueMock).not.toHaveBeenCalled();
	});
});
