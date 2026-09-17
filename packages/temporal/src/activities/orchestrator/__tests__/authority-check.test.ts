/**
 * checkStepAuthorityActivity — fail-closed provider resolution and whole-step
 * access classification.
 *
 * Two regressions this pins:
 *
 * 1. When the tenant's MCP configs could not be loaded the activity used to
 *    log and carry on with `requiredProviders = []`, which the next line
 *    turned into `{ allowed: true }` — a DB outage silently disabled the
 *    authority gate. It must now report a block with a reason the workflow
 *    can distinguish from a genuine "authority missing" outcome.
 *
 * 2. A step was classified by its FIRST tool only, so `[list_issues,
 *    delete_repo]` was a READ step. The level must be the maximum across every
 *    tool in the step, both in the config-derived fallback and in
 *    `extractRequiredProviders` (where the first tool seen per provider won).
 *
 * Run with: pnpm --filter @repo/temporal test -- authority-check
 */

import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	listMcpConfigsForTenant: vi.fn(),
	findOrCreateAuthoritySessionForRun: vi.fn(),
	approveAuthoritySession: vi.fn(),
	denyAuthoritySession: vi.fn(),
	/**
	 * The session already bound to the run, as the locked resolver would
	 * find it; null when the run has none. The mock applies the caller's
	 * `covers` predicate to it exactly as the real query does.
	 */
	existingRunSession: null as null | {
		id: string;
		status: string;
		grants: Array<{
			providerKey: string;
			accessLevel: "READ" | "WRITE";
			status: string;
		}>;
	},
}));

const { MockAuthoritySessionConflictError } = vi.hoisted(() => {
	class MockAuthoritySessionConflictError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "AuthoritySessionConflictError";
		}
	}
	return { MockAuthoritySessionConflictError };
});

const policyMocks = vi.hoisted(() => ({
	evaluateAuthorityPolicy: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listMcpConfigsForTenant: dbMocks.listMcpConfigsForTenant,
	findOrCreateAuthoritySessionForRun:
		dbMocks.findOrCreateAuthoritySessionForRun,
	approveAuthoritySession: dbMocks.approveAuthoritySession,
	denyAuthoritySession: dbMocks.denyAuthoritySession,
	AuthoritySessionConflictError: MockAuthoritySessionConflictError,
	checkAuthority: vi.fn(),
	resolveCanonicalProviderKey: (key: string) => key.toLowerCase(),
}));

vi.mock("../approval/trust-manager", () => ({
	loadTrustConfiguration: vi.fn(async () => null),
}));

vi.mock("../approval/authority-policy", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../approval/authority-policy")>();
	return {
		...actual,
		evaluateAuthorityPolicy: policyMocks.evaluateAuthorityPolicy,
	};
});

import { extractRequiredProviders } from "../approval/authority-policy";
import {
	AUTHORITY_CHECK_FAILED,
	AUTHORITY_ORGANIZATION_MISSING,
	approveAuthoritySessionActivity,
	checkStepAuthorityActivity,
	denyAuthoritySessionActivity,
	sessionCoversProviders,
} from "../authority-check";
import { maxToolAccessLevel } from "../execution/authority-gate";

const baseStep = {
	id: "step-1",
	description: "Touch GitHub",
	type: "action",
	status: "pending",
	order: 1,
	capability: "mcp_tool",
};

const githubConfig = {
	id: "cfg-github",
	enabled: true,
	mcpServer: { key: "github" },
};

beforeEach(() => {
	vi.clearAllMocks();
	policyMocks.evaluateAuthorityPolicy.mockResolvedValue({ allowed: true });
	dbMocks.existingRunSession = null;
	dbMocks.findOrCreateAuthoritySessionForRun.mockImplementation(
		async (input: {
			covers: (
				session: NonNullable<typeof dbMocks.existingRunSession>,
			) => boolean;
		}) => {
			const existing = dbMocks.existingRunSession;
			if (existing && input.covers(existing)) {
				return { session: existing, created: false };
			}
			return { session: { id: "sess-new", grants: [] }, created: true };
		},
	);
	dbMocks.approveAuthoritySession.mockResolvedValue({ status: "ACTIVE" });
	dbMocks.denyAuthoritySession.mockResolvedValue({
		transitioned: true,
		previousStatus: "PENDING",
		outcome: "withdrawn",
	});
});

