/**
 * Coverage for `isProjectReadOnly` — the fresh, uncached lookup
 * every outbound write-gate consults. The behaviours that matter and are easy
 * to regress silently: it reflects the stored flag, treats a missing row as
 * NOT read-only, and FAILS OPEN (returns false) on a lookup error so a
 * transient DB fault can't turn the safety toggle into a write outage.
 *
 * Run with:
 *   pnpm --filter @repo/database test prisma/queries/projects/__tests__/read-only-mode.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();

vi.mock("../../../client", () => ({
	db: {
		$queryRaw: (...args: unknown[]) => queryRaw(...args),
	},
}));

const { isProjectReadOnly } = await import("../read-only-mode");

describe("isProjectReadOnly", () => {
	beforeEach(() => {
		queryRaw.mockReset();
	});

	it("returns true when the stored flag is true", async () => {
		queryRaw.mockResolvedValue([{ readOnlyMode: true }]);
		await expect(isProjectReadOnly("p1")).resolves.toBe(true);
	});

	it("returns false when the stored flag is false", async () => {
		queryRaw.mockResolvedValue([{ readOnlyMode: false }]);
		await expect(isProjectReadOnly("p1")).resolves.toBe(false);
	});

	it("returns false when no row matches (unknown project)", async () => {
		queryRaw.mockResolvedValue([]);
		await expect(isProjectReadOnly("missing")).resolves.toBe(false);
	});

	it("FAILS OPEN (false) when the lookup throws — a DB fault must not block writes", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		queryRaw.mockRejectedValue(new Error("connection terminated"));
		await expect(isProjectReadOnly("p1")).resolves.toBe(false);
		// The fail-open path must be loud, not silent.
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
