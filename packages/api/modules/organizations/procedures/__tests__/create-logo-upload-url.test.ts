/**
 * Signing the organization logo upload (Fizzy #2946). The logo is the
 * proposer's mark on client-document Proposal covers, so its upload is held
 * to the Brand kit's rules: `ORG_UPDATE` and admin or owner of the INPUT
 * organization (not the session's), and a PUT signed for its exact size.
 *
 * The permission middleware here is the REAL `requireInputOrgPermission`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { world, storage } = vi.hoisted(() => ({
	world: { roles: new Map<string, string>() },
	storage: {
		type: "s3" as const,
		supportsPresignedUrls: true,
		getSignedUploadUrl: vi.fn(
			async (key: string) => `https://storage.example.com/${key}?put`,
		),
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: vi.fn() },
		member: { findFirst: vi.fn() },
		projectMember: { findUnique: vi.fn() },
	},
	grantProjectAccess: vi.fn(),
	getTenantContext: vi.fn(() => ({ effectiveWriteOrgId: undefined })),
	getOrganizationMembership: async (
		organizationId: string,
		userId: string,
	) => {
		const role = world.roles.get(`${organizationId}:${userId}`);
		return role ? { role, organization: { id: organizationId } } : null;
	},
	getOrganizationById: async (id: string) => ({ id, name: "Example Org" }),
	resolveProjectTenant: vi.fn(),
}));

vi.mock("@repo/storage", () => ({ getStorageProvider: () => storage }));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { avatars: "avatars" } } },
}));

vi.mock("../../../../orpc/procedures", async () => {
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	const { requireInputOrgPermission } = await vi.importActual<
		typeof import("../../../../orpc/middleware/require-permission")
	>("../../../../orpc/middleware/require-permission");
	const state: { middleware?: unknown; input?: unknown } = {};
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: (mw: unknown) => {
			state.middleware = mw;
			return chain;
		},
		route: () => chain,
		input: (schema: unknown) => {
			state.input = schema;
			return chain;
		},
		output: () => chain,
		handler: (fn: unknown) => ({
			__handler: fn,
			__middleware: state.middleware,
			__input: state.input,
		}),
	});
	return {
		tenantProtectedProcedure: chain,
		requireInputOrgPermission,
		Permissions,
	};
});

import { createLogoUploadUrl } from "../create-logo-upload-url";

const ORG = "org_1";
const OTHER_ORG = "org_2";
const MIB = 1024 * 1024;

type Wired = {
	__handler: (args: {
		input: Record<string, unknown>;
		context: unknown;
	}) => Promise<Record<string, unknown>>;
	__middleware: (
		args: { context: unknown; next: () => Promise<unknown> },
		input: unknown,
	) => Promise<unknown>;
	__input: {
		parse: (value: unknown) => Record<string, unknown>;
		safeParse: (value: unknown) => { success: boolean };
	};
};

function context(userId: string) {
	return {
		user: { id: userId, name: "Admin", email: `${userId}@example.com` },
		session: { id: "session-1", activeOrganizationId: ORG },
		tenantContext: { userId, type: "organization", organizationId: ORG },
	};
}

async function sign(
	userId: string,
	overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const wired = createLogoUploadUrl as unknown as Wired;
	const input = wired.__input.parse({
		organizationId: ORG,
		contentLength: 120_000,
		...overrides,
	});
	let output: Record<string, unknown> | undefined;
	await wired.__middleware(
		{
			context: context(userId),
			next: async () => {
				output = await wired.__handler({
					input,
					context: context(userId),
				});
				return { output };
			},
		},
		input,
	);
	return output as Record<string, unknown>;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
	throw new Error("expected a rejection");
}

beforeEach(() => {
	vi.clearAllMocks();
	world.roles.clear();
	world.roles.set(`${ORG}:user_owner`, "owner");
	world.roles.set(`${ORG}:user_admin`, "admin");
	world.roles.set(`${ORG}:user_member`, "member");
	world.roles.set(`${OTHER_ORG}:user_admin`, "member");
});

describe("createLogoUploadUrl", () => {
	it("signs a PNG PUT of the exact size for the organization's logo path", async () => {
		const result = await sign("user_admin");

		expect(storage.getSignedUploadUrl).toHaveBeenCalledWith(`${ORG}.png`, {
			bucket: "avatars",
			contentType: "image/png",
			contentLength: 120_000,
		});
		expect(result).toEqual({
			signedUploadUrl: `https://storage.example.com/${ORG}.png?put`,
			path: `${ORG}.png`,
			useServerUpload: false,
			storageProvider: "s3",
		});
	});

	it("an owner signs too", async () => {
		await sign("user_owner");
		expect(storage.getSignedUploadUrl).toHaveBeenCalledTimes(1);
	});

	it("a member is FORBIDDEN and nothing is signed", async () => {
		expect(await rejection(sign("user_member"))).toBe("FORBIDDEN");
		expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
	});

	it("an admin of the active organization who is only a member of another cannot sign that one's logo", async () => {
		expect(
			await rejection(sign("user_admin", { organizationId: OTHER_ORG })),
		).toBe("FORBIDDEN");
		expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
	});

	it("a non-member is FORBIDDEN", async () => {
		expect(await rejection(sign("user_stranger"))).toBe("FORBIDDEN");
		expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
	});

	it("requires a positive content length of at most 5 MiB and an organization", () => {
		const schema = (createLogoUploadUrl as unknown as Wired).__input;
		expect(
			schema.safeParse({ organizationId: ORG, contentLength: 5 * MIB })
				.success,
		).toBe(true);
		expect(
			schema.safeParse({
				organizationId: ORG,
				contentLength: 5 * MIB + 1,
			}).success,
		).toBe(false);
		expect(schema.safeParse({ organizationId: ORG }).success).toBe(false);
		expect(
			schema.safeParse({ organizationId: ORG, contentLength: 0 }).success,
		).toBe(false);
		expect(
			schema.safeParse({ organizationId: null, contentLength: 1 })
				.success,
		).toBe(false);
	});
});
