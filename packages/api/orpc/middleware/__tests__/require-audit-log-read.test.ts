/**
 * Unit tests for `isDeploymentAdmin` and the audit-log permission
 * middleware factories.
 *
 * - `isDeploymentAdmin` parsing rules (empty env, whitespace,
 *   case-insensitivity, malformed entries, empty input guard).
 * - Middleware behaviour: personal pass-through, env-admin bypass,
 *   member role enforcement, non-member FORBIDDEN.
 *
 * Spec: docs/audit-log/README.md §5.3,
 * §13.1.
 */

import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	memberFindUnique: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			...((actual.db ?? {}) as Record<string, unknown>),
			member: {
				findUnique: mocks.memberFindUnique,
			},
		},
	};
});

import {
	isDeploymentAdmin,
	requireAuditLogExportOrDeploymentAdmin,
	requireAuditLogReadOrDeploymentAdmin,
} from "../require-audit-log-read";

describe("isDeploymentAdmin", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns false when the env var is unset", () => {
		vi.stubEnv("FABRIC_DEPLOYMENT_ADMIN_EMAILS", "");
		expect(isDeploymentAdmin("alice@example.com")).toBe(false);
	});

	it("returns false when the env var is whitespace only", () => {
		vi.stubEnv("FABRIC_DEPLOYMENT_ADMIN_EMAILS", "   ");
		expect(isDeploymentAdmin("alice@example.com")).toBe(false);
	});

	it("matches a single email exactly", () => {
		vi.stubEnv("FABRIC_DEPLOYMENT_ADMIN_EMAILS", "sre@example.com");
		expect(isDeploymentAdmin("sre@example.com")).toBe(true);
	});

	it("matches case-insensitively in both directions", () => {
		vi.stubEnv("FABRIC_DEPLOYMENT_ADMIN_EMAILS", "A@EXAMPLE.COM");
		expect(isDeploymentAdmin("a@example.com")).toBe(true);
		vi.stubEnv("FABRIC_DEPLOYMENT_ADMIN_EMAILS", "a@example.com");
		expect(isDeploymentAdmin("A@EXAMPLE.COM")).toBe(true);
	});

	it("trims surrounding whitespace on every entry", () => {
		vi.stubEnv(
			"FABRIC_DEPLOYMENT_ADMIN_EMAILS",
			" a@example.com , c@example.org ",
		);
		expect(isDeploymentAdmin("a@example.com")).toBe(true);
		expect(isDeploymentAdmin("c@example.org")).toBe(true);
	});

	it("skips empty entries from leading, trailing, and adjacent commas", () => {
		vi.stubEnv("FABRIC_DEPLOYMENT_ADMIN_EMAILS", ",,a@example.com,,");
		expect(isDeploymentAdmin("a@example.com")).toBe(true);
		// Empty entries must not match the empty input — defense-in-depth.
		expect(isDeploymentAdmin("")).toBe(false);
		expect(isDeploymentAdmin(null)).toBe(false);
		expect(isDeploymentAdmin(undefined)).toBe(false);
	});

	it("does not match an email that is not in the list", () => {
		vi.stubEnv(
			"FABRIC_DEPLOYMENT_ADMIN_EMAILS",
			"sre@example.com,ops@example.com",
		);
		expect(isDeploymentAdmin("attacker@example.com")).toBe(false);
	});

	it("ignores trailing whitespace inside the input email", () => {
		vi.stubEnv("FABRIC_DEPLOYMENT_ADMIN_EMAILS", "sre@example.com");
		expect(isDeploymentAdmin("  sre@example.com  ")).toBe(true);
	});
});

/**
 * Run a middleware factory against a synthetic ctx/input pair. The
 * middleware shape from oRPC is `(args, input) => Promise<unknown>` —
 * we provide a no-op `next` and capture whether it was invoked.
 */
async function runMiddleware(
	mw: ReturnType<typeof requireAuditLogReadOrDeploymentAdmin>,
	context: { user: { id: string; email: string } },
	input: { organizationId?: string | null },
): Promise<{ called: boolean; error: unknown }> {
	let called = false;
	let error: unknown = null;
	try {
		const factory = mw as unknown as (
			args: {
				context: typeof context;
				next: () => Promise<unknown>;
			},
			input: unknown,
		) => Promise<unknown>;
		await factory(
			{
				context,
				next: async () => {
					called = true;
					return undefined;
				},
			},
			input,
		);
	} catch (err) {
		error = err;
	}
	return { called, error };
}

