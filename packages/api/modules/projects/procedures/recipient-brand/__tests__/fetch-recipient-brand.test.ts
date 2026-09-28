/**
 * Recipient brand fetch and logo upload issuance (Fizzy #2589, R33, R34,
 * AE9, KTD22, KTD23).
 *
 * The website extractor is replaced (no network); everything around it is
 * real: the permission decision, the rate-limit ordering, the pending-object
 * key the procedure builds, and what it tells the editor and the audit log.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, world, storage } = vi.hoisted(() => ({
	world: {
		deletedAt: null as Date | null,
		projectMembers: new Map<string, { role: string; acceptedAt: Date }>(),
		orgMembers: new Map<string, string>(),
	},
	storage: {
		type: "s3" as const,
		supportsPresignedUrls: true,
		uploadFile: vi.fn(),
		getSignedUrl: vi.fn(
			async (key: string, _options?: unknown) =>
				`https://storage.example.com/${key}?get`,
		),
		getSignedUploadUrl: vi.fn(
			async (key: string, _options?: unknown) =>
				`https://storage.example.com/${key}?put`,
		),
	},
	mocks: {
		isFeatureEnabled: vi.fn(),
		fetchWebsiteBrand: vi.fn(),
		checkRateLimit: vi.fn(),
		recordAudit: vi.fn(),
		confirmRecipientBrand: vi.fn(),
		canEditProject: vi.fn(),
	},
}));

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	const project = () => ({
		id: "proj_1",
		organizationId: "org_1",
		userId: "user_editor",
		deletedAt: world.deletedAt,
	});
	return {
		...actual,
		db: {
			project: { findUnique: async () => project() },
			projectMember: {
				findUnique: async ({
					where,
				}: {
					where: { projectId_userId: { userId: string } };
				}) => {
					const row = world.projectMembers.get(
						where.projectId_userId.userId,
					);
					return row ? { ...row, expiresAt: null } : null;
				},
			},
			member: {
				findFirst: async ({ where }: { where: { userId: string } }) => {
					const role = world.orgMembers.get(where.userId);
					return role ? { role } : null;
				},
			},
		},
		grantProjectAccess: vi.fn(),
		isFeatureEnabled: mocks.isFeatureEnabled,
		resolveProjectTenant: async () => ({
			organizationId: "org_1",
			userId: null,
		}),
		hasProjectAccess: async () => true,
		canEditProject: mocks.canEditProject,
		confirmRecipientBrand: mocks.confirmRecipientBrand,
	};
});

vi.mock("@repo/storage", () => ({ getStorageProvider: () => storage }));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/integrations/website-brand", async () => ({
	...(await vi.importActual<
		typeof import("@repo/integrations/website-brand")
	>("@repo/integrations/website-brand")),
	fetchWebsiteBrand: mocks.fetchWebsiteBrand,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));

vi.mock("../../../../../lib/rate-limit", () => ({
	checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("../../../../../orpc/procedures", async () => {
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	const state: { permission?: string; input?: unknown } = {};
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: (mw: { __permission?: string }) => {
			state.permission = mw.__permission;
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
			__permission: state.permission,
			__input: state.input,
		}),
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (permission: string) => ({
			__permission: permission,
		}),
		Permissions,
	};
});

const { assertProjectPermission } = await vi.importActual<
	typeof import("../../../../../orpc/middleware/require-permission")
>("../../../../../orpc/middleware/require-permission");
const { LOGO_MAX_INPUT_BYTES, WEBSITE_BRAND_RATE_LIMIT } =
	await vi.importActual<typeof import("@repo/integrations/website-brand")>(
		"@repo/integrations/website-brand",
	);

import { createRecipientLogoUploadUrlProcedure } from "../create-recipient-logo-upload-url";
import { fetchRecipientBrandProcedure } from "../fetch-recipient-brand";

const EDITOR = "user_editor";
const VIEWER = "user_viewer";
const PENDING_KEY =
	/^project-brand\/proj_1\/recipient-brand\/pending\/[A-Za-z0-9_-]{32}\.png$/;
const LOGO_PNG = Buffer.from("normalized-png-bytes");

type Wired = {
	__handler: (args: {
		input: Record<string, unknown>;
		context: unknown;
		signal?: AbortSignal;
	}) => Promise<Record<string, unknown>>;
	__permission: string;
	__input: {
		parse: (value: unknown) => Record<string, unknown>;
		safeParse: (value: unknown) => { success: boolean };
	};
};

async function call(
	procedure: unknown,
	rawInput: Record<string, unknown>,
	userId = EDITOR,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const wired = procedure as Wired;
	const input = wired.__input.parse(rawInput);
	await assertProjectPermission(
		input.projectId as string,
		userId,
		wired.__permission as Parameters<typeof assertProjectPermission>[2],
	);
	return wired.__handler({
		input,
		context: {
			user: {
				id: userId,
				name: "Editor",
				email: `${userId}@example.com`,
			},
			session: { id: "session-1", activeOrganizationId: "org_1" },
		},
		signal,
	});
}

function fetchBrand(website = "example.com", userId = EDITOR) {
	return call(
		fetchRecipientBrandProcedure,
		{ projectId: "proj_1", website },
		userId,
	);
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
	world.deletedAt = null;
	world.orgMembers.clear();
	world.projectMembers.clear();
	world.orgMembers.set(EDITOR, "member");
	world.projectMembers.set(VIEWER, {
		role: "VIEWER",
		acceptedAt: new Date("2026-01-01"),
	});

	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.canEditProject.mockImplementation(
		async (_projectId: string, userId: string) =>
			world.orgMembers.get(userId) === "member" ||
			world.projectMembers.get(userId)?.role === "EDITOR",
	);
	mocks.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 9,
		resetInSeconds: 600,
	});
	mocks.fetchWebsiteBrand.mockResolvedValue({
		ok: true,
		logoPng: LOGO_PNG,
		colors: ["#0a66c2", "#123456"],
		finalHost: "www.example.com",
	});
	storage.uploadFile.mockResolvedValue({ url: "x", pathname: "x" });
});

describe("fetchRecipientBrandProcedure", () => {
	it("declares DOCUMENT_UPDATE", () => {
		expect(
			(fetchRecipientBrandProcedure as unknown as Wired).__permission,
		).toBe("document:update");
	});

	it("checks the per-user rate limit before any outbound request", async () => {
		await fetchBrand();

		expect(mocks.checkRateLimit).toHaveBeenCalledWith(
			`website-brand:${EDITOR}`,
			WEBSITE_BRAND_RATE_LIMIT.limit,
			WEBSITE_BRAND_RATE_LIMIT.windowMs,
		);
		expect(mocks.checkRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.fetchWebsiteBrand.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("a success writes a new tokened pending PNG and returns the token, a signed read and colors", async () => {
		const controller = new AbortController();
		const result = await call(
			fetchRecipientBrandProcedure,
			{ projectId: "proj_1", website: "  Example.com/about  " },
			EDITOR,
			controller.signal,
		);

		expect(mocks.fetchWebsiteBrand).toHaveBeenCalledWith(
			"Example.com/about",
			{
				signal: controller.signal,
			},
		);
		const [key, bytes, options] = storage.uploadFile.mock.calls[0] ?? [];
		expect(key).toMatch(PENDING_KEY);
		expect(bytes).toBe(LOGO_PNG);
		expect(options).toEqual({
			bucket: "project-contexts",
			contentType: "image/png",
		});
		expect(result).toEqual({
			outcome: "fetched",
			website: "https://example.com",
			token: (key as string).slice(
				"project-brand/proj_1/recipient-brand/pending/".length,
				-".png".length,
			),
			logoUrl: `https://storage.example.com/${key}?get`,
			colors: ["#0a66c2", "#123456"],
		});
		expect(storage.getSignedUrl).toHaveBeenCalledWith(key, {
			bucket: "project-contexts",
			expiresIn: 300,
			responseContentType: "image/png",
			responseContentDisposition: "inline",
		});
		// A fetch proposes; only a confirmation saves.
		expect(mocks.confirmRecipientBrand).not.toHaveBeenCalled();
	});

	it("each fetch gets its own pending object", async () => {
		const first = await fetchBrand();
		const second = await fetchBrand();

		expect(first.token).not.toBe(second.token);
		const keys = storage.uploadFile.mock.calls.map((c) => c[0]);
		expect(new Set(keys).size).toBe(2);
	});

	it("records the fetch with the host and outcome code only", async () => {
		await fetchBrand("https://www.example.com/pricing?ref=1");

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordAudit).toHaveBeenCalledWith(expect.anything(), {
			action: "project.recipient_brand.fetched",
			category: "project",
			outcome: "success",
			organizationId: "org_1",
			projectId: "proj_1",
			resource: { type: "project", id: "proj_1", name: null },
			metadata: { host: "www.example.com", code: "ok" },
		});
	});

	// AE9: the form falls back to manual entry; the answer carries nothing
	// about the host beyond what the editor typed.
	it.each([
		["blocked", "intranet.example.com"],
		["unreachable", "offline.example.com"],
		["no_logo", "plain.example.com"],
	] as const)(
		"a %s fetch returns a fixed code and no host detail",
		async (code, website) => {
			mocks.fetchWebsiteBrand.mockResolvedValueOnce({
				ok: false,
				code,
				colors: code === "no_logo" ? ["#336699"] : [],
			});

			const result = await fetchBrand(website);

			expect(result).toEqual({
				outcome: "failed",
				code,
				colors: code === "no_logo" ? ["#336699"] : [],
			});
			expect(JSON.stringify(result)).not.toContain(website.split(".")[0]);
			expect(storage.uploadFile).not.toHaveBeenCalled();
			expect(mocks.recordAudit).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					action: "project.recipient_brand.fetched",
					outcome: "failure",
					metadata: { host: website, code },
				}),
			);
		},
	);

	it("an input that names no public website is recorded without a host", async () => {
		mocks.fetchWebsiteBrand.mockResolvedValueOnce({
			ok: false,
			code: "blocked",
			colors: [],
		});

		const result = await fetchBrand("javascript:alert(1)");

		expect(result).toMatchObject({ outcome: "failed", code: "blocked" });
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				metadata: { host: null, code: "blocked" },
			}),
		);
	});

	it("over the rate limit, nothing is fetched", async () => {
		mocks.checkRateLimit.mockResolvedValueOnce({
			allowed: false,
			remaining: 0,
			resetInSeconds: 120,
		});

		expect(await rejection(fetchBrand())).toBe("TOO_MANY_REQUESTS");
		expect(mocks.fetchWebsiteBrand).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("an unavailable rate limiter fails closed", async () => {
		mocks.checkRateLimit.mockResolvedValueOnce({
			allowed: false,
			remaining: 0,
			resetInSeconds: 60,
			statusCode: 503,
		});

		expect(await rejection(fetchBrand())).toBe("SERVICE_UNAVAILABLE");
		expect(mocks.fetchWebsiteBrand).not.toHaveBeenCalled();
	});

	it("a storage failure after a successful fetch is an error with a fixed message, and the fetch is still recorded", async () => {
		storage.uploadFile.mockRejectedValueOnce(
			new Error("socket hang up at 10.0.0.12:9000"),
		);

		let caught: unknown;
		try {
			await fetchBrand();
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Could not store the fetched logo",
		});
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
	});

	it("a trashed project is NOT_FOUND and nothing is fetched", async () => {
		world.deletedAt = new Date();

		expect(await rejection(fetchBrand())).toBe("NOT_FOUND");
		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
		expect(mocks.fetchWebsiteBrand).not.toHaveBeenCalled();
	});

	it("with the rollout gate off it is NOT_FOUND and nothing is fetched", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		expect(await rejection(fetchBrand())).toBe("NOT_FOUND");
		expect(mocks.fetchWebsiteBrand).not.toHaveBeenCalled();
	});

	// Every role that holds DOCUMENT_UPDATE also holds PROJECT_UPDATE today, so
	// only a refused edit check shows that the handler asks it at all.
	it("a caller the project edit check refuses is FORBIDDEN and nothing is fetched", async () => {
		mocks.canEditProject.mockResolvedValue(false);

		expect(await rejection(fetchBrand())).toBe("FORBIDDEN");
		expect(mocks.canEditProject).toHaveBeenCalledWith("proj_1", EDITOR);
		expect(mocks.fetchWebsiteBrand).not.toHaveBeenCalled();
		expect(
			await rejection(
				call(createRecipientLogoUploadUrlProcedure, {
					projectId: "proj_1",
					contentType: "image/png",
					size: 10,
				}),
			),
		).toBe("FORBIDDEN");
		expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
	});

	it("a project viewer is FORBIDDEN and nothing is fetched", async () => {
		expect(await rejection(fetchBrand("example.com", VIEWER))).toBe(
			"FORBIDDEN",
		);
		expect(mocks.fetchWebsiteBrand).not.toHaveBeenCalled();
	});
});

describe("createRecipientLogoUploadUrlProcedure", () => {
	function issue(overrides: Record<string, unknown> = {}) {
		return call(createRecipientLogoUploadUrlProcedure, {
			projectId: "proj_1",
			contentType: "image/webp",
			size: 48_000,
			...overrides,
		});
	}

	it("signs a new tokened pending key for the declared image type and exact size", async () => {
		const result = await issue();

		const [key, options] = storage.getSignedUploadUrl.mock.calls[0] ?? [];
		expect(key).toMatch(PENDING_KEY);
		expect(options).toEqual({
			bucket: "project-contexts",
			contentType: "image/webp",
			contentLength: 48_000,
			expiresIn: 300,
		});
		expect(result).toEqual({
			token: (key as string).slice(
				"project-brand/proj_1/recipient-brand/pending/".length,
				-".png".length,
			),
			signedUploadUrl: `https://storage.example.com/${key}?put`,
			contentType: "image/webp",
		});
	});

	it("each issuance names a new pending object", async () => {
		const first = await issue();
		const second = await issue();
		expect(first.token).not.toBe(second.token);
	});

	it("refuses a non-image type and a size over the cap at the input", () => {
		const schema = (
			createRecipientLogoUploadUrlProcedure as unknown as Wired
		).__input;
		for (const contentType of [
			"image/svg+xml",
			"text/html",
			"image/x-icon",
		]) {
			expect(
				schema.safeParse({ projectId: "proj_1", contentType, size: 10 })
					.success,
			).toBe(false);
		}
		expect(
			schema.safeParse({
				projectId: "proj_1",
				contentType: "image/png",
				size: LOGO_MAX_INPUT_BYTES + 1,
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({
				projectId: "proj_1",
				contentType: "image/png",
				size: LOGO_MAX_INPUT_BYTES,
			}).success,
		).toBe(true);
	});

	it("writes no curated audit row, leaving issuance to activity capture", async () => {
		await issue();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("a project viewer is FORBIDDEN; a trashed project is NOT_FOUND", async () => {
		expect(
			await rejection(
				call(
					createRecipientLogoUploadUrlProcedure,
					{ projectId: "proj_1", contentType: "image/png", size: 10 },
					VIEWER,
				),
			),
		).toBe("FORBIDDEN");

		world.deletedAt = new Date();
		expect(await rejection(issue())).toBe("NOT_FOUND");
		expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
	});
});
