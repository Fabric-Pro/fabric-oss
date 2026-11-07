import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

const m = vi.hoisted(() => ({
	member: vi.fn(),
	orgCreate: vi.fn(),
	userCreate: vi.fn(),
	role: "member",
	deleted: false,
}));
vi.mock("@repo/database", () => ({
	createOrganizationApiKey: m.orgCreate,
	createUserApiKey: m.userCreate,
}));
vi.mock("../../../lib/membership", () => ({
	requireOrgMembership: (userId: string, orgId: string, roles?: string[]) => {
		m.member(userId, orgId, roles);
		return roles && !roles.includes(m.role)
			? null
			: {
					role: m.role,
					organization: { deletedAt: m.deleted ? new Date(0) : null },
				};
	},
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => {
	function chain(schema?: z.ZodType) {
		const c = {
			use: () => c,
			route: () => c,
			input: (s: z.ZodType) => chain(s),
			output: () => c,
			handler: (handler: unknown) => ({
				_schema: schema,
				_handler: handler,
			}),
		};
		return c;
	}
	return {
		get tenantProtectedProcedure() {
			return chain();
		},
		Permissions: new Proxy({}, { get: (_, key) => String(key) }),
		requirePermission: () => ({}),
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string },
		) =>
			input === null
				? undefined
				: (input ?? session.activeOrganizationId),
	};
});

import { createUserApiKeyProcedure } from "../../../../users/procedures/api-keys/create";
import {
	createOrganizationApiKeyProcedure,
	ORG_API_KEY_SCOPES,
} from "../create";

type Hatch = {
	_schema: z.ZodType;
	_handler: (args: { input: unknown; context: unknown }) => Promise<unknown>;
};
const org = createOrganizationApiKeyProcedure as unknown as Hatch;
const user = createUserApiKeyProcedure as unknown as Hatch;
const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org" },
	headers: new Headers(),
};
beforeEach(() => {
	vi.clearAllMocks();
	m.role = "member";
	m.deleted = false;
	for (const fn of [m.orgCreate, m.userCreate]) {
		fn.mockResolvedValue({
			id: "example-key",
			name: "Example key",
			keyPrefix: "example-prefix",
			scopes: [],
			expiresAt: null,
			createdAt: new Date(0),
		});
	}
});
const create = (kind: "org" | "user", scopes: string[]) => {
	const p = kind === "org" ? org : user;
	return p._handler({
		input: p._schema.parse({
			name: "Example skill client",
			scopes,
			...(kind === "org" ? { organizationId: "example-org" } : {}),
		}),
		context,
	});
};
describe("Skill and governance API-key consent", () => {
	it("offers all explicit scopes on organization keys", () => {
		for (const scope of [
			"skills:read",
			"skills:write",
			"skills:publish",
			"governance:read",
			"governance:write",
		]) {
			expect(ORG_API_KEY_SCOPES).toContain(scope);
		}
	});
	it("lets viewers mint genuine skill/governance reads only", async () => {
		m.role = "viewer";
		await create("org", ["skills:read", "governance:read"]);
		await create("user", ["skills:read", "governance:read"]);
		expect(m.orgCreate).toHaveBeenCalled();
		for (const scope of ["skills:write", "skills:publish"]) {
			m.userCreate.mockClear();
			await expect(create("user", [scope])).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(m.userCreate).not.toHaveBeenCalled();
			m.orgCreate.mockClear();
			await expect(create("org", [scope])).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(m.orgCreate).not.toHaveBeenCalled();
		}
	});
	it.each(["org", "user"] as const)(
		"does not let a regular member mint governance writes through %s keys",
		async (kind) => {
			await expect(
				create(kind, ["governance:write"]),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(m.orgCreate).not.toHaveBeenCalled();
			expect(m.userCreate).not.toHaveBeenCalled();
		},
	);
	it.each(["admin", "owner"])(
		"allows current %s consent to governance writes",
		async (role) => {
			m.role = role;
			await create("org", ["governance:write"]);
			await create("user", ["governance:write"]);
			expect(m.orgCreate).toHaveBeenCalled();
			expect(m.userCreate).toHaveBeenCalled();
			expect(m.member).toHaveBeenCalledWith(
				"example-user",
				"example-org",
				undefined,
			);
		},
	);
	it.each(["org", "user"] as const)(
		"reserves company-brand write consent for current administrators on %s keys",
		async (kind) => {
			await expect(create(kind, ["orgs:write"])).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(m.orgCreate).not.toHaveBeenCalled();
			expect(m.userCreate).not.toHaveBeenCalled();
			m.role = "admin";
			await create(kind, ["orgs:write"]);
			expect(
				kind === "org" ? m.orgCreate : m.userCreate,
			).toHaveBeenCalled();
		},
	);

	it("keeps wildcard minting outside both public consent schemas", () => {
		for (const procedure of [org, user]) {
			expect(
				procedure._schema.safeParse({
					name: "Example",
					organizationId: "example-org",
					scopes: ["*"],
				}).success,
			).toBe(false);
		}
	});
	it("refuses new Skills grants from a soft-deleted active organization", async () => {
		m.role = "owner";
		m.deleted = true;
		for (const scope of [
			"skills:write",
			"skills:publish",
			"governance:write",
		]) {
			await expect(create("user", [scope])).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		}
		expect(m.userCreate).not.toHaveBeenCalled();
	});
	it("does not manufacture an organization for an unbound user-key request", async () => {
		m.role = "owner";
		await expect(
			user._handler({
				input: user._schema.parse({
					name: "Example",
					scopes: ["governance:write"],
				}),
				context: { ...context, session: {} },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.userCreate).not.toHaveBeenCalled();
	});
});

it("offers explicit prompt consent and clamps viewer writes", async () => {
	expect(ORG_API_KEY_SCOPES).toContain("prompts:read");
	expect(ORG_API_KEY_SCOPES).toContain("prompts:write");
	m.role = "admin";
	await create("org", ["prompts:read", "prompts:write"]);
	expect(m.orgCreate).toHaveBeenCalled();
	m.role = "viewer";
	await create("org", ["prompts:read"]);
	m.orgCreate.mockClear();
	await expect(create("org", ["prompts:write"])).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(m.orgCreate).not.toHaveBeenCalled();
});