describe("requireAuditLogReadOrDeploymentAdmin middleware", () => {
	beforeEach(() => {
		mocks.memberFindUnique.mockReset();
		vi.unstubAllEnvs();
	});

	it("passes through for personal-context calls (no organizationId)", async () => {
		const mw = requireAuditLogReadOrDeploymentAdmin();
		const { called, error } = await runMiddleware(
			mw,
			{ user: { id: "u1", email: "a@example.com" } },
			{},
		);
		expect(called).toBe(true);
		expect(error).toBeNull();
		expect(mocks.memberFindUnique).not.toHaveBeenCalled();
	});

	it("passes through for explicit personal context (organizationId: null)", async () => {
		const mw = requireAuditLogReadOrDeploymentAdmin();
		const { called, error } = await runMiddleware(
			mw,
			{ user: { id: "u1", email: "a@example.com" } },
			{ organizationId: null },
		);
		expect(called).toBe(true);
		expect(error).toBeNull();
	});

	it("bypasses membership and role for deployment-admin emails", async () => {
		vi.stubEnv("FABRIC_DEPLOYMENT_ADMIN_EMAILS", "sre@example.com");
		mocks.memberFindUnique.mockResolvedValue(null);

		const mw = requireAuditLogReadOrDeploymentAdmin();
		const { called, error } = await runMiddleware(
			mw,
			{ user: { id: "u1", email: "sre@example.com" } },
			{ organizationId: "org-1" },
		);
		expect(called).toBe(true);
		expect(error).toBeNull();
		expect(mocks.memberFindUnique).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN when the caller is not a member of the org", async () => {
		mocks.memberFindUnique.mockResolvedValue(null);

		const mw = requireAuditLogReadOrDeploymentAdmin();
		const { called, error } = await runMiddleware(
			mw,
			{ user: { id: "u1", email: "a@example.com" } },
			{ organizationId: "org-1" },
		);
		expect(called).toBe(false);
		expect(error).toBeInstanceOf(ORPCError);
		expect((error as { message: string }).message).toMatch(/not a member/);
	});

	it("throws FORBIDDEN for a viewer role (no audit_log:read grant)", async () => {
		mocks.memberFindUnique.mockResolvedValue({ role: "viewer" });

		const mw = requireAuditLogReadOrDeploymentAdmin();
		const { called, error } = await runMiddleware(
			mw,
			{ user: { id: "u1", email: "a@example.com" } },
			{ organizationId: "org-1" },
		);
		expect(called).toBe(false);
		expect(error).toBeInstanceOf(ORPCError);
		expect((error as { message: string }).message).toMatch(
			/Missing required permission/,
		);
	});

	it("passes through for admin role (has org_audit_log:read)", async () => {
		mocks.memberFindUnique.mockResolvedValue({ role: "admin" });

		const mw = requireAuditLogReadOrDeploymentAdmin();
		const { called, error } = await runMiddleware(
			mw,
			{ user: { id: "u1", email: "a@example.com" } },
			{ organizationId: "org-1" },
		);
		expect(called).toBe(true);
		expect(error).toBeNull();
	});

	it("passes through for owner role", async () => {
		mocks.memberFindUnique.mockResolvedValue({ role: "owner" });

		const mw = requireAuditLogReadOrDeploymentAdmin();
		const { called, error } = await runMiddleware(
			mw,
			{ user: { id: "u1", email: "a@example.com" } },
			{ organizationId: "org-1" },
		);
		expect(called).toBe(true);
		expect(error).toBeNull();
	});

	it("export middleware FORBIDS member role (no audit_log:export grant)", async () => {
		mocks.memberFindUnique.mockResolvedValue({ role: "member" });

		const mw = requireAuditLogExportOrDeploymentAdmin();
		const { called, error } = await runMiddleware(
			mw,
			{ user: { id: "u1", email: "a@example.com" } },
			{ organizationId: "org-1" },
		);
		expect(called).toBe(false);
		expect(error).toBeInstanceOf(ORPCError);
	});
});
