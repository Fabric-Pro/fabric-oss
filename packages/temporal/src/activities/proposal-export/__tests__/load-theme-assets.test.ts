/**
 * The brand logos a Proposal export prints (Fizzy #2946): each key is checked
 * against the one place its upload writes before a byte is read (the
 * organization logo is `{organizationId}.png` in the avatars bucket, a
 * recipient logo sits under this project's promoted recipient-brand prefix),
 * read, charged against the export's image budget and re-encoded. Any logo
 * that fails is left off the cover, keeping its source, and all of them count
 * toward one `LOGO_UNAVAILABLE` warning.
 *
 * Mocked: `@repo/config` (distinct bucket names) and `@repo/storage` (its
 * default reader is never used: every test injects `read`). `@repo/database`
 * is mocked down to the two real key predicates, so the rules under test are
 * the shipped ones. Images are real PNG and JPEG bytes from `sharp`, and the
 * real normalizer decodes them.
 */

import { buildProposalThemeTokens } from "@repo/utils/proposal-artifact/theme-tokens";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

import { createExportImageBudget } from "../../../lib/proposal-export/extract-document-images";
import {
	loadThemeAssets,
	type ThemeAssetLocation,
	themeAssetLocation,
} from "../load-theme-assets";

const ORGANIZATION = "org-example-1";
const PROJECT = "project-example-1";
const ORG_LOGO_KEY = `${ORGANIZATION}.png`;
const RECIPIENT_LOGO_KEY = `project-brand/${PROJECT}/recipient-brand/current/abc123.png`;
const SCOPE = { organizationId: ORGANIZATION, projectId: PROJECT };

let png: Buffer;
let opaquePng: Buffer;
let wide: Buffer;

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
});

function tokens(logos: {
	organization?: string | null;
	recipient?: string | null;
}) {
	return buildProposalThemeTokens({
		organization: {
			name: "Example Org",
			logoKey: logos.organization ?? null,
		},
		style: null,
		brandKit: null,
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

	it("reads nothing and warns about nothing for the default tokens", async () => {
		const read = reader({});
		const input = tokens({});

		const result = await loadThemeAssets({
			tokens: input,
			...SCOPE,
			budget: createExportImageBudget(),
			read,
		});

		expect(read).not.toHaveBeenCalled();
		expect(result.warnings).toEqual([]);
		expect(result.tokens).toEqual(input);
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
