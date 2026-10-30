/**
 * The brand logos and hero a Proposal export prints (Fizzy #2946): each key
 * is checked against the one place its upload writes before a byte is read
 * (the organization logo is `{organizationId}.png` in the avatars bucket, the
 * hero a promoted Brand kit hero of the export's own organization, a
 * recipient logo sits under this project's promoted recipient-brand prefix),
 * read, charged against the export's image budget and re-encoded, a logo at
 * 1200 px and the hero at the export's image edge. Any asset that fails is
 * left off the cover, keeping its source, and all of them count toward one
 * `LOGO_UNAVAILABLE` warning.
 *
 * Mocked: `@repo/config` (distinct bucket names), `@repo/storage` (its
 * default reader is never used: every test injects `read`) and the activity
 * logger. The normalizer is the real one unless a test replaces a call. `@repo/database`
 * is mocked down to the two real key predicates, so the rules under test are
 * the shipped ones. Images are real PNG and JPEG bytes from `sharp`, and the
 * real normalizer decodes them. Each logo is measured too, so the dark
 * cover can set one drawn for a light background on a plate.
 */

import { buildProposalThemeTokens } from "@repo/utils/proposal-artifact/theme-tokens";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				avatars: "example-avatars",
				projectContexts: "example-project-contexts",
			},
		},
	},
}));
vi.mock("@repo/storage", () => ({
	downloadFile: vi.fn(async () => {
		throw new Error("the default reader is not used in these tests");
	}),
}));
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		trustedOrganizationLogoKey: actual.trustedOrganizationLogoKey,
		isRecipientLogoKeyForProject: actual.isRecipientLogoKeyForProject,
	};
});

