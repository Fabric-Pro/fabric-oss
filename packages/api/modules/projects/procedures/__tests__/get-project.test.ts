/**
 * Tests for `getProjectProcedure` (`projects.get`) — Task 4a: `canPublish`
 * capability (Publishing Suite Phase 1A, Plan 3), and Task 3 (Stage 2+3,
 * Fizzy #1767): `canManageMembers` capability.
 *
 * `canPublish` must be derived via the SAME authoritative resolver
 * (`resolveEffectiveProjectPermissions` + `hasPermission`) that
 * `requireProjectPermission` uses for mutation authorization — NOT the
 * org-first `userHasProjectPermission` used for `canEditSettings` — so the
 * UI never shows a control the server would reject.
 *
 * `canManageMembers` must be definitionally identical to the write gate in
 * `setForProjectMember` (Stage 1): `hasProjectAccess(...) &&
 * hasPermission(effectivePermissions, PROJECT_MEMBERS_MANAGE)`. It is
 * computed explicitly here — an org-role grant of PROJECT_MEMBERS_MANAGE is
 * NOT enough on its own; the caller must also have actual project access
 * (ownership or an active membership).
 *
 * These tests exercise the REAL `resolveEffectiveProjectPermissions`
 * resolver and the REAL `@repo/permissions` role tables (only the DB layer
 * is mocked) so the ProjectMember-row-precedence claim is proven end-to-end,
 * not just asserted against a stub. This mirrors the "real enforcement"
 * technique in `packages/api/__tests__/publishing-suite-procedures.test.ts`.
 * `hasProjectAccess` itself is mocked directly (per test) since it is a
 * separate authorization primitive, not part of the permission-matrix
 * resolver.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getProjectById: vi.fn(),
		getProjectRole: vi.fn(),
		hasProjectAccess: vi.fn(),
		projectFindUnique: vi.fn(),
		projectMemberFindUnique: vi.fn(),
		memberFindFirst: vi.fn(),
		userHasProjectPermission: vi.fn(),
		resolveAttachmentRetentionOverrides: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	getProjectById: (...args: unknown[]) => mocks.getProjectById(...args),
	getProjectRole: (...args: unknown[]) => mocks.getProjectRole(...args),
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
	resolveAttachmentRetentionOverrides: (...args: unknown[]) =>
		mocks.resolveAttachmentRetentionOverrides(...args),
	db: {
		project: { findUnique: mocks.projectFindUnique },
		projectMember: { findUnique: mocks.projectMemberFindUnique },
		member: { findFirst: mocks.memberFindFirst },
	},
}));

// canEditSettings is out of scope for this task — stub it directly rather
// than re-deriving it, so failures here can't be masked by (or blamed on)
// the unrelated org-first resolver.
vi.mock("../../../../lib/project-permissions", () => ({
	userHasProjectPermission: (...args: unknown[]) =>
		mocks.userHasProjectPermission(...args),
}));

// Deliberately NOT mocked: "../../../../lib/effective-project-permissions"
// (real resolver) and "@repo/permissions" (real hasPermission + role
// tables) — both run for real against the mocked DB layer above.

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.get = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		requireProjectPermission: () => () => chainable,
		resolveOrganizationId: (
			explicit: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => explicit ?? session?.activeOrganizationId ?? undefined,
		Permissions: {
			PROJECT_READ: "project:read",
			PROJECT_UPDATE: "project:update",
			PROJECT_SETTINGS_EDIT: "project:settings:edit",
			PUBLISHING_TOPIC_CREATE: "publishing-topic:create",
			PROJECT_MEMBERS_MANAGE: "project:members:manage",
		},
	};
});

// Importing the module registers its handler in `handlers`.
import "../get-project";

type GetProjectHandler = (args: {
	input: { id: string; organizationId?: string | null };
	context: { user: { id: string }; session: unknown };
}) => Promise<{ project: Record<string, unknown> }>;

const handler = handlers.get as GetProjectHandler;

const PROJECT_ID = "proj-1";
const ORG_ID = "org-A";
const USER_ID = "user-1";
const OWNER_ID = "user-owner";

const ctx = { user: { id: USER_ID }, session: {} };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getProjectById.mockResolvedValue({ id: PROJECT_ID, name: "Project" });
	mocks.getProjectRole.mockResolvedValue("EDITOR");
	mocks.userHasProjectPermission.mockResolvedValue(false);
	// Per-test override for the canManageMembers cases below; defaulting to
	// `false` means a test that forgets to set it fails loudly instead of
	// silently passing.
	mocks.hasProjectAccess.mockResolvedValue(false);
	// Total map with no override — the ordinary case for the capability tests
	// above, which must not start failing because the retention read exists.
	mocks.resolveAttachmentRetentionOverrides.mockResolvedValue(
		new Map([[PROJECT_ID, { days: null, settingChangedAt: null }]]),
	);
});

describe("getProjectProcedure — canPublish capability", () => {
	it("an org Member granted PUBLISHING_TOPIC_CREATE via org role, with NO ProjectMember row, gets canPublish: true", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue({ role: "member" });

		const result = await handler({
			input: { id: PROJECT_ID, organizationId: ORG_ID },
			context: ctx,
		});

		expect(result.project.canPublish).toBe(true);
	});

	it("an org Member WITH a project-level VIEWER ProjectMember row gets canPublish: false (ProjectMember row takes precedence over the org grant)", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: null,
		});
		// Path C (active ProjectMember) must short-circuit before the org-role
		// fallback is ever consulted — stub it to grant CREATE anyway so a
		// regression that fell through to org permissions would be caught as a
		// false positive instead of silently passing.
		mocks.memberFindFirst.mockResolvedValue({ role: "member" });

		const result = await handler({
			input: { id: PROJECT_ID, organizationId: ORG_ID },
			context: ctx,
		});

		expect(result.project.canPublish).toBe(false);
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});
});

describe("getProjectProcedure — canManageMembers capability", () => {
	it("owner (personal project): hasProjectAccess true, effective permissions include PROJECT_MEMBERS_MANAGE -> true", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: null,
			userId: USER_ID,
		});
		mocks.hasProjectAccess.mockResolvedValue(true);

		const result = await handler({
			input: { id: PROJECT_ID, organizationId: null },
			context: ctx,
		});

		expect(result.project.canManageMembers).toBe(true);
		expect(mocks.hasProjectAccess).toHaveBeenCalledExactlyOnceWith(
			PROJECT_ID,
			USER_ID,
		);
	});

	it("project admin with an active ProjectMember row: hasProjectAccess true, perms include manage -> true", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "PROJECT_ADMIN",
			acceptedAt: new Date(),
			expiresAt: null,
		});
		mocks.hasProjectAccess.mockResolvedValue(true);

		const result = await handler({
			input: { id: PROJECT_ID, organizationId: ORG_ID },
			context: ctx,
		});

		expect(result.project.canManageMembers).toBe(true);
	});

	it("editor with an active ProjectMember row: hasProjectAccess true, perms WITHOUT manage -> false", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "EDITOR",
			acceptedAt: new Date(),
			expiresAt: null,
		});
		mocks.hasProjectAccess.mockResolvedValue(true);

		const result = await handler({
			input: { id: PROJECT_ID, organizationId: ORG_ID },
			context: ctx,
		});

		expect(result.project.canManageMembers).toBe(false);
	});

	it("org admin granted PROJECT_MEMBERS_MANAGE via org role but with NO project access -> false", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		// No active ProjectMember row — falls through to the org-role path,
		// which grants PROJECT_MEMBERS_MANAGE to org admins.
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue({ role: "admin" });
		// The defense-in-depth access check fails — no ownership, no accepted
		// ProjectMember row, no guest grant.
		mocks.hasProjectAccess.mockResolvedValue(false);

		const result = await handler({
			input: { id: PROJECT_ID, organizationId: ORG_ID },
			context: ctx,
		});

		expect(result.project.canManageMembers).toBe(false);
	});

	it("removed org member with an active PROJECT_ADMIN ProjectMember row: guest access true, perms include manage -> true", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		// Active ProjectMember row is authoritative (Path C) and short-circuits
		// BEFORE the org-role lookup — the org membership having been revoked
		// (simulated by a null org-member row) must not matter.
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "PROJECT_ADMIN",
			acceptedAt: new Date(),
			expiresAt: null,
		});
		mocks.memberFindFirst.mockResolvedValue(null);
		// hasProjectAccess grants this via its own guest path (accepted
		// ProjectMember row without an OrgMember row) — mocked directly here
		// since hasProjectAccess is a separate primitive from the permission
		// resolver under test.
		mocks.hasProjectAccess.mockResolvedValue(true);

		const result = await handler({
			input: { id: PROJECT_ID, organizationId: ORG_ID },
			context: ctx,
		});

		expect(result.project.canManageMembers).toBe(true);
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});
});

describe("getProjectProcedure — canUpdateProject capability", () => {
	it("an org Member granted PROJECT_UPDATE via org role, with NO ProjectMember row, gets canUpdateProject: true", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue({ role: "member" });

		const result = await handler({
			input: { id: PROJECT_ID, organizationId: ORG_ID },
			context: ctx,
		});

		expect(result.project.canUpdateProject).toBe(true);
	});

	it("an org Member WITH a project-level VIEWER ProjectMember row gets canUpdateProject: false (ProjectMember row takes precedence over the org grant)", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue({
			role: "VIEWER",
			acceptedAt: new Date(),
			expiresAt: null,
		});
		mocks.memberFindFirst.mockResolvedValue({ role: "member" });

		const result = await handler({
			input: { id: PROJECT_ID, organizationId: ORG_ID },
			context: ctx,
		});

		expect(result.project.canUpdateProject).toBe(false);
		expect(mocks.memberFindFirst).not.toHaveBeenCalled();
	});
});

describe("getProjectProcedure — effectiveAttachmentRetentionDays (Fizzy #1749)", () => {
	beforeEach(() => {
		mocks.projectFindUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: OWNER_ID,
		});
		mocks.projectMemberFindUnique.mockResolvedValue(null);
		mocks.memberFindFirst.mockResolvedValue({ role: "member" });
	});

	it("resolves the server default when nothing is overridden", async () => {
		// The browser must never hold its own copy of the default — the number
		// the purge would actually apply is resolved here, server-side.
		const result = await handler({
			input: { id: PROJECT_ID, organizationId: ORG_ID },
			context: ctx,
		});

		expect(result.project.effectiveAttachmentRetentionDays).toBe(90);
		expect(
			mocks.resolveAttachmentRetentionOverrides,
		).toHaveBeenCalledExactlyOnceWith([PROJECT_ID]);
	});

	it("returns the cascade's resolved override when one is configured", async () => {
		mocks.resolveAttachmentRetentionOverrides.mockResolvedValue(
			new Map([
				[PROJECT_ID, { days: 365, settingChangedAt: new Date() }],
			]),
		);

		const result = await handler({
			input: { id: PROJECT_ID, organizationId: ORG_ID },
			context: ctx,
		});

		expect(result.project.effectiveAttachmentRetentionDays).toBe(365);
	});

	it("falls back to the default for a stored value outside the usable range", async () => {
		// A CHECK constraint makes this unrepresentable through the API, but a
		// seed/restore/psql write is not bound by it — and the purge would treat
		// such a row as the server default, so the UI must agree rather than
		// display a window nobody actually has.
		mocks.resolveAttachmentRetentionOverrides.mockResolvedValue(
			new Map([[PROJECT_ID, { days: 5, settingChangedAt: null }]]),
		);

		const result = await handler({
			input: { id: PROJECT_ID, organizationId: ORG_ID },
			context: ctx,
		});

		expect(result.project.effectiveAttachmentRetentionDays).toBe(90);
	});

	it("falls back to the default when the project is absent from the resolver map", async () => {
		mocks.resolveAttachmentRetentionOverrides.mockResolvedValue(new Map());

		const result = await handler({
			input: { id: PROJECT_ID, organizationId: ORG_ID },
			context: ctx,
		});

		expect(result.project.effectiveAttachmentRetentionDays).toBe(90);
	});
});
