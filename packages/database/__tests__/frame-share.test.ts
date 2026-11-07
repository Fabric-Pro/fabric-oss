/** Canonical sharing policy and atomic revocation, with transactional fake storage. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	frame: null as any,
	grants: [] as any[],
	audits: [] as any[],
	policy: null as any,
	failAudit: false,
}));
const calls = vi.hoisted(() => ({
	update: vi.fn(),
	create: vi.fn(),
	remove: vi.fn(),
	audit: vi.fn(),
	lock: vi.fn(),
}));
vi.mock("../prisma/client", async (original) => {
	const actual = await original<typeof import("../prisma/client")>();
	const tx = {
		frameApprovedRevision: {
			findFirst: vi.fn().mockResolvedValue(null),
			create: vi.fn(async ({ data }) => ({ id: data.id, ...data })),
		},
		$queryRaw: calls.lock,
		agentWorkspaceFile: {
			findFirst: async ({ where }: any) =>
				store.frame &&
				where.id === store.frame.id &&
				where.userId === store.frame.userId &&
				where.organizationId === store.frame.organizationId
					? structuredClone(store.frame)
					: null,
			update: calls.update,
		},
		organization: { findUnique: async () => store.policy },
		frameSharingGrant: {
			findMany: async ({ where }: any) =>
				store.grants.filter(
					(g) =>
						g.frameId === where.frameId &&
						(!where.email?.in || where.email.in.includes(g.email)),
				),
			createMany: calls.create,
			deleteMany: calls.remove,
		},
		auditLog: { create: calls.audit },
	};
	return {
		...actual,
		db: {
			...tx,
			$transaction: async (fn: any) => {
				const before = structuredClone({
					frame: store.frame,
					grants: store.grants,
					audits: store.audits,
				});
				try {
					return await fn(tx);
				} catch (e) {
					Object.assign(store, before);
					throw e;
				}
			},
		},
	};
});

import { FrameUpdateConflictError } from "../prisma/queries/frame-revision";
import {
	PUBLIC_SHARING_DISABLED_MESSAGE,
	publicSharingRefusal,
	revokeFrameSharing,
	shareFrame,
} from "../prisma/queries/frame-share";

const revision = new Date("2026-11-01T00:00:00Z");
const actor = {
	frameId: "example-frame",
	userId: "example-owner",
	organizationId: "example-org",
};
const grant = (email: string) => ({
	id: `example-${email}`,
	frameId: actor.frameId,
	email,
	invitedBy: actor.userId,
	invitedAt: revision,
	lastAccessedAt: null,
	accessCount: 0,
});
const share = (input: Partial<Parameters<typeof shareFrame>[0]> = {}) =>
	shareFrame({ ...actor, ...input });
const revoke = (
	mode: Parameters<typeof revokeFrameSharing>[0]["mode"],
	extra: Partial<Parameters<typeof revokeFrameSharing>[0]> = {},
) => revokeFrameSharing({ ...actor, mode, ...extra });
beforeEach(() => {
	vi.clearAllMocks();
	store.frame = {
		id: actor.frameId,
		userId: actor.userId,
		organizationId: actor.organizationId,
		projectId: null,
		shareScope: "PRIVATE",
		shareToken: null,
		isPublic: false,
		updatedAt: revision,
		content: JSON.stringify({
			version: 1,
			kind: "frame",
			title: "Example private page",
			blocks: [
				{
					id: "main",
					type: "markdown",
					content: "Example private content",
				},
			],
		}),
	};
	store.grants = [];
	store.audits = [];
	store.failAudit = false;
	store.policy = {
		canShareFramesPublicly: false,
		allowedFrameShareDomains: [],
	};
	calls.update.mockImplementation(async ({ where, data }: any) => {
		if (where.updatedAt.getTime() !== store.frame.updatedAt.getTime()) {
			throw Object.assign(new Error("Stale"), { code: "P2025" });
		}
		store.frame = { ...store.frame, ...data };
		return structuredClone(store.frame);
	});
	calls.create.mockImplementation(async ({ data }: any) => {
		store.grants.push(...data.map((g: any) => grant(g.email)));
		return { count: data.length };
	});
	calls.remove.mockImplementation(async ({ where }: any) => {
		const before = store.grants.length;
		store.grants = store.grants.filter(
			(g) =>
				!(
					g.frameId === where.frameId &&
					(!where.email || g.email === where.email)
				),
		);
		return { count: before - store.grants.length };
	});
	calls.audit.mockImplementation(async ({ data }: any) => {
		if (store.failAudit) {
			throw new Error("Audit unavailable");
		}
		store.audits.push(data);
		return { id: "example-audit", ...data };
	});
});

describe("sharing policy", () => {
	it.each([
		{ userId: "example-stranger" },
		{ organizationId: "example-other-org" },
		{ organizationId: undefined },
	])("rejects a caller outside ownership and tenant: %s", async (input) => {
		expect(await share({ scope: "EMAILS_ONLY", ...input })).toMatchObject({
			ok: false,
			reason: "frame_not_found",
		});
		expect(calls.update).not.toHaveBeenCalled();
		expect(calls.audit).not.toHaveBeenCalled();
	});
	it("refuses public links without policy and without mutating the audience", async () => {
		expect(await share({ scope: "PUBLIC" })).toMatchObject({
			ok: false,
			reason: "public_sharing_disabled",
			message: PUBLIC_SHARING_DISABLED_MESSAGE,
		});
		expect(store.frame.shareScope).toBe("PRIVATE");
		expect(calls.update).not.toHaveBeenCalled();
	});
	it("does not invite or change audiences for a deleted or missing organization", async () => {
		store.policy = null;
		expect(
			await share({
				scope: "EMAILS_ONLY",
				emails: ["person@example.com"],
			}),
		).toMatchObject({ ok: false, reason: "frame_not_found" });
		expect(calls.update).not.toHaveBeenCalled();
		expect(store.grants).toEqual([]);
	});
	it("refuses a missing organization's public policy", async () => {
		store.policy = null;
		expect(await share({ scope: "PUBLIC" })).toMatchObject({
			ok: false,
			reason: "public_sharing_disabled",
		});
	});
	it("creates a public token only through an explicit share command", async () => {
		store.policy.canShareFramesPublicly = true;
		const result = await share({
			scope: "PUBLIC",
			expectedUpdatedAt: revision,
		});
		expect(result).toMatchObject({
			ok: true,
			scope: "PUBLIC",
			shareToken: expect.any(String),
		});
		expect(store.frame.isPublic).toBe(true);
		expect(store.frame.shareToken).toBeTruthy();
		expect(store.audits[0].action).toBe("frame.sharing.updated");
	});
	it("never returns an existing token from an unrelated invitation request", async () => {
		store.frame.shareScope = "PUBLIC";
		store.frame.isPublic = true;
		store.frame.shareToken = "example-bearer";
		const result = await share();
		expect(result).not.toHaveProperty("shareToken");
	});
	it("keeps domain checks exact, normalized, and atomic with the scope change", async () => {
		store.policy.allowedFrameShareDomains = ["@Example.com"];
		expect(
			await share({
				scope: "EMAILS_ONLY",
				emails: ["one@example.com", "other@example.com.outside.test"],
			}),
		).toMatchObject({
			ok: false,
			reason: "email_domain_not_allowed",
			emails: ["other@example.com.outside.test"],
		});
		expect(store.frame.shareScope).toBe("PRIVATE");
		expect(store.grants).toEqual([]);
	});
	it("normalizes and deduplicates allowed invitations without adding duplicates", async () => {
		store.policy.allowedFrameShareDomains = ["example.com"];
		store.grants = [grant("first@example.com")];
		const result = await share({
			scope: "WORKSPACE_AND_EMAILS",
			emails: [
				"First@Example.com",
				"SECOND@example.com",
				"second@example.com",
			],
		});
		expect(result).toMatchObject({
			ok: true,
			invited: ["second@example.com"],
			grants: [expect.objectContaining({ email: "second@example.com" })],
		});
		expect(store.grants).toHaveLength(2);
		expect(store.frame.shareScope).toBe("WORKSPACE_AND_EMAILS");
	});
	it.each(["PRIVATE", "PUBLIC"] as const)(
		"refuses invitations while %s, including a scope change",
		async (scope) => {
			expect(
				await share({ scope, emails: ["person@example.com"] }),
			).toMatchObject({
				ok: false,
				reason: "emails_need_an_inviting_scope",
			});
			expect(store.grants).toEqual([]);
			expect(calls.update).not.toHaveBeenCalled();
		},
	);
	it("requires an inviting audience before adding an email to a project-scoped page", async () => {
		store.frame.shareScope = "PROJECT";
		expect(await share({ emails: ["person@example.com"] })).toMatchObject({
			ok: false,
			reason: "emails_need_an_inviting_scope",
		});
		expect(store.grants).toEqual([]);
	});
	it("refuses invalid invitation addresses before changing data", async () => {
		expect(
			await share({ scope: "EMAILS_ONLY", emails: ["invalid"] }),
		).toMatchObject({ ok: false, reason: "invalid_email" });
		expect(calls.create).not.toHaveBeenCalled();
	});
	it("uses the same public policy for creation and sharing", async () => {
		expect(await publicSharingRefusal(actor.organizationId)).toBe(
			PUBLIC_SHARING_DISABLED_MESSAGE,
		);
		store.policy.canShareFramesPublicly = true;
		expect(await publicSharingRefusal(actor.organizationId)).toBeNull();
		expect(await publicSharingRefusal(undefined)).toBe(
			PUBLIC_SHARING_DISABLED_MESSAGE,
		);
	});
});

describe("revocation and revisions", () => {
	beforeEach(() => {
		store.frame.shareScope = "PUBLIC";
		store.frame.isPublic = true;
		store.frame.shareToken = "example-old-bearer";
		store.grants = [
			grant("first@example.com"),
			grant("second@example.com"),
		];
	});
	it("removes only the public link and preserves explicit email invitations", async () => {
		expect(await revoke("public-link")).toMatchObject({
			ok: true,
			scope: "EMAILS_ONLY",
			revokedInvitations: 0,
		});
		expect(store.frame).toMatchObject({
			isPublic: false,
			shareToken: null,
		});
		expect(store.grants).toHaveLength(2);
	});
	it("removes one invitation without altering unrelated access", async () => {
		expect(
			await revoke("invitation", { email: "FIRST@Example.com" }),
		).toMatchObject({ ok: true, scope: "PUBLIC", revokedInvitations: 1 });
		expect(store.frame).toMatchObject({
			isPublic: true,
			shareToken: "example-old-bearer",
		});
		expect(store.grants.map((g) => g.email)).toEqual([
			"second@example.com",
		]);
	});
	it("revokes all legacy and modern access paths atomically", async () => {
		expect(await revoke("all")).toMatchObject({
			ok: true,
			scope: "PRIVATE",
			revokedInvitations: 2,
		});
		expect(store.frame).toMatchObject({
			shareScope: "PRIVATE",
			shareToken: null,
			isPublic: false,
		});
		expect(store.grants).toEqual([]);
	});
	it("PRIVATE clears dormant grants so a future scope change cannot resurrect them", async () => {
		await share({ scope: "PRIVATE" });
		await share({ scope: "EMAILS_ONLY" });
		expect(store.grants).toEqual([]);
		expect(store.frame.shareToken).toBeNull();
	});
	it("rejects stale share and revoke without changing any access", async () => {
		const stale = new Date(revision.getTime() - 1);
		await expect(
			share({ scope: "PRIVATE", expectedUpdatedAt: stale }),
		).rejects.toBeInstanceOf(FrameUpdateConflictError);
		await expect(
			revoke("all", { expectedUpdatedAt: stale }),
		).rejects.toBeInstanceOf(FrameUpdateConflictError);
		expect(store.grants).toHaveLength(2);
		expect(store.frame.shareToken).toBe("example-old-bearer");
		expect(store.audits).toEqual([]);
	});
	it("rolls scope, grant, and token changes back when audit recording fails", async () => {
		store.failAudit = true;
		await expect(revoke("all")).rejects.toThrow("Audit unavailable");
		expect(store.frame).toMatchObject({
			shareScope: "PUBLIC",
			shareToken: "example-old-bearer",
			isPublic: true,
		});
		expect(store.grants).toHaveLength(2);
		await expect(
			share({ scope: "EMAILS_ONLY", emails: ["third@example.com"] }),
		).rejects.toThrow("Audit unavailable");
		expect(store.grants).toHaveLength(2);
		expect(store.frame.shareScope).toBe("PUBLIC");
	});
	it("increments revision for invitation removal and excludes bearer/email/content from audit", async () => {
		const result = await revoke("invitation", {
			email: "first@example.com",
		});
		expect(result.ok && result.updatedAt.getTime()).toBeGreaterThan(
			revision.getTime(),
		);
		const audit = JSON.stringify(store.audits);
		expect(audit).not.toContain("example-old-bearer");
		expect(audit).not.toContain("first@example.com");
		expect(audit).not.toContain("example private content");
	});
	it("rejects an invalid revoke action without writing", async () => {
		expect(await revoke("unknown" as "all")).toMatchObject({
			ok: false,
			reason: "invalid_revoke_mode",
		});
		expect(calls.update).not.toHaveBeenCalled();
	});
	it("does not recreate a removed public token when publishing again", async () => {
		await revoke("public-link");
		store.policy.canShareFramesPublicly = true;
		const result = await share({ scope: "PUBLIC" });
		expect(result.ok && result.shareToken).not.toBe("example-old-bearer");
	});
});

it("never admits an organization-less public share even for a legacy owner record", async () => {
	store.frame.organizationId = null;
	store.policy.canShareFramesPublicly = true;
	expect(
		await share({ scope: "PUBLIC", organizationId: undefined }),
	).toMatchObject({ ok: false, reason: "frame_not_found" });
	expect(calls.update).not.toHaveBeenCalled();
	expect(store.frame.shareToken).toBeNull();
});
