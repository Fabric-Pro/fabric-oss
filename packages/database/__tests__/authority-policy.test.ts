/**
 * Authority Policy Integration Tests
 *
 * Tests the full evaluateAuthorityPolicy() function with real DB-backed
 * authority sessions and grants. Covers the unified precedence model:
 *
 * 1. Authority check (runtime grants from DB)
 * 2. Step risk check
 * 3. Trust optimization
 *
 * Run with: DATABASE_URL="..." pnpm --filter @repo/database test -- authority-policy
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// Import the policy function from temporal (it only depends on @repo/database at runtime)
// We import it directly here since we're testing the policy logic, not the Temporal activity wrapper
import { evaluateAuthorityPolicy } from "../../temporal/src/activities/orchestrator/approval/authority-policy";
import { db, Prisma } from "../prisma/client";
import {
	approveAuthoritySession,
	createAuthorityRequest,
} from "../prisma/queries/authority";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const USER_A = "test-policy-user-a";
const ORG_A = "test-policy-org-a";

function makeStep(overrides: Record<string, unknown> = {}) {
	return {
		id: "step-1",
		description: "Test step",
		type: "api" as const,
		status: "pending" as const,
		order: 1,
		...overrides,
	};
}

beforeAll(async () => {
	const now = new Date();
	await db.$executeRaw(Prisma.sql`
		INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
		VALUES (${USER_A}, ${"Test Policy User A"}, ${"policy-a@test.com"}, true, false, ${now}, ${now})
		ON CONFLICT (id) DO NOTHING
	`);
	await db.$executeRaw(Prisma.sql`
		INSERT INTO "organization" (id, name, slug, "createdAt")
		VALUES (${ORG_A}, ${"Test Policy Org A"}, ${"test-policy-org-a"}, ${now})
		ON CONFLICT (id) DO NOTHING
	`);
});

async function cleanup() {
	const sessions = await db.authoritySession.findMany({
		where: { userId: USER_A },
		select: { id: true },
	});
	const ids = sessions.map((s) => s.id);
	if (ids.length > 0) {
		await db.authorityGrant.deleteMany({
			where: { authoritySessionId: { in: ids } },
		});
		await db.authoritySession.deleteMany({
			where: { id: { in: ids } },
		});
	}
}

afterAll(async () => {
	await cleanup();
	await db.user.deleteMany({ where: { id: USER_A } });
	await db.organization.deleteMany({ where: { id: ORG_A } });
});

beforeEach(async () => {
	await cleanup();
});

// ─── evaluateAuthorityPolicy ────────────────────────────────────────────────

describe("evaluateAuthorityPolicy", () => {
	it("should allow step with no required providers", async () => {
		const result = await evaluateAuthorityPolicy({
			step: makeStep(),
			userId: USER_A,
			requiredProviders: [],
		});

		expect(result.allowed).toBe(true);
	});

	it("should block step when authority is missing", async () => {
		const result = await evaluateAuthorityPolicy({
			step: makeStep(),
			userId: USER_A,
			requiredProviders: [{ providerKey: "github", accessLevel: "READ" }],
		});

		expect(result.allowed).toBe(false);
		expect(result.blockedBy).toBe("authority_missing");
		expect(result.blockedDetails?.providerKey).toBe("github");
	});

	it("should allow step when authority is granted", async () => {
		// Create and approve authority
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "ORCHESTRATOR",
			ttlMinutes: 30,
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		const result = await evaluateAuthorityPolicy({
			step: makeStep(),
			userId: USER_A,
			requiredProviders: [{ providerKey: "github", accessLevel: "READ" }],
		});

		expect(result.allowed).toBe(true);
	});

	it("should block when authority exists for wrong provider", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "ORCHESTRATOR",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		const result = await evaluateAuthorityPolicy({
			step: makeStep(),
			userId: USER_A,
			requiredProviders: [{ providerKey: "linear", accessLevel: "READ" }],
		});

		expect(result.allowed).toBe(false);
		expect(result.blockedBy).toBe("authority_missing");
		expect(result.blockedDetails?.providerKey).toBe("linear");
	});

	it("should block when READ authority exists but WRITE is needed", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "ORCHESTRATOR",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "READ",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		const result = await evaluateAuthorityPolicy({
			step: makeStep(),
			userId: USER_A,
			requiredProviders: [
				{ providerKey: "github", accessLevel: "WRITE" },
			],
		});

		expect(result.allowed).toBe(false);
		expect(result.blockedBy).toBe("authority_missing");
		expect(result.blockedDetails?.requiredAccessLevel).toBe("WRITE");
	});

	it("should check ALL required providers", async () => {
		// Grant authority only for github, not linear
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "ORCHESTRATOR",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		const result = await evaluateAuthorityPolicy({
			step: makeStep(),
			userId: USER_A,
			requiredProviders: [
				{ providerKey: "github", accessLevel: "READ" },
				{ providerKey: "linear", accessLevel: "READ" },
			],
		});

		expect(result.allowed).toBe(false);
		expect(result.blockedBy).toBe("authority_missing");
		expect(result.blockedDetails?.providerKey).toBe("linear");
	});

	it("should allow when authority granted for all required providers", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "ORCHESTRATOR",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
				{
					providerType: "MCP",
					providerKey: "linear",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		const result = await evaluateAuthorityPolicy({
			step: makeStep(),
			userId: USER_A,
			requiredProviders: [
				{ providerKey: "github", accessLevel: "READ" },
				{ providerKey: "linear", accessLevel: "WRITE" },
			],
		});

		expect(result.allowed).toBe(true);
	});

	it("should respect executionId binding via boundRunId", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "ORCHESTRATOR",
			runId: "exec-123",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		// Matching executionId — should work
		const matching = await evaluateAuthorityPolicy({
			step: makeStep(),
			userId: USER_A,
			executionId: "exec-123",
			requiredProviders: [{ providerKey: "github", accessLevel: "READ" }],
		});
		expect(matching.allowed).toBe(true);

		// Different executionId — should fail
		const nonMatching = await evaluateAuthorityPolicy({
			step: makeStep(),
			userId: USER_A,
			executionId: "exec-456",
			requiredProviders: [{ providerKey: "github", accessLevel: "READ" }],
		});
		expect(nonMatching.allowed).toBe(false);
	});

	// ── Step risk ──

	it("should block critical risk step without approval", async () => {
		// Grant authority (so it passes step 1)
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "ORCHESTRATOR",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		const result = await evaluateAuthorityPolicy({
			step: makeStep({
				riskLevel: "critical",
				requiresApproval: true,
				// No approvalId — hasn't been approved yet
			}),
			userId: USER_A,
			requiredProviders: [{ providerKey: "github", accessLevel: "READ" }],
		});

		expect(result.allowed).toBe(false);
		expect(result.blockedBy).toBe("step_approval_required");
		expect(result.blockedDetails?.riskLevel).toBe("critical");
	});

	it("should allow critical step that has already been approved", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "ORCHESTRATOR",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		const result = await evaluateAuthorityPolicy({
			step: makeStep({
				riskLevel: "critical",
				requiresApproval: true,
				approvalId: "approval-123", // Already approved
			}),
			userId: USER_A,
			requiredProviders: [{ providerKey: "github", accessLevel: "READ" }],
		});

		expect(result.allowed).toBe(true);
	});

	// ── Precedence: authority blocks before risk check ──

	it("should block on authority before checking risk level", async () => {
		// No authority granted at all
		const result = await evaluateAuthorityPolicy({
			step: makeStep({
				riskLevel: "critical",
				requiresApproval: true,
			}),
			userId: USER_A,
			requiredProviders: [
				{ providerKey: "github", accessLevel: "WRITE" },
			],
		});

		// Should be blocked by authority, not risk
		expect(result.allowed).toBe(false);
		expect(result.blockedBy).toBe("authority_missing");
	});

	// ── Org isolation ──

	it("should respect org isolation in authority check", async () => {
		// Grant authority in personal context
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "ORCHESTRATOR",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		// Check in org context — should fail (personal grant doesn't cross to org)
		const orgResult = await evaluateAuthorityPolicy({
			step: makeStep(),
			userId: USER_A,
			organizationId: ORG_A,
			requiredProviders: [{ providerKey: "github", accessLevel: "READ" }],
		});

		expect(orgResult.allowed).toBe(false);
		expect(orgResult.blockedBy).toBe("authority_missing");
	});
});