const authorityMissing = {
	allowed: false,
	blockedBy: "authority_missing",
	blockedDetails: {
		providerKey: "github",
		requiredAccessLevel: "WRITE",
		message: "no grant",
	},
};

describe("checkStepAuthorityActivity — the session is bound to this run", () => {
	it("looks up the session by this run, not any active orchestrator session", async () => {
		dbMocks.listMcpConfigsForTenant.mockResolvedValue([githubConfig]);
		policyMocks.evaluateAuthorityPolicy.mockResolvedValue(authorityMissing);

		const result = await checkStepAuthorityActivity({
			userId: "user-1",
			organizationId: "org-1",
			executionId: "orch-this-run",
			step: { ...baseStep, toolsToUse: ["create_issue"] },
		});

		// One locked find-or-create keyed on THIS run and its tenant. No
		// session for this run → one is raised for it, and the workflow is
		// told which one to activate.
		expect(
			dbMocks.findOrCreateAuthoritySessionForRun,
		).toHaveBeenCalledTimes(1);
		expect(dbMocks.findOrCreateAuthoritySessionForRun).toHaveBeenCalledWith(
			expect.objectContaining({
				runType: "ORCHESTRATOR",
				runId: "orch-this-run",
				userId: "user-1",
				organizationId: "org-1",
				grants: [
					expect.objectContaining({
						providerKey: "github",
						accessLevel: "WRITE",
					}),
				],
			}),
		);
		expect(result.allowed).toBe(false);
		expect(result.blockedBy).toBe("authority_missing");
		expect(result.authoritySessionId).toBe("sess-new");
	});

	it("reuses this run's own pending session when it covers the step", async () => {
		dbMocks.listMcpConfigsForTenant.mockResolvedValue([githubConfig]);
		policyMocks.evaluateAuthorityPolicy.mockResolvedValue(authorityMissing);
		dbMocks.existingRunSession = {
			id: "sess-mine",
			status: "PENDING",
			grants: [
				{
					providerKey: "github",
					accessLevel: "WRITE",
					status: "PENDING",
				},
			],
		};

		const result = await checkStepAuthorityActivity({
			userId: "user-1",
			organizationId: "org-1",
			executionId: "orch-this-run",
			step: { ...baseStep, toolsToUse: ["create_issue"] },
		});

		expect(result.authoritySessionId).toBe("sess-mine");
	});

	it("raises a new session when this run's session does not cover the provider", async () => {
		dbMocks.listMcpConfigsForTenant.mockResolvedValue([githubConfig]);
		policyMocks.evaluateAuthorityPolicy.mockResolvedValue(authorityMissing);
		dbMocks.existingRunSession = {
			id: "sess-linear-only",
			status: "ACTIVE",
			grants: [
				{
					providerKey: "linear",
					accessLevel: "WRITE",
					status: "APPROVED",
				},
			],
		};

		const result = await checkStepAuthorityActivity({
			userId: "user-1",
			organizationId: "org-1",
			executionId: "orch-this-run",
			step: { ...baseStep, toolsToUse: ["create_issue"] },
		});

		expect(result.authoritySessionId).toBe("sess-new");
	});

	it("never returns an authority_missing block without a session id", async () => {
		dbMocks.listMcpConfigsForTenant.mockResolvedValue([githubConfig]);
		policyMocks.evaluateAuthorityPolicy.mockResolvedValue(authorityMissing);
		dbMocks.findOrCreateAuthoritySessionForRun.mockRejectedValue(
			new Error("insert failed"),
		);

		// A session-less block would be shown as ordinary step approval and
		// then executed with no authority; the failure must surface instead.
		await expect(
			checkStepAuthorityActivity({
				userId: "user-1",
				organizationId: "org-1",
				executionId: "orch-this-run",
				step: { ...baseStep, toolsToUse: ["create_issue"] },
			}),
		).rejects.toThrow("insert failed");
	});
});

