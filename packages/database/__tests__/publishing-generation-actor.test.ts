/**
 * `checkPublishingGenerationActor` — the point-of-use re-check for Publishing
 * Suite generation runs.
 *
 * The defect it replaced: the five generation activities re-checked
 * `isCurrentOrgMember`, while the API gate that authorized the run had checked
 * `PUBLISHING_TOPIC_UPDATE` on the PROJECT. That gate's precedence is
 * owner -> active ProjectMember -> org role, so org membership is the LAST of
 * three paths. An actor authorized by the second — a project-scoped guest with
 * an EDITOR row, the collaborator the project-invite flow exists to create —
 * passed the gate, had a GENERATING draft row written for them, and was then
 * refused by the activity. Every time, for two shipped phases.
 *
 * The load-bearing case here is therefore "guest EDITOR, no org membership,
 * ALLOWED". Its opposite number is "demoted org admin, VIEWER row, REFUSED":
 * mirroring the gate must not become a synonym for saying yes.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/publishing-generation-actor.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	memberFindFirst: vi.fn(),
	projectMemberFindUnique: vi.fn(),
}));

// `projects.ts` resolves its `db` import to `../../client` from its position at
// `prisma/queries/projects/`; from this test that same module is
// `../prisma/client`. The module also imports `Prisma` / `ProjectMemberRole` as
// values, so the mock must provide them for the import to bind.
vi.mock("../prisma/client", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		member: { findFirst: mocks.memberFindFirst },
		projectMember: { findUnique: mocks.projectMemberFindUnique },
	},
	Prisma: { JsonNull: Symbol("JsonNull") },
	ProjectMemberRole: {
		OWNER: "OWNER",
		PROJECT_ADMIN: "PROJECT_ADMIN",
		EDITOR: "EDITOR",
		COMMENTER: "COMMENTER",
		VIEWER: "VIEWER",
	},
}));

import { resolveProjectAccess } from "../prisma/queries/projects/projects";
import { checkPublishingGenerationActor } from "../prisma/queries/projects/publishing-generation-actor";

const PROJECT_ID = "proj-1";
const ORG_ID = "org-A";
const OTHER_ORG_ID = "org-B";
const OWNER_ID = "user-owner";
const USER_ID = "user-x";

const run = (organizationId: string | null = ORG_ID) =>
	checkPublishingGenerationActor({
		projectId: PROJECT_ID,
		organizationId,
		actorUserId: USER_ID,
	});

function orgProject(organizationId: string = ORG_ID) {
	mocks.projectFindUnique.mockResolvedValue({
		userId: OWNER_ID,
		organizationId,
	});
}

function activeRow(role: string) {
	mocks.projectMemberFindUnique.mockResolvedValue({
		role,
		acceptedAt: new Date(),
		expiresAt: null,
	});
}

beforeEach(() => {
	mocks.projectFindUnique.mockReset();
	mocks.memberFindFirst.mockReset();
	mocks.projectMemberFindUnique.mockReset();
	mocks.projectMemberFindUnique.mockResolvedValue(null);
	mocks.memberFindFirst.mockResolvedValue(null);
});

describe("the actor half — it asks the gate's question", () => {
	it("ALLOWS a project EDITOR who is not a member of the organization", () => {
		// THE defect. This actor passes `requireProjectPermission(
		// PUBLISHING_TOPIC_UPDATE)` on the ProjectMember path and was then
		// refused by the activity's org-membership re-check.
		orgProject();
		activeRow("EDITOR");

		return expect(run()).resolves.toEqual({ ok: true });
	});

	it("does NOT consult the organization when an active project row decides", async () => {
		// The mirror image, and the reason "mirror the gate" is not a synonym
		// for "say yes": an org admin explicitly demoted to VIEWER on this one
		// project is refused, and their org role is never even read.
		orgProject();
		activeRow("VIEWER");
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		await expect(run()).resolves.toEqual({
			ok: false,
			reason: "NOT_AUTHORIZED",
			currentOrganizationId: ORG_ID,
		});
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("ALLOWS a plain organization member with no project row", () => {
		orgProject();
		mocks.memberFindFirst.mockResolvedValue({ role: "member" });

		return expect(run()).resolves.toEqual({ ok: true });
	});

	it("REFUSES an organization viewer — membership alone is not the question", () => {
		// The other direction of the same defect. `isCurrentOrgMember` answered
		// yes for this actor; the gate answers no, because the org `viewer` role
		// does not carry PUBLISHING_TOPIC_UPDATE.
		orgProject();
		mocks.memberFindFirst.mockResolvedValue({ role: "viewer" });

		return expect(run()).resolves.toEqual({
			ok: false,
			reason: "NOT_AUTHORIZED",
			currentOrganizationId: ORG_ID,
		});
	});

	it("REFUSES someone with no standing anywhere", () => {
		orgProject();

		return expect(run()).resolves.toEqual({
			ok: false,
			reason: "NOT_AUTHORIZED",
			currentOrganizationId: ORG_ID,
		});
	});

	it("treats an expired project row as absent and falls back to the org role", () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: new Date(Date.now() - 1_000_000),
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });

		return expect(run()).resolves.toEqual({ ok: true });
	});

	it("treats an unaccepted invitation as absent", () => {
		orgProject();
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "EDITOR",
			acceptedAt: null,
			expiresAt: null,
		});

		return expect(run()).resolves.toEqual({
			ok: false,
			reason: "NOT_AUTHORIZED",
			currentOrganizationId: ORG_ID,
		});
	});
});

describe("the tenant half — defence in depth, not a fix", () => {
	// Nothing in the product moves a project between organizations today:
	// `PROJECT_TRANSFER` is declared in the permission vocabulary and consumed
	// by nothing, and no production query writes `Project.organizationId` after
	// creation. These cases prove the comparison is WIRED. They do not
	// demonstrate a live defect, and should not be cited as though they did.

	it("REFUSES when the project now belongs to a different organization", () => {
		orgProject(OTHER_ORG_ID);
		activeRow("EDITOR");

		return expect(run(ORG_ID)).resolves.toEqual({
			ok: false,
			reason: "TENANT_MISMATCH",
			// The field that makes the operator log worth reading.
			currentOrganizationId: OTHER_ORG_ID,
		});
	});

	it("REFUSES a personal project when the run was queued under an organization", () => {
		mocks.projectFindUnique.mockResolvedValue({
			userId: USER_ID,
			organizationId: null,
		});

		return expect(run(ORG_ID)).resolves.toEqual({
			ok: false,
			reason: "TENANT_MISMATCH",
			currentOrganizationId: null,
		});
	});

	it("REFUSES an organization project when the run carries no organization", () => {
		orgProject();
		activeRow("EDITOR");

		return expect(run(null)).resolves.toEqual({
			ok: false,
			reason: "TENANT_MISMATCH",
			currentOrganizationId: ORG_ID,
		});
	});

	it("calls a missing project a TENANT mismatch, not an authorization failure", () => {
		// Saying "you are not allowed" about a row that no longer exists would
		// be a false statement about a person, stored on a draft and rendered.
		mocks.projectFindUnique.mockResolvedValue(null);

		return expect(run()).resolves.toEqual({
			ok: false,
			reason: "TENANT_MISMATCH",
			currentOrganizationId: null,
		});
	});

	it("ALLOWS a personal-project owner when the run also carries no organization", () => {
		// Unreachable in production — the Publishing Suite feature gate refuses
		// a project with no organization (ADR-018) — so this is a fail-closed
		// unit case, not coverage of a live path.
		mocks.projectFindUnique.mockResolvedValue({
			userId: USER_ID,
			organizationId: null,
		});

		return expect(run(null)).resolves.toEqual({ ok: true });
	});
});

describe("resolveProjectAccess — the shape callers depend on", () => {
	it("reports the personal owner as `owner`, which is the gate's short-circuit", async () => {
		// `source` is not decoration. The middleware passes a personal-project
		// owner unconditionally, for ANY project permission including ones
		// outside the OWNER set (no project role grants AGENT_CREATE, and an
		// owner may still do it). A caller that reads only `permissions` answers
		// "no" where the gate answers "yes".
		mocks.projectFindUnique.mockResolvedValue({
			userId: USER_ID,
			organizationId: null,
		});

		const access = await resolveProjectAccess(PROJECT_ID, USER_ID);

		expect(access?.source).toBe("owner");
		expect(access?.organizationId).toBeNull();
	});

	it("does not issue the project-member lookup on the owner path", async () => {
		// Serial by design, not by accident: the API-side resolver fetches both
		// rows in parallel and accepts a discarded lookup because it runs on
		// every request. A background caller runs once per job and buys nothing
		// with that trade.
		mocks.projectFindUnique.mockResolvedValue({
			userId: USER_ID,
			organizationId: null,
		});

		await resolveProjectAccess(PROJECT_ID, USER_ID);

		expect(mocks.projectMemberFindUnique).not.toHaveBeenCalled();
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});

	it("reports the project's CURRENT organization, not the caller's belief about it", async () => {
		orgProject(OTHER_ORG_ID);
		activeRow("EDITOR");

		const access = await resolveProjectAccess(PROJECT_ID, USER_ID);

		expect(access?.organizationId).toBe(OTHER_ORG_ID);
		expect(access?.source).toBe("project-member");
	});

	it("returns null for a project that does not exist", () => {
		mocks.projectFindUnique.mockResolvedValue(null);

		return expect(
			resolveProjectAccess(PROJECT_ID, USER_ID),
		).resolves.toBeNull();
	});
});
