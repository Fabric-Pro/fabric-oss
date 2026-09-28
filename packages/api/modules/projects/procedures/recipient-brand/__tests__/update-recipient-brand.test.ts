/**
 * Recipient brand confirmation (Fizzy #2589, KTD19, KTD23).
 *
 * These run the procedures against a small in-memory world rather than a
 * stub per call:
 *   - project, organization-member and project-member rows, read by the REAL
 *     `assertProjectPermission` decision (so guest and cross-project answers
 *     are the gate's own, not a mock's);
 *   - a compare-and-set store that validates with the REAL
 *     `normalizeRecipientBrandFields` — the same key shape the migration's
 *     CHECK constraint enforces;
 *   - a storage bucket that holds bytes, so "deleted" means gone;
 *   - the REAL `normalizeLogo` pipeline, so an SVG or HTML page uploaded as a
 *     PNG is refused by the code that will refuse it in production.
 * Only the outbound website fetch is replaced.
 */
import { crc32, deflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, world, objects, storage } = vi.hoisted(() => {
	const objects = new Map<string, { data: Buffer; contentType: string }>();
	const storage = {
		type: "s3" as const,
		supportsPresignedUrls: true,
		getSignedUrl: vi.fn(
			async (key: string) => `https://storage.example.com/${key}?get`,
		),
		getSignedUploadUrl: vi.fn(
			async (key: string) => `https://storage.example.com/${key}?put`,
		),
		getFileMetadata: vi.fn(async (key: string) => {
			const object = objects.get(key);
			return object
				? {
						size: object.data.length,
						contentType: object.contentType,
						uploadedAt: new Date(),
						pathname: key,
						url: key,
					}
				: null;
		}),
		downloadFile: vi.fn(async (key: string) => {
			const object = objects.get(key);
			if (!object) {
				throw new Error("NoSuchKey");
			}
			return {
				data: object.data,
				contentType: object.contentType,
				size: object.data.length,
			};
		}),
		uploadFile: vi.fn(
			async (
				key: string,
				data: Buffer,
				options: { contentType: string },
			) => {
				objects.set(key, { data, contentType: options.contentType });
				return { url: key, pathname: key };
			},
		),
		deleteObjects: vi.fn(async (keys: string[]) => {
			let deleted = 0;
			for (const key of keys) {
				if (objects.delete(key)) {
					deleted++;
				}
			}
			return { deleted, errors: [] };
		}),
		listObjects: vi.fn(async ({ prefix }: { prefix: string }) => ({
			objects: [...objects.keys()]
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key, lastModified: new Date(), size: 1 })),
			nextContinuationToken: undefined,
		})),
	};
	return {
		objects,
		storage,
		world: {
			projects: new Map<
				string,
				{
					id: string;
					organizationId: string | null;
					userId: string;
					deletedAt: Date | null;
				}
			>(),
			orgMembers: new Map<string, string>(),
			projectMembers: new Map<
				string,
				{
					role: string;
					acceptedAt: Date | null;
					expiresAt: Date | null;
				}
			>(),
			brands: new Map<string, Record<string, unknown>>(),
		},
		mocks: {
			isFeatureEnabled: vi.fn(),
			confirmRecipientBrand: vi.fn(),
			recordAudit: vi.fn(),
			checkRateLimit: vi.fn(),
			fetchWebsiteBrand: vi.fn(),
		},
	};
});

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	const { hasPermission, resolveOrgPermissions, resolveProjectPermissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	const project = (id: string) => world.projects.get(id) ?? null;
	const member = (projectId: string, userId: string) => {
		const row = world.projectMembers.get(`${projectId}:${userId}`);
		return row?.acceptedAt &&
			(row.expiresAt === null || row.expiresAt > new Date())
			? row
			: null;
	};
	return {
		...actual,
		db: {
			project: {
				findUnique: async ({ where }: { where: { id: string } }) =>
					project(where.id),
			},
			projectMember: {
				findUnique: async ({
					where,
				}: {
					where: {
						projectId_userId: { projectId: string; userId: string };
					};
				}) =>
					world.projectMembers.get(
						`${where.projectId_userId.projectId}:${where.projectId_userId.userId}`,
					) ?? null,
			},
			member: {
				findFirst: async ({
					where,
				}: {
					where: { organizationId: string; userId: string };
				}) => {
					const role = world.orgMembers.get(
						`${where.organizationId}:${where.userId}`,
					);
					return role ? { role } : null;
				},
			},
		},
		grantProjectAccess: vi.fn(),
		isFeatureEnabled: mocks.isFeatureEnabled,
		resolveProjectTenant: async (id: string) => {
			const row = project(id);
			return row
				? { organizationId: row.organizationId, userId: null }
				: null;
		},
		// The discovery predicate: an organization member who created the
		// project or was added to it, or an invited guest.
		hasProjectAccess: async (projectId: string, userId: string) => {
			const row = project(projectId);
			if (!row?.organizationId) {
				return false;
			}
			const isOrgMember = world.orgMembers.has(
				`${row.organizationId}:${userId}`,
			);
			return isOrgMember
				? row.userId === userId || member(projectId, userId) !== null
				: member(projectId, userId) !== null;
		},
		// Same precedence as the gate: an active project member row decides,
		// otherwise the organization role.
		canEditProject: async (projectId: string, userId: string) => {
			const row = project(projectId);
			if (!row?.organizationId) {
				return false;
			}
			const active = member(projectId, userId);
			const orgRole = world.orgMembers.get(
				`${row.organizationId}:${userId}`,
			);
			const permissions = active
				? resolveProjectPermissions(
						active.role as Parameters<
							typeof resolveProjectPermissions
						>[0],
					)
				: orgRole
					? resolveOrgPermissions(orgRole)
					: [];
			return hasPermission(permissions, "project:update");
		},
		getRecipientBrand: async (projectId: string) =>
			world.brands.get(projectId) ?? null,
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
const { normalizeLogo } = await vi.importActual<
	typeof import("@repo/integrations/website-brand")
>("@repo/integrations/website-brand");
const { normalizeRecipientBrandFields } =
	await vi.importActual<typeof import("@repo/database")>("@repo/database");

import { createRecipientLogoUploadUrlProcedure } from "../create-recipient-logo-upload-url";
import { fetchRecipientBrandProcedure } from "../fetch-recipient-brand";
import { getRecipientBrandProcedure } from "../get-recipient-brand";
import { updateRecipientBrandProcedure } from "../update-recipient-brand";

// --- fixtures -------------------------------------------------------------

const ORG = "org_1";
const PROJECT = "proj_1";
const OTHER_PROJECT = "proj_2";
const EDITOR_A = "user_editor_a";
const EDITOR_B = "user_editor_b";
const GUEST_EDITOR = "user_guest_editor";
const GUEST_VIEWER = "user_guest_viewer";
const OTHER_GUEST = "user_other_guest";

const PENDING = `project-brand/${PROJECT}/recipient-brand/pending/`;
const CURRENT = `project-brand/${PROJECT}/recipient-brand/current/`;
const CURRENT_KEY = new RegExp(
	`^project-brand/${PROJECT}/recipient-brand/current/[A-Za-z0-9_-]+\\.png$`,
);

/** A real, minimal RGBA PNG of one colour. */
function png(width: number, height: number, rgba: number[]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // RGBA
	const row = Buffer.concat([
		Buffer.from([0]),
		Buffer.from(Array.from({ length: width }, () => rgba).flat()),
	]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk(
			"IDAT",
			deflateSync(
				Buffer.concat(Array.from({ length: height }, () => row)),
			),
		),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const RED_LOGO = png(4, 4, [200, 20, 20, 255]);
const BLUE_LOGO = png(6, 3, [20, 20, 200, 255]);
const SVG_AS_PNG = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const HTML_AS_PNG = Buffer.from(
	"<!doctype html><html><body><script>alert(1)</script></body></html>",
);

async function normalized(bytes: Buffer): Promise<Buffer> {
	const result = await normalizeLogo(bytes);
	if (!result.ok) {
		throw new Error("fixture does not normalize");
	}
	return result.png;
}

// --- harness --------------------------------------------------------------

type Wired = {
	__handler: (args: {
		input: Record<string, unknown>;
		context: unknown;
		signal?: AbortSignal;
	}) => Promise<Record<string, unknown>>;
	__permission: string;
	__input: { parse: (value: unknown) => Record<string, unknown> };
};

function context(userId: string) {
	return {
		user: { id: userId, name: "Editor", email: `${userId}@example.com` },
		session: { id: "session-1", activeOrganizationId: ORG },
	};
}

/**
 * Input validation, then the REAL project-permission decision the middleware
 * makes, then the handler — the order oRPC runs them in.
 */
async function call(
	procedure: unknown,
	rawInput: Record<string, unknown>,
	userId = EDITOR_A,
): Promise<Record<string, unknown>> {
	const wired = procedure as Wired;
	const input = wired.__input.parse(rawInput);
	await assertProjectPermission(
		input.projectId as string,
		userId,
		wired.__permission as Parameters<typeof assertProjectPermission>[2],
	);
	return wired.__handler({ input, context: context(userId) });
}

async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
	throw new Error("expected a rejection");
}

/** An editor's fetch: runs the fetch procedure and returns its token. */
async function fetchAs(userId: string, logo: Buffer): Promise<string> {
	mocks.fetchWebsiteBrand.mockResolvedValueOnce({
		ok: true,
		logoPng: logo,
		colors: ["#123456"],
		finalHost: "example.com",
	});
	const result = await call(
		fetchRecipientBrandProcedure,
		{ projectId: PROJECT, website: "example.com" },
		userId,
	);
	return result.token as string;
}

/** An editor's upload: issues the signed PUT, then "PUTs" the bytes. */
async function uploadAs(
	userId: string,
	bytes: Buffer,
	projectId = PROJECT,
): Promise<string> {
	const result = await call(
		createRecipientLogoUploadUrlProcedure,
		{ projectId, contentType: "image/png", size: bytes.length },
		userId,
	);
	const key = storage.getSignedUploadUrl.mock.lastCall?.[0] as string;
	objects.set(key, { data: bytes, contentType: "image/png" });
	return result.token as string;
}

function confirm(overrides: Record<string, unknown> = {}, userId = EDITOR_A) {
	return call(
		updateRecipientBrandProcedure,
		{
			projectId: PROJECT,
			expectedVersion: 0,
			name: "Example Client",
			website: "example.com",
			colors: ["#123456"],
			logo: { action: "keep" },
			...overrides,
		},
		userId,
	);
}

function keysUnder(prefix: string): string[] {
	return [...objects.keys()].filter((key) => key.startsWith(prefix));
}

/** The compare-and-set, as the query implements it, over `world.brands`. */
function compareAndSet(input: Record<string, unknown>) {
	const projectId = input.projectId as string;
	const current = world.brands.get(projectId);
	const version = (current?.version as number | undefined) ?? 0;
	if (version !== input.expectedVersion) {
		return { outcome: "conflict" as const };
	}
	const fields = normalizeRecipientBrandFields(projectId, input);
	world.brands.set(projectId, {
		projectId,
		organizationId: ORG,
		...fields,
		version: version + 1,
		updatedById: input.updatedById,
		updatedAt: new Date(),
	});
	return {
		outcome: "applied" as const,
		version: version + 1,
		previousLogoKey:
			(current?.logoKey as string | null | undefined) ?? null,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	objects.clear();
	world.projects.clear();
	world.orgMembers.clear();
	world.projectMembers.clear();
	world.brands.clear();

	world.projects.set(PROJECT, {
		id: PROJECT,
		organizationId: ORG,
		userId: EDITOR_A,
		deletedAt: null,
	});
	world.projects.set(OTHER_PROJECT, {
		id: OTHER_PROJECT,
		organizationId: ORG,
		userId: EDITOR_A,
		deletedAt: null,
	});
	world.orgMembers.set(`${ORG}:${EDITOR_A}`, "member");
	world.orgMembers.set(`${ORG}:${EDITOR_B}`, "member");
	const accepted = { acceptedAt: new Date("2026-01-01"), expiresAt: null };
	world.projectMembers.set(`${PROJECT}:${EDITOR_B}`, {
		role: "EDITOR",
		...accepted,
	});
	world.projectMembers.set(`${PROJECT}:${GUEST_EDITOR}`, {
		role: "EDITOR",
		...accepted,
	});
	world.projectMembers.set(`${PROJECT}:${GUEST_VIEWER}`, {
		role: "VIEWER",
		...accepted,
	});
	world.projectMembers.set(`${OTHER_PROJECT}:${OTHER_GUEST}`, {
		role: "EDITOR",
		...accepted,
	});

	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 9,
		resetInSeconds: 600,
	});
	mocks.confirmRecipientBrand.mockImplementation(async (input) =>
		compareAndSet(input),
	);
});

// --- tests ----------------------------------------------------------------

describe("updateRecipientBrandProcedure — promotion (KTD23)", () => {
	it("declares DOCUMENT_UPDATE", () => {
		expect(
			(updateRecipientBrandProcedure as unknown as Wired).__permission,
		).toBe("document:update");
	});

	it("copies a fetched logo to a new immutable key, then compare-and-sets, then cleans up", async () => {
		const token = await fetchAs(EDITOR_A, RED_LOGO);
		expect(keysUnder(PENDING)).toEqual([`${PENDING}${token}.png`]);

		const result = await confirm({ logo: { action: "replace", token } });

		expect(result).toEqual({ outcome: "applied", version: 1 });
		const saved = world.brands.get(PROJECT);
		expect(saved?.logoKey).toMatch(CURRENT_KEY);
		expect(saved).toMatchObject({
			name: "Example Client",
			website: "https://example.com",
			colors: ["#123456"],
			version: 1,
		});
		expect(objects.get(saved?.logoKey as string)).toEqual({
			data: await normalized(RED_LOGO),
			contentType: "image/png",
		});
		// Every pending object is gone; only the promoted one remains.
		expect(keysUnder(PENDING)).toEqual([]);
		expect(keysUnder(CURRENT)).toEqual([saved?.logoKey]);

		// Step order: copy, then the compare-and-set, then cleanup.
		const copyOrder =
			storage.uploadFile.mock.invocationCallOrder.at(-1) ?? 0;
		const casOrder =
			mocks.confirmRecipientBrand.mock.invocationCallOrder[0] ?? 0;
		const cleanupOrder =
			storage.deleteObjects.mock.invocationCallOrder.at(-1) ?? 0;
		expect(copyOrder).toBeLessThan(casOrder);
		expect(casOrder).toBeLessThan(cleanupOrder);

		expect(mocks.recordAudit).toHaveBeenCalledTimes(2); // fetched + updated
		expect(mocks.recordAudit).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.recipient_brand.updated",
				organizationId: ORG,
				projectId: PROJECT,
				metadata: {
					version: 1,
					changedFields: ["name", "website", "colors", "logo"],
				},
			}),
		);
	});

	it("a copy failure before the compare-and-set leaves the row and the current object unchanged", async () => {
		const oldKey = `${CURRENT}old-logo.png`;
		objects.set(oldKey, { data: RED_LOGO, contentType: "image/png" });
		world.brands.set(PROJECT, {
			projectId: PROJECT,
			organizationId: ORG,
			name: "Example Client",
			website: "https://example.com",
			logoKey: oldKey,
			colors: [],
			version: 1,
			updatedAt: new Date(),
		});
		const token = await uploadAs(EDITOR_A, BLUE_LOGO);
		const before = structuredClone(world.brands.get(PROJECT));
		storage.uploadFile.mockRejectedValueOnce(new Error("bucket down"));

		expect(
			await rejection(
				confirm({
					expectedVersion: 1,
					logo: { action: "replace", token },
				}),
			),
		).toBe("INTERNAL_SERVER_ERROR");

		expect(mocks.confirmRecipientBrand).not.toHaveBeenCalled();
		expect(world.brands.get(PROJECT)).toEqual(before);
		expect(objects.get(oldKey)?.data).toEqual(RED_LOGO);
		expect(storage.deleteObjects).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("two confirmations racing on the same version: one applies, the loser's object is deleted", async () => {
		const oldKey = `${CURRENT}old-logo.png`;
		objects.set(oldKey, { data: RED_LOGO, contentType: "image/png" });
		world.brands.set(PROJECT, {
			projectId: PROJECT,
			organizationId: ORG,
			name: null,
			website: null,
			logoKey: oldKey,
			colors: [],
			version: 1,
			updatedAt: new Date(),
		});
		const tokenA = await uploadAs(EDITOR_A, RED_LOGO);
		const tokenB = await uploadAs(EDITOR_B, BLUE_LOGO);

		// Hold each compare-and-set until both have arrived, so both
		// confirmations have read version 1 and promoted their own object
		// before either commits.
		let release: () => void = () => {};
		const bothArrived = new Promise<void>((resolve) => {
			release = resolve;
		});
		let arrivals = 0;
		mocks.confirmRecipientBrand.mockImplementation(async (input) => {
			arrivals++;
			if (arrivals === 2) {
				release();
			}
			await bothArrived;
			return compareAndSet(input);
		});

		const results = await Promise.all([
			confirm(
				{
					expectedVersion: 1,
					logo: { action: "replace", token: tokenA },
				},
				EDITOR_A,
			),
			confirm(
				{
					expectedVersion: 1,
					logo: { action: "replace", token: tokenB },
				},
				EDITOR_B,
			),
		]);

		expect(results.map((r) => r.outcome).sort()).toEqual([
			"applied",
			"conflict",
		]);
		const promoted = storage.uploadFile.mock.calls
			.map((c) => c[0] as string)
			.filter((key) => key.startsWith(CURRENT));
		expect(promoted).toHaveLength(2);
		expect(new Set(promoted).size).toBe(2);

		const winner = results.findIndex((r) => r.outcome === "applied");
		const winnerKey = world.brands.get(PROJECT)?.logoKey as string;
		const loserKey = promoted.find((key) => key !== winnerKey);
		expect(promoted).toContain(winnerKey);
		expect(objects.get(winnerKey)?.data).toEqual(
			await normalized(winner === 0 ? RED_LOGO : BLUE_LOGO),
		);
		expect(objects.has(loserKey as string)).toBe(false);
		// The winner's cleanup took the superseded logo too.
		expect(objects.has(oldKey)).toBe(false);
		expect(world.brands.get(PROJECT)?.version).toBe(2);
	});

	it("overlapping flows: A fetches, B uploads, A confirms; B's stale confirmation conflicts", async () => {
		const tokenA = await fetchAs(EDITOR_A, RED_LOGO);
		const tokenB = await uploadAs(EDITOR_B, BLUE_LOGO);
		expect(keysUnder(PENDING)).toHaveLength(2);

		const a = await confirm(
			{ expectedVersion: 0, logo: { action: "replace", token: tokenA } },
			EDITOR_A,
		);
		expect(a).toEqual({ outcome: "applied", version: 1 });
		const savedKey = world.brands.get(PROJECT)?.logoKey as string;
		expect(objects.get(savedKey)?.data).toEqual(await normalized(RED_LOGO));
		// B's pending upload went with A's cleanup.
		expect(objects.has(`${PENDING}${tokenB}.png`)).toBe(false);

		const b = await confirm(
			{ expectedVersion: 0, logo: { action: "replace", token: tokenB } },
			EDITOR_B,
		);
		expect(b).toEqual({ outcome: "conflict" });
		expect(world.brands.get(PROJECT)?.logoKey).toBe(savedKey);
		expect(world.brands.get(PROJECT)?.version).toBe(1);
	});

	it("refuses a token that was never issued, and another project's token", async () => {
		const neverIssued = "A".repeat(32);
		expect(
			await rejection(
				confirm({ logo: { action: "replace", token: neverIssued } }),
			),
		).toBe("BAD_REQUEST");

		const otherProjectToken = await uploadAs(
			EDITOR_A,
			RED_LOGO,
			OTHER_PROJECT,
		);
		const otherKey = `project-brand/${OTHER_PROJECT}/recipient-brand/pending/${otherProjectToken}.png`;
		expect(objects.has(otherKey)).toBe(true);

		expect(
			await rejection(
				confirm({
					logo: { action: "replace", token: otherProjectToken },
				}),
			),
		).toBe("BAD_REQUEST");

		expect(mocks.confirmRecipientBrand).not.toHaveBeenCalled();
		expect(world.brands.has(PROJECT)).toBe(false);
		// The other project's object is neither read nor touched.
		expect(storage.downloadFile).not.toHaveBeenCalled();
		expect(objects.has(otherKey)).toBe(true);
	});

	it.each([
		[
			"a same-organization workspace file key",
			`workspace-files/${ORG}/logo.png`,
		],
		[
			"another project's key",
			`project-brand/${OTHER_PROJECT}/recipient-brand/pending/${"A".repeat(32)}.png`,
		],
		["a .. key", `../../${OTHER_PROJECT}/recipient-brand/pending/x`],
		["a bare ..", ".."],
	])(
		"refuses %s in place of a token, before any storage read",
		async (_label, token) => {
			expect(
				await rejection(
					confirm({ logo: { action: "replace", token } }),
				),
			).toBe("BAD_REQUEST");
			expect(storage.getFileMetadata).not.toHaveBeenCalled();
			expect(storage.downloadFile).not.toHaveBeenCalled();
			expect(mocks.confirmRecipientBrand).not.toHaveBeenCalled();
		},
	);

	it.each([
		["an SVG", SVG_AS_PNG],
		["an HTML page", HTML_AS_PNG],
	])(
		"rejects %s uploaded as image/png at promotion",
		async (_label, bytes) => {
			const token = await uploadAs(EDITOR_A, bytes);

			const result = await confirm({
				logo: { action: "replace", token },
			});

			expect(result).toEqual({
				outcome: "logoRejected",
				code: "unsupported",
			});
			expect(keysUnder(CURRENT)).toEqual([]);
			expect(keysUnder(PENDING)).toEqual([]);
			expect(mocks.confirmRecipientBrand).not.toHaveBeenCalled();
			expect(world.brands.has(PROJECT)).toBe(false);
		},
	);

	it("keep leaves the logo in place; remove clears it and deletes the object", async () => {
		const token = await uploadAs(EDITOR_A, RED_LOGO);
		await confirm({ logo: { action: "replace", token } });
		const logoKey = world.brands.get(PROJECT)?.logoKey as string;

		const kept = await confirm({
			expectedVersion: 1,
			name: "Example Client Ltd",
			logo: { action: "keep" },
		});
		expect(kept).toEqual({ outcome: "applied", version: 2 });
		expect(world.brands.get(PROJECT)?.logoKey).toBe(logoKey);
		expect(objects.has(logoKey)).toBe(true);
		expect(mocks.recordAudit).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				metadata: { version: 2, changedFields: ["name"] },
			}),
		);

		const removed = await confirm({
			expectedVersion: 2,
			name: "Example Client Ltd",
			logo: { action: "remove" },
		});
		expect(removed).toEqual({ outcome: "applied", version: 3 });
		expect(world.brands.get(PROJECT)?.logoKey).toBeNull();
		expect(objects.has(logoKey)).toBe(false);
	});

	it("refuses a website that is not a public address before promoting anything", async () => {
		const token = await uploadAs(EDITOR_A, RED_LOGO);

		expect(
			await rejection(
				confirm({
					website: "javascript:alert(1)",
					logo: { action: "replace", token },
				}),
			),
		).toBe("BAD_REQUEST");
		expect(keysUnder(CURRENT)).toEqual([]);
		expect(mocks.confirmRecipientBrand).not.toHaveBeenCalled();
	});
});