vi.mock("../../lib/activity-logger", () => ({
	activityLogger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// The real normalizer, which a test may replace for a call or two.
vi.mock(
	"../../../lib/proposal-export/normalize-image",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../lib/proposal-export/normalize-image")
			>();
		return {
			...actual,
			normalizeExportImage: vi.fn(actual.normalizeExportImage),
		};
	},
);

import { createExportImageBudget } from "../../../lib/proposal-export/extract-document-images";
import { normalizeExportImage } from "../../../lib/proposal-export/normalize-image";
import { COVER_LOGO_DARK_LUMINANCE } from "../../../lib/proposal-export/types";
import {
	loadThemeAssets,
	measureHero,
	measureLogo,
	type ThemeAssetLocation,
	themeAssetLocation,
} from "../load-theme-assets";

const ORGANIZATION = "org-example-1";
const PROJECT = "project-example-1";
const ORG_LOGO_KEY = `${ORGANIZATION}.png`;
const RECIPIENT_LOGO_KEY = `project-brand/${PROJECT}/recipient-brand/current/abc123.png`;
const HERO_KEY = `organization-brand/${ORGANIZATION}/hero/hero-1.jpg`;
const SCOPE = { organizationId: ORGANIZATION, projectId: PROJECT };

let png: Buffer;
let opaquePng: Buffer;
let wide: Buffer;
let wider: Buffer;

beforeAll(async () => {
	png = await sharp({
		create: {
			width: 40,
			height: 30,
			channels: 4,
			background: { r: 10, g: 120, b: 200, alpha: 0.5 },
		},
	})
		.png()
		.toBuffer();
	opaquePng = await sharp({
		create: {
			width: 60,
			height: 20,
			channels: 3,
			background: { r: 200, g: 40, b: 40 },
		},
	})
		.png()
		.toBuffer();
	wide = await sharp({
		create: {
			width: 2400,
			height: 120,
			channels: 3,
			background: { r: 20, g: 20, b: 20 },
		},
	})
		.png()
		.toBuffer();
	wider = await sharp({
		create: {
			width: 3000,
			height: 150,
			channels: 3,
			background: { r: 30, g: 60, b: 90 },
		},
	})
		.jpeg()
		.toBuffer();
});

afterEach(() => {
	warn.mockClear();
	// Back to the real normalizer, any queued replacement dropped.
	vi.mocked(normalizeExportImage).mockReset();
});

function tokens(logos: {
	organization?: string | null;
	recipient?: string | null;
	hero?: string | null;
}) {
	return buildProposalThemeTokens({
		organization: {
			name: "Example Org",
			logoKey: logos.organization ?? null,
		},
		style: null,
		brandKit:
			logos.hero === undefined
				? null
				: { accentColors: [], heroKey: logos.hero },
		recipient: {
			name: "Example Client",
			logoKey: logos.recipient ?? null,
			colors: [],
		},
	});
}

/** A reader serving `objects` by `bucket/key`, throwing for anything else. */
function reader(objects: Record<string, Buffer | Error>) {
	return vi.fn(async ({ bucket, key }: ThemeAssetLocation) => {
		const object = objects[`${bucket}/${key}`];
		if (!object) {
			throw new Error("NoSuchKey");
		}
		if (object instanceof Error) {
			throw object;
		}
		return object;
	});
}

describe("loadThemeAssets: logos that load", () => {
	it("reads each logo from its own bucket and returns re-encoded rasters", async () => {
		const read = reader({
			[`example-avatars/${ORG_LOGO_KEY}`]: png,
			[`example-project-contexts/${RECIPIENT_LOGO_KEY}`]: opaquePng,
		});

		const result = await loadThemeAssets({
			tokens: tokens({
				organization: ORG_LOGO_KEY,
				recipient: RECIPIENT_LOGO_KEY,
			}),
			...SCOPE,
			budget: createExportImageBudget(),
			read,
		});

		expect(read).toHaveBeenCalledTimes(2);
		expect(read).toHaveBeenCalledWith({
			bucket: "example-avatars",
			key: ORG_LOGO_KEY,
		});
		expect(read).toHaveBeenCalledWith({
			bucket: "example-project-contexts",
			key: RECIPIENT_LOGO_KEY,
		});

		const proposer = result.tokens.proposer.logo;
		expect(proposer.source).toBe("BRAND_KIT");
		expect(proposer.value).toMatchObject({
			mimeType: "image/png",
			width: 40,
			height: 30,
		});
		expect(Buffer.isBuffer(proposer.value?.bytes)).toBe(true);

		const recipient = result.tokens.recipient.logo;
		expect(recipient.source).toBe("MANUAL");
		expect(recipient.value).toMatchObject({
			mimeType: "image/jpeg",
			width: 60,
			height: 20,
		});
		expect(result.warnings).toEqual([]);
	});

	it("charges what it reads against the shared image budget", async () => {
		const budget = createExportImageBudget(1_000_000);

		await loadThemeAssets({
			tokens: tokens({ organization: ORG_LOGO_KEY }),
			...SCOPE,
			budget,
			read: reader({ [`example-avatars/${ORG_LOGO_KEY}`]: png }),
		});

		expect(budget.remainingBytes).toBe(1_000_000 - png.byteLength);
	});

	it("keeps a logo's longest edge within print resolution", async () => {
		const result = await loadThemeAssets({
			tokens: tokens({ organization: ORG_LOGO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({ [`example-avatars/${ORG_LOGO_KEY}`]: wide }),
		});

		expect(result.tokens.proposer.logo.value).toMatchObject({
			width: 1200,
			height: 60,
		});
	});

	it("steps a logo down until print can inline it as a data URL", async () => {
		const normalize = vi.mocked(normalizeExportImage);
		const real =
			normalize.getMockImplementation() as typeof normalizeExportImage;
		// Over the cap at 1200 px, as a high-entropy logo would be.
		normalize.mockImplementation(async (bytes, options) =>
			(options?.maxEdge ?? 0) >= 1200
				? {
						ok: true,
						image: {
							mimeType: "image/png",
							bytes: Buffer.alloc(1_500_001),
							width: 1200,
							height: 60,
						},
					}
				: real(bytes, options),
		);

		const result = await loadThemeAssets({
			tokens: tokens({ organization: ORG_LOGO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({ [`example-avatars/${ORG_LOGO_KEY}`]: wide }),
		});

		expect(
			normalize.mock.calls.map(([, options]) => options?.maxEdge),
		).toEqual([1200, 900]);
		const logo = result.tokens.proposer.logo.value;
		expect(logo).toMatchObject({ width: 900, height: 45 });
		expect(logo?.bytes.byteLength).toBeLessThanOrEqual(1_500_000);
		expect(result.warnings).toEqual([]);
	});

	it("leaves out a logo over the byte cap at every edge, in one warning", async () => {
		vi.mocked(normalizeExportImage).mockImplementation(
			async (_bytes, options) => ({
				ok: true,
				image: {
					mimeType: "image/png",
					bytes: Buffer.alloc(1_500_001),
					width: options?.maxEdge ?? 0,
					height: 60,
				},
			}),
		);

		const result = await loadThemeAssets({
			tokens: tokens({ organization: ORG_LOGO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({ [`example-avatars/${ORG_LOGO_KEY}`]: wide }),
		});

		expect(
			vi
				.mocked(normalizeExportImage)
				.mock.calls.map(([, options]) => options?.maxEdge),
		).toEqual([1200, 900]);
		expect(result.tokens.proposer.logo.value).toBeNull();
		expect(result.warnings).toEqual([
			{ code: "LOGO_UNAVAILABLE", count: 1 },
		]);
	});

	it("reads nothing and warns about nothing for the default tokens: no logo, no hero, the neutral faces", async () => {
		const read = reader({});
		const input = buildProposalThemeTokens({
			organization: null,
			style: null,
			brandKit: null,
			recipient: null,
		});

		const result = await loadThemeAssets({
			tokens: input,
			...SCOPE,
			budget: createExportImageBudget(),
			read,
		});

		expect(read).not.toHaveBeenCalled();
		expect(result.warnings).toEqual([]);
		expect(result.tokens).toEqual(input);
		expect(result.printed).toEqual(input);
		expect(result.tokens.proposer.logo.value).toBeNull();
		expect(result.tokens.proposer.hero.value).toBeNull();
		expect(result.tokens.recipient.logo.value).toBeNull();
		expect(result.tokens.proposer.fonts.display.value).toBe("Poppins");
		expect(result.tokens.proposer.fonts.body.value).toBe("Inter");
		expect(result.tokens.proposer.fonts.mono.value).toBe("JetBrains Mono");
	});
});

/**
 * A wordmark: a bar of `color` on a transparent canvas, the way a logo
 * drawn for one background or the other is stored.
 */
async function wordmark(color: { r: number; g: number; b: number }) {
	const bar = await sharp({
		create: {
			width: 60,
			height: 12,
			channels: 4,
			background: { ...color, alpha: 1 },
		},
	})
		.png()
		.toBuffer();
	return sharp({
		create: {
			width: 80,
			height: 24,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		},
	})
		.composite([{ input: bar, top: 6, left: 10 }])
		.png()
		.toBuffer();
}

describe("loadThemeAssets: how light a logo is", () => {
	const loadLogo = async (bytes: Buffer) =>
		(
			await loadThemeAssets({
				tokens: tokens({ organization: ORG_LOGO_KEY }),
				...SCOPE,
				budget: createExportImageBudget(),
				read: reader({ [`example-avatars/${ORG_LOGO_KEY}`]: bytes }),
			})
		).tokens.proposer.logo.value;

	it("reads a black wordmark as dark and a white one as light, over their opaque pixels only", async () => {
		const black = await loadLogo(await wordmark({ r: 0, g: 0, b: 0 }));
		expect(black).toMatchObject({ mimeType: "image/png", opaque: false });
		expect(black?.luminance).toBeCloseTo(0, 5);
		expect(black?.luminance).toBeLessThan(COVER_LOGO_DARK_LUMINANCE);

		const white = await loadLogo(
			await wordmark({ r: 255, g: 255, b: 255 }),
		);
		expect(white).toMatchObject({ mimeType: "image/png", opaque: false });
		expect(white?.luminance).toBeCloseTo(1, 5);
	});

	it("reads a mid-tone brand wordmark by its relative luminance", async () => {
		// #d6452b measures about 0.19: drawn for a light background.
		const red = await loadLogo(await wordmark({ r: 214, g: 69, b: 43 }));
		expect(red?.luminance).toBeGreaterThan(0.17);
		expect(red?.luminance).toBeLessThan(0.21);
	});

	it("gives a fully transparent logo no luminance, so no plate", async () => {
		const clear = await loadLogo(
			await sharp({
				create: {
					width: 20,
					height: 10,
					channels: 4,
					background: { r: 0, g: 0, b: 0, alpha: 0 },
				},
			})
				.png()
				.toBuffer(),
		);
		expect(clear).not.toBeNull();
		expect(clear?.luminance).toBeUndefined();
		expect(clear?.opaque).toBe(false);
	});

	it("marks a logo without a transparent pixel as opaque, however light", async () => {
		const jpeg = await loadLogo(
			await sharp({
				create: {
					width: 30,
					height: 10,
					channels: 3,
					background: { r: 250, g: 250, b: 250 },
				},
			})
				.jpeg()
				.toBuffer(),
		);
		expect(jpeg).toMatchObject({ mimeType: "image/jpeg", opaque: true });
		expect(jpeg?.luminance).toBeGreaterThan(0.9);

		// The same holds for a PNG whose alpha channel is solid throughout.
		const solid = await measureLogo({
			mimeType: "image/png",
			bytes: await sharp({
				create: {
					width: 8,
					height: 8,
					channels: 4,
					background: { r: 255, g: 255, b: 255, alpha: 1 },
				},
			})
				.png()
				.toBuffer(),
			width: 8,
			height: 8,
		});
		expect(solid.opaque).toBe(true);
	});

	it("weights a half-transparent pixel by its alpha", async () => {
		// One solid white pixel and one black pixel at half opacity.
		const bytes = await sharp(
			Buffer.from([255, 255, 255, 255, 0, 0, 0, 128]),
			{ raw: { width: 2, height: 1, channels: 4 } },
		)
			.png()
			.toBuffer();
		const { luminance, opaque } = await measureLogo({
			mimeType: "image/png",
			bytes,
			width: 2,
			height: 1,
		});

		expect(opaque).toBe(false);
		expect(luminance).toBeCloseTo(255 / (255 + 128), 5);
	});

	it("measures the hero by its bright end, never as a logo", async () => {
		const result = await loadThemeAssets({
			tokens: tokens({ hero: HERO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({
				[`example-project-contexts/${HERO_KEY}`]: opaquePng,
			}),
		});
		const hero = result.tokens.proposer.hero.value;
		// A flat #c82828 is about 0.13 throughout, so its bright end too.
		expect(hero?.luminance).toBeGreaterThan(0.12);
		expect(hero?.luminance).toBeLessThan(0.15);
		expect(hero).not.toHaveProperty("opaque");
	});
});

describe("measureHero", () => {
	/** A black picture with a white band over `share` of its rows. */
	const banded = async (share: number) => {
		const height = 100;
		const band = Math.round(height * share);
		const black = sharp({
			create: {
				width: 200,
				height,
				channels: 3,
				background: { r: 0, g: 0, b: 0 },
			},
		});
		const bytes =
			band === 0
				? await black.png().toBuffer()
				: await black
						.composite([
							{
								input: await sharp({
									create: {
										width: 200,
										height: band,
										channels: 3,
										background: { r: 255, g: 255, b: 255 },
									},
								})
									.png()
									.toBuffer(),
								top: 0,
								left: 0,
							},
						])
						.png()
						.toBuffer();
		return measureHero({
			mimeType: "image/png",
			bytes,
			width: 200,
			height,
		});
	};

	it("reads a dark picture with a few bright specks as dark", async () => {
		const { luminance } = await banded(0.05);
		expect(luminance).toBeLessThan(0.01);
	});

	it("reads a picture whose brightest tenth is white as white", async () => {
		const { luminance } = await banded(0.2);
		expect(luminance).toBe(1);
	});

	it("gives a fully transparent hero no luminance", async () => {
		const clear = await sharp({
			create: {
				width: 20,
				height: 10,
				channels: 4,
				background: { r: 255, g: 255, b: 255, alpha: 0 },
			},
		})
			.png()
			.toBuffer();
		expect(
			await measureHero({
				mimeType: "image/png",
				bytes: clear,
				width: 20,
				height: 10,
			}),
		).toEqual({});
	});
});

describe("loadThemeAssets: the hero", () => {
	it("reads the organization's own hero from the project contexts bucket", async () => {
		const read = reader({
			[`example-project-contexts/${HERO_KEY}`]: opaquePng,
		});

		const result = await loadThemeAssets({
			tokens: tokens({ hero: HERO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read,
		});

		expect(read).toHaveBeenCalledExactlyOnceWith({
			bucket: "example-project-contexts",
			key: HERO_KEY,
		});
		expect(result.tokens.proposer.hero.source).toBe("BRAND_KIT");
		expect(result.tokens.proposer.hero.value).toMatchObject({
			mimeType: "image/jpeg",
			width: 60,
			height: 20,
		});
		expect(result.warnings).toEqual([]);
	});

	it("keeps the hero at the export's image edge while a logo stays at 1200 px", async () => {
		const result = await loadThemeAssets({
			tokens: tokens({ organization: ORG_LOGO_KEY, hero: HERO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({
				[`example-avatars/${ORG_LOGO_KEY}`]: wider,
				[`example-project-contexts/${HERO_KEY}`]: wider,
			}),
		});

		expect(result.tokens.proposer.logo.value).toMatchObject({
			width: 1200,
			height: 60,
		});
		expect(result.tokens.proposer.hero.value).toMatchObject({
			width: 2400,
			height: 120,
		});
	});

	it("keeps a small copy of the hero for the section openers", async () => {
		const result = await loadThemeAssets({
			tokens: tokens({ hero: HERO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({ [`example-project-contexts/${HERO_KEY}`]: wider }),
		});

		const hero = result.tokens.proposer.hero.value;
		expect(hero?.openerCopy).toMatchObject({
			mimeType: "image/jpeg",
			width: 900,
			height: 45,
		});
		expect(hero?.openerCopy).not.toHaveProperty("openerCopy");
	});

	it("steps a hero down until print can inline it as a data URL", async () => {
		// Grain is what JPEG keeps worst: at 2400 px this is over the cap.
		const grainy = await sharp({
			create: {
				width: 2400,
				height: 1200,
				channels: 3,
				background: { r: 0, g: 0, b: 0 },
				noise: { type: "gaussian", mean: 128, sigma: 80 },
			},
		})
			.jpeg({ quality: 95 })
			.toBuffer();

		const result = await loadThemeAssets({
			tokens: tokens({ hero: HERO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({ [`example-project-contexts/${HERO_KEY}`]: grainy }),
		});

		const hero = result.tokens.proposer.hero.value;
		expect(hero).toMatchObject({ width: 1800, height: 900 });
		expect(hero?.bytes.byteLength).toBeLessThanOrEqual(1_500_000);
		expect(hero?.openerCopy).toMatchObject({ width: 900, height: 450 });
		expect(result.warnings).toEqual([]);
	});

	it("drops a hero that stays over the byte cap at every edge, in one warning", async () => {
		// Each edge smaller than the last, and every one over the cap.
		vi.mocked(normalizeExportImage).mockImplementation(
			async (_bytes, options) => ({
				ok: true,
				image: {
					mimeType: "image/jpeg",
					bytes: Buffer.alloc(1_500_001),
					width: options?.maxEdge ?? 0,
					height: (options?.maxEdge ?? 0) / 2,
				},
			}),
		);

		const result = await loadThemeAssets({
			tokens: tokens({ hero: HERO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({ [`example-project-contexts/${HERO_KEY}`]: wider }),
		});

		expect(
			vi
				.mocked(normalizeExportImage)
				.mock.calls.map(([, options]) => options?.maxEdge),
		).toEqual([2400, 1800, 1200, 900]);
		expect(result.tokens.proposer.hero.value).toBeNull();
		expect(result.printed.proposer.hero.value).toBeNull();
		expect(result.warnings).toEqual([
			{ code: "LOGO_UNAVAILABLE", count: 1 },
		]);
	});

	it("skips an edge a hero already fits within, without making it again", async () => {
		// Within the smallest edge already, so no smaller one is tried.
		const small = {
			ok: true as const,
			image: {
				mimeType: "image/jpeg" as const,
				bytes: Buffer.alloc(1_500_001),
				width: 800,
				height: 400,
			},
		};
		vi.mocked(normalizeExportImage).mockResolvedValueOnce(small);

		const result = await loadThemeAssets({
			tokens: tokens({ hero: HERO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({ [`example-project-contexts/${HERO_KEY}`]: wider }),
		});

		expect(normalizeExportImage).toHaveBeenCalledTimes(1);
		expect(result.tokens.proposer.hero.value).toBeNull();
		expect(result.warnings).toEqual([
			{ code: "LOGO_UNAVAILABLE", count: 1 },
		]);
	});

	it("steps a hero under 1800 px straight to 1200 px when its own size is over the cap", async () => {
		const source = await sharp({
			create: {
				width: 1500,
				height: 750,
				channels: 3,
				background: { r: 40, g: 80, b: 120 },
			},
		})
			.png()
			.toBuffer();
		const normalize = vi.mocked(normalizeExportImage);
		const real =
			normalize.getMockImplementation() as typeof normalizeExportImage;
		// Over the cap at its own 1500 px, as a high-entropy photo would be.
		normalize.mockImplementation(async (bytes, options) =>
			(options?.maxEdge ?? 0) >= 1500
				? {
						ok: true,
						image: {
							mimeType: "image/jpeg",
							bytes: Buffer.alloc(1_500_001),
							width: 1500,
							height: 750,
						},
					}
				: real(bytes, options),
		);

		const result = await loadThemeAssets({
			tokens: tokens({ hero: HERO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({ [`example-project-contexts/${HERO_KEY}`]: source }),
		});

		expect(
			normalize.mock.calls.map(([, options]) => options?.maxEdge),
		).toEqual([2400, 1200, 900]);
		const hero = result.tokens.proposer.hero.value;
		expect(hero).toMatchObject({ width: 1200, height: 600 });
		expect(hero?.openerCopy).toMatchObject({ width: 900, height: 450 });
		expect(result.warnings).toEqual([]);
	});

	it("keeps the hero without its openers' copy when the copy cannot be made, silently", async () => {
		const normalize = vi.mocked(normalizeExportImage);
		const real = normalize.getMockImplementation();
		normalize
			.mockImplementationOnce(real as typeof normalizeExportImage)
			.mockResolvedValueOnce({ ok: false, code: "unsupported" });

		const result = await loadThemeAssets({
			tokens: tokens({ hero: HERO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({ [`example-project-contexts/${HERO_KEY}`]: wider }),
		});

		expect(
			normalize.mock.calls.map(([, options]) => options?.maxEdge),
		).toEqual([2400, 900]);
		const hero = result.tokens.proposer.hero.value;
		expect(hero).toMatchObject({ width: 2400, height: 120 });
		expect(hero).not.toHaveProperty("openerCopy");
		expect(result.warnings).toEqual([]);
	});

	it("prints a hero and a logo that cannot be measured unmeasured, and logs why", async () => {
		// Bytes the measuring decode refuses, as a re-encode gone wrong.
		const unreadable = {
			ok: true as const,
			image: {
				mimeType: "image/png" as const,
				bytes: Buffer.from("not an image"),
				width: 10,
				height: 10,
			},
		};
		vi.mocked(normalizeExportImage).mockResolvedValue(unreadable);

		const result = await loadThemeAssets({
			tokens: tokens({ organization: ORG_LOGO_KEY, hero: HERO_KEY }),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({
				[`example-avatars/${ORG_LOGO_KEY}`]: png,
				[`example-project-contexts/${HERO_KEY}`]: wider,
			}),
		});

		const logo = result.tokens.proposer.logo.value;
		const hero = result.tokens.proposer.hero.value;
		expect(logo).toMatchObject({ width: 10, height: 10 });
		expect(logo).not.toHaveProperty("luminance");
		expect(logo).not.toHaveProperty("opaque");
		expect(hero).toMatchObject({ width: 10, height: 10 });
		expect(hero).not.toHaveProperty("luminance");
		expect(result.warnings).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(2);
		for (const kind of ["organization-logo", "organization-hero"]) {
			expect(warn).toHaveBeenCalledWith(
				"Proposal export asset measure failed",
				{ kind, error: "Error" },
			);
		}
		// Only the asset's kind and the error's name, never its bytes.
		expect(JSON.stringify(warn.mock.calls)).not.toContain("not an image");
	});

	it("charges the hero against the shared image budget", async () => {
		const budget = createExportImageBudget(1_000_000);

		await loadThemeAssets({
			tokens: tokens({ hero: HERO_KEY }),
			...SCOPE,
			budget,
			read: reader({ [`example-project-contexts/${HERO_KEY}`]: wider }),
		});

		expect(budget.remainingBytes).toBe(1_000_000 - wider.byteLength);
	});

	it("drops another organization's hero before storage is read", async () => {
		const foreign = "organization-brand/org-example-2/hero/hero-1.jpg";
		const read = reader({ [`example-project-contexts/${foreign}`]: wider });

		const result = await loadThemeAssets({
			tokens: tokens({ hero: foreign }),
			...SCOPE,
			budget: createExportImageBudget(),
			read,
		});

		expect(read).not.toHaveBeenCalled();
		expect(result.tokens.proposer.hero).toEqual({
			value: null,
			source: "BRAND_KIT",
		});
		expect(result.warnings).toEqual([
			{ code: "LOGO_UNAVAILABLE", count: 1 },
		]);
	});
});

describe("loadThemeAssets: what printed", () => {
	it("keeps the reference of every asset that printed and nulls the ones left out, sources kept", async () => {
		const input = tokens({
			organization: ORG_LOGO_KEY,
			recipient: RECIPIENT_LOGO_KEY,
			hero: HERO_KEY,
		});

		const result = await loadThemeAssets({
			tokens: input,
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({
				[`example-avatars/${ORG_LOGO_KEY}`]: png,
				[`example-project-contexts/${HERO_KEY}`]: new Error(
					"NoSuchKey",
				),
			}),
		});

		expect(result.printed).toEqual({
			proposer: {
				...input.proposer,
				hero: { value: null, source: "BRAND_KIT" },
			},
			recipient: {
				...input.recipient,
				logo: { value: null, source: "MANUAL" },
			},
		});
		expect(result.printed.proposer.logo).toEqual(input.proposer.logo);
	});
});

describe("loadThemeAssets: logos left off the cover", () => {
	it("never reads another organization's logo or another project's recipient logo", async () => {
		const read = reader({
			"example-avatars/org-example-2.png": png,
			"example-project-contexts/project-brand/project-example-2/recipient-brand/current/abc123.png":
				png,
		});

		const result = await loadThemeAssets({
			tokens: tokens({
				organization: "org-example-2.png",
				recipient:
					"project-brand/project-example-2/recipient-brand/current/abc123.png",
			}),
			...SCOPE,
			budget: createExportImageBudget(),
			read,
		});

		expect(read).not.toHaveBeenCalled();
		expect(result.tokens.proposer.logo).toEqual({
			value: null,
			source: "BRAND_KIT",
		});
		expect(result.tokens.recipient.logo).toEqual({
			value: null,
			source: "MANUAL",
		});
		expect(result.warnings).toEqual([
			{ code: "LOGO_UNAVAILABLE", count: 2 },
		]);
	});

	it("drops a logo that cannot be read and one the normalizer refuses, in one warning", async () => {
		const svg = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
		);
		const read = reader({
			[`example-avatars/${ORG_LOGO_KEY}`]: new Error("Access Denied"),
			[`example-project-contexts/${RECIPIENT_LOGO_KEY}`]: svg,
		});

		const result = await loadThemeAssets({
			tokens: tokens({
				organization: ORG_LOGO_KEY,
				recipient: RECIPIENT_LOGO_KEY,
			}),
			...SCOPE,
			budget: createExportImageBudget(),
			read,
		});

		expect(read).toHaveBeenCalledTimes(2);
		expect(result.tokens.proposer.logo).toEqual({
			value: null,
			source: "BRAND_KIT",
		});
		expect(result.tokens.recipient.logo).toEqual({
			value: null,
			source: "MANUAL",
		});
		expect(result.warnings).toEqual([
			{ code: "LOGO_UNAVAILABLE", count: 2 },
		]);
	});

	it("drops a logo the image budget cannot hold, without charging it", async () => {
		const budget = createExportImageBudget(10);

		const result = await loadThemeAssets({
			tokens: tokens({ organization: ORG_LOGO_KEY }),
			...SCOPE,
			budget,
			read: reader({ [`example-avatars/${ORG_LOGO_KEY}`]: png }),
		});

		expect(result.tokens.proposer.logo).toEqual({
			value: null,
			source: "BRAND_KIT",
		});
		expect(result.warnings).toEqual([
			{ code: "LOGO_UNAVAILABLE", count: 1 },
		]);
		expect(budget.remainingBytes).toBe(10);
	});

	it("counts only the logos that failed when one of two loads", async () => {
		const result = await loadThemeAssets({
			tokens: tokens({
				organization: ORG_LOGO_KEY,
				recipient: RECIPIENT_LOGO_KEY,
			}),
			...SCOPE,
			budget: createExportImageBudget(),
			read: reader({ [`example-avatars/${ORG_LOGO_KEY}`]: png }),
		});

		expect(result.tokens.proposer.logo.value).not.toBeNull();
		expect(result.tokens.recipient.logo.value).toBeNull();
		expect(result.warnings).toEqual([
			{ code: "LOGO_UNAVAILABLE", count: 1 },
		]);
	});
});

describe("themeAssetLocation", () => {
	it("places the organization's own logo in the avatars bucket", () => {
		expect(
			themeAssetLocation(
				{ kind: "organization-logo", key: ORG_LOGO_KEY },
				SCOPE,
			),
		).toEqual({ bucket: "example-avatars", key: ORG_LOGO_KEY });
	});

	it("places the organization's own promoted hero in the project contexts bucket", () => {
		expect(
			themeAssetLocation(
				{ kind: "organization-hero", key: HERO_KEY },
				SCOPE,
			),
		).toEqual({ bucket: "example-project-contexts", key: HERO_KEY });
	});

	it.each([
		[
			"another organization's",
			"organization-brand/org-example-2/hero/hero-1.jpg",
		],
		[
			"a pending upload",
			`organization-brand/${ORGANIZATION}/pending/hero-1`,
		],
		["a font", `organization-brand/${ORGANIZATION}/fonts/font-1.woff2`],
		[
			"a nested path",
			`organization-brand/${ORGANIZATION}/hero/a/hero-1.jpg`,
		],
		[
			"a path escape",
			`organization-brand/${ORGANIZATION}/hero/../hero-1.jpg`,
		],
		[
			"not a PNG or JPEG",
			`organization-brand/${ORGANIZATION}/hero/hero-1.svg`,
		],
		["the organization logo", ORG_LOGO_KEY],
	])("refuses a hero key that is %s", (_case, key) => {
		expect(
			themeAssetLocation({ kind: "organization-hero", key }, SCOPE),
		).toBeNull();
	});

	it("places this project's promoted recipient logo in the project contexts bucket", () => {
		expect(
			themeAssetLocation(
				{ kind: "recipient-logo", key: RECIPIENT_LOGO_KEY },
				SCOPE,
			),
		).toEqual({
			bucket: "example-project-contexts",
			key: RECIPIENT_LOGO_KEY,
		});
	});

	it.each([
		["another organization's logo", "org-example-2.png"],
		["a nested path", `avatars/${ORGANIZATION}.png`],
		["a leading slash", `/${ORGANIZATION}.png`],
		["a URL", `https://example.com/${ORGANIZATION}.png`],
		["another extension", `${ORGANIZATION}.svg`],
	])("refuses an organization logo key that is %s", (_case, key) => {
		expect(
			themeAssetLocation({ kind: "organization-logo", key }, SCOPE),
		).toBeNull();
	});

	it.each([
		[
			"another project's",
			"project-brand/project-example-2/recipient-brand/current/abc123.png",
		],
		[
			"a pending upload",
			`project-brand/${PROJECT}/recipient-brand/pending/abc123.png`,
		],
		[
			"a path escape",
			`project-brand/${PROJECT}/recipient-brand/current/../../other.png`,
		],
		[
			"not a PNG",
			`project-brand/${PROJECT}/recipient-brand/current/abc123.svg`,
		],
	])("refuses a recipient logo key that is %s", (_case, key) => {
		expect(
			themeAssetLocation({ kind: "recipient-logo", key }, SCOPE),
		).toBeNull();
	});
});
