import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { artifactBrandFontFaceCss } from "../lib/artifact-brand-fonts";
import {
	buildProposalThemeTokens,
	mapThemeAssets,
	themeTokenHash,
} from "../lib/proposal-artifact/theme-tokens";

describe("client artifact theme", () => {
	it("keeps generated preview bytes identical to the committed print font files", () => {
		expect(() =>
			execFileSync(
				process.execPath,
				[
					fileURLToPath(
						new URL(
							"../../../scripts/generate-artifact-brand-fonts.mjs",
							import.meta.url,
						),
					),
					"--check",
				],
				{ stdio: "pipe" },
			),
		).not.toThrow();
	});
	const sources = {
		organization: { name: "Example Studio", logoKey: "example-org.png" },
		style: {
			brandSource: "CLIENT" as const,
			primaryColor: null,
			accentColors: [],
		},
		brandKit: {
			primaryColor: "#dc2626",
			accentColors: ["#991b1b"],
			displayFontFamily: "Agency Font",
			bodyFontFamily: "Agency Font",
			displayFontFileId: "private-font",
			heroKey: "agency-hero",
		},
		recipient: {
			name: "Example Client",
			logoKey: null,
			colors: ["#123456", "#345678"],
			displayFontFamily: "Inter",
			bodyFontFamily: "Poppins",
			coverStyle: "LIGHT" as const,
		},
	};
	it("uses the reviewed client design while keeping both parties separate", async () => {
		const tokens = buildProposalThemeTokens(sources);
		expect(tokens.proposer.name.value).toBe("Example Studio");
		expect(tokens.recipient.name.value).toBe("Example Client");
		expect(tokens.proposer.primary.value).toBe("#123456");
		expect(tokens.proposer.accents.value).toEqual(["#345678"]);
		expect(tokens.proposer.fonts.display.value).toBe("Inter");
		expect(tokens.proposer.fonts.body.value).toBe("Poppins");
		expect(tokens.proposer.fontFiles?.display.value).toBeNull();
		expect(tokens.proposer.hero.value).toBeNull();
		expect(
			(await mapThemeAssets(tokens, async () => null)).appearance,
		).toEqual({ brandSource: "CLIENT", coverStyle: "LIGHT" });
	});
	it("never borrows agency fonts or palette for an incomplete client", () => {
		const tokens = buildProposalThemeTokens({
			...sources,
			recipient: null,
		});
		expect(tokens.proposer.primary.value).toBe("#334155");
		expect(tokens.proposer.fonts.display.value).toBe("Poppins");
		expect(tokens.proposer.hero.value).toBeNull();
	});
	it("includes selected cover in design change detection and honors document overrides", () => {
		const a = buildProposalThemeTokens(sources);
		const b = buildProposalThemeTokens({
			...sources,
			style: { ...sources.style, coverStyle: "MINIMAL" },
		});
		expect(themeTokenHash(a)).not.toBe(themeTokenHash(b));
		expect(b.appearance?.coverStyle).toBe("MINIMAL");
	});
	it("embeds only committed font data without network URLs or input interpolation", () => {
		const css = artifactBrandFontFaceCss({
			displayFontFamily: 'bad";}url(https://example.com)',
			bodyFontFamily: "Poppins",
		});
		expect(css).toContain('font-family: "Poppins"');
		expect(css).toContain("font-weight: 400");
		expect(css).toContain("font-weight: 700");
		expect(css).not.toContain("https:");
		expect(css.includes('bad";}url(https://example.com)')).toBe(false);
		expect(css).toContain("data:font/ttf;base64,");
	});
});