describe("recipient brand gate (KTD19)", () => {
	it("a trashed project is NOT_FOUND", async () => {
		const project = world.projects.get(PROJECT);
		world.projects.set(PROJECT, {
			...(project as NonNullable<typeof project>),
			deletedAt: new Date(),
		});

		expect(await rejection(confirm())).toBe("NOT_FOUND");
		expect(
			await rejection(
				call(getRecipientBrandProcedure, { projectId: PROJECT }),
			),
		).toBe("NOT_FOUND");
		expect(mocks.confirmRecipientBrand).not.toHaveBeenCalled();
	});

	it("the rollout gate off is NOT_FOUND", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		expect(await rejection(confirm())).toBe("NOT_FOUND");
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"GLOSSY_EDITION",
			ORG,
		);
	});

	it("an invited guest editor of the project can confirm", async () => {
		const token = await uploadAs(GUEST_EDITOR, RED_LOGO);

		const result = await confirm(
			{ logo: { action: "replace", token } },
			GUEST_EDITOR,
		);

		expect(result).toEqual({ outcome: "applied", version: 1 });
		expect(world.brands.get(PROJECT)?.updatedById).toBe(GUEST_EDITOR);
	});

	it("a guest of another project gets NOT_FOUND", async () => {
		expect(await rejection(confirm({}, OTHER_GUEST))).toBe("NOT_FOUND");
		expect(
			await rejection(
				call(
					getRecipientBrandProcedure,
					{ projectId: PROJECT },
					OTHER_GUEST,
				),
			),
		).toBe("NOT_FOUND");
	});

	it("a guest viewer can read but not confirm", async () => {
		await expect(
			call(
				getRecipientBrandProcedure,
				{ projectId: PROJECT },
				GUEST_VIEWER,
			),
		).resolves.toEqual({ version: 0, recipientBrand: null });
		expect(await rejection(confirm({}, GUEST_VIEWER))).toBe("FORBIDDEN");
	});

	it("never takes an organization id from the input", async () => {
		const wired = updateRecipientBrandProcedure as unknown as Wired;
		const parsed = wired.__input.parse({
			projectId: PROJECT,
			expectedVersion: 0,
			name: null,
			website: null,
			colors: [],
			logo: { action: "keep" },
			organizationId: "org_attacker",
		});
		expect(parsed).not.toHaveProperty("organizationId");

		await confirm({ organizationId: "org_attacker" });
		expect(mocks.confirmRecipientBrand).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG }),
		);
	});
});

