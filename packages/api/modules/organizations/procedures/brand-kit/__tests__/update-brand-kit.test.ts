/**
 * The organization Brand kit procedures (Fizzy #2589, extended in Fizzy #2946).
 *
 * The permission middleware here is the REAL `requireInputOrgPermission`,
 * evaluated against the organization in the input (not the session's), so a
 * member-role FORBIDDEN and a cross-organization FORBIDDEN are the gate's own
 * answers. The handler then narrows to admins and owners and reads the
 * either-or rollout gate for that same organization.
 *
 * Saves run against a small in-memory world rather than a stub per call:
 *   - a compare-and-set kit store that validates with the REAL
 *     `normalizeBrandKitFields` and the REAL key predicates — the same shapes
 *     the migration's CHECK constraints accept;
 *   - a storage bucket that holds bytes, so "deleted" means gone;
 *   - the REAL hero normalizer and font sniff, so an SVG uploaded as a font
 *     is refused by the code that will refuse it in production.
 */
import { crc32, deflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	forgedTrueType,
	forgedWoff2,
	realTrueType,
	realWoff2,
} from "../../../../../__tests__/support/font-fixtures";

type StoredKit = Record<string, unknown> & {
	organizationId: string;
	version: number;
};

const { mocks, world, objects, storage } = vi.hoisted(() => {
	const objects = new Map<
		string,
		{ data: Buffer; contentType: string; lastModified?: Date }
	>();
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
			objects: [...objects.entries()]
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, object]) => ({
					key,
					lastModified: object.lastModified ?? new Date(),
					size: 1,
				})),
			nextContinuationToken: undefined,
		})),
	};
	return {
		objects,
		storage,
		world: {
			kits: new Map<string, StoredKit>(),
			siteFetches: new Map<string, Record<string, unknown>>(),
			/** Role of each user in each organization, `org:user`. */
			roles: new Map<string, string>(),
			/** Flags on per organization, `FLAG:org`. */
			flags: new Set<string>(),
			/** Make the next save lose its compare-and-set to a racing one. */
			raceNextSave: false,
		},
		mocks: {
			upsertBrandKit: vi.fn(),
			updateOrganizationBrandColor: vi.fn(),
			organizationUpdate: vi.fn(),
			organizationFindUnique: vi.fn(),
			recordAudit: vi.fn(),
		},
	};
});

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		db: {
			organization: {
				update: mocks.organizationUpdate,
				findUnique: mocks.organizationFindUnique,
			},
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
		getBrandKit: vi.fn(
			async (organizationId: string) =>
				world.kits.get(organizationId) ?? null,
		),
		getBrandSiteFetch: vi.fn(
			async (organizationId: string) =>
				world.siteFetches.get(organizationId) ?? null,
		),
		upsertBrandKit: mocks.upsertBrandKit,
		updateOrganizationBrandColor: mocks.updateOrganizationBrandColor,
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

const {
	BrandKitValidationError,
	normalizeBrandKitFields,
	isFeatureEnabled,
	getBrandSiteFetch,
} = await import("@repo/database");
const { normalizeHeroImage } = await import("@repo/integrations/website-brand");
const { BRAND_ASSET_REJECTION_CODES, checkBrandAssetFile } = await import(
	"@repo/utils/brand-assets"
);
const { isOrganizationFontKey, isOrganizationHeroKey } = await import(
	"@repo/utils/proposal-artifact/brand-sources"
);
const { brandKitPendingKey, newBrandKitAssetToken } = await import(
	"../../../lib/brand-kit-assets"
);

import { getBrandKitProcedure } from "../get-brand-kit";
import { updateBrandKitProcedure } from "../update-brand-kit";

// --- fixtures -------------------------------------------------------------

const ORG = "org_1";
const OTHER_ORG = "org_2";
const KIB = 1024;
const MIB = 1024 * KIB;

const HERO_KEY = new RegExp(
	`^organization-brand/${ORG}/hero/[A-Za-z0-9_-]+\\.(png|jpg)$`,
);
const FONT_KEY = new RegExp(
	`^organization-brand/${ORG}/fonts/[A-Za-z0-9_-]+\\.(woff2|ttf)$`,
);

const OLD_HERO = `organization-brand/${ORG}/hero/00000000-0000-4000-8000-000000000001.jpg`;
const OLD_DISPLAY_FONT = `organization-brand/${ORG}/fonts/00000000-0000-4000-8000-000000000002.woff2`;

const SAVED_AT = new Date("2026-09-24T10:00:00Z");

/** A real, minimal PNG of one colour: RGBA (color type 6) or RGB (2). */
function png(
	width: number,
	height: number,
	pixel: number[],
	colorType: 2 | 6 = 6,
): Buffer {
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
	header[8] = 8;
	header[9] = colorType;
	const row = Buffer.concat([
		Buffer.from([0]),
		Buffer.from(Array.from({ length: width }, () => pixel).flat()),
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

/** A valid PNG whose header claims `width` x `height`. */
function pngDeclaring(width: number, height: number): Buffer {
	const bytes = png(2, 2, [20, 20, 200, 255]);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
	return bytes;
}

function padded(signature: number[] | string, size = 64): Buffer {
	const head =
		typeof signature === "string"
			? Buffer.from(signature, "ascii")
			: Buffer.from(signature);
	return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
}

const WOFF2 = realWoff2();
const TTF = realTrueType();
const OTF = padded("OTTO");
const SVG_AS_WOFF2 = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

/** A real JPEG, made by the same pipeline from an opaque PNG. */
async function jpegHero(): Promise<Buffer> {
	const result = await normalizeHeroImage(png(32, 16, [13, 148, 136], 2));
	if (!result.ok || result.format !== "jpeg") {
		throw new Error("fixture does not normalize to JPEG");
	}
	return result.bytes;
}

/** A finished upload: the bytes stored at a fresh token's pending key. */
function uploaded(
	bytes: Buffer,
	contentType: string,
	organizationId = ORG,
	lastModified = new Date(),
): string {
	const token = newBrandKitAssetToken();
	objects.set(brandKitPendingKey(organizationId, token), {
		data: bytes,
		contentType,
		lastModified,
	});
	return token;
}

/** Older than the age a save sweeps a pending upload at. */
const SWEEPABLE = new Date(Date.now() - 16 * 60_000);

function keysUnder(prefix: string): string[] {
	return [...objects.keys()].filter((key) => key.startsWith(prefix));
}

function seedKit(overrides: Record<string, unknown> = {}) {
	world.kits.set(ORG, {
		organizationId: ORG,
		accentColors: ["#0a66c2"],
		guidance: "Plain.",
		primaryColor: "#112233",
		displayFontFamily: "Example Display",
		bodyFontFamily: null,
		displayFontKey: OLD_DISPLAY_FONT,
		bodyFontKey: null,
		heroKey: OLD_HERO,
		website: "https://example.com",
		version: 3,
		updatedById: "user_admin",
		updatedAt: SAVED_AT,
		...overrides,
	});
	objects.set(OLD_HERO, {
		data: Buffer.from("old"),
		contentType: "image/jpeg",
	});
	objects.set(OLD_DISPLAY_FONT, {
		data: WOFF2,
		contentType: "font/woff2",
	});
}

const COMPARED_FIELDS = [
	"accentColors",
	"guidance",
	"primaryColor",
	"displayFontFamily",
	"bodyFontFamily",
	"website",
	"displayFontKey",
	"bodyFontKey",
	"heroKey",
] as const;
const ASSET_FIELDS = ["displayFontKey", "bodyFontKey", "heroKey"] as const;

/**
 * The compare-and-set, in memory: the query's own validation and key
 * predicates, its version rule, and its superseded-key report.
 */
async function inMemoryUpsert(
	input: Parameters<typeof normalizeBrandKitFields>[0] & {
		organizationId: string;
		assets?: Record<string, string | null | undefined>;
		expectedVersion?: number;
		updatedById: string;
	},
) {
	const fields = normalizeBrandKitFields(input);
	const assets = input.assets ?? {};
	const fontsValid = [assets.displayFontKey, assets.bodyFontKey].every(
		(key) =>
			key == null || isOrganizationFontKey(input.organizationId, key),
	);
	const heroValid =
		assets.heroKey == null ||
		isOrganizationHeroKey(input.organizationId, assets.heroKey);
	if (!fontsValid || !heroValid) {
		throw new BrandKitValidationError("invalidAssetKey");
	}
	const current = world.kits.get(input.organizationId) ?? null;
	const readVersion = current?.version ?? 0;
	if (
		(input.expectedVersion !== undefined &&
			input.expectedVersion !== readVersion) ||
		world.raceNextSave
	) {
		world.raceNextSave = false;
		return { outcome: "conflict" as const };
	}
	const keep = (name: string, value: unknown) =>
		value !== undefined ? value : (current?.[name] ?? null);
	const next: Record<string, unknown> = {
		accentColors: fields.accentColors,
		guidance: fields.guidance,
		primaryColor: keep("primaryColor", fields.primaryColor),
		displayFontFamily: keep("displayFontFamily", fields.displayFontFamily),
		bodyFontFamily: keep("bodyFontFamily", fields.bodyFontFamily),
		website: keep("website", fields.website),
		displayFontKey: keep("displayFontKey", assets.displayFontKey),
		bodyFontKey: keep("bodyFontKey", assets.bodyFontKey),
		heroKey: keep("heroKey", assets.heroKey),
	};
	if (
		(next.displayFontKey && !next.displayFontFamily) ||
		(next.bodyFontKey && !next.bodyFontFamily)
	) {
		throw new BrandKitValidationError("fontWithoutFamily");
	}
	const brandKit: StoredKit = {
		organizationId: input.organizationId,
		...next,
		version: readVersion + 1,
		updatedById: input.updatedById,
		updatedAt: SAVED_AT,
	};
	world.kits.set(input.organizationId, brandKit);
	const changedFields = COMPARED_FIELDS.filter(
		(name) =>
			JSON.stringify(
				current?.[name] ?? (name === "accentColors" ? [] : null),
			) !== JSON.stringify(brandKit[name]),
	);
	const supersededKeys = ASSET_FIELDS.flatMap((name) => {
		const previous = (current?.[name] as string | null) ?? null;
		return previous && previous !== brandKit[name] ? [previous] : [];
	});
	return {
		outcome: "applied" as const,
		brandKit,
		changedFields,
		supersededKeys,
	};
}

// --- harness --------------------------------------------------------------

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

/** Input validation, the real permission middleware, then the handler. */
async function call(
	procedure: unknown,
	rawInput: Record<string, unknown>,
	userId: string,
): Promise<Record<string, unknown>> {
	const wired = procedure as Wired;
	const input = wired.__input.parse(rawInput);
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

async function rejection(promise: Promise<unknown>): Promise<string> {
	const error = await caught(promise);
	return error.code ?? String(error);
}

function update(userId: string, overrides: Record<string, unknown> = {}) {
	return call(
		updateBrandKitProcedure,
		{
			organizationId: ORG,
			accentColors: ["#0A66C2", "#ff8800"],
			guidance: "Confident, plain, no exclamation marks.",
			...overrides,
		},
		userId,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	objects.clear();
	world.kits.clear();
	world.siteFetches.clear();
	world.roles.clear();
	world.flags.clear();
	world.raceNextSave = false;
	world.roles.set(`${ORG}:user_owner`, "owner");
	world.roles.set(`${ORG}:user_admin`, "admin");
	world.roles.set(`${ORG}:user_member`, "member");
	world.roles.set(`${ORG}:user_viewer`, "viewer");
	world.roles.set(`${OTHER_ORG}:user_other_admin`, "admin");
	// An admin of the active organization who is only a member of another.
	world.roles.set(`${ORG}:user_cross`, "admin");
	world.roles.set(`${OTHER_ORG}:user_cross`, "member");
	world.flags.add(`GLOSSY_EDITION:${ORG}`);
	world.flags.add(`PROPOSAL_ARTIFACT:${ORG}`);
	world.flags.add(`GLOSSY_EDITION:${OTHER_ORG}`);
	mocks.upsertBrandKit.mockImplementation(inMemoryUpsert);
});

describe("updateBrandKitProcedure — access", () => {
	it("a member-role update is FORBIDDEN and writes nothing", async () => {
		expect(await rejection(update("user_member"))).toBe("FORBIDDEN");
		expect(await rejection(update("user_viewer"))).toBe("FORBIDDEN");
		expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("an admin of another organization is FORBIDDEN before the gate is read", async () => {
		expect(await rejection(update("user_other_admin"))).toBe("FORBIDDEN");
		expect(isFeatureEnabled).not.toHaveBeenCalled();
		expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
	});

	it("an admin of the active organization cannot update another organization they are only a member of", async () => {
		expect(
			await rejection(
				update("user_cross", { organizationId: OTHER_ORG }),
			),
		).toBe("FORBIDDEN");
		expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
	});

	it("passes with GLOSSY_EDITION alone and with PROPOSAL_ARTIFACT alone", async () => {
		world.flags.delete(`PROPOSAL_ARTIFACT:${ORG}`);
		expect((await update("user_admin")).outcome).toBe("applied");

		world.flags.delete(`GLOSSY_EDITION:${ORG}`);
		world.flags.add(`PROPOSAL_ARTIFACT:${ORG}`);
		expect((await update("user_admin")).outcome).toBe("applied");
	});

	it("with both rollouts off an admin gets NOT_FOUND and nothing is written", async () => {
		world.flags.clear();

		expect(await rejection(update("user_admin"))).toBe("NOT_FOUND");
		expect(isFeatureEnabled).toHaveBeenCalledWith("GLOSSY_EDITION", ORG);
		expect(isFeatureEnabled).toHaveBeenCalledWith("PROPOSAL_ARTIFACT", ORG);
		expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
	});

	it("an organization id of null is refused before any role check can be skipped", async () => {
		const wired = updateBrandKitProcedure as unknown as Wired;
		expect(
			wired.__input.safeParse({
				organizationId: null,
				accentColors: [],
				guidance: null,
			}).success,
		).toBe(false);
	});
});

describe("updateBrandKitProcedure — fields", () => {
	it("an admin update saves the kit and emits exactly one audit event, field names only", async () => {
		const result = await update("user_admin", {
			primaryColor: "#AA0000",
			displayFontFamily: "Example Display",
		});

		expect(mocks.upsertBrandKit).toHaveBeenCalledWith({
			organizationId: ORG,
			accentColors: ["#0a66c2", "#ff8800"],
			guidance: "Confident, plain, no exclamation marks.",
			primaryColor: "#aa0000",
			displayFontFamily: "Example Display",
			bodyFontFamily: undefined,
			website: undefined,
			assets: {},
			expectedVersion: undefined,
			updatedById: "user_admin",
		});
		expect(result).toMatchObject({
			outcome: "applied",
			brandKit: {
				accentColors: ["#0a66c2", "#ff8800"],
				guidance: "Confident, plain, no exclamation marks.",
				primaryColor: "#aa0000",
				displayFontFamily: "Example Display",
				bodyFontFamily: null,
				hasDisplayFontFile: false,
				hasBodyFontFile: false,
				heroUrl: null,
				website: null,
				version: 1,
				siteFetch: null,
				updatedAt: SAVED_AT,
			},
		});
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordAudit).toHaveBeenCalledWith(expect.anything(), {
			action: "org.brand_kit.updated",
			category: "org",
			organizationId: ORG,
			resource: { type: "organization", id: ORG, name: null },
			metadata: {
				changedFields: [
					"accentColors",
					"guidance",
					"primaryColor",
					"displayFontFamily",
				],
			},
		});
		// Nothing of the guidance text, the colors or the family reaches
		// the audit row.
		expect(
			JSON.stringify(mocks.recordAudit.mock.calls[0]?.[1]),
		).not.toMatch(/Confident|#0a66c2|#ff8800|#aa0000|Example Display/i);
	});

	it("never touches or sends the organization's named brand color", async () => {
		await update("user_owner");

		expect(mocks.updateOrganizationBrandColor).not.toHaveBeenCalled();
		expect(mocks.organizationUpdate).not.toHaveBeenCalled();
		expect(mocks.organizationFindUnique).not.toHaveBeenCalled();
		const sent = mocks.upsertBrandKit.mock.calls[0]?.[0];
		expect(sent).not.toHaveProperty("brandColor");
		// Left out, the primary keeps what the kit stores; nothing fills it.
		expect(sent.primaryColor).toBeUndefined();
		expect(world.kits.get(ORG)?.primaryColor).toBeNull();
	});

	it("leaves out-of-request fields as stored: an older caller changes only the accents and guidance", async () => {
		seedKit();
		const result = await update("user_admin");

		expect(result.outcome).toBe("applied");
		expect(world.kits.get(ORG)).toMatchObject({
			primaryColor: "#112233",
			displayFontFamily: "Example Display",
			website: "https://example.com",
			heroKey: OLD_HERO,
			displayFontKey: OLD_DISPLAY_FONT,
		});
		expect(objects.has(OLD_HERO)).toBe(true);
		expect(objects.has(OLD_DISPLAY_FONT)).toBe(true);
	});

	it("normalizes the website to https://host and clears it with null", async () => {
		await update("user_admin", { website: "Example.COM/about" });
		expect(world.kits.get(ORG)?.website).toBe("https://example.com");

		await update("user_admin", { website: null });
		expect(world.kits.get(ORG)?.website).toBeNull();
	});

	it("refuses a website it cannot normalize, before anything is promoted", async () => {
		const token = uploaded(WOFF2, "font/woff2");
		const error = await caught(
			update("user_admin", {
				website: "mailto:dev@example.com",
				displayFontFamily: "Example Display",
				assets: { displayFont: { action: "replace", token } },
			}),
		);
		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "invalidWebsite" },
		});
		expect(storage.getFileMetadata).not.toHaveBeenCalled();
		expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
	});

	it("refuses an unsafe font family as BAD_REQUEST with its code, before anything is promoted", async () => {
		const token = uploaded(WOFF2, "font/woff2");
		const error = await caught(
			update("user_admin", {
				displayFontFamily: "Inter; } body { color: red",
				assets: { displayFont: { action: "replace", token } },
			}),
		);
		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "invalidFontFamily" },
		});
		expect(storage.getFileMetadata).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("refuses a font file without a family, before it is promoted", async () => {
		const token = uploaded(WOFF2, "font/woff2");
		const error = await caught(
			update("user_admin", {
				assets: { bodyFont: { action: "replace", token } },
			}),
		);
		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "fontWithoutFamily" },
		});
		expect(storage.getFileMetadata).not.toHaveBeenCalled();
	});

	it("refuses too many accents, a non-hex accent or primary and over-long guidance at the input", () => {
		const schema = (updateBrandKitProcedure as unknown as Wired).__input;
		const base = { organizationId: ORG, accentColors: [], guidance: null };
		expect(schema.safeParse(base).success).toBe(true);
		expect(
			schema.safeParse({
				...base,
				accentColors: ["#111111", "#222222", "#333333", "#444444"],
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({ ...base, accentColors: ["red"] }).success,
		).toBe(false);
		expect(schema.safeParse({ ...base, primaryColor: "red" }).success).toBe(
			false,
		);
		expect(
			schema.safeParse({ ...base, guidance: "x".repeat(2001) }).success,
		).toBe(false);
		expect(
			schema.safeParse({
				...base,
				assets: { hero: { action: "replace" } },
			}).success,
		).toBe(false);
	});
});

describe("updateBrandKitProcedure — versions", () => {
	it("a stale expectedVersion is a CONFLICT before any upload is read", async () => {
		seedKit();
		const token = uploaded(await jpegHero(), "image/jpeg");

		expect(
			await rejection(
				update("user_admin", {
					expectedVersion: 2,
					assets: { hero: { action: "replace", token } },
				}),
			),
		).toBe("CONFLICT");
		expect(storage.getFileMetadata).not.toHaveBeenCalled();
		expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
		expect(world.kits.get(ORG)?.version).toBe(3);
	});

	it("version 0 names a kit that was never saved", async () => {
		const result = await update("user_admin", { expectedVersion: 0 });
		expect(result).toMatchObject({
			outcome: "applied",
			brandKit: { version: 1 },
		});
	});

	it("a save that loses the compare-and-set deletes only the files it promoted", async () => {
		seedKit();
		const heroToken = uploaded(await jpegHero(), "image/jpeg");
		const fontToken = uploaded(WOFF2, "font/woff2");
		world.raceNextSave = true;

		expect(
			await rejection(
				update("user_admin", {
					expectedVersion: 3,
					assets: {
						hero: { action: "replace", token: heroToken },
						displayFont: { action: "replace", token: fontToken },
					},
				}),
			),
		).toBe("CONFLICT");

		// The kit's own files and the uploads stay; the copies are gone.
		expect(keysUnder(`organization-brand/${ORG}/hero/`)).toEqual([
			OLD_HERO,
		]);
		expect(keysUnder(`organization-brand/${ORG}/fonts/`)).toEqual([
			OLD_DISPLAY_FONT,
		]);
		expect(objects.has(brandKitPendingKey(ORG, heroToken))).toBe(true);
		expect(objects.has(brandKitPendingKey(ORG, fontToken))).toBe(true);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});
});

describe("updateBrandKitProcedure — a save that fails", () => {
	async function failingSave(committed: boolean) {
		seedKit();
		const heroToken = uploaded(await jpegHero(), "image/jpeg");
		mocks.upsertBrandKit.mockImplementationOnce(async (input) => {
			if (committed) {
				await inMemoryUpsert(input);
			}
			throw new Error("connection reset");
		});
		const error = await caught(
			update("user_admin", {
				expectedVersion: 3,
				assets: { hero: { action: "replace", token: heroToken } },
			}),
		);
		expect(error).toBeInstanceOf(Error);
		return heroToken;
	}

	it("deletes the file it promoted when the stored kit does not point at it", async () => {
		const heroToken = await failingSave(false);

		expect(keysUnder(`organization-brand/${ORG}/hero/`)).toEqual([
			OLD_HERO,
		]);
		expect(world.kits.get(ORG)?.heroKey).toBe(OLD_HERO);
		// The upload stays for a retry.
		expect(objects.has(brandKitPendingKey(ORG, heroToken))).toBe(true);
	});

	it("a lost commit answer deletes nothing the saved kit points at", async () => {
		await failingSave(true);

		const saved = world.kits.get(ORG)?.heroKey as string;
		expect(saved).toMatch(HERO_KEY);
		expect(saved).not.toBe(OLD_HERO);
		expect(objects.has(saved)).toBe(true);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("deletes nothing when the stored kit cannot be read back", async () => {
		const { getBrandKit } = await import("@repo/database");
		seedKit();
		const heroToken = uploaded(await jpegHero(), "image/jpeg");
		mocks.upsertBrandKit.mockRejectedValueOnce(
			new Error("connection reset"),
		);
		vi.mocked(getBrandKit)
			.mockImplementationOnce(
				async (organizationId: string) =>
					(world.kits.get(organizationId) ?? null) as never,
			)
			.mockRejectedValueOnce(new Error("connection reset"));

		await caught(
			update("user_admin", {
				expectedVersion: 3,
				assets: { hero: { action: "replace", token: heroToken } },
			}),
		);

		expect(keysUnder(`organization-brand/${ORG}/hero/`)).toHaveLength(2);
		expect(storage.deleteObjects).not.toHaveBeenCalled();
	});
});

describe("updateBrandKitProcedure — files", () => {
	it("promotes a JPEG hero and a woff2 font to new keys of their column's shape, then deletes the superseded and pending objects", async () => {
		seedKit();
		const heroToken = uploaded(await jpegHero(), "image/jpeg");
		const fontToken = uploaded(WOFF2, "font/woff2");
		// Someone else's abandoned upload: its save can only conflict now.
		const strayToken = uploaded(TTF, "font/ttf", ORG, SWEEPABLE);
		// An upload minutes old may be a form still open: it stays.
		const freshToken = uploaded(TTF, "font/ttf");
		// Another organization's upload is never touched.
		const otherToken = uploaded(TTF, "font/ttf", OTHER_ORG, SWEEPABLE);

		const result = await update("user_admin", {
			expectedVersion: 3,
			assets: {
				hero: { action: "replace", token: heroToken },
				displayFont: { action: "replace", token: fontToken },
			},
		});

		expect(result.outcome).toBe("applied");
		const kit = world.kits.get(ORG);
		expect(kit?.heroKey).toMatch(HERO_KEY);
		expect(kit?.heroKey).toMatch(/\.jpg$/);
		expect(kit?.displayFontKey).toMatch(FONT_KEY);
		expect(kit?.displayFontKey).toMatch(/\.woff2$/);
		expect(objects.get(kit?.heroKey as string)?.contentType).toBe(
			"image/jpeg",
		);
		expect(objects.get(kit?.displayFontKey as string)).toEqual({
			data: WOFF2,
			contentType: "font/woff2",
		});

		expect(objects.has(OLD_HERO)).toBe(false);
		expect(objects.has(OLD_DISPLAY_FONT)).toBe(false);
		// The uploads this save used go whatever their age; of the rest,
		// only the one older than the sweep age.
		expect(keysUnder(`organization-brand/${ORG}/pending/`)).toEqual([
			brandKitPendingKey(ORG, freshToken),
		]);
		expect(objects.has(brandKitPendingKey(ORG, strayToken))).toBe(false);
		expect(objects.has(brandKitPendingKey(OTHER_ORG, otherToken))).toBe(
			true,
		);

		expect(result).toMatchObject({
			brandKit: {
				hasDisplayFontFile: true,
				heroUrl: `https://storage.example.com/${kit?.heroKey}?get`,
				version: 4,
			},
		});
		expect(storage.getSignedUrl).toHaveBeenCalledWith(kit?.heroKey, {
			bucket: "project-contexts",
			expiresIn: 300,
			responseContentType: "image/jpeg",
			responseContentDisposition: "inline",
		});
		// The audit row names the columns, never the keys.
		const audit = JSON.stringify(mocks.recordAudit.mock.calls[0]?.[1]);
		expect(audit).toContain("heroKey");
		expect(audit).not.toContain("organization-brand/");
	});

	it("keeps a hero with transparency as PNG and stores a ttf by what its bytes say", async () => {
		const heroToken = uploaded(png(8, 8, [200, 20, 20, 128]), "image/png");
		// Signed as woff2, but the bytes are TrueType.
		const fontToken = uploaded(TTF, "font/woff2");

		await update("user_admin", {
			bodyFontFamily: "Example Body",
			assets: {
				hero: { action: "replace", token: heroToken },
				bodyFont: { action: "replace", token: fontToken },
			},
		});

		const kit = world.kits.get(ORG);
		expect(kit?.heroKey).toMatch(/\.png$/);
		expect(kit?.bodyFontKey).toMatch(/\.ttf$/);
		expect(objects.get(kit?.bodyFontKey as string)?.contentType).toBe(
			"font/ttf",
		);
	});

	it("saving without touching the hero or fonts sends no key and changes none", async () => {
		seedKit();
		await update("user_admin", {
			expectedVersion: 3,
			assets: {
				hero: { action: "keep" },
				displayFont: { action: "keep" },
				bodyFont: { action: "keep" },
			},
		});

		expect(mocks.upsertBrandKit.mock.calls[0]?.[0].assets).toEqual({});
		expect(world.kits.get(ORG)).toMatchObject({
			heroKey: OLD_HERO,
			displayFontKey: OLD_DISPLAY_FONT,
		});
		expect(objects.has(OLD_HERO)).toBe(true);
		expect(objects.has(OLD_DISPLAY_FONT)).toBe(true);
		expect(storage.uploadFile).not.toHaveBeenCalled();
	});

	it("remove clears the column and deletes the file it pointed at", async () => {
		seedKit();
		const result = await update("user_admin", {
			assets: { hero: { action: "remove" } },
		});

		expect(mocks.upsertBrandKit.mock.calls[0]?.[0].assets).toEqual({
			heroKey: null,
		});
		expect(world.kits.get(ORG)?.heroKey).toBeNull();
		expect(objects.has(OLD_HERO)).toBe(false);
		expect(result).toMatchObject({ brandKit: { heroUrl: null } });
	});

	it.each([
		{
			name: "an .otf font",
			kind: "displayFont",
			bytes: OTF,
			contentType: "font/woff2",
			file: { type: "font/otf", size: OTF.length, name: "Display.otf" },
			code: "unsupported",
		},
		{
			name: "a 600 KiB font",
			kind: "displayFont",
			bytes: Buffer.concat([WOFF2, Buffer.alloc(600 * KIB)]),
			contentType: "font/woff2",
			file: {
				type: "font/woff2",
				size: 600 * KIB + WOFF2.length,
				name: "Display.woff2",
			},
			code: "too_large",
		},
		{
			name: "a 12 MiB hero",
			kind: "hero",
			bytes: Buffer.alloc(12 * MIB),
			contentType: "image/png",
			file: { type: "image/png", size: 12 * MIB, name: "cover.png" },
			code: "too_large",
		},
	])(
		"$name is refused as $code, the code the browser's pre-check answers",
		async ({ kind, bytes, contentType, file, code }) => {
			const token = uploaded(bytes, contentType);
			const result = await update("user_admin", {
				displayFontFamily: "Example Display",
				assets: { [kind]: { action: "replace", token } },
			});

			expect(result).toEqual({ outcome: "assetRejected", kind, code });
			const vocabulary = kind === "hero" ? "hero" : "font";
			expect(checkBrandAssetFile(vocabulary, file)).toEqual({
				ok: false,
				code,
			});
			expect(objects.has(brandKitPendingKey(ORG, token))).toBe(false);
			expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
			expect(mocks.recordAudit).not.toHaveBeenCalled();
		},
	);

	it("an object larger than its kind allows is refused before its bytes are read", async () => {
		const token = uploaded(Buffer.alloc(12 * MIB), "image/png");
		await update("user_admin", {
			assets: { hero: { action: "replace", token } },
		});

		expect(storage.getFileMetadata).toHaveBeenCalledWith(
			brandKitPendingKey(ORG, token),
			{ bucket: "project-contexts" },
		);
		expect(storage.downloadFile).not.toHaveBeenCalled();
	});

	it("refuses an SVG renamed .woff2 and a 9,000 x 9,000 PNG by their bytes", async () => {
		const fontToken = uploaded(SVG_AS_WOFF2, "font/woff2");
		expect(
			await update("user_admin", {
				displayFontFamily: "Example Display",
				assets: {
					displayFont: { action: "replace", token: fontToken },
				},
			}),
		).toEqual({
			outcome: "assetRejected",
			kind: "displayFont",
			code: "unsupported",
		});

		const heroToken = uploaded(pngDeclaring(9000, 9000), "image/png");
		expect(
			await update("user_admin", {
				assets: { hero: { action: "replace", token: heroToken } },
			}),
		).toEqual({
			outcome: "assetRejected",
			kind: "hero",
			code: "too_large",
		});

		for (const code of ["unsupported", "too_large"]) {
			expect(BRAND_ASSET_REJECTION_CODES).toContain(code);
		}
	});

	it.each([
		{
			name: "a bare WOFF2 signature over filler",
			bytes: padded("wOF2"),
			contentType: "font/woff2",
		},
		{
			name: "a WOFF2 file cut short of the length it declares",
			bytes: WOFF2.subarray(0, WOFF2.length - 4),
			contentType: "font/woff2",
		},
		{
			name: "a TrueType file cut inside its table directory",
			bytes: TTF.subarray(0, 100),
			contentType: "font/ttf",
		},
		{
			name: "a WOFF2 container whose data does not decode",
			bytes: forgedWoff2(),
			contentType: "font/woff2",
		},
		{
			name: "a TrueType container whose tables do not decode",
			bytes: forgedTrueType(),
			contentType: "font/ttf",
		},
		{
			name: "a TrueType file with a corrupted middle",
			bytes: Buffer.from(TTF).fill(0xff, 2000, 6000),
			contentType: "font/ttf",
		},
	])(
		"refuses $name, before it is promoted",
		async ({ bytes, contentType }) => {
			const token = uploaded(bytes, contentType);

			expect(
				await update("user_admin", {
					displayFontFamily: "Example Display",
					assets: { displayFont: { action: "replace", token } },
				}),
			).toEqual({
				outcome: "assetRejected",
				kind: "displayFont",
				code: "unsupported",
			});
			expect(keysUnder(`organization-brand/${ORG}/fonts/`)).toEqual([]);
			expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
		},
	);

	it("a refused file undoes the files promoted before it and keeps their uploads for a retry", async () => {
		const heroToken = uploaded(await jpegHero(), "image/jpeg");
		const fontToken = uploaded(OTF, "font/woff2");

		expect(
			await update("user_admin", {
				displayFontFamily: "Example Display",
				assets: {
					hero: { action: "replace", token: heroToken },
					displayFont: { action: "replace", token: fontToken },
				},
			}),
		).toEqual({
			outcome: "assetRejected",
			kind: "displayFont",
			code: "unsupported",
		});

		expect(keysUnder(`organization-brand/${ORG}/hero/`)).toEqual([]);
		expect(objects.has(brandKitPendingKey(ORG, heroToken))).toBe(true);
		expect(objects.has(brandKitPendingKey(ORG, fontToken))).toBe(false);
		expect(world.kits.has(ORG)).toBe(false);
	});

	it.each([
		{
			name: "a token under another organization's pending prefix",
			token: `organization-brand/${OTHER_ORG}/pending/${"a".repeat(32)}`,
		},
		{ name: "a path", token: "pending/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
		{ name: "a parent reference", token: `../${"a".repeat(29)}` },
		{ name: "a short value", token: "abc" },
	])("refuses $name before storage is touched", async ({ token }) => {
		expect(
			await rejection(
				update("user_admin", {
					assets: { hero: { action: "replace", token } },
				}),
			),
		).toBe("BAD_REQUEST");
		expect(storage.getFileMetadata).not.toHaveBeenCalled();
		expect(storage.downloadFile).not.toHaveBeenCalled();
		expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
	});

	it("another organization's upload token does not name its object here", async () => {
		const token = uploaded(await jpegHero(), "image/jpeg", OTHER_ORG);

		expect(
			await rejection(
				update("user_admin", {
					assets: { hero: { action: "replace", token } },
				}),
			),
		).toBe("BAD_REQUEST");
		expect(storage.getFileMetadata).toHaveBeenCalledWith(
			brandKitPendingKey(ORG, token),
			{ bucket: "project-contexts" },
		);
		expect(objects.has(brandKitPendingKey(OTHER_ORG, token))).toBe(true);
		expect(mocks.upsertBrandKit).not.toHaveBeenCalled();
	});
});

describe("getBrandKitProcedure", () => {
	it("any member reads the kit, with defaults before it is first saved", async () => {
		await expect(
			call(getBrandKitProcedure, { organizationId: ORG }, "user_viewer"),
		).resolves.toEqual({
			brandKit: {
				accentColors: [],
				guidance: null,
				updatedAt: null,
				primaryColor: null,
				displayFontFamily: null,
				bodyFontFamily: null,
				hasDisplayFontFile: false,
				hasBodyFontFile: false,
				heroUrl: null,
				website: null,
				version: 0,
				siteFetch: null,
			},
		});
	});

	it("returns the saved kit with a signed hero read and which fonts have files, never a key", async () => {
		seedKit();

		const result = await call(
			getBrandKitProcedure,
			{ organizationId: ORG },
			"user_member",
		);
		expect(result).toEqual({
			brandKit: {
				accentColors: ["#0a66c2"],
				guidance: "Plain.",
				updatedAt: SAVED_AT,
				primaryColor: "#112233",
				displayFontFamily: "Example Display",
				bodyFontFamily: null,
				hasDisplayFontFile: true,
				hasBodyFontFile: false,
				heroUrl: `https://storage.example.com/${OLD_HERO}?get`,
				website: "https://example.com",
				version: 3,
				siteFetch: null,
			},
		});
		expect(JSON.stringify(result)).not.toContain("fonts/");
	});

	it("shows the latest website fetch without who asked for it, and a cut-off attempt as timed out", async () => {
		seedKit();
		world.siteFetches.set(ORG, {
			organizationId: ORG,
			website: "https://example.com",
			requestId: "request-1",
			status: "RUNNING",
			failureCode: null,
			requestedById: "user_admin",
			requestedAt: new Date(Date.now() - 10 * 60 * 1000),
			resultWebsite: "https://example.com",
			primaryColor: "#334455",
			accentColors: ["#667788"],
			fetchedAt: SAVED_AT,
		});

		const result = await call(
			getBrandKitProcedure,
			{ organizationId: ORG },
			"user_member",
		);
		const siteFetch = (result.brandKit as Record<string, unknown>)
			.siteFetch as Record<string, unknown>;
		expect(siteFetch).toMatchObject({
			website: "https://example.com",
			status: "FAILED",
			failureCode: "timed_out",
			resultWebsite: "https://example.com",
			primaryColor: "#334455",
			accentColors: ["#667788"],
			fetchedAt: SAVED_AT,
		});
		expect(siteFetch).not.toHaveProperty("requestedById");
		expect(siteFetch).not.toHaveProperty("requestId");
		expect(JSON.stringify(result)).not.toContain("user_admin");
		expect(getBrandSiteFetch).toHaveBeenCalledWith(ORG);
	});

	it("shows the kit without its hero when the signed read fails", async () => {
		seedKit();
		storage.getSignedUrl.mockRejectedValueOnce(new Error("unavailable"));

		const result = await call(
			getBrandKitProcedure,
			{ organizationId: ORG },
			"user_member",
		);
		expect(result).toMatchObject({
			brandKit: { heroUrl: null, version: 3 },
		});
	});

	it("never signs a stored key that is not this organization's hero", async () => {
		seedKit({
			heroKey: `organization-brand/${OTHER_ORG}/hero/00000000-0000-4000-8000-000000000003.jpg`,
		});

		const result = await call(
			getBrandKitProcedure,
			{ organizationId: ORG },
			"user_member",
		);
		expect(result).toMatchObject({ brandKit: { heroUrl: null } });
		expect(storage.getSignedUrl).not.toHaveBeenCalled();
	});

	it("passes with GLOSSY_EDITION alone and with PROPOSAL_ARTIFACT alone", async () => {
		world.flags.delete(`PROPOSAL_ARTIFACT:${ORG}`);
		await expect(
			call(getBrandKitProcedure, { organizationId: ORG }, "user_member"),
		).resolves.toHaveProperty("brandKit");

		world.flags.delete(`GLOSSY_EDITION:${ORG}`);
		world.flags.add(`PROPOSAL_ARTIFACT:${ORG}`);
		await expect(
			call(getBrandKitProcedure, { organizationId: ORG }, "user_member"),
		).resolves.toHaveProperty("brandKit");
	});

	it("a non-member is FORBIDDEN before the gate is read; with both rollouts off a member gets NOT_FOUND", async () => {
		expect(
			await rejection(
				call(
					getBrandKitProcedure,
					{ organizationId: ORG },
					"user_other_admin",
				),
			),
		).toBe("FORBIDDEN");
		expect(isFeatureEnabled).not.toHaveBeenCalled();

		world.flags.clear();
		expect(
			await rejection(
				call(
					getBrandKitProcedure,
					{ organizationId: ORG },
					"user_member",
				),
			),
		).toBe("NOT_FOUND");
		expect(storage.getSignedUrl).not.toHaveBeenCalled();
	});
});
