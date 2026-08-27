import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: { user: { findUnique: vi.fn() } },
	enrollProjectMemberIfNewsletterEnabled: vi.fn(),
	reconcilePendingInvitesForUser: vi.fn(),
	recordAudit: vi.fn(),
}));

vi.mock("@repo/agent-core/backend", () => ({
	seedDefaultMcpConfigsForTenant: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("../organization", () => ({
	updateSeatsInOrganizationSubscription: vi.fn(),
}));

import { seedDefaultMcpConfigsForTenant } from "@repo/agent-core/backend";
import {
	db,
	enrollProjectMemberIfNewsletterEnabled,
	type ReconcilePendingInvitesResult,
	reconcilePendingInvitesForUser,
	recordAudit,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { Mock } from "vitest";
import {
	type InviteReconciliationTrigger,
	runInviteReconciliationForUser,
} from "../invite-reconciliation";
import { updateSeatsInOrganizationSubscription } from "../organization";

const VERIFIED_USER = {
	id: "user-1",
	email: "user@example.com",
	name: "User One",
	emailVerified: true,
};

function mockUser(user: unknown): void {
	(db.user.findUnique as unknown as Mock).mockResolvedValue(user);
}

function buildResult(
	overrides: Partial<ReconcilePendingInvitesResult> = {},
): ReconcilePendingInvitesResult {
	return {
		orgInvitesFound: 0,
		orgMembershipsCreated: 0,
		projectInvitesFound: 0,
		projectMembershipsCreated: 0,
		createdOrgMemberships: [],
		createdProjectMemberships: [],
		skipped: [],
		warnings: [],
		...overrides,
	};
}

function mockResult(
	overrides: Partial<ReconcilePendingInvitesResult> = {},
): void {
	(reconcilePendingInvitesForUser as Mock).mockResolvedValue(
		buildResult(overrides),
	);
}

const ORG_GRANT = {
	organizationId: "org-1",
	memberId: "member-1",
	role: "admin",
	invitationIds: ["inv-1", "inv-2"],
};

const PROJECT_GRANT = {
	projectId: "proj-1",
	memberId: "pmember-1",
	role: "EDITOR" as const,
	invitationId: "pinv-1",
};

describe("runInviteReconciliationForUser — gating", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("never calls the core for an unverified email and logs an info skip", async () => {
		mockUser({ ...VERIFIED_USER, emailVerified: false });

		await expect(
			runInviteReconciliationForUser({
				userId: "user-1",
				trigger: "user_create",
			}),
		).resolves.toBeUndefined();

		expect(reconcilePendingInvitesForUser).not.toHaveBeenCalled();
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("email not verified"),
			expect.objectContaining({
				trigger: "user_create",
				userId: "user-1",
				reason: "email_unverified",
			}),
		);
	});

	it("calls the core with the normalized email for a verified user", async () => {
		mockUser({ ...VERIFIED_USER, email: " User@Example.COM " });
		mockResult();

		await runInviteReconciliationForUser({
			userId: "user-1",
			trigger: "session_create",
		});

		expect(db.user.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "user-1" } }),
		);
		expect(reconcilePendingInvitesForUser).toHaveBeenCalledTimes(1);
		expect(reconcilePendingInvitesForUser).toHaveBeenCalledWith({
			userId: "user-1",
			email: "user@example.com",
		});
	});

	it("logs a warn and resolves when the user row is missing", async () => {
		mockUser(null);

		await expect(
			runInviteReconciliationForUser({
				userId: "ghost",
				trigger: "session_create",
			}),
		).resolves.toBeUndefined();

		expect(reconcilePendingInvitesForUser).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("user not found"),
			expect.objectContaining({
				trigger: "session_create",
				userId: "ghost",
			}),
		);
	});
});