describe("getRecipientBrandProcedure", () => {
	it("declares DOCUMENT_READ and reports version 0 before anything is confirmed", async () => {
		expect(
			(getRecipientBrandProcedure as unknown as Wired).__permission,
		).toBe("document:read");
		await expect(
			call(getRecipientBrandProcedure, { projectId: PROJECT }),
		).resolves.toEqual({ version: 0, recipientBrand: null });
	});

	it("signs the logo as a short-lived inline PNG and never returns its key", async () => {
		const token = await uploadAs(EDITOR_A, RED_LOGO);
		await confirm({ logo: { action: "replace", token } });
		const logoKey = world.brands.get(PROJECT)?.logoKey as string;

		const result = await call(getRecipientBrandProcedure, {
			projectId: PROJECT,
		});

		expect(result).toMatchObject({
			version: 1,
			recipientBrand: {
				name: "Example Client",
				website: "https://example.com",
				colors: ["#123456"],
				logoUrl: `https://storage.example.com/${logoKey}?get`,
			},
		});
		expect(JSON.stringify(result)).not.toContain('"logoKey"');
		expect(storage.getSignedUrl).toHaveBeenLastCalledWith(logoKey, {
			bucket: "project-contexts",
			expiresIn: 300,
			responseContentType: "image/png",
			responseContentDisposition: "inline",
		});
	});
});