describe("authority activities require the run's organization (ADR-018)", () => {
	const missingOrganization = expect.objectContaining({
		type: AUTHORITY_ORGANIZATION_MISSING,
		nonRetryable: true,
	});

	it("the check fails the step instead of evaluating authority in the personal arm", async () => {
		dbMocks.listMcpConfigsForTenant.mockResolvedValue([githubConfig]);

		await expect(
			checkStepAuthorityActivity({
				userId: "user-1",
				executionId: "orch-this-run",
				step: { ...baseStep, toolsToUse: ["create_issue"] },
			}),
		).rejects.toThrow(missingOrganization);

		expect(dbMocks.listMcpConfigsForTenant).not.toHaveBeenCalled();
		expect(policyMocks.evaluateAuthorityPolicy).not.toHaveBeenCalled();
		expect(
			dbMocks.findOrCreateAuthoritySessionForRun,
		).not.toHaveBeenCalled();
	});

	it("approval refuses rather than approving against the organization-less arm", async () => {
		await expect(
			approveAuthoritySessionActivity({
				authoritySessionId: "sess-1",
				userId: "user-1",
			}),
		).rejects.toThrow(missingOrganization);
		expect(dbMocks.approveAuthoritySession).not.toHaveBeenCalled();
	});

	it("denial refuses rather than denying against the organization-less arm", async () => {
		await expect(
			denyAuthoritySessionActivity({
				authoritySessionId: "sess-1",
				userId: "user-1",
				organizationId: "",
			}),
		).rejects.toThrow(missingOrganization);
		expect(dbMocks.denyAuthoritySession).not.toHaveBeenCalled();
	});

	it("passes the organization, never null, into the decision's tenant filter", async () => {
		await approveAuthoritySessionActivity({
			authoritySessionId: "sess-1",
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(dbMocks.approveAuthoritySession).toHaveBeenCalledWith(
			"sess-1",
			"user-1",
			undefined,
			{ organizationId: "org-1" },
		);
	});
});

describe("sessionCoversProviders", () => {
	const need = [{ providerKey: "github", accessLevel: "WRITE" as const }];

	it("requires a live grant at the needed level or higher", () => {
		expect(
			sessionCoversProviders(
				{
					grants: [
						{
							providerKey: "github",
							accessLevel: "WRITE",
							status: "PENDING",
						},
					],
				},
				need,
			),
		).toBe(true);
		expect(
			sessionCoversProviders(
				{
					grants: [
						{
							providerKey: "github",
							accessLevel: "READ",
							status: "APPROVED",
						},
					],
				},
				need,
			),
		).toBe(false);
		expect(
			sessionCoversProviders(
				{
					grants: [
						{
							providerKey: "github",
							accessLevel: "WRITE",
							status: "DENIED",
						},
					],
				},
				need,
			),
		).toBe(false);
		expect(
			sessionCoversProviders(
				{
					grants: [
						{
							providerKey: "GitHub",
							accessLevel: "WRITE",
							status: "APPROVED",
						},
					],
				},
				[{ providerKey: "github", accessLevel: "READ" }],
			),
		).toBe(true);
	});
});

describe("approveAuthoritySessionActivity — conditional on the DB transition", () => {
	it("hands ownership, tenant, status and expiry to the conditional update", async () => {
		const result = await approveAuthoritySessionActivity({
			authoritySessionId: "sess-1",
			userId: "user-1",
			organizationId: "org-1",
			instructions: "read only",
		});

		expect(result).toEqual({ success: true });
		expect(dbMocks.approveAuthoritySession).toHaveBeenCalledWith(
			"sess-1",
			"user-1",
			"read only",
			{ organizationId: "org-1" },
		);
	});

	// The organization-less arm this suite used to pin ("{ organizationId:
	// null }" when none was given) is gone on purpose: runtime authority is
	// organization-scoped (ADR-018). The refusal is pinned in the
	// "require the run's organization" suite above.

	it("fails non-retryably when a revoke landed before the decision", async () => {
		dbMocks.approveAuthoritySession.mockRejectedValue(
			new MockAuthoritySessionConflictError(
				"Authority session sess-1 is REVOKED; refusing to approve",
			),
		);

		const failure = await approveAuthoritySessionActivity({
			authoritySessionId: "sess-1",
			userId: "user-1",
			organizationId: "org-1",
		}).catch((e: unknown) => e);

		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect((failure as ApplicationFailure).nonRetryable).toBe(true);
		expect((failure as ApplicationFailure).message).toContain("REVOKED");
	});

	it("a retry after the approval committed succeeds (idempotent transition)", async () => {
		// The DB transition returns the already-ACTIVE session on retry
		// instead of throwing; the activity's postcondition holds.
		dbMocks.approveAuthoritySession.mockResolvedValue({
			status: "ACTIVE",
		});
		await expect(
			approveAuthoritySessionActivity({
				authoritySessionId: "sess-1",
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({ success: true });
	});

	it("lets transient DB errors propagate for Temporal to retry", async () => {
		dbMocks.approveAuthoritySession.mockRejectedValue(
			new Error("connection reset"),
		);
		const failure = await approveAuthoritySessionActivity({
			authoritySessionId: "sess-1",
			userId: "user-1",
			organizationId: "org-1",
		}).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(ApplicationFailure);
	});
});

describe("denyAuthoritySessionActivity — conditional on the DB transition", () => {
	it("passes the tenant to the conditional update", async () => {
		await denyAuthoritySessionActivity({
			authoritySessionId: "sess-1",
			userId: "user-1",
			organizationId: "org-1",
			reason: "nope",
		});
		expect(dbMocks.denyAuthoritySession).toHaveBeenCalledWith(
			"sess-1",
			"user-1",
			"nope",
			{ organizationId: "org-1" },
		);
	});

	it("reports a withdrawal as a successful denial", async () => {
		await expect(
			denyAuthoritySessionActivity({
				authoritySessionId: "sess-1",
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({ success: true, outcome: "withdrawn" });
	});

	it("treats an already-final session as a no-op", async () => {
		dbMocks.denyAuthoritySession.mockResolvedValue({
			transitioned: false,
			previousStatus: "REVOKED",
			outcome: "already-final",
		});
		await expect(
			denyAuthoritySessionActivity({
				authoritySessionId: "sess-1",
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({ success: true, outcome: "already-final" });
	});

	it("does not report an expired request as a successful denial", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		dbMocks.denyAuthoritySession.mockResolvedValue({
			transitioned: false,
			previousStatus: "PENDING",
			outcome: "expired",
		});
		await expect(
			denyAuthoritySessionActivity({
				authoritySessionId: "sess-1",
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual({ success: false, outcome: "expired" });
		warn.mockRestore();
	});

	it("fails non-retryably for a session the user cannot see in this tenant", async () => {
		dbMocks.denyAuthoritySession.mockRejectedValue(
			new MockAuthoritySessionConflictError(
				"Authority session sess-1 was not found for this user and tenant",
			),
		);
		const failure = await denyAuthoritySessionActivity({
			authoritySessionId: "sess-1",
			userId: "user-1",
			organizationId: "org-2",
		}).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(ApplicationFailure);
		expect((failure as ApplicationFailure).nonRetryable).toBe(true);
	});
});

describe("checkStepAuthorityActivity — fail-closed on provider resolution", () => {
	it("blocks the step when the MCP config lookup throws, and never consults the policy", async () => {
		dbMocks.listMcpConfigsForTenant.mockRejectedValue(
			new Error("connection refused"),
		);

		const result = await checkStepAuthorityActivity({
			userId: "user-1",
			organizationId: "org-1",
			step: { ...baseStep, toolsToUse: ["list_issues"] },
		});

		expect(result.allowed).toBe(false);
		expect(result.blockedBy).toBe(AUTHORITY_CHECK_FAILED);
		expect(result.blockedDetails?.message).toContain("connection refused");
		// Nothing to approve: no session may be minted for an unknown grant.
		expect(result.authoritySessionId).toBeUndefined();
		expect(
			dbMocks.findOrCreateAuthoritySessionForRun,
		).not.toHaveBeenCalled();
		expect(policyMocks.evaluateAuthorityPolicy).not.toHaveBeenCalled();
	});

	it("uses a blockedBy value distinct from the policy outcomes", () => {
		expect(AUTHORITY_CHECK_FAILED).not.toBe("authority_missing");
		expect(AUTHORITY_CHECK_FAILED).not.toBe("step_approval_required");
	});
});

describe("checkStepAuthorityActivity — whole-step access level", () => {
	it("classifies [READ, WRITE] tools as a WRITE step for every enabled provider", async () => {
		dbMocks.listMcpConfigsForTenant.mockResolvedValue([githubConfig]);

		await checkStepAuthorityActivity({
			userId: "user-1",
			organizationId: "org-1",
			step: { ...baseStep, toolsToUse: ["list_issues", "delete_repo"] },
		});

		expect(policyMocks.evaluateAuthorityPolicy).toHaveBeenCalledTimes(1);
		const call = policyMocks.evaluateAuthorityPolicy.mock.calls[0][0];
		expect(call.requiredProviders).toEqual([
			{ providerKey: "github", accessLevel: "WRITE" },
		]);
	});

	it("keeps an all-read step at READ", async () => {
		dbMocks.listMcpConfigsForTenant.mockResolvedValue([githubConfig]);

		await checkStepAuthorityActivity({
			userId: "user-1",
			organizationId: "org-1",
			step: { ...baseStep, toolsToUse: ["list_issues", "get_issue"] },
		});

		const call = policyMocks.evaluateAuthorityPolicy.mock.calls[0][0];
		expect(call.requiredProviders).toEqual([
			{ providerKey: "github", accessLevel: "READ" },
		]);
	});

	it("defaults a step with no named tools to WRITE", async () => {
		dbMocks.listMcpConfigsForTenant.mockResolvedValue([githubConfig]);

		await checkStepAuthorityActivity({
			userId: "user-1",
			organizationId: "org-1",
			step: { ...baseStep },
		});

		const call = policyMocks.evaluateAuthorityPolicy.mock.calls[0][0];
		expect(call.requiredProviders).toEqual([
			{ providerKey: "github", accessLevel: "WRITE" },
		]);
	});
});

describe("checkStepAuthorityActivity — unchanged positive paths", () => {
	it("allows a step when the policy allows it", async () => {
		dbMocks.listMcpConfigsForTenant.mockResolvedValue([githubConfig]);
		policyMocks.evaluateAuthorityPolicy.mockResolvedValue({
			allowed: true,
			trustAutoApproved: true,
		});

		const result = await checkStepAuthorityActivity({
			userId: "user-1",
			organizationId: "org-1",
			step: { ...baseStep, toolsToUse: ["list_issues"] },
		});

		expect(result).toEqual({
			allowed: true,
			blockedBy: undefined,
			blockedDetails: undefined,
			trustAutoApproved: true,
		});
	});

	it("allows immediately when the tenant has no enabled MCP configs", async () => {
		dbMocks.listMcpConfigsForTenant.mockResolvedValue([
			{ ...githubConfig, enabled: false },
		]);

		const result = await checkStepAuthorityActivity({
			userId: "user-1",
			organizationId: "org-1",
			step: { ...baseStep, toolsToUse: ["list_issues"] },
		});

		expect(result).toEqual({ allowed: true });
		expect(policyMocks.evaluateAuthorityPolicy).not.toHaveBeenCalled();
	});

	it("does not touch the MCP configs for a non-MCP capability without tools", async () => {
		const result = await checkStepAuthorityActivity({
			userId: "user-1",
			organizationId: "org-1",
			step: { ...baseStep, capability: "llm" },
		});

		expect(result).toEqual({ allowed: true });
		expect(dbMocks.listMcpConfigsForTenant).not.toHaveBeenCalled();
	});
});

describe("maxToolAccessLevel", () => {
	it("returns the most privileged level across the step's tools", () => {
		expect(maxToolAccessLevel(["list_issues", "delete_repo"])).toBe(
			"WRITE",
		);
		expect(maxToolAccessLevel(["delete_repo", "list_issues"])).toBe(
			"WRITE",
		);
		expect(maxToolAccessLevel(["list_issues", "get_issue"])).toBe("READ");
	});

	it("treats an empty tool list as WRITE (conservative default)", () => {
		expect(maxToolAccessLevel([])).toBe("WRITE");
	});
});

describe("extractRequiredProviders — per-provider maximum", () => {
	const toolToConfig = {
		list_issues: { serverName: "github", configId: "cfg-github" },
		delete_repo: { serverName: "github", configId: "cfg-github" },
		search_pages: { serverName: "notion", configId: "cfg-notion" },
	};

	it("raises a provider to WRITE when any of its tools is a write, regardless of order", () => {
		const step = {
			...baseStep,
			toolsToUse: ["list_issues", "delete_repo", "search_pages"],
		};

		expect(extractRequiredProviders(step as never, toolToConfig)).toEqual([
			{ providerKey: "github", accessLevel: "WRITE" },
			{ providerKey: "notion", accessLevel: "READ" },
		]);
	});

	it("never lowers a provider from WRITE back to READ", () => {
		const step = {
			...baseStep,
			toolsToUse: ["delete_repo", "list_issues"],
		};

		expect(extractRequiredProviders(step as never, toolToConfig)).toEqual([
			{ providerKey: "github", accessLevel: "WRITE" },
		]);
	});
});
