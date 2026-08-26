/**
 * Coverage for Fizzy 1869 Task 9: scheduled dispatch reclaims a stale review
 * send (abandoned PENDING_APPROVAL draft → EXPIRED; dead APPROVED send whose
 * workflow never finalized → FAILED) before creating the next send, so the
 * project's active-send slot can never wedge the newsletter cadence forever.
 *
 * This is a static source scan (mirroring `approval-wiring.test.ts` /
 * `send-approved-wiring.test.ts`): it asserts `dispatchNewsletterSendActivity`
 * calls `reclaimStaleReviewSends(` and that the call happens BEFORE
 * `createOrGetNewsletterSend(` in source order — i.e. the reclaim always runs
 * ahead of send creation on every scheduled dispatch.
 *
 * DB-level coverage of `reclaimStaleReviewSends` itself (TTL boundaries, the
 * reviewedAt-not-createdAt regression) lives in
 * `packages/database/prisma/queries/projects/__tests__/reclaim-stale-review-sends.test.ts`,
 * which self-skips without a reachable DATABASE_URL — that harness isn't
 * exported for cross-package reuse from `@repo/temporal`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DISPATCH = readFileSync(
	join(__dirname, "../dispatch-newsletter-send.ts"),
	"utf8",
);

describe("stale review-send reclaim wiring (Fizzy 1869, static scan)", () => {
	it("imports reclaimStaleReviewSends from @repo/database", () => {
		expect(DISPATCH).toContain("reclaimStaleReviewSends");
		expect(DISPATCH).toMatch(/from\s+"@repo\/database"/);
	});

	it("calls reclaimStaleReviewSends(p.projectId) before createOrGetNewsletterSend(", () => {
		const reclaimIdx = DISPATCH.indexOf(
			"reclaimStaleReviewSends(p.projectId)",
		);
		const createIdx = DISPATCH.indexOf("createOrGetNewsletterSend({");
		expect(reclaimIdx).toBeGreaterThan(-1);
		expect(createIdx).toBeGreaterThan(-1);
		expect(reclaimIdx).toBeLessThan(createIdx);
	});

	it("runs the reclaim on every dispatch — after the actor-validity guard, not inside a conditional it could skip", () => {
		const actorGuardIdx = DISPATCH.indexOf(
			"isScheduledNewsletterActorValid(",
		);
		const reclaimIdx = DISPATCH.indexOf(
			"reclaimStaleReviewSends(p.projectId)",
		);
		expect(actorGuardIdx).toBeGreaterThan(-1);
		expect(reclaimIdx).toBeGreaterThan(actorGuardIdx);

		// The reclaim call must sit at the function's top level (one level of
		// indentation, i.e. directly in dispatchNewsletterSendActivity), not
		// nested inside the actor-guard's `if` block above it.
		const lineStart = DISPATCH.lastIndexOf("\n", reclaimIdx) + 1;
		const line = DISPATCH.slice(lineStart, reclaimIdx);
		expect(line).toBe("\tconst reclaimed = await ");
	});

	it("logs a warning when a stale send was reclaimed, without gating the reclaim call itself", () => {
		const reclaimIdx = DISPATCH.indexOf(
			"reclaimStaleReviewSends(p.projectId)",
		);
		const tail = DISPATCH.slice(reclaimIdx, reclaimIdx + 400);
		expect(tail).toContain(
			"reclaimed.expiredDraftId || reclaimed.failedApprovedId",
		);
		expect(tail).toContain("[Newsletter] reclaimed stale review send");
	});
});