describe("runInviteReconciliationForUser — org-grant side effects", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockUser(VERIFIED_USER);
	});

	it("fires all three side effects once per created org membership", async () => {
		const secondGrant = {
			organizationId: "org-2",
			memberId: "member-2",
			role: "member",
			invitationIds: ["inv-3"],
		};
		mockResult({
			orgInvitesFound: 3,
			orgMembershipsCreated: 2,
			createdOrgMemberships: [ORG_GRANT, secondGrant],
		});

		await runInviteReconciliationForUser({
			userId: "user-1",
			trigger: "email_verification",
		});

		expect(seedDefaultMcpConfigsForTenant).toHaveBeenCalledTimes(2);
		expect(seedDefaultMcpConfigsForTenant).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(seedDefaultMcpConfigsForTenant).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-2",
		});

		expect(recordAudit).toHaveBeenCalledTimes(2);
		expect(updateSeatsInOrganizationSubscription).toHaveBeenCalledTimes(2);
		expect(updateSeatsInOrganizationSubscription).toHaveBeenCalledWith(
			"org-1",
		);
		expect(updateSeatsInOrganizationSubscription).toHaveBeenCalledWith(
			"org-2",
		);
	});

	it("records the audit row with the exact reconciliation shape", async () => {
		mockResult({
			orgInvitesFound: 2,
			orgMembershipsCreated: 1,
			createdOrgMemberships: [ORG_GRANT],
		});

		await runInviteReconciliationForUser({
			userId: "user-1",
			trigger: "user_create",
		});

		expect(recordAudit).toHaveBeenCalledTimes(1);
		expect(recordAudit).toHaveBeenCalledWith({
			action: "org.member.invited",
			category: "org",
			actor: {
				type: "user",
				userId: "user-1",
				emailSnapshot: "user@example.com",
				nameSnapshot: "User One",
			},
			organizationId: "org-1",
			resource: {
				type: "user",
				id: "user-1",
				name: "user@example.com",
			},
			metadata: {
				role: "admin",
				via: "signup_reconciliation",
				invitationIds: ["inv-1", "inv-2"],
			},
		});
	});

	it("fires no side effects for skipped invites", async () => {
		mockResult({
			orgInvitesFound: 1,
			skipped: [
				{
					type: "organization",
					invitationId: "inv-9",
					reason: "already_member",
				},
			],
		});

		await runInviteReconciliationForUser({
			userId: "user-1",
			trigger: "session_create",
		});

		expect(seedDefaultMcpConfigsForTenant).not.toHaveBeenCalled();
		expect(recordAudit).not.toHaveBeenCalled();
		expect(updateSeatsInOrganizationSubscription).not.toHaveBeenCalled();
	});

	it("fires no org-grant side effects for project grants (guest-scoped)", async () => {
		mockResult({
			projectInvitesFound: 1,
			projectMembershipsCreated: 1,
			createdProjectMemberships: [PROJECT_GRANT],
		});

		await runInviteReconciliationForUser({
			userId: "user-1",
			trigger: "session_create",
		});

		expect(seedDefaultMcpConfigsForTenant).not.toHaveBeenCalled();
		expect(recordAudit).not.toHaveBeenCalled();
		expect(updateSeatsInOrganizationSubscription).not.toHaveBeenCalled();
		// The grant itself is still logged.
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("created project membership"),
			expect.objectContaining({
				projectId: "proj-1",
				memberId: "pmember-1",
				role: "EDITOR",
			}),
		);
	});

	// Fizzy #2290 — the one side effect project grants DO share with the
	// manual accept path, so someone who signs up straight into an already
	// enabled project appears in its recipient list at once.
	it("enrols newsletter subscribers for each created project membership", async () => {
		mockResult({
			projectInvitesFound: 1,
			projectMembershipsCreated: 1,
			createdProjectMemberships: [PROJECT_GRANT],
		});

		await runInviteReconciliationForUser({
			userId: "user-1",
			trigger: "session_create",
		});

		expect(enrollProjectMemberIfNewsletterEnabled).toHaveBeenCalledTimes(1);
		expect(enrollProjectMemberIfNewsletterEnabled).toHaveBeenCalledWith({
			projectId: "proj-1",
			// The reconciled user's own verified address, normalized.
			email: "user@example.com",
		});
	});

	it("does not enrol when no project membership was created", async () => {
		mockResult({ projectInvitesFound: 1, projectMembershipsCreated: 0 });

		await runInviteReconciliationForUser({
			userId: "user-1",
			trigger: "session_create",
		});

		expect(enrollProjectMemberIfNewsletterEnabled).not.toHaveBeenCalled();
	});

	it("logs and continues when newsletter enrolment throws", async () => {
		mockResult({
			projectInvitesFound: 1,
			projectMembershipsCreated: 1,
			createdProjectMemberships: [PROJECT_GRANT],
		});
		(enrollProjectMemberIfNewsletterEnabled as Mock).mockRejectedValueOnce(
			new Error("newsletter is down"),
		);

		// The membership is already committed; a newsletter outage must not
		// take down the sign-in hook that got us here.
		await expect(
			runInviteReconciliationForUser({
				userId: "user-1",
				trigger: "session_create",
			}),
		).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("newsletter enrolment failed"),
			expect.objectContaining({ projectId: "proj-1" }),
		);
	});
});

