/**
 * Authority Session & Grant Tests
 *
 * Tests the runtime authorization layer (Pipes-style session-scoped authorization).
 * Covers:
 * - CRUD lifecycle (create, approve, deny, revoke, complete, expire)
 * - Tenant isolation (personal vs org, org A vs org B)
 * - Access level enforcement (READ vs WRITE)
 * - Grant kind semantics (BROAD vs REQUEST)
 * - Session binding (runType, runId)
 * - One-shot grant consumption
 *
 * Run with: pnpm --filter @repo/database test -- authority
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	approveAuthoritySession,
	checkAuthority,
	completeAuthoritySession,
	consumeRequestGrant,
	createAuthorityRequest,
	createAuthoritySession,
	denyAuthoritySession,
	expireAuthoritySessions,
	findActiveAuthoritySession,
	getActiveAuthoritySessionForRun,
	getAuthoritySession,
	listAuthoritySessions,
	revokeAuthoritySession,
} from "../prisma/queries/authority";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const USER_A = "test-authority-user-a";
const USER_B = "test-authority-user-b";
const ORG_A = "test-authority-org-a";
const ORG_B = "test-authority-org-b";

beforeAll(async () => {
	// Create test users — use Prisma.sql tagged template for pg adapter compatibility
	const now = new Date();
	for (const userId of [USER_A, USER_B]) {
		const name = `Test ${userId}`;
		const email = `${userId}@test.com`;
		await db.$executeRaw(Prisma.sql`
			INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
			VALUES (${userId}, ${name}, ${email}, true, false, ${now}, ${now})
			ON CONFLICT (id) DO NOTHING
		`);
	}

	// Create test organizations
	for (const orgId of [ORG_A, ORG_B]) {
		const name = `Test ${orgId}`;
		await db.$executeRaw(Prisma.sql`
			INSERT INTO "organization" (id, name, slug, "createdAt")
			VALUES (${orgId}, ${name}, ${orgId}, ${now})
			ON CONFLICT (id) DO NOTHING
		`);
	}
});

async function cleanupAuthority() {
	// Must delete grants first (FK constraint), then sessions
	const sessions = await db.authoritySession.findMany({
		where: { userId: { in: [USER_A, USER_B] } },
		select: { id: true },
	});
	const sessionIds = sessions.map((s) => s.id);
	if (sessionIds.length > 0) {
		await db.authorityGrant.deleteMany({
			where: { authoritySessionId: { in: sessionIds } },
		});
		await db.authoritySession.deleteMany({
			where: { id: { in: sessionIds } },
		});
	}
}

afterAll(async () => {
	await cleanupAuthority();
	await db.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
	await db.organization.deleteMany({
		where: { id: { in: [ORG_A, ORG_B] } },
	});
});

beforeEach(async () => {
	await cleanupAuthority();
});

// ─── Session Lifecycle ──────────────────────────────────────────────────────

describe("AuthoritySession lifecycle", () => {
	it("should create a PENDING session", async () => {
		const session = await createAuthoritySession({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			expiresAt: new Date(Date.now() + 30 * 60_000),
		});

		expect(session.id).toBeDefined();
		expect(session.status).toBe("PENDING");
		expect(session.userId).toBe(USER_A);
		expect(session.organizationId).toBeNull();
		expect(session.runType).toBe("MCP_GATEWAY");
	});

	it("should create a session in org context", async () => {
		const session = await createAuthoritySession({
			userId: USER_A,
			organizationId: ORG_A,
			runType: "ORCHESTRATOR",
			expiresAt: new Date(Date.now() + 30 * 60_000),
		});

		expect(session.organizationId).toBe(ORG_A);
	});

	it("should approve a PENDING session and all its grants", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			ttlMinutes: 30,
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
				{
					providerType: "MCP",
					providerKey: "linear",
					accessLevel: "READ",
				},
			],
		});

		expect(session.status).toBe("PENDING");

		const approved = await approveAuthoritySession(
			session.id,
			USER_A,
			"Only use read operations",
		);

		expect(approved?.status).toBe("ACTIVE");
		expect(approved?.approvedAt).toBeDefined();
		expect(approved?.approvalInstructions).toBe("Only use read operations");
		expect(approved?.grants.every((g) => g.status === "APPROVED")).toBe(
			true,
		);
	});

	it("should deny a session and all its grants", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "slack",
					accessLevel: "WRITE",
				},
			],
		});

		await denyAuthoritySession(session.id, USER_A, "Not needed");

		const denied = await getAuthoritySession(session.id, USER_A);
		expect(denied?.status).toBe("REVOKED");

		const deniedGrants = denied?.grants ?? [];
		expect(deniedGrants.every((g) => g.status === "DENIED")).toBe(true);
		expect(deniedGrants[0]?.denialReason).toBe("Not needed");
	});

	it("should revoke an ACTIVE session", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "notion",
					accessLevel: "READ",
				},
			],
		});

		await approveAuthoritySession(session.id, USER_A);
		await revokeAuthoritySession(session.id);

		const revoked = await getAuthoritySession(session.id, USER_A);
		expect(revoked?.status).toBe("REVOKED");
		expect(revoked?.revokedAt).toBeDefined();
		expect(revoked?.grants.every((g) => g.status === "REVOKED")).toBe(true);
	});

	it("should complete a session", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "READ",
				},
			],
		});

		await approveAuthoritySession(session.id, USER_A);
		await completeAuthoritySession(session.id);

		const completed = await getAuthoritySession(session.id, USER_A);
		expect(completed?.status).toBe("COMPLETED");
		expect(completed?.completedAt).toBeDefined();
	});

	it("should expire stale sessions and grants", async () => {
		// Create a session that's already expired
		const pastExpiry = new Date(Date.now() - 60_000);

		const session = await db.authoritySession.create({
			data: {
				userId: USER_A,
				runType: "MCP_GATEWAY",
				status: "ACTIVE",
				expiresAt: pastExpiry,
				approvedAt: new Date(Date.now() - 120_000),
			},
		});

		await db.authorityGrant.create({
			data: {
				authoritySessionId: session.id,
				providerType: "MCP",
				providerKey: "github",
				accessLevel: "WRITE",
				status: "APPROVED",
				approvedBy: USER_A,
				approvedAt: new Date(Date.now() - 120_000),
				expiresAt: pastExpiry,
			},
		});

		const result = await expireAuthoritySessions();
		expect(result.expiredSessions).toBeGreaterThanOrEqual(1);
		expect(result.expiredGrants).toBeGreaterThanOrEqual(1);

		const expired = await getAuthoritySession(session.id, USER_A);
		expect(expired?.status).toBe("EXPIRED");
	});
});

// ─── Tenant Isolation ───────────────────────────────────────────────────────

describe("Authority tenant isolation", () => {
	it("personal session should NOT be visible in org context", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			// No organizationId — personal context
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "READ",
				},
			],
		});

		// Should be visible in personal context
		const personal = await getAuthoritySession(session.id, USER_A);
		expect(personal).not.toBeNull();

		// Should NOT be visible in org context
		const inOrg = await getAuthoritySession(session.id, USER_A, ORG_A);
		expect(inOrg).toBeNull();
	});

	it("org session should NOT be visible in personal context", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			organizationId: ORG_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "READ",
				},
			],
		});

		// Should be visible in org A context
		const inOrgA = await getAuthoritySession(session.id, USER_A, ORG_A);
		expect(inOrgA).not.toBeNull();

		// Should NOT be visible in personal context
		const personal = await getAuthoritySession(session.id, USER_A);
		expect(personal).toBeNull();
	});

	it("org A session should NOT be visible in org B context", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			organizationId: ORG_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "linear",
					accessLevel: "WRITE",
				},
			],
		});

		// Should NOT be visible in org B
		const inOrgB = await getAuthoritySession(session.id, USER_A, ORG_B);
		expect(inOrgB).toBeNull();
	});

	it("user B should NOT see user A's session", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "READ",
				},
			],
		});

		const result = await getAuthoritySession(session.id, USER_B);
		expect(result).toBeNull();
	});

	it("checkAuthority should NOT cross personal ↔ org boundary", async () => {
		// Create and approve in personal context
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		// Should be authorized in personal context
		const personalCheck = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "READ",
		});
		expect(personalCheck.authorized).toBe(true);

		// Should NOT be authorized in org context
		const orgCheck = await checkAuthority({
			userId: USER_A,
			organizationId: ORG_A,
			providerKey: "github",
			accessLevel: "READ",
		});
		expect(orgCheck.authorized).toBe(false);
	});

	it("listAuthoritySessions should isolate by tenant", async () => {
		// Create sessions in different contexts
		await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "READ",
				},
			],
		});

		await createAuthorityRequest({
			userId: USER_A,
			organizationId: ORG_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "linear",
					accessLevel: "READ",
				},
			],
		});

		// Personal context should only see personal sessions
		const personalList = await listAuthoritySessions({
			userId: USER_A,
		});
		expect(personalList.total).toBe(1);
		expect(personalList.sessions[0]?.grants[0]?.providerKey).toBe("github");

		// Org A context should only see org A sessions
		const orgList = await listAuthoritySessions({
			userId: USER_A,
			organizationId: ORG_A,
		});
		expect(orgList.total).toBe(1);
		expect(orgList.sessions[0]?.grants[0]?.providerKey).toBe("linear");
	});
});

// ─── checkAuthority ─────────────────────────────────────────────────────────

describe("checkAuthority", () => {
	it("should deny when no grants exist", async () => {
		const result = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "READ",
		});
		expect(result.authorized).toBe(false);
		expect(result.reason).toContain("No active authority grant");
	});

	it("should authorize with matching BROAD grant", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		const result = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "WRITE",
		});
		expect(result.authorized).toBe(true);
		expect(result.grant?.providerKey).toBe("github");
	});

	it("WRITE grant should cover READ access", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		const result = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "READ",
		});
		expect(result.authorized).toBe(true);
	});

	it("READ grant should NOT cover WRITE access", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "READ",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		const result = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "WRITE",
		});
		expect(result.authorized).toBe(false);
		expect(result.reason).toContain("READ authority but WRITE is required");
	});

	it("should deny for wrong provider key", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		const result = await checkAuthority({
			userId: USER_A,
			providerKey: "linear",
			accessLevel: "READ",
		});
		expect(result.authorized).toBe(false);
	});

	it("should respect tool scope restrictions", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
					toolScope: ["list_repos", "get_repo"],
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		// Allowed tool
		const allowed = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "READ",
			toolName: "list_repos",
		});
		expect(allowed.authorized).toBe(true);

		// Denied tool (not in scope)
		const denied = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "READ",
			toolName: "delete_repo",
		});
		expect(denied.authorized).toBe(false);
	});

	it("should deny expired grants", async () => {
		const pastExpiry = new Date(Date.now() - 60_000);

		const session = await db.authoritySession.create({
			data: {
				userId: USER_A,
				runType: "MCP_GATEWAY",
				status: "ACTIVE",
				expiresAt: pastExpiry,
				approvedAt: new Date(Date.now() - 120_000),
			},
		});

		await db.authorityGrant.create({
			data: {
				authoritySessionId: session.id,
				providerType: "MCP",
				providerKey: "github",
				accessLevel: "WRITE",
				status: "APPROVED",
				approvedBy: USER_A,
				expiresAt: pastExpiry,
			},
		});

		const result = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "READ",
		});
		expect(result.authorized).toBe(false);
	});

	it("should deny REVOKED grants", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);
		await revokeAuthoritySession(session.id);

		const result = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "READ",
		});
		expect(result.authorized).toBe(false);
	});

	// ── Session binding ──

	it("should respect boundRunType filter", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		// Should match MCP_GATEWAY
		const matching = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "READ",
			boundRunType: "MCP_GATEWAY",
		});
		expect(matching.authorized).toBe(true);

		// Should NOT match ORCHESTRATOR
		const nonMatching = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "READ",
			boundRunType: "ORCHESTRATOR",
		});
		expect(nonMatching.authorized).toBe(false);
	});

	it("should respect boundRunId filter", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			runId: "session-123",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		// Should match correct runId
		const matching = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "READ",
			boundRunId: "session-123",
		});
		expect(matching.authorized).toBe(true);

		// Should NOT match different runId
		const nonMatching = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "READ",
			boundRunId: "session-456",
		});
		expect(nonMatching.authorized).toBe(false);
	});

	it("should respect boundSessionId filter", async () => {
		// Create two sessions for the same provider
		const { session: session1 } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
				},
			],
		});
		await approveAuthoritySession(session1.id, USER_A);

		const { session: session2 } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "READ",
				},
			],
		});
		await approveAuthoritySession(session2.id, USER_A);

		// Bound to session1 — should find WRITE grant
		const fromSession1 = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "WRITE",
			boundSessionId: session1.id,
		});
		expect(fromSession1.authorized).toBe(true);

		// Bound to session2 — should NOT have WRITE, only READ
		const fromSession2 = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "WRITE",
			boundSessionId: session2.id,
		});
		expect(fromSession2.authorized).toBe(false);
	});

	// ── One-shot REQUEST grants ──

	it("should match REQUEST grant by fingerprint", async () => {
		const { session, grants: _grants } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
					kind: "REQUEST",
					requestFingerprint: "abc123hash",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		// Should match with correct fingerprint
		const matching = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "WRITE",
			requestFingerprint: "abc123hash",
		});
		expect(matching.authorized).toBe(true);
		expect(matching.grant?.kind).toBe("REQUEST");

		// Should NOT match without fingerprint (REQUEST grants require it)
		const noFingerprint = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "WRITE",
		});
		expect(noFingerprint.authorized).toBe(false);
	});

	it("should consume a REQUEST grant after use", async () => {
		const { session, grants: _grants } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "WRITE",
					kind: "REQUEST",
					requestFingerprint: "oneshot-hash",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		// First check — should be authorized
		const first = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "WRITE",
			requestFingerprint: "oneshot-hash",
		});
		expect(first.authorized).toBe(true);

		// Consume the grant
		// biome-ignore lint/style/noNonNullAssertion: test assertion — grant exists on authorized request
		await consumeRequestGrant(first.grant!.id);

		// Second check — should be denied (consumed)
		const second = await checkAuthority({
			userId: USER_A,
			providerKey: "github",
			accessLevel: "WRITE",
			requestFingerprint: "oneshot-hash",
		});
		expect(second.authorized).toBe(false);
	});
});

// ─── Lookup Functions ───────────────────────────────────────────────────────

describe("Authority lookup functions", () => {
	it("getActiveAuthoritySessionForRun should find by runType+runId", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			runType: "MCP_GATEWAY",
			runId: "gateway-session-abc",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "READ",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		const found = await getActiveAuthoritySessionForRun(
			"MCP_GATEWAY",
			"gateway-session-abc",
			USER_A,
		);
		expect(found).not.toBeNull();
		expect(found?.id).toBe(session.id);

		// Wrong runId should not find it
		const notFound = await getActiveAuthoritySessionForRun(
			"MCP_GATEWAY",
			"gateway-session-xyz",
			USER_A,
		);
		expect(notFound).toBeNull();
	});

	it("findActiveAuthoritySession should respect org context", async () => {
		const { session } = await createAuthorityRequest({
			userId: USER_A,
			organizationId: ORG_A,
			runType: "MCP_GATEWAY",
			grants: [
				{
					providerType: "MCP",
					providerKey: "github",
					accessLevel: "READ",
				},
			],
		});
		await approveAuthoritySession(session.id, USER_A);

		// Should find in org A
		const inOrgA = await findActiveAuthoritySession(USER_A, ORG_A);
		expect(inOrgA).not.toBeNull();

		// Should NOT find in personal context
		const personal = await findActiveAuthoritySession(USER_A);
		expect(personal).toBeNull();

		// Should NOT find in org B
		const inOrgB = await findActiveAuthoritySession(USER_A, ORG_B);
		expect(inOrgB).toBeNull();
	});
});
