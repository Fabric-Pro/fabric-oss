/**
 * Organization Brand kit queries (Fizzy #2589), without a database.
 *
 * The kit lives in its own table. The load-bearing assertion here is the
 * negative one: no Brand kit write reads or writes organization metadata,
 * which the auth library rewrites wholesale.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	organization: {
		findUnique: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
	},
	project: { findUnique: vi.fn() },
	organizationBrandKit: { findUnique: vi.fn(), upsert: vi.fn() },
}));

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
	updatedById: "u1",
	updatedAt: new Date("2026-09-24T10:00:00Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
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
	it("upserts the one row keyed by organization and never touches organization metadata", async () => {
		fake.organizationBrandKit.findUnique.mockResolvedValue(null);
		fake.organizationBrandKit.upsert.mockResolvedValue(saved);

		const result = await upsertBrandKit({
			organizationId: "org-1",
			accentColors: ["#112233"],
			guidance: null,
			updatedById: "u1",
		});

		expect(fake.organizationBrandKit.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: "org-1" },
				create: expect.objectContaining({
					organizationId: "org-1",
					accentColors: ["#112233"],
				}),
				update: expect.objectContaining({ accentColors: ["#112233"] }),
			}),
		);
		expect(result).toEqual({
			brandKit: saved,
			changedFields: ["accentColors"],
		});
		expect(fake.organization.findUnique).not.toHaveBeenCalled();
		expect(fake.organization.update).not.toHaveBeenCalled();
		expect(fake.organization.updateMany).not.toHaveBeenCalled();
	});

	it("reports only the fields that changed", async () => {
		fake.organizationBrandKit.findUnique.mockResolvedValue({
			...saved,
			guidance: "old",
		});
		fake.organizationBrandKit.upsert.mockResolvedValue(saved);

		const { changedFields } = await upsertBrandKit({
			organizationId: "org-1",
			accentColors: ["#112233"],
			guidance: "new",
			updatedById: "u1",
		});
		expect(changedFields).toEqual(["guidance"]);
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
		expect(fake.organizationBrandKit.upsert).not.toHaveBeenCalled();
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
