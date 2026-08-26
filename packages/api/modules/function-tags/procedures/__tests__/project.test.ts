/**
 * Tests for the project-scoped `functionTags.listForProject` /
 * `functionTags.setForProjectMember` oRPC procedures (Role/Function Tags
 * Stage 1, Task 7).
 *
 * Same two-seam harness as `self.test.ts` (Task 6):
 *
 *   1. Closed-vocabulary enforcement is verified at the SCHEMA level
 *      (`FunctionTagSchema.array().parse(...)`) since `.input()` is a
 *      no-op in the stubbed procedure chain below.
 *   2. Handler BEHAVIOR is verified by mocking the `@repo/database` helper
 *      functions the procedures import (`getProjectMemberFunctionTags`,
 *      `upsertProjectUserFunctionTags`, `hasProjectAccess`) plus
 *      `db.project.findUnique` /
 *      `db.projectMember.findUnique`, and by mocking `recordAuditFromRequest`
 *      to assert on the audit payload (Codex plan finding: audit tenancy
 *      must be PROJECT-derived, never session-derived).
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/function-tags
 */

import { FunctionTagSchema } from "@repo/database/prisma/zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Schema-level: closed vocabulary (the real guard behind `.input(...)`)
// ---------------------------------------------------------------------------

describe("FunctionTagSchema closed vocabulary (project procedures)", () => {
	it("rejects a value outside the 8-tag enum", () => {
		expect(() => FunctionTagSchema.array().parse(["MANAGER"])).toThrow();
	});

	it("parses every valid tag", () => {
		const valid = [
			"PRODUCT_OWNER",
			"PRODUCT_CONTRIBUTOR",
			"DEVELOPER",
			"ARCHITECT",
			"DESIGNER",
			"SDET_QA",
			"SME",
			"STAKEHOLDER",
		];
		expect(() => FunctionTagSchema.array().parse(valid)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Handler behavior: mock the helper functions + db calls the procedures use
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	getProjectMemberFunctionTags: vi.fn(),
	upsertProjectUserFunctionTags: vi.fn(),
	getMyProjectFunctionTagStatus: vi.fn(),
	confirmProjectUserFunctionTags: vi.fn(),
	hasProjectAccess: vi.fn(),
	dbMock: {
		project: { findUnique: vi.fn() },
		projectMember: { findUnique: vi.fn() },
	},
	recordAuditFromRequest: vi.fn(),
	captured: {} as Record<
		string,
		(args: { context: any; input: any }) => Promise<any>
	>,
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getProjectMemberFunctionTags: mocks.getProjectMemberFunctionTags,
		upsertProjectUserFunctionTags: mocks.upsertProjectUserFunctionTags,
		getMyProjectFunctionTagStatus: mocks.getMyProjectFunctionTagStatus,
		confirmProjectUserFunctionTags: mocks.confirmProjectUserFunctionTags,
		hasProjectAccess: mocks.hasProjectAccess,
		db: mocks.dbMock,
	};
});

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) =>
		mocks.recordAuditFromRequest(...args),
}));

// Stub the procedure builder so we can extract the raw handlers. `.input()`
// and `.output()` are intentionally no-ops here — see file header.
vi.mock("../../../../orpc/procedures", () => {
	let pendingKey = "";
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.captured[pendingKey] = fn as any;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy({}, { get: (_: unknown, prop: string) => prop }),
		__setPendingHandlerKey(key: string) {
			pendingKey = key;
		},
	};
});

const procedures = await import("../../../../orpc/procedures");
const setSlot = (
	procedures as unknown as { __setPendingHandlerKey: (key: string) => void }
).__setPendingHandlerKey;

setSlot("listForProject");
await import("../list-for-project");

setSlot("setForProjectMember");
await import("../set-for-project-member");

setSlot("getMyProjectStatus");
await import("../get-my-project-status");

setSlot("confirmForProject");
await import("../confirm-for-project");

const PROJECT_ID = "proj-1";
const OWNER_ID = "owner-1";
const baseCtx = {
	user: { id: "user-1", email: "alice@example.com", name: "Alice" },
	session: {
		id: "sess-1",
		activeOrganizationId: "org-SESSION",
		impersonatedBy: null,
	},
	headers: new Headers(),
};

