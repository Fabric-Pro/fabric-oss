/**
 * Signing a Brand kit hero or font upload (Fizzy #2946).
 *
 * The permission middleware here is the REAL `requireInputOrgPermission`,
 * evaluated against the organization in the input (not the session's); the
 * handler then narrows to admins and owners, reads the either-or gate, and
 * checks the type and size against the upload vocabulary the browser uses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { world, storage } = vi.hoisted(() => ({
	world: {
		roles: new Map<string, string>(),
		flags: new Set<string>(),
	},
	storage: {
		type: "s3" as const,
		supportsPresignedUrls: true,
		getSignedUploadUrl: vi.fn(
			async (key: string) => `https://storage.example.com/${key}?put`,
		) as ((key: string, options: unknown) => Promise<string>) | null,
		getFileMetadata: vi.fn(),
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
	isFeatureEnabled: vi.fn(async (flag: string, organizationId: string) =>
		world.flags.has(`${flag}:${organizationId}`),
	),
	resolveProjectTenant: vi.fn(),
}));

vi.mock("@repo/storage", () => ({ getStorageProvider: () => storage }));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../../orpc/procedures", async () => {
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	const { requireInputOrgPermission } = await vi.importActual<
		typeof import("../../../../../orpc/middleware/require-permission")
	>("../../../../../orpc/middleware/require-permission");
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

const { isFeatureEnabled } = await import("@repo/database");
const { BRAND_ASSET_MAX_BYTES, checkBrandAssetFile } = await import(
	"@repo/utils/brand-assets"
);

import { createBrandAssetUploadUrlProcedure } from "../create-brand-asset-upload-url";

const ORG = "org_1";
const OTHER_ORG = "org_2";
const KIB = 1024;
const MIB = 1024 * KIB;
const PENDING_KEY = new RegExp(
	`^organization-brand/${ORG}/pending/[A-Za-z0-9_-]{32}$`,
);

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
	const wired = createBrandAssetUploadUrlProcedure as unknown as Wired;
	const input = wired.__input.parse({
		organizationId: ORG,
		kind: "displayFont",
		contentType: "font/woff2",
		contentLength: 40 * KIB,
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

async function caught(promise: Promise<unknown>): Promise<{
	code?: string;
	data?: { code?: string };
}> {
	try {
		await promise;
	} catch (error) {
		return error as { code?: string; data?: { code?: string } };
	}
	throw new Error("expected a rejection");
}

const signUpload = () =>
	storage.getSignedUploadUrl as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	storage.supportsPresignedUrls = true;
	storage.getSignedUploadUrl = vi.fn(
		async (key: string) => `https://storage.example.com/${key}?put`,
	);
	world.roles.clear();
	world.flags.clear();
	world.roles.set(`${ORG}:user_owner`, "owner");
	world.roles.set(`${ORG}:user_admin`, "admin");
	world.roles.set(`${ORG}:user_member`, "member");
	world.roles.set(`${OTHER_ORG}:user_other_admin`, "admin");
	world.roles.set(`${ORG}:user_cross`, "admin");
	world.roles.set(`${OTHER_ORG}:user_cross`, "member");
	world.flags.add(`GLOSSY_EDITION:${ORG}`);
	world.flags.add(`PROPOSAL_ARTIFACT:${ORG}`);
	world.flags.add(`GLOSSY_EDITION:${OTHER_ORG}`);
});

describe("createBrandAssetUploadUrlProcedure", () => {
	it("signs a PUT for the kind's content type and the exact size, under a new pending token", async () => {
		const result = await sign("user_admin", {
			kind: "hero",
			contentType: "image/jpeg",
			contentLength: 3 * MIB,
		});

		expect(result.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
		const key = `organization-brand/${ORG}/pending/${result.token}`;
		expect(key).toMatch(PENDING_KEY);
		expect(result).toEqual({
			token: result.token,
			signedUploadUrl: `https://storage.example.com/${key}?put`,
		});
		expect(signUpload()).toHaveBeenCalledWith(key, {
			bucket: "project-contexts",
			contentType: "image/jpeg",
			contentLength: 3 * MIB,
			expiresIn: 300,
		});
		// Signing reads nothing from storage.
		expect(storage.getFileMetadata).not.toHaveBeenCalled();
	});

	it("issues a new token on every call", async () => {
		const first = await sign("user_owner");
		const second = await sign("user_owner");
		expect(first.token).not.toBe(second.token);
	});

	it("a member is FORBIDDEN and nothing is signed", async () => {
		expect((await caught(sign("user_member"))).code).toBe("FORBIDDEN");
		expect(signUpload()).not.toHaveBeenCalled();
	});

	it("a non-member is FORBIDDEN before the gate is read", async () => {
		expect((await caught(sign("user_other_admin"))).code).toBe("FORBIDDEN");
		expect(isFeatureEnabled).not.toHaveBeenCalled();
		expect(signUpload()).not.toHaveBeenCalled();
	});

	it("an admin of the active organization cannot sign an upload for another organization they are only a member of", async () => {
		expect(
			(await caught(sign("user_cross", { organizationId: OTHER_ORG })))
				.code,
		).toBe("FORBIDDEN");
		expect(signUpload()).not.toHaveBeenCalled();
	});

	it("passes with either rollout and is NOT_FOUND with both off", async () => {
		world.flags.delete(`PROPOSAL_ARTIFACT:${ORG}`);
		expect((await sign("user_admin")).token).toBeTruthy();

		world.flags.delete(`GLOSSY_EDITION:${ORG}`);
		world.flags.add(`PROPOSAL_ARTIFACT:${ORG}`);
		expect((await sign("user_admin")).token).toBeTruthy();

		world.flags.clear();
		expect((await caught(sign("user_admin"))).code).toBe("NOT_FOUND");
		expect(signUpload()).toHaveBeenCalledTimes(2);
	});

	it.each([
		{
			name: "an .otf font",
			input: { kind: "bodyFont", contentType: "font/otf" },
			file: { type: "font/otf", size: 40 * KIB, name: "Body.otf" },
			vocabulary: "font",
			code: "unsupported",
		},
		{
			name: "a GIF hero",
			input: { kind: "hero", contentType: "image/gif" },
			file: { type: "image/gif", size: 40 * KIB, name: "cover.gif" },
			vocabulary: "hero",
			code: "unsupported",
		},
		{
			name: "a 600 KiB font",
			input: { contentLength: 600 * KIB },
			file: {
				type: "font/woff2",
				size: 600 * KIB,
				name: "Display.woff2",
			},
			vocabulary: "font",
			code: "too_large",
		},
		{
			name: "a 12 MiB hero",
			input: {
				kind: "hero",
				contentType: "image/png",
				contentLength: 12 * MIB,
			},
			file: { type: "image/png", size: 12 * MIB, name: "cover.png" },
			vocabulary: "hero",
			code: "too_large",
		},
	] as const)(
		"refuses $name with $code, the code the browser's pre-check answers",
		async ({ input, file, vocabulary, code }) => {
			const error = await caught(
				sign("user_admin", { contentLength: 40 * KIB, ...input }),
			);
			expect(error).toMatchObject({
				code: "BAD_REQUEST",
				data: { code },
			});
			expect(checkBrandAssetFile(vocabulary, file)).toEqual({
				ok: false,
				code,
			});
			expect(signUpload()).not.toHaveBeenCalled();
		},
	);

	it("signs a file at exactly its kind's cap", async () => {
		await sign("user_admin", {
			kind: "bodyFont",
			contentType: "font/ttf",
			contentLength: BRAND_ASSET_MAX_BYTES.font,
		});
		expect(signUpload()).toHaveBeenCalledTimes(1);
	});

	it("refuses a null organization, an unknown kind and a size that is not a positive integer at the input", () => {
		const schema = (createBrandAssetUploadUrlProcedure as unknown as Wired)
			.__input;
		const base = {
			organizationId: ORG,
			kind: "hero",
			contentType: "image/png",
			contentLength: 1,
		};
		expect(schema.safeParse(base).success).toBe(true);
		expect(
			schema.safeParse({ ...base, organizationId: null }).success,
		).toBe(false);
		expect(schema.safeParse({ ...base, kind: "logo" }).success).toBe(false);
		expect(schema.safeParse({ ...base, contentLength: 0 }).success).toBe(
			false,
		);
		expect(schema.safeParse({ ...base, contentLength: 1.5 }).success).toBe(
			false,
		);
	});

	it("is SERVICE_UNAVAILABLE when storage cannot sign uploads", async () => {
		storage.supportsPresignedUrls = false;
		expect((await caught(sign("user_admin"))).code).toBe(
			"SERVICE_UNAVAILABLE",
		);
	});
});
