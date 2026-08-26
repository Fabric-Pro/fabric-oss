/**
 * Focused zod-schema tests for the newsletter send-now input (AC-6):
 * `detailLevel` (the per-send override) must never reject an invalid value —
 * omitted leaves it undefined (effective level falls back to settings), a
 * valid tier passes through, and an invalid tier COERCES to STANDARD via
 * `.catch()` (never a validation error). `@repo/database` / `@repo/temporal`
 * and the orpc procedure chain are mocked so the module can be imported
 * without a real DB/Prisma client or Temporal connection — mirrors the
 * harness in `newsletter.test.ts`.
 *
 * Run with: pnpm --filter @repo/api test sends-send-now
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: { project: { findFirst: vi.fn() } },
	createOrGetNewsletterSend: vi.fn(),
	finalizeNewsletterSend: vi.fn(),
	findRecentNonFailedSend: vi.fn(),
	getNewsletterSettings: vi.fn(),
	manualDedupeKey: vi.fn(),
	resolveWindow: vi.fn(),
	setNewsletterSendWorkflowId: vi.fn(),
	NEWSLETTER_DETAIL_LEVELS: ["BRIEF", "STANDARD", "DETAILED"],
	DEFAULT_NEWSLETTER_DETAIL_LEVEL: "STANDARD",
	coerceDetailLevel: (v: unknown) =>
		v === "BRIEF" || v === "DETAILED" ? v : "STANDARD",
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(),
	isTemporalAvailable: vi.fn(),
}));

vi.mock("../../../../orpc/procedures", () => {
	// biome-ignore lint/suspicious/noExplicitAny: minimal chainable test double
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId ?? null,
		),
	};
});

import { sendNowInput } from "../sends-send-now";

describe("sendNowInput.detailLevel (AC-6)", () => {
	it("omitted → undefined (use the persisted settings value)", () => {
		const r = sendNowInput.parse({ projectId: "p" });
		expect(r.detailLevel).toBeUndefined();
	});
	it("valid value passes through", () => {
		const r = sendNowInput.parse({ projectId: "p", detailLevel: "BRIEF" });
		expect(r.detailLevel).toBe("BRIEF");
	});
	it("invalid value coerces to STANDARD, does NOT throw", () => {
		const r = sendNowInput.parse({
			projectId: "p",
			detailLevel: "NONSENSE",
		});
		expect(r.detailLevel).toBe("STANDARD");
	});
});
