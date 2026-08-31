/**
 * `resolveOrganizationIdForCaller` — resolution AND the access check.
 *
 * The plain procedure builder carries no tenant context, so the permission
 * middleware returns early on it: a `requirePermission` there never evaluates a
 * role. A handler on that builder which resolves a caller-supplied organization
 * and then writes it onto a row therefore lets the caller choose the tenant
 * their content lands in — and the largest tenancy class filters organization
 * reads by organization alone, so the row is readable by every member of it.
 *
 * This helper is the answer: a caller may ask for a tenant, but not for one
 * they have no TIE to. These tests pin the refusal, because it is the half that
 * `resolveOrganizationId` deliberately does not do.
 *
 * "Tie", not "membership", and the distinction was learned the hard way. A
 * membership-only check refused every project-scoped guest, because a guest
 * holds no membership row by definition — observed against a real guest, whose
 * own dashboard's calls were refused while the same call succeeded with the
 * organization omitted. `hasOrganizationTie` accepts an accepted project
 * membership as the real relationship it is, and refuses a caller with
 * neither.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hasOrganizationTie = vi.fn();
const getTenantContext = vi.fn(() => ({}) as Record<string, unknown>);

vi.mock("@repo/payments", () => ({}));
vi.mock("@repo/auth", () => ({ auth: {} }));
vi.mock("@repo/config", () => ({ config: {} }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/database", () => ({
	hasOrganizationTie: (...args: unknown[]) => hasOrganizationTie(...args),
	getTenantContext: () => getTenantContext(),
	db: {},
	getOrganizationMembership: vi.fn(),
}));

const MEMBER_ORG = "org-example-alpha";
const OUTSIDE_ORG = "org-example-outside";
const USER = "user-1";

async function resolve(
	inputOrganizationId: string | null | undefined,
	activeOrganizationId: string | null = null,
) {
	const { resolveOrganizationIdForCaller } = await import("../procedures");
	return resolveOrganizationIdForCaller(
		inputOrganizationId,
		{ activeOrganizationId },
		USER,
	);
}

describe("resolveOrganizationIdForCaller", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getTenantContext.mockReturnValue({});
		hasOrganizationTie.mockResolvedValue(true);
	});

	// The regression this distinction exists to prevent. A guest is refused by
	// a membership check and accepted by a tie one; the helper must use the
	// second, or every guest loses the project they were invited to.
	it("returns an organization the caller is only a project guest in", async () => {
		hasOrganizationTie.mockImplementation(
			async (_userId: string, organizationId: string) =>
				organizationId === MEMBER_ORG,
		);

		await expect(resolve(MEMBER_ORG)).resolves.toBe(MEMBER_ORG);
	});

	it("returns an organization the caller belongs to", async () => {
		await expect(resolve(MEMBER_ORG)).resolves.toBe(MEMBER_ORG);
		expect(hasOrganizationTie).toHaveBeenCalledWith(USER, MEMBER_ORG);
	});

	it("refuses one the caller does not belong to", async () => {
		hasOrganizationTie.mockResolvedValue(false);
		await expect(resolve(OUTSIDE_ORG)).rejects.toThrow(
			/do not have access/i,
		);
	});

	it("refuses a named organization even when the session names another", async () => {
		// The input wins over the session in the underlying resolver, so the
		// input is what has to be checked. Checking the session's organization
		// instead would confirm a tenant the request never asked for.
		hasOrganizationTie.mockImplementation(
			async (_userId: string, organizationId: string) =>
				organizationId === MEMBER_ORG,
		);
		await expect(resolve(OUTSIDE_ORG, MEMBER_ORG)).rejects.toThrow(
			/do not have access/i,
		);
	});

	it("checks the session's organization when the request names none", async () => {
		hasOrganizationTie.mockResolvedValue(false);
		await expect(resolve(undefined, MEMBER_ORG)).rejects.toThrow(
			/do not have access/i,
		);
	});

	it("asks nothing for personal context", async () => {
		// An explicit null means personal, and there is no membership to
		// confirm — spending a query to confirm nothing would be the same
		// mistake as checking a tenant nobody named.
		await expect(resolve(null)).resolves.toBeUndefined();
		expect(hasOrganizationTie).not.toHaveBeenCalled();
	});

	it("asks nothing when neither the request nor the session names one", async () => {
		await expect(resolve(undefined, null)).resolves.toBeUndefined();
		expect(hasOrganizationTie).not.toHaveBeenCalled();
	});
});
