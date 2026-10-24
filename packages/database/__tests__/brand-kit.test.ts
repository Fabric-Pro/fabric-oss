/**
 * Organization Brand kit queries (Fizzy #2589), without a database.
 *
 * The kit lives in its own table. The load-bearing assertion here is the
 * negative one: no Brand kit write reads or writes organization metadata,
 * which the auth library rewrites wholesale.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	const fake = {
		organization: {
			findUnique: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		project: { findUnique: vi.fn() },
		organizationBrandKit: {
			findUnique: vi.fn(),
			findUniqueOrThrow: vi.fn(),
			createMany: vi.fn(),
			updateMany: vi.fn(),
			upsert: vi.fn(),
		},
		$transaction: vi.fn(),
	};
	fake.$transaction.mockImplementation(
		async (run: (tx: typeof fake) => Promise<unknown>) => run(fake),
	);
	return fake;
});

vi.mock("../prisma/client", () => ({ db: fake }));

import {
	BRAND_KIT_MAX_GUIDANCE_LENGTH,
	BrandKitValidationError,
	getBrandKitForProject,
	normalizeBrandKitFields,
	upsertBrandKit,
} from "../prisma/queries/brand-kit";

const saved = {
	organizationId: "org-1",
	accentColors: ["#112233"],
	guidance: null,
	primaryColor: null,
	displayFontFamily: null,
	bodyFontFamily: null,
	displayFontKey: null,
	bodyFontKey: null,
	heroKey: null,
	website: null,
	version: 1,
	updatedById: "u1",
	updatedAt: new Date("2026-09-24T10:00:00Z"),
};

const HERO = "organization-brand/org-1/hero/new-hero.png";
const OLD_HERO = "organization-brand/org-1/hero/old-hero.png";

beforeEach(() => {
	vi.clearAllMocks();
	fake.organizationBrandKit.createMany.mockResolvedValue({ count: 1 });
	fake.organizationBrandKit.updateMany.mockResolvedValue({ count: 1 });
});

describe("normalizeBrandKitFields", () => {
	it("lowercases accents and trims guidance, turning an empty one into null", () => {
		expect(
			normalizeBrandKitFields({
				accentColors: ["#AABBCC", "#0a0B0c"],
				guidance: "   ",
			}),
		).toEqual({ accentColors: ["#aabbcc", "#0a0b0c"], guidance: null });
	});

	it.each([
		[
			{ accentColors: ["#111111", "#222222", "#333333", "#444444"] },
			"tooManyAccents",
		],
		[{ accentColors: ["#12345"] }, "invalidAccent"],
		[{ accentColors: ["#1234567"] }, "invalidAccent"],
		[{ accentColors: ["123456"] }, "invalidAccent"],
		[{ accentColors: ["rgb(1,2,3)"] }, "invalidAccent"],
		[
			{
				accentColors: [],
				guidance: "g".repeat(BRAND_KIT_MAX_GUIDANCE_LENGTH + 1),
			},
			"guidanceTooLong",
		],
	])("rejects %o with %s", (input, code) => {
		expect(() => normalizeBrandKitFields(input)).toThrow(
			expect.objectContaining({ code }),
		);
	});

	it("accepts exactly three accents and 2,000 characters of guidance", () => {
		expect(() =>
			normalizeBrandKitFields({
				accentColors: ["#111111", "#222222", "#333333"],
				guidance: "g".repeat(BRAND_KIT_MAX_GUIDANCE_LENGTH),
			}),
		).not.toThrow();
	});
});

describe("upsertBrandKit", () => {
	it("creates the one row keyed by organization and never touches organization metadata", async () => {
		fake.organizationBrandKit.findUnique.mockResolvedValue(null);
		fake.organizationBrandKit.findUniqueOrThrow.mockResolvedValue(saved);

		const result = await upsertBrandKit({
			organizationId: "org-1",
			accentColors: ["#112233"],
			guidance: null,
			updatedById: "u1",
		});

		expect(fake.organizationBrandKit.createMany).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					organizationId: "org-1",
					accentColors: ["#112233"],
					version: 1,
				}),
			],
			skipDuplicates: true,
		});
		expect(result).toEqual({
			outcome: "applied",
			brandKit: saved,
			changedFields: ["accentColors"],
			supersededKeys: [],
		});
		expect(fake.organization.findUnique).not.toHaveBeenCalled();
		expect(fake.organization.update).not.toHaveBeenCalled();
		expect(fake.organization.updateMany).not.toHaveBeenCalled();
	});

	it("updates under the version it read and reports only the fields that changed", async () => {
		fake.organizationBrandKit.findUnique.mockResolvedValue({
			...saved,
			guidance: "old",
			version: 4,
		});
		fake.organizationBrandKit.findUniqueOrThrow.mockResolvedValue({
			...saved,
			guidance: "new",
			version: 5,
		});

		const result = await upsertBrandKit({
			organizationId: "org-1",
			accentColors: ["#112233"],
			guidance: "new",
			expectedVersion: 4,
			updatedById: "u1",
		});

		expect(fake.organizationBrandKit.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: "org-1", version: 4 },
				data: expect.objectContaining({
					guidance: "new",
					version: { increment: 1 },
				}),
			}),
		);
		expect(result).toMatchObject({
			outcome: "applied",
			changedFields: ["guidance"],
		});
	});

	it("keeps every field a save does not name", async () => {
		fake.organizationBrandKit.findUnique.mockResolvedValue({
			...saved,
			primaryColor: "#1f4e79",
			displayFontFamily: "Example Display",
			heroKey: OLD_HERO,
			website: "https://example.com",
		});
		fake.organizationBrandKit.findUniqueOrThrow.mockResolvedValue(saved);

		await upsertBrandKit({
			organizationId: "org-1",
			accentColors: [],
			guidance: null,
			updatedById: "u1",
		});

		expect(fake.organizationBrandKit.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					primaryColor: "#1f4e79",
					displayFontFamily: "Example Display",
					heroKey: OLD_HERO,
					website: "https://example.com",
				}),
			}),
		);
	});

	it("reports a replaced hero for cleanup", async () => {
		fake.organizationBrandKit.findUnique.mockResolvedValue({
			...saved,
			heroKey: OLD_HERO,
		});
		fake.organizationBrandKit.findUniqueOrThrow.mockResolvedValue({
			...saved,
			heroKey: HERO,
		});

		const result = await upsertBrandKit({
			organizationId: "org-1",
			accentColors: [],
			assets: { heroKey: HERO },
			updatedById: "u1",
		});

		expect(result).toMatchObject({
			outcome: "applied",
			supersededKeys: [OLD_HERO],
		});
	});

	it.each([
		["a stale version", { expectedVersion: 3 }, 0],
		["a version that moved before the write", {}, 0],
	])("writes nothing on %s", async (_label, extra, updated) => {
		fake.organizationBrandKit.findUnique.mockResolvedValue({
			...saved,
			version: 4,
		});
		fake.organizationBrandKit.updateMany.mockResolvedValue({
			count: updated,
		});

		const result = await upsertBrandKit({
			organizationId: "org-1",
			accentColors: [],
			updatedById: "u1",
			...extra,
		});

		expect(result).toEqual({ outcome: "conflict" });
		expect(
			fake.organizationBrandKit.findUniqueOrThrow,
		).not.toHaveBeenCalled();
	});

	it("treats the second of two first saves as a conflict", async () => {
		fake.organizationBrandKit.findUnique.mockResolvedValue(null);
		fake.organizationBrandKit.createMany.mockResolvedValue({ count: 0 });

		expect(
			await upsertBrandKit({
				organizationId: "org-1",
				accentColors: [],
				expectedVersion: 0,
				updatedById: "u1",
			}),
		).toEqual({ outcome: "conflict" });
	});

	it.each([
		[
			{ assets: { heroKey: "organization-brand/org-2/hero/x.png" } },
			"invalidAssetKey",
		],
		[
			{ assets: { heroKey: "organization-brand/org-1/pending/x.png" } },
			"invalidAssetKey",
		],
		[
			{
				assets: {
					displayFontKey: "organization-brand/org-1/hero/x.png",
				},
			},
			"invalidAssetKey",
		],
		[{ primaryColor: "red" }, "invalidPrimary"],
		[{ displayFontFamily: 'Evil"; }' }, "invalidFontFamily"],
		[{ website: "http://example.com" }, "invalidWebsite"],
		[{ website: "https://example.com/brand" }, "invalidWebsite"],
		[{ website: "https://my_site.example.com" }, "invalidWebsite"],
		[{ website: "https://192.0.2.10" }, "invalidWebsite"],
	])("refuses %o with %s before any read", async (extra, code) => {
		await expect(
			upsertBrandKit({
				organizationId: "org-1",
				accentColors: [],
				updatedById: "u1",
				...extra,
			}),
		).rejects.toThrow(expect.objectContaining({ code }));
		expect(fake.organizationBrandKit.findUnique).not.toHaveBeenCalled();
	});

	it("drops a kept font file when its family is renamed or cleared", async () => {
		const DISPLAY = "organization-brand/org-1/fonts/display.woff2";
		const BODY = "organization-brand/org-1/fonts/body.ttf";
		const stored = {
			...saved,
			displayFontFamily: "Example Display",
			bodyFontFamily: "Example Body",
			displayFontKey: DISPLAY,
			bodyFontKey: BODY,
		};
		fake.organizationBrandKit.findUnique.mockResolvedValue(stored);
		fake.organizationBrandKit.findUniqueOrThrow.mockResolvedValue({
			...stored,
			displayFontFamily: "Example Serif",
			displayFontKey: null,
			bodyFontFamily: null,
			bodyFontKey: null,
		});

		const result = await upsertBrandKit({
			organizationId: "org-1",
			accentColors: [],
			displayFontFamily: "Example Serif",
			bodyFontFamily: null,
			updatedById: "u1",
		});

		expect(
			fake.organizationBrandKit.updateMany.mock.calls[0][0].data,
		).toMatchObject({
			displayFontFamily: "Example Serif",
			displayFontKey: null,
			bodyFontFamily: null,
			bodyFontKey: null,
		});
		expect(result).toMatchObject({
			outcome: "applied",
			supersededKeys: [DISPLAY, BODY],
		});
	});

	it("keeps a font file when its family is unchanged or not named", async () => {
		const DISPLAY = "organization-brand/org-1/fonts/display.woff2";
		const BODY = "organization-brand/org-1/fonts/body.ttf";
		const stored = {
			...saved,
			displayFontFamily: "Example Display",
			bodyFontFamily: "Example Body",
			displayFontKey: DISPLAY,
			bodyFontKey: BODY,
		};
		fake.organizationBrandKit.findUnique.mockResolvedValue(stored);
		fake.organizationBrandKit.findUniqueOrThrow.mockResolvedValue(stored);

		const result = await upsertBrandKit({
			organizationId: "org-1",
			accentColors: [],
			displayFontFamily: "  Example   Display ",
			updatedById: "u1",
		});

		expect(
			fake.organizationBrandKit.updateMany.mock.calls[0][0].data,
		).toMatchObject({ displayFontKey: DISPLAY, bodyFontKey: BODY });
		expect(result).toMatchObject({ supersededKeys: [] });
	});

	it("keeps a new file uploaded with a renamed family", async () => {
		const OLD = "organization-brand/org-1/fonts/old.woff2";
		const NEW = "organization-brand/org-1/fonts/new.woff2";
		fake.organizationBrandKit.findUnique.mockResolvedValue({
			...saved,
			displayFontFamily: "Example Display",
			displayFontKey: OLD,
		});
		fake.organizationBrandKit.findUniqueOrThrow.mockResolvedValue({
			...saved,
			displayFontFamily: "Example Serif",
			displayFontKey: NEW,
		});

		const result = await upsertBrandKit({
			organizationId: "org-1",
			accentColors: [],
			displayFontFamily: "Example Serif",
			assets: { displayFontKey: NEW },
			updatedById: "u1",
		});

		expect(
			fake.organizationBrandKit.updateMany.mock.calls[0][0].data,
		).toMatchObject({ displayFontKey: NEW });
		expect(result).toMatchObject({ supersededKeys: [OLD] });
	});

	it("refuses a font file without its family", async () => {
		fake.organizationBrandKit.findUnique.mockResolvedValue(saved);

		await expect(
			upsertBrandKit({
				organizationId: "org-1",
				accentColors: [],
				assets: {
					displayFontKey: "organization-brand/org-1/fonts/f.woff2",
				},
				updatedById: "u1",
			}),
		).rejects.toThrow(
			expect.objectContaining({ code: "fontWithoutFamily" }),
		);
		expect(fake.organizationBrandKit.updateMany).not.toHaveBeenCalled();
	});

	it("rejects invalid input before any read or write", async () => {
		await expect(
			upsertBrandKit({
				organizationId: "org-1",
				accentColors: ["#111111", "#222222", "#333333", "#444444"],
				updatedById: "u1",
			}),
		).rejects.toBeInstanceOf(BrandKitValidationError);
		expect(fake.organizationBrandKit.findUnique).not.toHaveBeenCalled();
		expect(fake.organizationBrandKit.updateMany).not.toHaveBeenCalled();
	});
});

describe("getBrandKitForProject", () => {
	it("reads the kit of the project's own organization", async () => {
		fake.project.findUnique.mockResolvedValue({ organizationId: "org-7" });
		fake.organizationBrandKit.findUnique.mockResolvedValue({
			...saved,
			organizationId: "org-7",
		});

		const kit = await getBrandKitForProject("project-1");

		expect(fake.project.findUnique).toHaveBeenCalledWith({
			where: { id: "project-1" },
			select: { organizationId: true },
		});
		expect(fake.organizationBrandKit.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { organizationId: "org-7" } }),
		);
		expect(kit?.organizationId).toBe("org-7");
	});

	it.each([
		["an unknown project", null],
		["a project outside any organization", { organizationId: null }],
	])(
		"returns null for %s without reading any kit",
		async (_label, project) => {
			fake.project.findUnique.mockResolvedValue(project);
			expect(await getBrandKitForProject("project-1")).toBeNull();
			expect(fake.organizationBrandKit.findUnique).not.toHaveBeenCalled();
		},
	);
});