describe("runInviteReconciliationForUser — never throws", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockUser(VERIFIED_USER);
	});

	it("logs an error and resolves when the core throws", async () => {
		(reconcilePendingInvitesForUser as Mock).mockRejectedValue(
			new Error("db down"),
		);

		await expect(
			runInviteReconciliationForUser({
				userId: "user-1",
				trigger: "session_create",
			}),
		).resolves.toBeUndefined();

		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("failed"),
			expect.objectContaining({
				trigger: "session_create",
				userId: "user-1",
				error: "db down",
			}),
		);
	});

	it("logs an error and resolves when the user lookup throws", async () => {
		(db.user.findUnique as unknown as Mock).mockRejectedValue(
			new Error("connection refused"),
		);

		await expect(
			runInviteReconciliationForUser({
				userId: "user-1",
				trigger: "user_create",
			}),
		).resolves.toBeUndefined();

		expect(logger.error).toHaveBeenCalled();
	});

	it("still attempts the remaining side effects when one throws", async () => {
		mockResult({
			orgInvitesFound: 1,
			orgMembershipsCreated: 1,
			createdOrgMemberships: [ORG_GRANT],
		});
		(seedDefaultMcpConfigsForTenant as Mock).mockRejectedValue(
			new Error("seed exploded"),
		);

		await expect(
			runInviteReconciliationForUser({
				userId: "user-1",
				trigger: "user_create",
			}),
		).resolves.toBeUndefined();

		// Failure logged, but audit + seats still ran.
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("seed default MCP configs"),
			expect.objectContaining({
				organizationId: "org-1",
				error: "seed exploded",
			}),
		);
		expect(recordAudit).toHaveBeenCalledTimes(1);
		expect(updateSeatsInOrganizationSubscription).toHaveBeenCalledTimes(1);
	});

	it("resolves when the seat update throws", async () => {
		mockResult({
			orgInvitesFound: 1,
			orgMembershipsCreated: 1,
			createdOrgMemberships: [ORG_GRANT],
		});
		(updateSeatsInOrganizationSubscription as Mock).mockRejectedValue(
			new Error("billing down"),
		);

		await expect(
			runInviteReconciliationForUser({
				userId: "user-1",
				trigger: "session_create",
			}),
		).resolves.toBeUndefined();

		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("subscription seats"),
			expect.objectContaining({ error: "billing down" }),
		);
	});
});

