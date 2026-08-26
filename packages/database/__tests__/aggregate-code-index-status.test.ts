/**
 * Unit tests for aggregateCodeIndexStatus — the canonical helper that collapses
 * a project's per-repo index rows into one status. Used by the codebase-state
 * signal and the launcher status chip, so its priority ordering (a READY repo
 * beats an INDEXING one) is load-bearing for "any repo READY makes it usable".
 */

import { describe, expect, it, vi } from "vitest";

// The queries module imports the Prisma client; the helper under test is pure,
// so an empty db mock is enough.
vi.mock("../prisma/client", () => ({ db: {} }));

import { aggregateCodeIndexStatus } from "../prisma/queries/project-code-index";

const row = (status: string) => ({ status: status as never });

describe("aggregateCodeIndexStatus", () => {
	it("returns null when there are no rows", () => {
		expect(aggregateCodeIndexStatus([])).toBeNull();
	});

	it("prefers READY over any other status", () => {
		expect(
			aggregateCodeIndexStatus([
				row("INDEXING"),
				row("READY"),
				row("FAILED"),
			]),
		).toBe("READY");
	});

	it("falls to STALE when no repo is READY", () => {
		expect(
			aggregateCodeIndexStatus([
				row("FAILED"),
				row("STALE"),
				row("PENDING"),
			]),
		).toBe("STALE");
	});

	it("reports INDEXING while a repo is building (none ready/stale)", () => {
		expect(
			aggregateCodeIndexStatus([row("PENDING"), row("INDEXING")]),
		).toBe("INDEXING");
	});

	it("reports FAILED only when it's the best available", () => {
		expect(aggregateCodeIndexStatus([row("FAILED")])).toBe("FAILED");
	});
});
