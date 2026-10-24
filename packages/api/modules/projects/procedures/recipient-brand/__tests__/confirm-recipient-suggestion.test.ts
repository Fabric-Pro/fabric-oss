/**
 * Confirming one field of the recipient website fetch (Fizzy #2946): the
 * Style tab's per-field Confirm copies that field from the stored result into
 * the recipient brand, server-side, through the recipient brand's own
 * compare-and-set.
 *
 * Like `update-recipient-brand.test.ts`, this runs over a small in-memory
 * world: project, organization-member and project-member rows read by the
 * REAL `assertProjectPermission` decision; a compare-and-set store validated
 * by the REAL `normalizeRecipientBrandFields`; a storage bucket that holds
 * bytes; and the REAL `normalizeLogo` pipeline.
 */
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, world, objects, storage } = vi.hoisted(() => {
	const objects = new Map<string, { data: Buffer; contentType: string }>();
	const storage = {
		getSignedUrl: vi.fn(
			async (key: string) => `https://storage.example.com/${key}?get`,
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
			suggestions: new Map<string, Record<string, unknown>>(),
		},
		mocks: {
			isFeatureEnabled: vi.fn(),
			confirmRecipientBrand: vi.fn(),
			getRecipientBrandSuggestion: vi.fn(),
			recordAudit: vi.fn(),
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
		isOrganizationMember: async (userId: string, organizationId: string) =>
			world.orgMembers.has(`${organizationId}:${userId}`),
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
		getRecipientBrand: vi.fn(
			async (projectId: string) => world.brands.get(projectId) ?? null,
		),
		getRecipientBrandSuggestion: mocks.getRecipientBrandSuggestion,
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

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
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
			if (mw.__permission) {
				state.permission = mw.__permission;
			}
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
const { normalizeRecipientBrandFields, RecipientBrandValidationError } =
	await vi.importActual<typeof import("@repo/database")>("@repo/database");
const { getRecipientBrand } = await import("@repo/database");

import { confirmRecipientSuggestionProcedure } from "../confirm-recipient-suggestion";

// --- fixtures -------------------------------------------------------------

const ORG = "org_1";
const OTHER_ORG = "org_2";
const PROJECT = "proj_1";
const OTHER_PROJECT = "proj_2";
const EDITOR = "user_editor";
const GUEST_EDITOR = "user_guest_editor";
const REQUEST_ID = "req-1";
const WEBSITE = "https://client.example.com";

const CURRENT = `project-brand/${PROJECT}/recipient-brand/current/`;
const SUGGESTED = `project-brand/${PROJECT}/recipient-brand/suggested/`;
const CURRENT_KEY = new RegExp(
	`^project-brand/${PROJECT}/recipient-brand/current/[A-Za-z0-9_-]+\\.png$`,
);
const OLD_LOGO_KEY = `${CURRENT}old-logo.png`;
const OLD_LOGO_HASH = "a".repeat(64);
const SUGGESTED_LOGO_KEY = `${SUGGESTED}found-1.png`;

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

const sha256 = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

async function normalized(bytes: Buffer): Promise<Buffer> {
	const result = await normalizeLogo(bytes);
	if (!result.ok) {
		throw new Error("fixture does not normalize");
	}
	return result.png;
}

const SVG_AS_PNG = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

// --- harness --------------------------------------------------------------

type Wired = {
	__handler: (args: {
		input: Record<string, unknown>;
		context: unknown;
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

/** Input validation, the REAL permission decision, then the handler. */
async function confirm(
	overrides: Record<string, unknown> = {},
	userId = EDITOR,
): Promise<Record<string, unknown>> {
	const wired = confirmRecipientSuggestionProcedure as unknown as Wired;
	const input = wired.__input.parse({
		projectId: PROJECT,
		expectedVersion: 1,
		requestId: REQUEST_ID,
		field: "colors",
		...overrides,
	});
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

/** The compare-and-set, as the query implements it, over `world.brands`. */
function compareAndSet(input: Record<string, unknown>) {
	const projectId = input.projectId as string;
	const current = world.brands.get(projectId);
	const version = (current?.version as number | undefined) ?? 0;
	// The query re-checks the attempt the editor saw inside its transaction.
	const named = input.suggestion as { requestId: string } | undefined;
	if (named) {
		const stored = world.suggestions.get(projectId);
		if (
			stored?.requestId !== named.requestId ||
			stored.status !== "SUCCEEDED" ||
			stored.resultWebsite !== current?.website
		) {
			return { outcome: "stale" as const };
		}
	}
	if (version !== input.expectedVersion) {
		return { outcome: "conflict" as const };
	}
	const fields = normalizeRecipientBrandFields(projectId, input);
	world.brands.set(projectId, {
		projectId,
		organizationId: ORG,
		...fields,
		logoHash: fields.logoKey ? (input.logoHash ?? null) : null,
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

function suggestion(overrides: Record<string, unknown> = {}) {
	return {
		projectId: PROJECT,
		organizationId: ORG,
		website: WEBSITE,
		requestId: REQUEST_ID,
		status: "SUCCEEDED",
		failureCode: null,
		requestedById: EDITOR,
		requestedAt: new Date(Date.now() - 30_000),
		resultWebsite: WEBSITE,
		name: "Example Client Group",
		colors: ["#224466", "#88aacc"],
		logoKey: SUGGESTED_LOGO_KEY,
		logoHash: null as string | null,
		fetchedAt: new Date(Date.now() - 20_000),
		...overrides,
	};
}

const RED_LOGO = png(4, 4, [200, 20, 20, 255]);

beforeEach(async () => {
	vi.clearAllMocks();
	objects.clear();
	world.projects.clear();
	world.orgMembers.clear();
	world.projectMembers.clear();
	world.brands.clear();
	world.suggestions.clear();

	world.projects.set(PROJECT, {
		id: PROJECT,
		organizationId: ORG,
		userId: EDITOR,
		deletedAt: null,
	});
	world.orgMembers.set(`${ORG}:${EDITOR}`, "member");
	world.projectMembers.set(`${PROJECT}:${GUEST_EDITOR}`, {
		role: "EDITOR",
		acceptedAt: new Date("2026-01-01"),
		expiresAt: null,
	});

	world.brands.set(PROJECT, {
		projectId: PROJECT,
		organizationId: ORG,
		name: "Example Client",
		website: WEBSITE,
		logoKey: OLD_LOGO_KEY,
		logoHash: OLD_LOGO_HASH,
		colors: ["#111111"],
		version: 1,
		updatedById: EDITOR,
		updatedAt: new Date("2026-10-01"),
	});
	objects.set(OLD_LOGO_KEY, { data: RED_LOGO, contentType: "image/png" });

	// The fetch stored the logo it found already normalized, with its hash.
	const found = await normalized(png(6, 3, [20, 20, 200, 255]));
	objects.set(SUGGESTED_LOGO_KEY, { data: found, contentType: "image/png" });
	world.suggestions.set(PROJECT, suggestion({ logoHash: sha256(found) }));

	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.getRecipientBrandSuggestion.mockImplementation(
		async (input: { projectId: string; organizationId: string }) => {
			const row = world.suggestions.get(input.projectId);
			return row && row.organizationId === input.organizationId
				? row
				: null;
		},
	);
	mocks.confirmRecipientBrand.mockImplementation(async (input) =>
		compareAndSet(input),
	);
});

function nothingWritten() {
	expect(mocks.confirmRecipientBrand).not.toHaveBeenCalled();
	expect(storage.uploadFile).not.toHaveBeenCalled();
	expect(storage.deleteObjects).not.toHaveBeenCalled();
	expect(mocks.recordAudit).not.toHaveBeenCalled();
	expect(world.brands.get(PROJECT)?.version).toBe(1);
}

// --- tests ----------------------------------------------------------------

describe("confirmRecipientSuggestionProcedure — a fetch replacing the suggestion during the confirm", () => {
	it("answers stale and writes nothing when a newer fetch replaced the suggestion before the write", async () => {
		mocks.confirmRecipientBrand.mockImplementationOnce(async (input) => {
			// A new attempt started between the procedure's read and its write.
			world.suggestions.set(
				PROJECT,
				suggestion({
					requestId: "request-newer",
					status: "RUNNING",
					resultWebsite: WEBSITE,
				}),
			);
			return compareAndSet(input);
		});

		const result = await confirm({ field: "logo" });

		expect(result).toEqual({ outcome: "stale" });
		expect(mocks.confirmRecipientBrand).toHaveBeenCalledWith(
			expect.objectContaining({ suggestion: { requestId: REQUEST_ID } }),
		);
		expect(world.brands.get(PROJECT)?.version).toBe(1);
		// The logo this attempt promoted is removed again.
		const deleted = storage.deleteObjects.mock.calls.flatMap(
			([keys]) => keys as string[],
		);
		expect(
			deleted.some((key) =>
				key.startsWith(
					`project-brand/${PROJECT}/recipient-brand/current/`,
				),
			),
		).toBe(true);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});
});

describe("confirmRecipientSuggestionProcedure — applying one field", () => {
	it("declares DOCUMENT_UPDATE and takes no organization from the input", () => {
		const wired = confirmRecipientSuggestionProcedure as unknown as Wired;
		expect(wired.__permission).toBe("document:update");
		expect(
			wired.__input.parse({
				projectId: PROJECT,
				expectedVersion: 1,
				requestId: REQUEST_ID,
				field: "name",
				organizationId: "org_attacker",
			}),
		).not.toHaveProperty("organizationId");
	});

	it("confirming colours applies only the colours", async () => {
		const result = await confirm({ field: "colors" });

		expect(result).toEqual({ outcome: "applied", version: 2 });
		expect(world.brands.get(PROJECT)).toMatchObject({
			name: "Example Client",
			website: WEBSITE,
			colors: ["#224466", "#88aacc"],
			logoKey: OLD_LOGO_KEY,
			logoHash: OLD_LOGO_HASH,
			version: 2,
		});
		expect(mocks.confirmRecipientBrand).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: ORG,
				updatedById: EDITOR,
			}),
		);
		// No logo moved: nothing was read, written or deleted in storage.
		expect(storage.getFileMetadata).not.toHaveBeenCalled();
		expect(storage.uploadFile).not.toHaveBeenCalled();
		expect(storage.deleteObjects).not.toHaveBeenCalled();
		expect(objects.has(OLD_LOGO_KEY)).toBe(true);
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.recipient_brand.updated",
				organizationId: ORG,
				projectId: PROJECT,
				resource: { type: "project", id: PROJECT, name: null },
				metadata: { version: 2, changedFields: ["colors"] },
			}),
		);
	});

	it("neutralizes the name again, whatever the suggestion row holds", async () => {
		world.suggestions.set(
			PROJECT,
			suggestion({ name: "  Example​ Client‮\n Ltd  " }),
		);

		const result = await confirm({ field: "name" });

		expect(result).toEqual({ outcome: "applied", version: 2 });
		expect(world.brands.get(PROJECT)).toMatchObject({
			name: "Example Client Ltd",
			colors: ["#111111"],
			logoKey: OLD_LOGO_KEY,
			logoHash: OLD_LOGO_HASH,
		});
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				metadata: { version: 2, changedFields: ["name"] },
			}),
		);
		// The audit row carries field names, never the name itself.
		expect(JSON.stringify(mocks.recordAudit.mock.calls)).not.toContain(
			"Example Client",
		);
	});

	it("confirming the logo promotes a copy with its hash and deletes the superseded one", async () => {
		const found = objects.get(SUGGESTED_LOGO_KEY)?.data as Buffer;

		const result = await confirm({ field: "logo" });

		expect(result).toEqual({ outcome: "applied", version: 2 });
		const saved = world.brands.get(PROJECT);
		expect(saved?.logoKey).toMatch(CURRENT_KEY);
		expect(saved).toMatchObject({
			name: "Example Client",
			colors: ["#111111"],
			// The same bytes the fetch hashed, so the suggestion's logo now
			// reads as the recipient's own.
			logoHash: sha256(found),
		});
		expect(objects.get(saved?.logoKey as string)).toEqual({
			data: found,
			contentType: "image/png",
		});
		expect(objects.has(OLD_LOGO_KEY)).toBe(false);
		// The suggestion still shows its logo.
		expect(objects.has(SUGGESTED_LOGO_KEY)).toBe(true);
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				metadata: { version: 2, changedFields: ["logo"] },
			}),
		);
	});

	it("refuses logo bytes that do not normalize, and writes nothing", async () => {
		objects.set(SUGGESTED_LOGO_KEY, {
			data: SVG_AS_PNG,
			contentType: "image/png",
		});

		expect(await confirm({ field: "logo" })).toEqual({
			outcome: "logoRejected",
			code: "unsupported",
		});
		nothingWritten();
		expect(world.brands.get(PROJECT)?.logoKey).toBe(OLD_LOGO_KEY);
		expect(objects.has(SUGGESTED_LOGO_KEY)).toBe(true);
	});

	it("deletes the object it promoted when the compare-and-set loses", async () => {
		mocks.confirmRecipientBrand.mockResolvedValueOnce({
			outcome: "conflict",
		});

		expect(await confirm({ field: "logo" })).toEqual({
			outcome: "conflict",
		});

		const promoted = storage.uploadFile.mock.calls.map(
			(args) => args[0] as string,
		);
		expect(promoted).toHaveLength(1);
		expect(promoted[0]).toMatch(CURRENT_KEY);
		expect(objects.has(promoted[0] as string)).toBe(false);
		expect(objects.has(OLD_LOGO_KEY)).toBe(true);
		expect(objects.has(SUGGESTED_LOGO_KEY)).toBe(true);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});
});