describe("runInviteReconciliationForUser — structured logging", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockUser(VERIFIED_USER);
	});

	it.each([
		"user_create",
		"email_verification",
		"session_create",
	] satisfies InviteReconciliationTrigger[])(
		"propagates trigger %s into the completion log",
		async (trigger) => {
			mockResult({
				orgInvitesFound: 1,
				skipped: [
					{
						type: "organization",
						invitationId: "inv-1",
						reason: "expired",
					},
				],
			});

			await runInviteReconciliationForUser({ userId: "user-1", trigger });

			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("completed"),
				expect.objectContaining({
					trigger,
					userId: "user-1",
					email: "user@example.com",
					orgInvitesFound: 1,
					skippedCount: 1,
				}),
			);
		},
	);

	it("logs the all-zero no-op at debug, not info", async () => {
		mockResult();

		await runInviteReconciliationForUser({
			userId: "user-1",
			trigger: "session_create",
		});

		expect(logger.debug).toHaveBeenCalledWith(
			expect.stringContaining("no-op"),
			expect.objectContaining({
				trigger: "session_create",
				orgInvitesFound: 0,
				projectInvitesFound: 0,
			}),
		);
		expect(logger.info).not.toHaveBeenCalledWith(
			expect.stringContaining("completed"),
			expect.anything(),
		);
	});

	it("logs each skip with reason, invitationId and type", async () => {
		mockResult({
			orgInvitesFound: 1,
			projectInvitesFound: 1,
			skipped: [
				{
					type: "organization",
					invitationId: "inv-1",
					reason: "expired",
				},
				{
					type: "project",
					invitationId: "pinv-1",
					reason: "already_member",
				},
			],
		});

		await runInviteReconciliationForUser({
			userId: "user-1",
			trigger: "session_create",
		});

		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("skipped"),
			expect.objectContaining({
				type: "organization",
				invitationId: "inv-1",
				reason: "expired",
			}),
		);
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("skipped"),
			expect.objectContaining({
				type: "project",
				invitationId: "pinv-1",
				reason: "already_member",
			}),
		);
	});

	it("logs error-reason skips at error level with the isolated message", async () => {
		mockResult({
			orgInvitesFound: 1,
			skipped: [
				{
					type: "organization",
					invitationId: "inv-1",
					reason: "error",
					message: "tx aborted",
				},
			],
		});

		await runInviteReconciliationForUser({
			userId: "user-1",
			trigger: "session_create",
		});

		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("invite failed"),
			expect.objectContaining({
				type: "organization",
				invitationId: "inv-1",
				reason: "error",
				message: "tx aborted",
			}),
		);
	});

	it("logs a warn for surfaced core warnings (non-null teamId)", async () => {
		mockResult({
			orgInvitesFound: 1,
			orgMembershipsCreated: 1,
			createdOrgMemberships: [ORG_GRANT],
			warnings: [
				{
					type: "organization",
					invitationId: "inv-1",
					organizationId: "org-1",
					code: "team_id_present",
					teamId: "team-1",
				},
			],
		});

		await runInviteReconciliationForUser({
			userId: "user-1",
			trigger: "user_create",
		});

		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("anomaly"),
			expect.objectContaining({
				invitationId: "inv-1",
				organizationId: "org-1",
				code: "team_id_present",
				teamId: "team-1",
			}),
		);
		// Warning never blocks the grant.
		expect(seedDefaultMcpConfigsForTenant).toHaveBeenCalledTimes(1);
	});

	it("logs each org grant with ids, role and consumed invitationIds", async () => {
		mockResult({
			orgInvitesFound: 2,
			orgMembershipsCreated: 1,
			createdOrgMemberships: [ORG_GRANT],
		});

		await runInviteReconciliationForUser({
			userId: "user-1",
			trigger: "email_verification",
		});

		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("created org membership"),
			expect.objectContaining({
				trigger: "email_verification",
				organizationId: "org-1",
				memberId: "member-1",
				role: "admin",
				invitationIds: ["inv-1", "inv-2"],
			}),
		);
	});
});