beforeEach(() => {
	mocks.getProjectMemberFunctionTags.mockReset();
	mocks.upsertProjectUserFunctionTags.mockReset();
	mocks.getMyProjectFunctionTagStatus.mockReset();
	mocks.confirmProjectUserFunctionTags.mockReset();
	mocks.hasProjectAccess.mockReset();
	mocks.dbMock.project.findUnique.mockReset();
	mocks.dbMock.projectMember.findUnique.mockReset();
	mocks.recordAuditFromRequest.mockReset();
	// Default to "has access" — `setForProjectMember`'s tests below focus on
	// other guards and expect this defense-in-depth check to pass unless a
	// test explicitly overrides it (see the FORBIDDEN test in that describe
	// block). `listForProject`'s own tests set this explicitly per-case.
	mocks.hasProjectAccess.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// listForProject
// ---------------------------------------------------------------------------

describe("listForProjectProcedure", () => {
	it("throws FORBIDDEN when hasProjectAccess is false", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			mocks.captured.listForProject({
				context: baseCtx,
				input: { projectId: PROJECT_ID, organizationId: null },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.getProjectMemberFunctionTags).not.toHaveBeenCalled();
	});

	// The roster/de-dup/stale-row join logic itself now lives in the shared
	// `joinRosterFunctionTags` helper (#1767 Stage 4) and is unit-tested at
	// the database layer (`packages/database/prisma/queries/projects/__tests__/function-tags.test.ts`).
	// This test only proves the handler delegates to it with the right
	// projectId and maps `{ userId, tags }` onto the wire shape
	// `{ userId, functionTags }`.
	it("delegates to getProjectMemberFunctionTags and maps tags to functionTags", async () => {
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.getProjectMemberFunctionTags.mockResolvedValue([
			{ userId: OWNER_ID, tags: [] },
			{ userId: "member-1", tags: ["DEVELOPER"] },
			{ userId: "member-2", tags: [] },
		]);

		const result = await mocks.captured.listForProject({
			context: baseCtx,
			input: { projectId: PROJECT_ID, organizationId: null },
		});

		expect(
			mocks.getProjectMemberFunctionTags,
		).toHaveBeenCalledExactlyOnceWith(PROJECT_ID);
		expect(result.members).toEqual([
			{ userId: OWNER_ID, functionTags: [] },
			{ userId: "member-1", functionTags: ["DEVELOPER"] },
			{ userId: "member-2", functionTags: [] },
		]);
	});
});

// ---------------------------------------------------------------------------
// setForProjectMember
// ---------------------------------------------------------------------------

describe("setForProjectMemberProcedure", () => {
	it("throws NOT_FOUND when the project does not exist", async () => {
		mocks.dbMock.project.findUnique.mockResolvedValue(null);

		await expect(
			mocks.captured.setForProjectMember({
				context: baseCtx,
				input: {
					projectId: PROJECT_ID,
					userId: "member-1",
					tags: ["DEVELOPER"],
				},
			}),
		).rejects.toThrow();

		expect(mocks.upsertProjectUserFunctionTags).not.toHaveBeenCalled();
	});

	it("rejects an actor whose org-role permission passes but who lacks project access", async () => {
		// `requireProjectPermission` can grant PROJECT_MEMBERS_MANAGE to an org
		// admin via its org-role fallback even when the admin has no
		// ProjectMember row and doesn't own the project (Codex HIGH finding).
		// The handler's own `hasProjectAccess` re-check must still reject them.
		//
		// The target is the project OWNER (`input.userId === OWNER_ID`, matching
		// `project.userId`) — a VALID target that satisfies target validation
		// (`project.userId === input.userId`) without any `projectMember` row.
		// This is deliberate: if the target were instead some non-owner,
		// non-member user, target validation alone would already throw
		// NOT_FOUND before the write, and the assertions below would pass
		// whether or not the `hasProjectAccess` gate existed — a vacuous test.
		// With a valid owner target, removing the gate would let the handler
		// reach `upsertProjectUserFunctionTags` + `recordAuditFromRequest` for
		// a real unauthorized write, so these assertions genuinely prove the
		// gate — not just check-ordering — prevents that write.
		mocks.dbMock.project.findUnique.mockResolvedValue({
			userId: OWNER_ID,
			organizationId: "org-PROJECT",
		});
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			mocks.captured.setForProjectMember({
				context: baseCtx,
				input: {
					projectId: PROJECT_ID,
					userId: OWNER_ID,
					tags: ["DEVELOPER"],
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.hasProjectAccess).toHaveBeenCalledExactlyOnceWith(
			PROJECT_ID,
			baseCtx.user.id,
		);
		expect(mocks.dbMock.projectMember.findUnique).not.toHaveBeenCalled();
		expect(mocks.upsertProjectUserFunctionTags).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when target is neither creator nor an accepted/unexpired member", async () => {
		mocks.dbMock.project.findUnique.mockResolvedValue({
			userId: OWNER_ID,
			organizationId: "org-PROJECT",
		});
		// Not a member at all.
		mocks.dbMock.projectMember.findUnique.mockResolvedValue(null);

		await expect(
			mocks.captured.setForProjectMember({
				context: baseCtx,
				input: {
					projectId: PROJECT_ID,
					userId: "stranger",
					tags: ["DEVELOPER"],
				},
			}),
		).rejects.toThrow();

		expect(mocks.upsertProjectUserFunctionTags).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the member row exists but is unaccepted", async () => {
		mocks.dbMock.project.findUnique.mockResolvedValue({
			userId: OWNER_ID,
			organizationId: "org-PROJECT",
		});
		mocks.dbMock.projectMember.findUnique.mockResolvedValue({
			acceptedAt: null,
			expiresAt: null,
		});

		await expect(
			mocks.captured.setForProjectMember({
				context: baseCtx,
				input: {
					projectId: PROJECT_ID,
					userId: "pending-invite",
					tags: ["DEVELOPER"],
				},
			}),
		).rejects.toThrow();

		expect(mocks.upsertProjectUserFunctionTags).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the member row is accepted but expired", async () => {
		mocks.dbMock.project.findUnique.mockResolvedValue({
			userId: OWNER_ID,
			organizationId: "org-PROJECT",
		});
		mocks.dbMock.projectMember.findUnique.mockResolvedValue({
			acceptedAt: new Date("2020-01-01"),
			expiresAt: new Date("2020-01-02"), // long expired
		});

		await expect(
			mocks.captured.setForProjectMember({
				context: baseCtx,
				input: {
					projectId: PROJECT_ID,
					userId: "expired-member",
					tags: ["DEVELOPER"],
				},
			}),
		).rejects.toThrow();

		expect(mocks.upsertProjectUserFunctionTags).not.toHaveBeenCalled();
	});

	it("throws BAD_REQUEST when the supplied organizationId disagrees with the project's", async () => {
		mocks.dbMock.project.findUnique.mockResolvedValue({
			userId: OWNER_ID,
			organizationId: "org-PROJECT",
		});

		await expect(
			mocks.captured.setForProjectMember({
				context: baseCtx,
				input: {
					projectId: PROJECT_ID,
					userId: OWNER_ID,
					tags: ["DEVELOPER"],
					organizationId: "org-OTHER",
				},
			}),
		).rejects.toThrow();

		expect(mocks.upsertProjectUserFunctionTags).not.toHaveBeenCalled();
	});

	it("succeeds for the project creator without a ProjectMember lookup", async () => {
		mocks.dbMock.project.findUnique.mockResolvedValue({
			userId: OWNER_ID,
			organizationId: "org-PROJECT",
		});
		mocks.upsertProjectUserFunctionTags.mockResolvedValue({
			changed: true,
		});

		const result = await mocks.captured.setForProjectMember({
			context: baseCtx,
			input: {
				projectId: PROJECT_ID,
				userId: OWNER_ID,
				tags: ["DEVELOPER"],
			},
		});

		expect(mocks.dbMock.projectMember.findUnique).not.toHaveBeenCalled();
		expect(
			mocks.upsertProjectUserFunctionTags,
		).toHaveBeenCalledExactlyOnceWith({
			projectId: PROJECT_ID,
			userId: OWNER_ID,
			organizationId: "org-PROJECT",
			tags: ["DEVELOPER"],
		});
		expect(result).toEqual({ success: true, tags: ["DEVELOPER"] });
	});

	it("dedupes tags, persists under the project's org, and audits under the project's org (never the session org)", async () => {
		mocks.dbMock.project.findUnique.mockResolvedValue({
			userId: OWNER_ID,
			organizationId: "org-PROJECT",
		});
		mocks.dbMock.projectMember.findUnique.mockResolvedValue({
			acceptedAt: new Date("2020-01-01"),
			expiresAt: null, // never expires
		});
		mocks.upsertProjectUserFunctionTags.mockResolvedValue({
			changed: true,
		});

		// The acting context's session/active org ("org-SESSION" from
		// baseCtx) deliberately differs from the project's org
		// ("org-PROJECT") to prove tenancy is project-derived, not
		// session-derived (Codex plan finding).
		const result = await mocks.captured.setForProjectMember({
			context: baseCtx,
			input: {
				projectId: PROJECT_ID,
				userId: "member-1",
				tags: ["DEVELOPER", "DEVELOPER", "ARCHITECT"],
				// organizationId omitted entirely — still must file under the
				// project's org.
			},
		});

		expect(
			mocks.upsertProjectUserFunctionTags,
		).toHaveBeenCalledExactlyOnceWith({
			projectId: PROJECT_ID,
			userId: "member-1",
			organizationId: "org-PROJECT",
			tags: ["DEVELOPER", "ARCHITECT"],
		});
		expect(result).toEqual({
			success: true,
			tags: ["DEVELOPER", "ARCHITECT"],
		});

		expect(mocks.recordAuditFromRequest).toHaveBeenCalledExactlyOnceWith(
			baseCtx,
			expect.objectContaining({
				action: "project.member.function_tags_changed",
				category: "project",
				organizationId: "org-PROJECT",
				projectId: PROJECT_ID,
				resource: { type: "user", id: "member-1", name: null },
				metadata: { tags: ["DEVELOPER", "ARCHITECT"] },
			}),
		);
	});

	it("does NOT audit when the write was a no-op", async () => {
		// `project.member.function_tags_changed` asserts a change in the past
		// tense. `upsertProjectUserFunctionTags` skips the write entirely when
		// the normalized tag set and the org both already match, so an admin
		// who opens the dialog and saves the same tags changes nothing — and an
		// audit row claiming otherwise makes every other row in the trail a
		// question. This is the case that can rot: it stays green if the `if`
		// is deleted only because the sibling above would then also pass.
		mocks.dbMock.project.findUnique.mockResolvedValue({
			userId: OWNER_ID,
			organizationId: "org-PROJECT",
		});
		mocks.dbMock.projectMember.findUnique.mockResolvedValue({
			acceptedAt: new Date("2020-01-01"),
			expiresAt: null,
		});
		mocks.upsertProjectUserFunctionTags.mockResolvedValue({
			changed: false,
		});

		const result = await mocks.captured.setForProjectMember({
			context: baseCtx,
			input: {
				projectId: PROJECT_ID,
				userId: "member-1",
				tags: ["DEVELOPER"],
			},
		});

		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		// Still a success, and still the tags the admin asked for: a no-op is
		// not an error and must not surface to the client as one.
		expect(result).toEqual({ success: true, tags: ["DEVELOPER"] });
	});

	it("routes the admin write through the single confirmation-clearing writer", async () => {
		// `upsertProjectUserFunctionTags` is the ONLY writer the admin path
		// uses, and it is where confirmation is cleared on a real change
		// (spec §5.2). A future refactor that writes the row directly here
		// would skip that and leave a member permanently "confirmed" for a
		// role an administrator replaced.
		mocks.dbMock.project.findUnique.mockResolvedValue({
			userId: OWNER_ID,
			organizationId: "org-PROJECT",
		});
		mocks.dbMock.projectMember.findUnique.mockResolvedValue({
			acceptedAt: new Date(),
			expiresAt: null,
		});
		// Task 2 changed this writer's contract from `Promise<void>` to
		// `Promise<{ changed: boolean }>`; a bare `vi.fn()` resolving
		// `undefined` throws on destructuring.
		mocks.upsertProjectUserFunctionTags.mockResolvedValue({
			changed: true,
		});

		await mocks.captured.setForProjectMember({
			context: baseCtx,
			input: {
				projectId: PROJECT_ID,
				userId: "member-1",
				tags: ["ARCHITECT"],
				organizationId: "org-PROJECT",
			},
		});

		// `…ExactlyOnceWith` rather than `…Times(1)`: the count alone is
		// already implied by the two tests above, which pin the same mock with
		// the same matcher. Naming the arguments gives this test refutation
		// power those two do not have.
		expect(
			mocks.upsertProjectUserFunctionTags,
		).toHaveBeenCalledExactlyOnceWith({
			projectId: PROJECT_ID,
			userId: "member-1",
			organizationId: "org-PROJECT",
			tags: ["ARCHITECT"],
		});
	});
});

// ---------------------------------------------------------------------------
// getMyProjectStatus — self-service, no permission middleware
// ---------------------------------------------------------------------------

describe("getMyProjectStatusProcedure", () => {
	it("throws FORBIDDEN when hasProjectAccess is false", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			mocks.captured.getMyProjectStatus({
				context: baseCtx,
				input: { projectId: PROJECT_ID, organizationId: null },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getMyProjectFunctionTagStatus).not.toHaveBeenCalled();
	});

	it("reads the CALLER's row — never an input userId", async () => {
		// There is no `userId` input field. This pins that the read is made
		// with the session's user, so adding one later fails here.
		mocks.getMyProjectFunctionTagStatus.mockResolvedValue({
			confirmed: false,
			tags: ["DEVELOPER"],
			defaultTags: ["DEVELOPER"],
			version: 3,
		});

		const result = await mocks.captured.getMyProjectStatus({
			context: baseCtx,
			input: {
				projectId: PROJECT_ID,
				organizationId: null,
				userId: "someone-else",
			},
		});

		expect(mocks.getMyProjectFunctionTagStatus).toHaveBeenCalledWith(
			PROJECT_ID,
			"user-1",
		);
		expect(result).toEqual({
			confirmed: false,
			tags: ["DEVELOPER"],
			defaultTags: ["DEVELOPER"],
			version: 3,
		});
	});

	it("gives a stranger the SAME answer for a real project and a made-up id", async () => {
		// This procedure has no project lookup to order the access check
		// against — `hasProjectAccess` is the only gate, and it returns false
		// for a project that does not exist, so both cases already land on the
		// same FORBIDDEN. What is pinned here is the PROPERTY that makes the
		// sibling's check ordering matter, so that adding a lookup-then-404 to
		// this handler later reddens instead of quietly introducing a
		// project-existence oracle.
		mocks.hasProjectAccess.mockResolvedValue(false);
		const caught = (error: unknown) =>
			error as { code?: string; message?: string };

		// Nothing calls this today. It is armed so that IF a lookup is ever
		// added, it behaves the way that CREATES the oracle — the real id
		// resolves, the made-up one does not. Without this the two ids would
		// both miss and the handler would answer NOT_FOUND uniformly, which
		// agrees with itself and would let the mutation through.
		mocks.dbMock.project.findUnique.mockImplementation(
			({ where }: { where: { id: string } }) =>
				Promise.resolve(
					where.id === PROJECT_ID
						? { organizationId: "org-PROJECT" }
						: null,
				),
		);

		const forReal = await mocks.captured
			.getMyProjectStatus({
				context: baseCtx,
				input: { projectId: PROJECT_ID, organizationId: null },
			})
			.catch(caught);
		const forMadeUp = await mocks.captured
			.getMyProjectStatus({
				context: baseCtx,
				input: {
					projectId: "proj-never-existed",
					organizationId: null,
				},
			})
			.catch(caught);

		// Both must actually reject — `.catch` would otherwise hand back a
		// resolved value whose `code` is `undefined`, and two `undefined`s
		// agree with each other.
		expect(forReal).toMatchObject({ code: "FORBIDDEN" });
		expect(forMadeUp).toMatchObject({ code: "FORBIDDEN" });
		// A differing MESSAGE is an existence oracle too, even when both
		// answers carry the same code.
		expect(forMadeUp.message).toBe(forReal.message);
		expect(mocks.getMyProjectFunctionTagStatus).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// confirmForProject — self-service, version-conditional
// ---------------------------------------------------------------------------

describe("confirmForProjectProcedure", () => {
	const CONFIRM_INPUT = {
		projectId: PROJECT_ID,
		tags: ["DEVELOPER"],
		expectedVersion: 2,
		organizationId: null,
	};

	beforeEach(() => {
		mocks.dbMock.project.findUnique.mockResolvedValue({
			organizationId: "org-PROJECT",
		});
		// FOUR keys on the confirmed branch (Task 2). `previousTags` is what
		// the row held before the compare-and-set; the audit metadata reads
		// it, so a three-key mock would record `undefined` and pin nothing.
		mocks.confirmProjectUserFunctionTags.mockResolvedValue({
			outcome: "confirmed",
			tags: ["DEVELOPER"],
			version: 3,
			previousTags: ["ARCHITECT"],
		});
	});

	it("writes the CALLER's own row with the version it was given", async () => {
		const result = await mocks.captured.confirmForProject({
			context: baseCtx,
			input: {
				...CONFIRM_INPUT,
				organizationId: "org-PROJECT",
				// A hostile `userId` the client has no business sending. There
				// is no such input field, so it must be ignored outright: the
				// row is keyed on `projectId_userId`, and honouring a supplied
				// value would let any project member write another member's
				// roles. The READ sibling pins the same thing; without it here
				// the WRITE — the one that matters — was pinned by nothing but
				// a sentence in the exemption list.
				userId: "someone-else",
			},
		});

		expect(mocks.confirmProjectUserFunctionTags).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			userId: "user-1",
			organizationId: "org-PROJECT",
			tags: ["DEVELOPER"],
			expectedVersion: 2,
		});
		expect(result).toEqual({
			success: true,
			tags: ["DEVELOPER"],
			version: 3,
		});
	});

	it("audits with the PROJECT-derived org, not the session's active one", async () => {
		await mocks.captured.confirmForProject({
			context: baseCtx,
			input: { ...CONFIRM_INPUT, organizationId: "org-PROJECT" },
		});

		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(
			baseCtx,
			expect.objectContaining({
				action: "project.member.function_tags_confirmed",
				category: "project",
				// NOT "org-SESSION" — an actor acting on this project while a
				// different org is active must not misfile the trail into that
				// other org's audit view.
				organizationId: "org-PROJECT",
				projectId: PROJECT_ID,
				resource: { type: "user", id: "user-1", name: null },
				// `previousTags` separates "accepted what the administrator
				// set" from "replaced it" — the two cases anyone reading this
				// row cares about.
				metadata: {
					tags: ["DEVELOPER"],
					previousTags: ["ARCHITECT"],
				},
			}),
		);
	});

	it("rejects an empty tag set with BAD_REQUEST and writes nothing", async () => {
		// The §5.8 floor. A confirmed-but-empty tag set is the exact state
		// this card exists to prevent.
		await expect(
			mocks.captured.confirmForProject({
				context: baseCtx,
				input: { ...CONFIRM_INPUT, tags: [] },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.confirmProjectUserFunctionTags).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("surfaces a conflict outcome as an error, and audits nothing", async () => {
		mocks.confirmProjectUserFunctionTags.mockResolvedValue({
			outcome: "conflict",
		});

		await expect(
			mocks.captured.confirmForProject({
				context: baseCtx,
				input: CONFIRM_INPUT,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		// A refused write must not leave a row claiming it happened.
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("passes expectedVersion null straight through (the no-row case)", async () => {
		await mocks.captured.confirmForProject({
			context: baseCtx,
			input: { ...CONFIRM_INPUT, expectedVersion: null },
		});
		expect(mocks.confirmProjectUserFunctionTags).toHaveBeenCalledWith(
			expect.objectContaining({ expectedVersion: null }),
		);
	});

	it("throws FORBIDDEN for a non-member", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			mocks.captured.confirmForProject({
				context: baseCtx,
				input: CONFIRM_INPUT,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.confirmProjectUserFunctionTags).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the project does not exist", async () => {
		mocks.dbMock.project.findUnique.mockResolvedValue(null);
		await expect(
			mocks.captured.confirmForProject({
				context: baseCtx,
				input: CONFIRM_INPUT,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("checks access BEFORE looking the project up", async () => {
		// The ordering is load-bearing. Reversed, the handler answers
		// NOT_FOUND for an id that does not exist and FORBIDDEN for one that
		// does — a project-existence oracle for every authenticated user.
		// Neither of the two tests above can see that: the FORBIDDEN one runs
		// against a project that exists and the NOT_FOUND one against a caller
		// who has access, so both stay green under either ordering. Only the
		// case where BOTH conditions fail separates them.
		mocks.hasProjectAccess.mockResolvedValue(false);
		mocks.dbMock.project.findUnique.mockResolvedValue(null);

		await expect(
			mocks.captured.confirmForProject({
				context: baseCtx,
				input: CONFIRM_INPUT,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		// The strongest statement of the ordering: under the correct one the
		// lookup is never reached at all, so there is nothing to leak.
		expect(mocks.dbMock.project.findUnique).not.toHaveBeenCalled();
		expect(mocks.confirmProjectUserFunctionTags).not.toHaveBeenCalled();
	});

	it("gives a stranger the SAME answer for a real project and a made-up id", async () => {
		// "They agree" IS the property the ordering exists to hold. Nothing
		// above states it: each case is asserted alone, so an implementation
		// that answered differently for the two would satisfy both.
		mocks.hasProjectAccess.mockResolvedValue(false);
		const caught = (error: unknown) =>
			error as { code?: string; message?: string };

		// A project that really exists…
		mocks.dbMock.project.findUnique.mockResolvedValue({
			organizationId: "org-PROJECT",
		});
		const forReal = await mocks.captured
			.confirmForProject({ context: baseCtx, input: CONFIRM_INPUT })
			.catch(caught);

		// …and one that never did.
		mocks.dbMock.project.findUnique.mockResolvedValue(null);
		const forMadeUp = await mocks.captured
			.confirmForProject({
				context: baseCtx,
				input: { ...CONFIRM_INPUT, projectId: "proj-never-existed" },
			})
			.catch(caught);

		// Both must actually reject — `.catch` would otherwise hand back a
		// resolved value whose `code` is `undefined`, and two `undefined`s
		// agree with each other.
		expect(forReal).toMatchObject({ code: "FORBIDDEN" });
		expect(forMadeUp).toMatchObject({ code: "FORBIDDEN" });
		expect(forMadeUp.code).toBe(forReal.code);
		// A differing MESSAGE is an existence oracle too, even when both
		// answers carry the same code.
		expect(forMadeUp.message).toBe(forReal.message);
	});

	it("rejects a disagreeing organizationId rather than overriding it", async () => {
		await expect(
			mocks.captured.confirmForProject({
				context: baseCtx,
				input: { ...CONFIRM_INPUT, organizationId: "org-OTHER" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.confirmProjectUserFunctionTags).not.toHaveBeenCalled();
	});

	it("deduplicates tags before writing and before auditing", async () => {
		await mocks.captured.confirmForProject({
			context: baseCtx,
			input: { ...CONFIRM_INPUT, tags: ["SME", "SME", "DEVELOPER"] },
		});
		expect(mocks.confirmProjectUserFunctionTags).toHaveBeenCalledWith(
			expect.objectContaining({ tags: ["SME", "DEVELOPER"] }),
		);
		// "and before auditing" is half the title, so assert it. Auditing
		// `input.tags` instead of the deduped set leaves the assertion above
		// green while the trail records a duplicate-bearing set that was never
		// written.
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(
			baseCtx,
			expect.objectContaining({
				metadata: {
					tags: ["SME", "DEVELOPER"],
					previousTags: ["ARCHITECT"],
				},
			}),
		);
	});
});
