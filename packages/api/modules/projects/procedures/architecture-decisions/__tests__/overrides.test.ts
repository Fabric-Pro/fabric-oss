/**
 * Tests for `listDecisionOverridesProcedure` (the read-only admin Overrides
 * view). The audit read is boundary-mocked; the test asserts the procedure
 * enforces project membership, scopes the read with the XOR tenant filter,
 * shapes each row for display, and handles the empty state.
 */

import { ORPCError } from "@orpc/client";
import {
	PROJECT_ROLE_PERMISSIONS,
	Permissions as RealPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks, captured } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		hasProjectAccess: vi.fn(),
		listDecisionOverrideAuditRows: vi.fn(),
	};
	// The permission the procedure gates on, captured at import time (before any
	// beforeEach reset) so the admin-only assertion has a stable value.
	const captured: { permission: unknown } = { permission: undefined };
	return { handlers, mocks, captured };
});

// Partial-mock: spread the real module so transitive importers (`@repo/payments`
// reads `setAiUsageRecorder` from `@repo/database` at load time) still resolve,
// and override only the two helpers this procedure exercises.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		hasProjectAccess: mocks.hasProjectAccess,
		listDecisionOverrideAuditRows: mocks.listDecisionOverrideAuditRows,
	};
});

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["list"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: {
			ARCHITECTURE_DECISION_READ: "architecture_decision:read",
			PROJECT_SETTINGS_EDIT: "project:settings:edit",
		},
		requireProjectPermission: (permission: unknown) => {
			captured.permission = permission;
			return (c: unknown) => c;
		},
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../overrides");

const context = {
	user: { id: "user-1", email: "reviewer@example.com", name: "Reviewer" },
	session: { id: "sess-1" },
};

const rawRow = {
	id: "row-1",
	createdAt: new Date("2026-07-10T00:00:00.000Z"),
	actorNameSnapshot: "Reviewer",
	actorEmailSnapshot: "reviewer@example.com",
	resourceId: "dec-1",
	resourceName: "ADR-012",
	metadata: {
		surface: "backlog_proposal",
		artifactType: "pending_backlog_proposal",
		artifactId: "prop-1",
		decisionIdentifier: "ADR-012",
		decisionTitle: "Use Postgres for all persistence",
		natureOfConflict: "The proposal introduces a MongoDB store.",
		conflictType: "violates_accepted",
	},
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.listDecisionOverrideAuditRows.mockResolvedValue([]);
});

describe("listDecisionOverrides — admin-only gate", () => {
	// The Overrides ledger is an audit surface. Card AC: "visible to project
	// admins." It must gate on an admin-scoped permission, not the read
	// permission viewers/editors inherit.
	it("gates on PROJECT_SETTINGS_EDIT — denies viewer/editor, allows admin/owner", () => {
		expect(captured.permission).toBe(RealPermissions.PROJECT_SETTINGS_EDIT);
		const perm = RealPermissions.PROJECT_SETTINGS_EDIT;
		// Viewers, commenters, and editors do NOT hold it → denied.
		expect(PROJECT_ROLE_PERMISSIONS.VIEWER).not.toContain(perm);
		expect(PROJECT_ROLE_PERMISSIONS.COMMENTER).not.toContain(perm);
		expect(PROJECT_ROLE_PERMISSIONS.EDITOR).not.toContain(perm);
		// Project admins and owners DO hold it → allowed.
		expect(PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN).toContain(perm);
		expect(PROJECT_ROLE_PERMISSIONS.OWNER).toContain(perm);
	});

	it("no longer gates on the viewer-inherited ARCHITECTURE_DECISION_READ", () => {
		expect(captured.permission).not.toBe(
			RealPermissions.ARCHITECTURE_DECISION_READ,
		);
		// Sanity: that read permission IS inherited by viewers — which is exactly
		// why it was the wrong gate for an admin-only ledger.
		expect(PROJECT_ROLE_PERMISSIONS.VIEWER).toContain(
			RealPermissions.ARCHITECTURE_DECISION_READ,
		);
	});
});

describe("listDecisionOverrides — membership", () => {
	it("throws FORBIDDEN and reads nothing when the caller lacks access", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			handlers.list({
				input: { projectId: "proj-1", organizationId: "org-1" },
				context,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.listDecisionOverrideAuditRows).not.toHaveBeenCalled();
	});
});

describe("listDecisionOverrides — empty state", () => {
	it("returns an empty list when no overrides exist", async () => {
		const result = await handlers.list({
			input: { projectId: "proj-1", organizationId: null },
			context,
		});
		expect(result).toEqual({ overrides: [] });
	});
});

describe("listDecisionOverrides — XOR tenant scope", () => {
	it("scopes the read to the org in org context", async () => {
		await handlers.list({
			input: { projectId: "proj-1", organizationId: "org-1" },
			context,
		});
		expect(mocks.listDecisionOverrideAuditRows).toHaveBeenCalledWith({
			scope: { organizationId: "org-1", userId: "user-1" },
			projectId: "proj-1",
		});
	});

	it("scopes the read to the user in personal context", async () => {
		await handlers.list({
			input: { projectId: "proj-1", organizationId: null },
			context,
		});
		expect(mocks.listDecisionOverrideAuditRows).toHaveBeenCalledWith({
			scope: { organizationId: null, userId: "user-1" },
			projectId: "proj-1",
		});
	});
});

describe("listDecisionOverrides — row shaping", () => {
	it("shapes a WORM row into the display fields from columns + metadata", async () => {
		mocks.listDecisionOverrideAuditRows.mockResolvedValue([rawRow]);
		const result = (await handlers.list({
			input: { projectId: "proj-1", organizationId: "org-1" },
			context,
		})) as { overrides: Array<Record<string, unknown>> };

		expect(result.overrides).toHaveLength(1);
		expect(result.overrides[0]).toEqual({
			id: "row-1",
			createdAt: rawRow.createdAt,
			actorName: "Reviewer",
			actorEmail: "reviewer@example.com",
			decisionId: "dec-1",
			decisionIdentifier: "ADR-012",
			decisionTitle: "Use Postgres for all persistence",
			surface: "backlog_proposal",
			artifactType: "pending_backlog_proposal",
			natureOfConflict: "The proposal introduces a MongoDB store.",
			conflictType: "violates_accepted",
		});
	});

	it("falls back to resourceName for the identifier and empties missing metadata", async () => {
		mocks.listDecisionOverrideAuditRows.mockResolvedValue([
			{
				id: "row-2",
				createdAt: rawRow.createdAt,
				actorNameSnapshot: null,
				actorEmailSnapshot: "only-email@example.com",
				resourceId: "dec-2",
				resourceName: "ADR-099",
				metadata: null,
			},
		]);
		const result = (await handlers.list({
			input: { projectId: "proj-1", organizationId: null },
			context,
		})) as { overrides: Array<Record<string, unknown>> };

		expect(result.overrides[0]).toMatchObject({
			decisionIdentifier: "ADR-099",
			decisionTitle: "",
			surface: "",
			artifactType: "",
			natureOfConflict: "",
			conflictType: "",
			actorName: null,
			actorEmail: "only-email@example.com",
		});
	});
});