describe("confirmRecipientSuggestionProcedure — after the write", () => {
	const PENDING = `project-brand/${PROJECT}/recipient-brand/pending/`;

	it("an applied confirm deletes the project's pending uploads, and only this project's", async () => {
		const own = `${PENDING}${"a".repeat(32)}.png`;
		const other = `project-brand/${OTHER_PROJECT}/recipient-brand/pending/${"b".repeat(32)}.png`;
		objects.set(own, { data: RED_LOGO, contentType: "image/png" });
		objects.set(other, { data: RED_LOGO, contentType: "image/png" });

		expect(await confirm({ field: "colors" })).toEqual({
			outcome: "applied",
			version: 2,
		});

		expect(objects.has(own)).toBe(false);
		expect(objects.has(other)).toBe(true);
		expect(objects.has(OLD_LOGO_KEY)).toBe(true);
		expect(objects.has(SUGGESTED_LOGO_KEY)).toBe(true);
	});

	it("a conflict leaves the pending uploads", async () => {
		const own = `${PENDING}${"a".repeat(32)}.png`;
		objects.set(own, { data: RED_LOGO, contentType: "image/png" });
		mocks.confirmRecipientBrand.mockResolvedValueOnce({
			outcome: "conflict",
		});

		await confirm({ field: "colors" });

		expect(objects.has(own)).toBe(true);
	});

	it("a lost commit answer keeps the logo the saved row points at", async () => {
		mocks.confirmRecipientBrand.mockImplementationOnce(async (input) => {
			compareAndSet(input);
			throw new Error("connection reset");
		});

		expect(await rejection(confirm({ field: "logo" }))).toBe(
			"Error: connection reset",
		);

		const saved = world.brands.get(PROJECT)?.logoKey as string;
		expect(saved).toMatch(CURRENT_KEY);
		expect(objects.has(saved)).toBe(true);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("an error before the commit deletes the object it promoted", async () => {
		mocks.confirmRecipientBrand.mockRejectedValueOnce(
			new Error("connection reset"),
		);

		await rejection(confirm({ field: "logo" }));

		const promoted = storage.uploadFile.mock.calls[0]?.[0] as string;
		expect(promoted).toMatch(CURRENT_KEY);
		expect(objects.has(promoted)).toBe(false);
		expect(world.brands.get(PROJECT)?.logoKey).toBe(OLD_LOGO_KEY);
	});

	it("deletes nothing when the row cannot be read back after an error", async () => {
		mocks.confirmRecipientBrand.mockRejectedValueOnce(
			new Error("connection reset"),
		);
		vi.mocked(getRecipientBrand)
			.mockImplementationOnce(
				async (projectId: string) =>
					(world.brands.get(projectId) ?? null) as never,
			)
			.mockRejectedValueOnce(new Error("connection reset"));

		await rejection(confirm({ field: "logo" }));

		expect(storage.uploadFile).toHaveBeenCalledTimes(1);
		expect(storage.deleteObjects).not.toHaveBeenCalled();
	});

	it("a row that no longer validates is stale, and the promoted object goes", async () => {
		mocks.confirmRecipientBrand.mockRejectedValueOnce(
			new RecipientBrandValidationError("nameTooLong"),
		);

		expect(await confirm({ field: "logo" })).toEqual({ outcome: "stale" });

		const promoted = storage.uploadFile.mock.calls[0]?.[0] as string;
		expect(objects.has(promoted)).toBe(false);
		expect(world.brands.get(PROJECT)?.version).toBe(1);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("a website stored before the host rule is stale, not an error", async () => {
		const brand = world.brands.get(PROJECT) as Record<string, unknown>;
		const legacy = "https://my_site.example.com";
		world.brands.set(PROJECT, { ...brand, website: legacy });
		world.suggestions.set(
			PROJECT,
			suggestion({ website: legacy, resultWebsite: legacy }),
		);

		expect(await confirm({ field: "colors" })).toEqual({
			outcome: "stale",
		});
		expect(world.brands.get(PROJECT)).toMatchObject({
			colors: ["#111111"],
			version: 1,
		});
	});

	it("a long astral name is cut to 200 UTF-16 units and applies", async () => {
		world.suggestions.set(
			PROJECT,
			suggestion({ name: "\u{1F600}".repeat(150) }),
		);

		expect(await confirm({ field: "name" })).toEqual({
			outcome: "applied",
			version: 2,
		});
		expect(world.brands.get(PROJECT)?.name).toBe("\u{1F600}".repeat(100));
	});
});

describe("confirmRecipientSuggestionProcedure — stale and conflicting reads", () => {
	it("a suggestion replaced by a newer fetch is stale, and nothing is written", async () => {
		world.suggestions.set(
			PROJECT,
			suggestion({ requestId: "req-2", colors: ["#999999"] }),
		);

		expect(await confirm({ field: "colors" })).toEqual({
			outcome: "stale",
		});
		nothingWritten();
	});

	it.each([
		["running", { status: "RUNNING", requestedAt: new Date() }],
		["failed", { status: "FAILED", failureCode: "unreachable" }],
		[
			"cut off long ago",
			{
				status: "RUNNING",
				requestedAt: new Date(Date.now() - 10 * 60_000),
			},
		],
	])("an attempt that is %s is stale", async (_label, overrides) => {
		world.suggestions.set(PROJECT, suggestion(overrides));

		expect(await confirm({ field: "colors" })).toEqual({
			outcome: "stale",
		});
		nothingWritten();
	});

	it("a recipient brand that moved since it was read is a conflict", async () => {
		const brand = world.brands.get(PROJECT) as Record<string, unknown>;
		world.brands.set(PROJECT, { ...brand, version: 2 });

		expect(await confirm({ field: "colors", expectedVersion: 1 })).toEqual({
			outcome: "conflict",
		});
		expect(mocks.confirmRecipientBrand).not.toHaveBeenCalled();
		expect(world.brands.get(PROJECT)?.colors).toEqual(["#111111"]);
	});

	it("a website changed since the fetch is stale, whichever version was read", async () => {
		const brand = world.brands.get(PROJECT) as Record<string, unknown>;
		world.brands.set(PROJECT, {
			...brand,
			website: "https://other.example.com",
			version: 2,
		});

		expect(await confirm({ field: "colors", expectedVersion: 1 })).toEqual({
			outcome: "stale",
		});
		expect(await confirm({ field: "colors", expectedVersion: 2 })).toEqual({
			outcome: "stale",
		});
		expect(mocks.confirmRecipientBrand).not.toHaveBeenCalled();
		expect(world.brands.get(PROJECT)?.colors).toEqual(["#111111"]);
	});

	it("a suggestion or recipient brand left in another organization is stale", async () => {
		world.suggestions.set(
			PROJECT,
			suggestion({ organizationId: OTHER_ORG }),
		);
		expect(await confirm()).toEqual({ outcome: "stale" });

		world.suggestions.set(PROJECT, suggestion());
		const brand = world.brands.get(PROJECT) as Record<string, unknown>;
		world.brands.set(PROJECT, { ...brand, organizationId: OTHER_ORG });
		expect(await confirm()).toEqual({ outcome: "stale" });
		expect(mocks.confirmRecipientBrand).not.toHaveBeenCalled();
	});

	it.each([
		["name", { name: null }],
		["name", { name: "​‮ " }],
		["colors", { colors: [] }],
		["logo", { logoKey: null }],
	])(
		"a suggestion with nothing in %s is stale and clears nothing",
		async (field, overrides) => {
			world.suggestions.set(PROJECT, suggestion(overrides));

			expect(await confirm({ field })).toEqual({ outcome: "stale" });
			nothingWritten();
		},
	);

	it.each([
		[
			"another project's suggested logo",
			`project-brand/${OTHER_PROJECT}/recipient-brand/suggested/found-1.png`,
		],
		["a current logo key", `${CURRENT}other.png`],
		[
			"a pending key",
			`project-brand/${PROJECT}/recipient-brand/pending/x.png`,
		],
		["a .. key", `${SUGGESTED}../../${OTHER_PROJECT}/x.png`],
	])(
		"refuses %s in the suggestion before any storage read",
		async (_label, logoKey) => {
			world.suggestions.set(PROJECT, suggestion({ logoKey }));

			expect(await confirm({ field: "logo" })).toEqual({
				outcome: "stale",
			});
			expect(storage.getFileMetadata).not.toHaveBeenCalled();
			expect(storage.downloadFile).not.toHaveBeenCalled();
			nothingWritten();
		},
	);

	it("a suggested logo whose object is gone is stale", async () => {
		objects.delete(SUGGESTED_LOGO_KEY);

		expect(await confirm({ field: "logo" })).toEqual({ outcome: "stale" });
		nothingWritten();
	});

	it("a suggested logo a newer fetch deletes during the read is stale, not an error", async () => {
		storage.downloadFile.mockImplementationOnce(async (key: string) => {
			objects.delete(key);
			throw new Error("Could not download file from S3: NoSuchKey");
		});

		expect(await confirm({ field: "logo" })).toEqual({ outcome: "stale" });
		nothingWritten();
	});

	it("a storage failure while reading a logo that is still there stays an error", async () => {
		storage.downloadFile.mockRejectedValueOnce(
			new Error("Could not download file from S3: timeout"),
		);

		expect(await rejection(confirm({ field: "logo" }))).toBe(
			"INTERNAL_SERVER_ERROR",
		);
		nothingWritten();
		expect(objects.has(SUGGESTED_LOGO_KEY)).toBe(true);
	});
});

describe("confirmRecipientSuggestionProcedure — who may confirm", () => {
	it("a project guest with an editor role is FORBIDDEN before anything is read", async () => {
		expect(await rejection(confirm({}, GUEST_EDITOR))).toBe("FORBIDDEN");
		expect(mocks.getRecipientBrandSuggestion).not.toHaveBeenCalled();
		nothingWritten();
	});

	it("is NOT_FOUND with both rollout gates off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		expect(await rejection(confirm())).toBe("NOT_FOUND");
		nothingWritten();
	});
});
