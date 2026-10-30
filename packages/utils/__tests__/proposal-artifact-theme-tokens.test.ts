import { describe, expect, it, vi } from "vitest";
import { contrastRatio } from "../lib/brand-colors";
import {
	buildProposalThemeTokens,
	diagramColors,
	GRAPHIC_CONTRAST,
	mapThemeAssets,
	NEUTRAL_THEME,
	type ProposalThemeSources,
	type ProposalThemeTokens,
	resolveThemePaint,
	resolveVisualRoleColors,
	type SourcedValue,
	safeFontFamily,
	TEXT_CONTRAST,
	themeCustomProperties,
	themeTokenHash,
	VISUAL_ROLES,
	visualRoleClassDefs,
	withVisualRoleClassDefs,
} from "../lib/proposal-artifact/theme-tokens";

const NO_SOURCES: ProposalThemeSources = {
	organization: null,
	style: null,
	brandKit: null,
	recipient: null,
};

function sources(
	overrides: Partial<ProposalThemeSources>,
): ProposalThemeSources {
	return { ...NO_SOURCES, ...overrides };
}

/** Every `{ value, source }` in the tokens, with its path. */
function sourcedValues(
	tokens: ProposalThemeTokens<unknown>,
): [string, SourcedValue<unknown>][] {
	const found: [string, SourcedValue<unknown>][] = [];
	const walk = (node: unknown, path: string) => {
		if (node && typeof node === "object" && "source" in node) {
			found.push([path, node as SourcedValue<unknown>]);
			return;
		}
		if (node && typeof node === "object") {
			for (const [key, child] of Object.entries(node)) {
				walk(child, path ? `${path}.${key}` : key);
			}
		}
	};
	walk(tokens, "");
	return found;
}

/** Neutral tokens with the given proposer fields replaced. */
function withProposer(
	proposer: Partial<ProposalThemeTokens["proposer"]>,
): ProposalThemeTokens {
	const tokens = buildProposalThemeTokens(NO_SOURCES);
	return { ...tokens, proposer: { ...tokens.proposer, ...proposer } };
}

const HEX = /^#[0-9a-f]{6}$/;

describe("buildProposalThemeTokens", () => {
	it("gives the neutral theme, no logos and DEFAULT everywhere when nothing is set", () => {
		const tokens = buildProposalThemeTokens(NO_SOURCES);

		expect(tokens.proposer.primary.value).toBe(NEUTRAL_THEME.primary);
		expect(tokens.proposer.accents.value).toEqual([
			...NEUTRAL_THEME.accents,
		]);
		expect(tokens.proposer.surface.value).toBe(NEUTRAL_THEME.surface);
		expect(tokens.proposer.ink.value).toBe(NEUTRAL_THEME.ink);
		// Three faces (Fizzy #2946): Poppins, Inter and JetBrains Mono.
		expect(tokens.proposer.fonts.display.value).toBe("Poppins");
		expect(tokens.proposer.fonts.body.value).toBe("Inter");
		expect(tokens.proposer.fonts.mono.value).toBe("JetBrains Mono");
		expect(tokens.proposer.name.value).toBeNull();
		expect(tokens.proposer.logo.value).toBeNull();
		expect(tokens.proposer.hero.value).toBeNull();
		expect(tokens.recipient.name.value).toBeNull();
		expect(tokens.recipient.logo.value).toBeNull();
		expect(tokens.recipient.colors.value).toEqual([]);

		expect(tokens.proposer.fontFiles?.display.value).toBeNull();
		expect(tokens.proposer.fontFiles?.body.value).toBeNull();

		// Twelve proposer values (three fonts, two font files) and three
		// recipient ones.
		const values = sourcedValues(tokens);
		expect(values).toHaveLength(15);
		for (const [path, token] of values) {
			expect({ path, source: token.source }).toEqual({
				path,
				source: "DEFAULT",
			});
		}
	});

	it("paints the neutral theme when nothing is set", () => {
		const paint = resolveThemePaint(buildProposalThemeTokens(NO_SOURCES));

		expect(paint.surface).toBe(NEUTRAL_THEME.surface);
		expect(paint.ink).toBe(NEUTRAL_THEME.ink);
		expect(paint.primary).toBe(NEUTRAL_THEME.primary);
		// Slate reads as text on white, so headings carry it.
		expect(paint.heading).toBe(NEUTRAL_THEME.primary);
		expect(paint.accent).toBe(NEUTRAL_THEME.accents[0]);
		expect(paint.recipient).toEqual([]);
		expect(paint.fonts).toEqual({
			display: "Poppins",
			body: "Inter",
			mono: "JetBrains Mono",
		});
		expect(paint.fonts).toEqual(NEUTRAL_THEME.fonts);
	});

	it("does not let an empty neutral accent list alias the shared default", () => {
		const first = buildProposalThemeTokens(NO_SOURCES);
		first.proposer.accents.value.push("#000000");

		expect(
			buildProposalThemeTokens(NO_SOURCES).proposer.accents.value,
		).toEqual([...NEUTRAL_THEME.accents]);
	});

	it("takes the Style's primary and accents as a person's choice", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				style: { primaryColor: "#1D4ED8", accentColors: ["#0F766E"] },
				brandKit: { accentColors: ["#b91c1c"] },
			}),
		);

		expect(tokens.proposer.primary).toEqual({
			value: "#1d4ed8",
			source: "MANUAL",
		});
		expect(tokens.proposer.accents).toEqual({
			value: ["#0f766e"],
			source: "MANUAL",
		});
	});

	it("falls back to the Brand kit accents when the Style has none", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				style: { primaryColor: "#1d4ed8", accentColors: [] },
				brandKit: { accentColors: ["#b91c1c", "#0f766e"] },
			}),
		);

		expect(tokens.proposer.accents).toEqual({
			value: ["#b91c1c", "#0f766e"],
			source: "BRAND_KIT",
		});
	});

	it("resolves the primary by Style, then Brand kit, then the vendor's website, then neutral", () => {
		const site = { primaryColor: "#0A2540", accentColors: ["#635BFF"] };
		const kit = { accentColors: [], primaryColor: "#7C3AED" };

		expect(
			buildProposalThemeTokens(
				sources({
					style: { primaryColor: "#1d4ed8", accentColors: [] },
					brandKit: kit,
					vendorSite: site,
				}),
			).proposer.primary,
		).toEqual({ value: "#1d4ed8", source: "MANUAL" });
		expect(
			buildProposalThemeTokens(
				sources({
					style: { primaryColor: null, accentColors: [] },
					brandKit: kit,
					vendorSite: site,
				}),
			).proposer.primary,
		).toEqual({ value: "#7c3aed", source: "BRAND_KIT" });
		expect(
			buildProposalThemeTokens(
				sources({ brandKit: { accentColors: [] }, vendorSite: site }),
			).proposer.primary,
		).toEqual({ value: "#0a2540", source: "VENDOR_SITE" });
		expect(
			buildProposalThemeTokens(sources({ vendorSite: null })).proposer
				.primary,
		).toEqual({ value: NEUTRAL_THEME.primary, source: "DEFAULT" });
	});

	it("takes the vendor's accents only when neither the Style nor the Brand kit has any", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				style: { primaryColor: null, accentColors: [] },
				brandKit: { accentColors: [] },
				vendorSite: { primaryColor: null, accentColors: ["#635BFF"] },
			}),
		);

		expect(tokens.proposer.accents).toEqual({
			value: ["#635bff"],
			source: "VENDOR_SITE",
		});
	});

	it("never lets a recipient colour fill a proposer value", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				recipient: {
					name: "Example Client",
					logoKey: null,
					colors: ["#b91c1c"],
				},
			}),
		);

		expect(tokens.proposer.primary.source).toBe("DEFAULT");
		expect(tokens.proposer.accents.source).toBe("DEFAULT");
		expect(tokens.recipient.colors.value).toEqual(["#b91c1c"]);
	});

	it("drops a vendor colour that is not #rrggbb, so the next source applies", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				vendorSite: {
					primaryColor: "red;} body{display:none",
					accentColors: ["url(x)", "#0f766e"],
				},
			}),
		);

		expect(tokens.proposer.primary.source).toBe("DEFAULT");
		expect(tokens.proposer.accents.value).toEqual(["#0f766e"]);
	});

	it("takes the Brand kit fonts, files and hero as the organization's own settings", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				brandKit: {
					accentColors: [],
					displayFontFamily: "Example Display",
					bodyFontFamily: "Example Text",
					displayFontFileId: "font-display-id",
					bodyFontFileId: null,
					heroKey: "organization-brand/org-1/hero/hero-id.png",
				},
			}),
		);

		expect(tokens.proposer.fonts.display).toEqual({
			value: "Example Display",
			source: "BRAND_KIT",
		});
		expect(tokens.proposer.fonts.body).toEqual({
			value: "Example Text",
			source: "BRAND_KIT",
		});
		expect(tokens.proposer.fonts.mono.source).toBe("DEFAULT");
		expect(tokens.proposer.fontFiles?.display).toEqual({
			value: "font-display-id",
			source: "BRAND_KIT",
		});
		expect(tokens.proposer.fontFiles?.body.value).toBeNull();
		expect(tokens.proposer.hero).toEqual({
			value: {
				kind: "organization-hero",
				key: "organization-brand/org-1/hero/hero-id.png",
			},
			source: "BRAND_KIT",
		});
	});

	it("ignores a font file without its family and a family the theme may not write", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				brandKit: {
					accentColors: [],
					displayFontFamily: 'Evil"; } body {',
					displayFontFileId: "font-display-id",
				},
			}),
		);

		expect(tokens.proposer.fonts.display).toEqual({
			value: NEUTRAL_THEME.fonts.display,
			source: "DEFAULT",
		});
		expect(tokens.proposer.fontFiles?.display.value).toBeNull();
	});

	it("treats a Style whose accents are all invalid as having none", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				style: { primaryColor: null, accentColors: ["red", "#fff"] },
				brandKit: { accentColors: ["#b91c1c"] },
			}),
		);

		expect(tokens.proposer.accents).toEqual({
			value: ["#b91c1c"],
			source: "BRAND_KIT",
		});
		expect(tokens.proposer.primary).toEqual({
			value: NEUTRAL_THEME.primary,
			source: "DEFAULT",
		});
	});

	it("drops invalid colours rather than repairing them", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				style: {
					primaryColor: "red;background:url(x)",
					accentColors: [
						"#fff",
						"rgb(1, 2, 3)",
						"#12345g",
						"#0f766e;}",
						" #B91C1C ",
						"",
					],
				},
				recipient: {
					name: "Example Client",
					logoKey: null,
					colors: ["blue", "#0B3D91"],
				},
			}),
		);

		expect(tokens.proposer.primary.source).toBe("DEFAULT");
		expect(tokens.proposer.accents.value).toEqual(["#b91c1c"]);
		expect(tokens.recipient.colors.value).toEqual(["#0b3d91"]);
	});

	it("keeps at most three colours, after removing duplicates", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				style: {
					primaryColor: null,
					accentColors: [
						"#111111",
						"#111111",
						"#222222",
						"#333333",
						"#444444",
					],
				},
				recipient: {
					name: null,
					logoKey: null,
					colors: [
						"#aa0000",
						"#AA0000",
						"#00aa00",
						"#0000aa",
						"#aaaa00",
					],
				},
			}),
		);

		expect(tokens.proposer.accents.value).toEqual([
			"#111111",
			"#222222",
			"#333333",
		]);
		expect(tokens.recipient.colors.value).toEqual([
			"#aa0000",
			"#00aa00",
			"#0000aa",
		]);
	});

	it("takes the organization and recipient brands, each into its own group", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				organization: {
					name: "  Example Org  ",
					logoKey: "org/logo.png",
				},
				recipient: {
					name: "Example Client",
					logoKey: "recipient/logo.png",
					colors: ["#0b3d91"],
				},
			}),
		);

		expect(tokens.proposer.name).toEqual({
			value: "Example Org",
			source: "BRAND_KIT",
		});
		expect(tokens.proposer.logo).toEqual({
			value: { kind: "organization-logo", key: "org/logo.png" },
			source: "BRAND_KIT",
		});
		expect(tokens.recipient.name).toEqual({
			value: "Example Client",
			source: "MANUAL",
		});
		expect(tokens.recipient.logo).toEqual({
			value: { kind: "recipient-logo", key: "recipient/logo.png" },
			source: "MANUAL",
		});
		expect(tokens.recipient.colors).toEqual({
			value: ["#0b3d91"],
			source: "MANUAL",
		});
	});

	it("treats blank names and logo keys as absent", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				organization: { name: "   ", logoKey: "" },
				recipient: { name: "", logoKey: null, colors: [] },
			}),
		);

		expect(tokens.proposer.name).toEqual({
			value: null,
			source: "DEFAULT",
		});
		expect(tokens.proposer.logo).toEqual({
			value: null,
			source: "DEFAULT",
		});
		expect(tokens.recipient.name).toEqual({
			value: null,
			source: "DEFAULT",
		});
		expect(tokens.recipient.colors).toEqual({
			value: [],
			source: "DEFAULT",
		});
	});
});

describe("resolveThemePaint", () => {
	it("keeps a light recipient colour in the tokens but does not paint it", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				recipient: {
					name: "Example Client",
					logoKey: null,
					colors: ["#f5f5f0", "#0b3d91"],
				},
			}),
		);
		const paint = resolveThemePaint(tokens);

		expect(tokens.recipient.colors).toEqual({
			value: ["#f5f5f0", "#0b3d91"],
			source: "MANUAL",
		});
		expect(contrastRatio("#f5f5f0", paint.surface)).toBeLessThan(
			GRAPHIC_CONTRAST,
		);
		expect(paint.recipient).toEqual(["#0b3d91"]);
	});

	it("paints a low-contrast primary with the fallbacks and keeps its source", () => {
		const tokens = buildProposalThemeTokens(
			sources({ style: { primaryColor: "#ffe36e", accentColors: [] } }),
		);
		const paint = resolveThemePaint(tokens);

		expect(tokens.proposer.primary).toEqual({
			value: "#ffe36e",
			source: "MANUAL",
		});
		// Too light for a heading and for a rule on white paper.
		expect(paint.heading).toBe(paint.ink);
		expect(paint.primary).toBe(NEUTRAL_THEME.primary);
		expect(["#000000", "#ffffff"]).toContain(paint.onPrimary);
	});

	it("keeps the ink readable on the opaque review washes", () => {
		const paint = resolveThemePaint(buildProposalThemeTokens(sources({})));
		for (const wash of [paint.reviewInsert, paint.reviewDelete]) {
			expect(wash).toMatch(/^#[0-9a-f]{6}$/);
			expect(contrastRatio(paint.ink, wash)).toBeGreaterThanOrEqual(
				TEXT_CONTRAST,
			);
		}
		const properties = themeCustomProperties(paint);
		expect(properties["--pa-review-insert"]).toBe(paint.reviewInsert);
		expect(properties["--pa-review-delete"]).toBe(paint.reviewDelete);
	});

	it("keeps text on a mid grey primary or accent fill at 4.5:1 or better", () => {
		// Black and the near-white ink both fall just short on this grey.
		const paint = resolveThemePaint(
			buildProposalThemeTokens(
				sources({
					style: {
						primaryColor: "#737373",
						accentColors: ["#757575"],
					},
				}),
			),
		);

		expect(paint.primary).toBe("#737373");
		expect(
			contrastRatio(paint.primary, paint.onPrimary),
		).toBeGreaterThanOrEqual(TEXT_CONTRAST);
		expect(
			contrastRatio(paint.accent, paint.onAccent),
		).toBeGreaterThanOrEqual(TEXT_CONTRAST);
	});

	it("uses a primary for rules but not for headings when it only holds up as a graphic", () => {
		// About 3.3:1 on white: a rule, not text.
		const tokens = buildProposalThemeTokens(
			sources({ style: { primaryColor: "#2f9e44", accentColors: [] } }),
		);
		const paint = resolveThemePaint(tokens);

		expect(contrastRatio("#2f9e44", paint.surface)).toBeGreaterThanOrEqual(
			GRAPHIC_CONTRAST,
		);
		expect(contrastRatio("#2f9e44", paint.surface)).toBeLessThan(
			TEXT_CONTRAST,
		);
		expect(paint.primary).toBe("#2f9e44");
		expect(paint.heading).toBe(paint.ink);
	});

	it("skips an accent that fails on the paper for the next one that holds", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				style: {
					primaryColor: null,
					accentColors: ["#fafafa", "#b91c1c"],
				},
			}),
		);

		expect(resolveThemePaint(tokens).accent).toBe("#b91c1c");
	});

	it("falls back to the primary when no accent holds on the paper", () => {
		const tokens = buildProposalThemeTokens(
			sources({
				style: { primaryColor: "#1d4ed8", accentColors: ["#fafafa"] },
			}),
		);

		expect(resolveThemePaint(tokens).accent).toBe("#1d4ed8");
	});

	it("keeps ink on paper readable for the neutral theme", () => {
		const paint = resolveThemePaint(buildProposalThemeTokens(NO_SOURCES));

		expect(contrastRatio(paint.ink, paint.surface)).toBeGreaterThanOrEqual(
			TEXT_CONTRAST,
		);
		expect(
			contrastRatio(paint.muted, paint.surface),
		).toBeGreaterThanOrEqual(TEXT_CONTRAST);
		expect(contrastRatio(paint.ink, paint.tint)).toBeGreaterThanOrEqual(
			TEXT_CONTRAST,
		);
		expect(
			contrastRatio(paint.heading, paint.surface),
		).toBeGreaterThanOrEqual(TEXT_CONTRAST);
	});

	it("replaces an unreadable surface and ink pair with the neutral pair", () => {
		const paint = resolveThemePaint(
			withProposer({
				surface: { value: "#777777", source: "MANUAL" },
				ink: { value: "#888888", source: "MANUAL" },
			}),
		);

		expect(paint.surface).toBe(NEUTRAL_THEME.surface);
		expect(paint.ink).toBe(NEUTRAL_THEME.ink);
		expect(contrastRatio(paint.ink, paint.surface)).toBeGreaterThanOrEqual(
			TEXT_CONTRAST,
		);
	});

	it("replaces a surface or ink that is not a hex colour", () => {
		const paint = resolveThemePaint(
			withProposer({
				surface: { value: "white", source: "MANUAL" },
				ink: { value: "#000;color:red", source: "MANUAL" },
			}),
		);

		expect(paint.surface).toBe(NEUTRAL_THEME.surface);
		expect(paint.ink).toBe(NEUTRAL_THEME.ink);
	});

	it("keeps a readable non-neutral surface and ink pair and checks against it", () => {
		const paint = resolveThemePaint(
			withProposer({
				surface: { value: "#fdf6e3", source: "MANUAL" },
				ink: { value: "#073642", source: "MANUAL" },
			}),
		);

		expect(paint.surface).toBe("#fdf6e3");
		expect(paint.ink).toBe("#073642");
		expect(
			contrastRatio(paint.muted, paint.surface),
		).toBeGreaterThanOrEqual(TEXT_CONTRAST);
		expect(contrastRatio(paint.ink, paint.tint)).toBeGreaterThanOrEqual(
			TEXT_CONTRAST,
		);
	});

	it("paints every colour as #rrggbb", () => {
		const paint = resolveThemePaint(
			buildProposalThemeTokens(
				sources({
					style: {
						primaryColor: "#1d4ed8",
						accentColors: ["#b91c1c"],
					},
					recipient: {
						name: null,
						logoKey: null,
						colors: ["#0b3d91"],
					},
				}),
			),
		);
		const { fonts, recipient, heroVeil, ...colors } = paint;

		for (const color of [...Object.values(colors), ...recipient]) {
			expect(color).toMatch(HEX);
		}
		expect(fonts.body).toBe("Inter");
		expect(heroVeil).toBeGreaterThanOrEqual(0);
		expect(heroVeil).toBeLessThanOrEqual(1);
	});
});

describe("resolveThemePaint: colours on the ink", () => {
	/** `weight` of `color` over `base`, as the page composites it. */
	const over = (color: string, base: string, weight: number) => {
		const channel = (hex: string, offset: number) =>
			Number.parseInt(hex.slice(offset, offset + 2), 16);
		const blend = (offset: number) =>
			Math.round(
				channel(color, offset) * weight +
					channel(base, offset) * (1 - weight),
			)
				.toString(16)
				.padStart(2, "0");
		return `#${blend(1)}${blend(3)}${blend(5)}`;
	};
	const branded = (primaryColor: string, accentColors: string[] = []) =>
		resolveThemePaint(
			buildProposalThemeTokens(
				sources({ style: { primaryColor, accentColors } }),
			),
		);

	it("sets white text on the neutral ink, and a lightened rule where the neutral primary is too dark", () => {
		const paint = resolveThemePaint(buildProposalThemeTokens(NO_SOURCES));

		expect(paint.onInk).toBe("#ffffff");
		expect(
			contrastRatio(paint.onInkMuted, paint.ink),
		).toBeGreaterThanOrEqual(TEXT_CONTRAST);
		expect(paint.onInkMuted).not.toBe(paint.onInk);
		// The neutral primary and accent are too close to the ink to read.
		expect(paint.onInkAccent).toBe("#ffffff");
		expect(paint.onInkRule).not.toBe(NEUTRAL_THEME.primary);
		expect(
			contrastRatio(paint.onInkRule, paint.ink),
		).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST);
	});

	it("gives a dark navy brand white text and a lightened navy rule", () => {
		const paint = branded("#0b1f3a");

		expect(paint.onInkAccent).toBe("#ffffff");
		expect(paint.onInkRule).not.toBe("#0b1f3a");
		expect(paint.onInkRule).not.toBe("#ffffff");
		expect(
			contrastRatio(paint.onInkRule, paint.ink),
		).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST);
		// Lighter than the navy, still bluer than it is red.
		const [red, , blue] = [1, 3, 5].map((offset) =>
			Number.parseInt(paint.onInkRule.slice(offset, offset + 2), 16),
		);
		expect(blue).toBeGreaterThan(red as number);
	});

	it("keeps a bright brand colour that reads on the ink, for text and rules alike", () => {
		const paint = branded("#f97316");

		expect(paint.onInkAccent).toBe("#f97316");
		expect(paint.onInkRule).toBe("#f97316");
	});

	it("keeps a red primary for rules and takes a light accent for text when the red does not read as text", () => {
		// The primary holds 3:1 on the ink but not 4.5:1; the accent, which
		// the paper itself drops as too light, reads as text on the ink.
		const paint = branded("#d6452b", ["#f08f72"]);

		expect(contrastRatio("#d6452b", paint.ink)).toBeLessThan(TEXT_CONTRAST);
		expect(paint.accent).not.toBe("#f08f72");
		expect(paint.onInkRule).toBe("#d6452b");
		expect(paint.onInkAccent).toBe("#f08f72");
	});

	it("veils a hero just enough that white and grey text read at 4.5:1 over pure white", () => {
		for (const paint of [
			resolveThemePaint(buildProposalThemeTokens(NO_SOURCES)),
			resolveThemePaint(
				withProposer({ ink: { value: "#2b2b2b", source: "MANUAL" } }),
			),
		]) {
			const worst = over(paint.ink, "#ffffff", paint.heroVeil);
			expect(contrastRatio(paint.onInk, worst)).toBeGreaterThanOrEqual(
				TEXT_CONTRAST,
			);
			expect(
				contrastRatio(paint.onInkMuted, worst),
			).toBeGreaterThanOrEqual(TEXT_CONTRAST);
			// No more ink than that.
			const lighter = over(paint.ink, "#ffffff", paint.heroVeil - 0.01);
			expect(
				Math.min(
					contrastRatio(paint.onInk, lighter),
					contrastRatio(paint.onInkMuted, lighter),
				),
			).toBeLessThan(TEXT_CONTRAST);
		}
	});

	it("veils a white hero more densely for a mid-tone brand accent, so the eyebrows still read", () => {
		const neutral = resolveThemePaint(buildProposalThemeTokens(NO_SOURCES));
		const paint = branded("#3b82f6");

		// The blue reads on the plain ink, so it is the accent, not white.
		expect(paint.ink).toBe(neutral.ink);
		expect(paint.onInkAccent).toBe("#3b82f6");
		expect(paint.heroVeil).toBeGreaterThan(neutral.heroVeil);

		const worst = over(paint.ink, "#ffffff", paint.heroVeil);
		expect(contrastRatio(paint.onInkAccent, worst)).toBeGreaterThanOrEqual(
			TEXT_CONTRAST,
		);
		// No more ink than the accent needs.
		const lighter = over(paint.ink, "#ffffff", paint.heroVeil - 0.01);
		expect(contrastRatio(paint.onInkAccent, lighter)).toBeLessThan(
			TEXT_CONTRAST,
		);
	});

	it("veils a measured hero only as much as its bright end needs", () => {
		const tokens = buildProposalThemeTokens(NO_SOURCES);
		const unmeasured = resolveThemePaint(tokens).heroVeil;
		const veil = (heroLuminance: number) =>
			resolveThemePaint(tokens, { heroLuminance }).heroVeil;

		// A dark brand graphic stays visible under a thin veil…
		expect(veil(0.02)).toBeLessThan(0.35);
		// …a white one needs what an unmeasured hero gets…
		expect(veil(1)).toBe(unmeasured);
		// …and the veil never thins as the hero brightens.
		const steps = [0, 0.1, 0.2, 0.4, 0.6, 0.8, 1].map(veil);
		expect(steps).toEqual([...steps].sort((a, b) => a - b));

		// Whatever it lays, white and grey text read at 4.5:1 over a grey of
		// that luminance (#808080 measures about 0.216).
		const paint = resolveThemePaint(tokens, { heroLuminance: 0.216 });
		const under = over(paint.ink, "#808080", paint.heroVeil);
		expect(contrastRatio(paint.onInk, under)).toBeGreaterThanOrEqual(
			TEXT_CONTRAST,
		);
		expect(contrastRatio(paint.onInkMuted, under)).toBeGreaterThanOrEqual(
			TEXT_CONTRAST,
		);
	});

	it("veils an unmeasurable hero as though it were white", () => {
		const tokens = buildProposalThemeTokens(NO_SOURCES);
		const unmeasured = resolveThemePaint(tokens).heroVeil;

		expect(
			resolveThemePaint(tokens, { heroLuminance: undefined }).heroVeil,
		).toBe(unmeasured);
		expect(
			resolveThemePaint(tokens, { heroLuminance: Number.NaN }).heroVeil,
		).toBe(unmeasured);
	});

	it("sets the paper as text on an ink too light for white", () => {
		const paint = resolveThemePaint(
			withProposer({
				surface: { value: "#111111", source: "MANUAL" },
				ink: { value: "#f5f5f5", source: "MANUAL" },
			}),
		);

		expect(paint.onInk).toBe("#111111");
		expect(contrastRatio(paint.onInk, paint.ink)).toBeGreaterThanOrEqual(
			TEXT_CONTRAST,
		);
		expect(
			contrastRatio(paint.onInkAccent, paint.ink),
		).toBeGreaterThanOrEqual(TEXT_CONTRAST);
	});
});

describe("safeFontFamily", () => {
	it("accepts family names and normalises their spacing", () => {
		expect(safeFontFamily("Inter")).toBe("Inter");
		expect(safeFontFamily("Source Sans 3")).toBe("Source Sans 3");
		expect(safeFontFamily("IBM Plex Mono")).toBe("IBM Plex Mono");
		expect(safeFontFamily("  Open   Sans ")).toBe("Open Sans");
		expect(safeFontFamily("Noto-Serif")).toBe("Noto-Serif");
	});

	it("refuses anything that could close a CSS string or rule", () => {
		for (const value of [
			'Inter"; } body { x',
			"Inter'",
			"Inter;",
			"Inter}",
			"Inter\\",
			"Inter, serif",
			"Inter/*",
			"url(x)",
			"-Inter",
			"Inter-",
			"",
			"   ",
			"I",
			"A".repeat(65),
			null,
			undefined,
			42,
		]) {
			expect(safeFontFamily(value)).toBeNull();
		}
	});
});

describe("themeCustomProperties", () => {
	it("writes only hex colours and single quoted family names", () => {
		const properties = themeCustomProperties(
			resolveThemePaint(
				buildProposalThemeTokens(
					sources({
						style: {
							primaryColor: "#ffe36e",
							accentColors: ["#0f766e"],
						},
						recipient: {
							name: "Example Client",
							logoKey: null,
							colors: ["#0b3d91", "#f5f5f0", "#7c3aed"],
						},
					}),
				),
			),
		);

		const entries = Object.entries(properties);
		expect(entries.length).toBeGreaterThanOrEqual(13);
		for (const [name, value] of entries) {
			expect(name).toMatch(/^--pa-[a-z0-9-]+$/);
			expect(value).toMatch(
				/^(#[0-9a-f]{6}|"[A-Za-z0-9 -]+"|[01]\.\d{2})$/,
			);
		}
		expect(properties["--pa-hero-veil"]).toMatch(/^[01]\.\d{2}$/);
		for (const name of [
			"--pa-on-ink",
			"--pa-on-ink-muted",
			"--pa-on-ink-accent",
			"--pa-on-ink-rule",
		] as const) {
			expect(properties[name]).toMatch(HEX);
		}
		// Only the recipient colours that hold up on the paper are written.
		expect(properties["--pa-recipient-1"]).toBe("#0b3d91");
		expect(properties["--pa-recipient-2"]).toBe("#7c3aed");
		expect(properties["--pa-recipient-3"]).toBeUndefined();
		expect(["#000000", "#ffffff"]).toContain(properties["--pa-on-primary"]);
	});

	it("writes the fallback family for a font name that tries to break out", () => {
		const paint = resolveThemePaint(
			withProposer({
				fonts: {
					display: { value: 'Inter"; } body { x', source: "MANUAL" },
					body: { value: "Example Sans", source: "MANUAL" },
					mono: { value: "x</style>", source: "MANUAL" },
				},
			}),
		);
		const properties = themeCustomProperties(paint);

		// Each role falls back to its own neutral face.
		expect(paint.fonts).toEqual({
			display: "Poppins",
			body: "Example Sans",
			mono: "JetBrains Mono",
		});
		expect(properties["--pa-font-display"]).toBe('"Poppins"');
		expect(properties["--pa-font-body"]).toBe('"Example Sans"');
		expect(properties["--pa-font-mono"]).toBe('"JetBrains Mono"');
	});

	it("checks a paint that did not come from the resolver", () => {
		const paint = {
			...resolveThemePaint(buildProposalThemeTokens(sources({}))),
			primary: "red; background: url(https://example.com/x)",
			tint: "#fff",
			onInkAccent: "currentColor",
			heroVeil: Number.NaN,
			recipient: ["#0b3d91", "expression(alert(1))"],
			fonts: { display: 'x"}', body: "Example Sans", mono: "" },
		};
		const properties = themeCustomProperties(paint);

		for (const value of Object.values(properties)) {
			expect(value).toMatch(
				/^(#[0-9a-f]{6}|"[A-Za-z0-9 -]+"|[01]\.\d{2})$/,
			);
		}
		expect(properties["--pa-primary"]).toBe(NEUTRAL_THEME.primary);
		expect(properties["--pa-on-ink-accent"]).toBe(NEUTRAL_THEME.surface);
		// An opacity that is not one paints the ink opaque over the hero.
		expect(properties["--pa-hero-veil"]).toBe("1.00");
		expect(properties["--pa-tint"]).toBe(NEUTRAL_THEME.surface);
		expect(properties["--pa-recipient-1"]).toBe("#0b3d91");
		expect(properties["--pa-recipient-2"]).toBeUndefined();
		expect(properties["--pa-font-display"]).toBe('"Poppins"');
		expect(properties["--pa-font-body"]).toBe('"Example Sans"');
		expect(properties["--pa-font-mono"]).toBe('"JetBrains Mono"');
	});

	it("writes a Brand kit display family for the live page", () => {
		const paint = resolveThemePaint(
			buildProposalThemeTokens(
				sources({
					brandKit: {
						accentColors: [],
						displayFontFamily: "Example Display",
					},
				}),
			),
		);
		const properties = themeCustomProperties(paint);

		expect(properties["--pa-font-display"]).toBe('"Example Display"');
		expect(properties["--pa-font-body"]).toBe('"Inter"');
		expect(properties["--pa-font-mono"]).toBe('"JetBrains Mono"');
	});
});

describe("themeTokenHash", () => {
	const branded = () =>
		buildProposalThemeTokens(
			sources({
				organization: { name: "Example Org", logoKey: "org/logo.png" },
				style: { primaryColor: "#1d4ed8", accentColors: ["#b91c1c"] },
				recipient: {
					name: "Example Client",
					logoKey: null,
					colors: ["#0b3d91"],
				},
			}),
		);

	it("is stable for equal values and carries its version prefix", () => {
		const hash = themeTokenHash(branded());

		expect(themeTokenHash(branded())).toBe(hash);
		expect(hash).toMatch(/^t3:[0-9a-f]{16}$/);
	});

	it("reads a record made before the three print faces as a different design", () => {
		// A `t2` record named Inter for every role; the same brand now hashes
		// under `t3`, so a later comparison cannot mistake it for unchanged.
		const hash = themeTokenHash(buildProposalThemeTokens(NO_SOURCES));

		expect(hash.startsWith("t2:")).toBe(false);
		expect(hash).toBe(themeTokenHash(buildProposalThemeTokens(NO_SOURCES)));
	});

	it("does not depend on key order", () => {
		const tokens = branded();
		const reordered: ProposalThemeTokens = {
			recipient: {
				colors: tokens.recipient.colors,
				logo: tokens.recipient.logo,
				name: tokens.recipient.name,
			},
			proposer: Object.fromEntries(
				Object.entries(tokens.proposer).reverse(),
			) as ProposalThemeTokens["proposer"],
		};

		expect(themeTokenHash(reordered)).toBe(themeTokenHash(tokens));
	});

	it("changes when an uploaded font file or the hero is replaced", () => {
		const withAssets = (fileId: string, heroKey: string) =>
			buildProposalThemeTokens(
				sources({
					brandKit: {
						accentColors: [],
						displayFontFamily: "Example Display",
						displayFontFileId: fileId,
						heroKey,
					},
				}),
			);
		const hero = "organization-brand/org-1/hero/first.png";
		const base = themeTokenHash(withAssets("font-a", hero));

		expect(themeTokenHash(withAssets("font-b", hero))).not.toBe(base);
		expect(
			themeTokenHash(
				withAssets(
					"font-a",
					"organization-brand/org-1/hero/second.png",
				),
			),
		).not.toBe(base);
	});

	it("changes when a colour changes", () => {
		const tokens = branded();
		const changed: ProposalThemeTokens = {
			...tokens,
			proposer: {
				...tokens.proposer,
				primary: { value: "#1d4ed9", source: "MANUAL" },
			},
		};

		expect(themeTokenHash(changed)).not.toBe(themeTokenHash(tokens));
	});

	it("changes when a logo or a recipient colour changes", () => {
		const tokens = branded();

		expect(
			themeTokenHash({
				...tokens,
				proposer: {
					...tokens.proposer,
					logo: {
						value: {
							kind: "organization-logo",
							key: "org/other.png",
						},
						source: "BRAND_KIT",
					},
				},
			}),
		).not.toBe(themeTokenHash(tokens));
		expect(
			themeTokenHash({
				...tokens,
				recipient: {
					...tokens.recipient,
					colors: { value: ["#0b3d92"], source: "MANUAL" },
				},
			}),
		).not.toBe(themeTokenHash(tokens));
	});

	it("is unaffected by a change of source alone", () => {
		const tokens = branded();
		const resourced: ProposalThemeTokens = {
			...tokens,
			proposer: {
				...tokens.proposer,
				primary: { ...tokens.proposer.primary, source: "BRAND_KIT" },
				surface: { ...tokens.proposer.surface, source: "MANUAL" },
			},
		};

		expect(themeTokenHash(resourced)).toBe(themeTokenHash(tokens));
	});
});

describe("mapThemeAssets", () => {
	it("converts every asset reference and leaves the rest untouched", async () => {
		const tokens = buildProposalThemeTokens(
			sources({
				organization: { name: "Example Org", logoKey: "org/logo.png" },
				recipient: {
					name: "Example Client",
					logoKey: "recipient/logo.png",
					colors: [],
				},
			}),
		);
		const before = structuredClone(tokens);
		const convert = vi.fn(async (asset: { key: string }) => ({
			url: `signed:${asset.key}`,
		}));

		const mapped = await mapThemeAssets(tokens, convert);

		expect(convert).toHaveBeenCalledTimes(2);
		expect(mapped.proposer.logo).toEqual({
			value: { url: "signed:org/logo.png" },
			source: "BRAND_KIT",
		});
		expect(mapped.recipient.logo).toEqual({
			value: { url: "signed:recipient/logo.png" },
			source: "MANUAL",
		});
		expect(mapped.proposer.hero).toEqual({
			value: null,
			source: "DEFAULT",
		});
		expect(mapped.proposer.primary).toEqual(tokens.proposer.primary);
		expect(mapped.recipient.name).toEqual(tokens.recipient.name);
		expect(tokens).toEqual(before);
	});

	it("leaves no asset where the conversion yields null, keeping the source", async () => {
		const tokens = buildProposalThemeTokens(
			sources({
				organization: { name: "Example Org", logoKey: "org/logo.png" },
			}),
		);

		const mapped = await mapThemeAssets(tokens, async () => null);

		expect(mapped.proposer.logo).toEqual({
			value: null,
			source: "BRAND_KIT",
		});
		expect(mapped.recipient.logo).toEqual({
			value: null,
			source: "DEFAULT",
		});
	});
});

describe("diagram colours", () => {
	const paint = resolveThemePaint(
		buildProposalThemeTokens(
			sources({
				style: { primaryColor: "#1d4ed8", accentColors: ["#b91c1c"] },
			}),
		),
	);

	it("emits one classDef per role, in hex only", () => {
		const lines = visualRoleClassDefs(paint);

		expect(lines).toHaveLength(4);
		lines.forEach((line, index) => {
			expect(line).toMatch(
				new RegExp(
					`^classDef ${VISUAL_ROLES[index]} fill:#[0-9a-f]{6},stroke:#[0-9a-f]{6},color:#[0-9a-f]{6}$`,
				),
			);
		});
	});

	it("labels every filled role with a readable colour", () => {
		const roles = resolveVisualRoleColors(paint);

		for (const role of VISUAL_ROLES) {
			expect(
				contrastRatio(roles[role].color, roles[role].fill),
			).toBeGreaterThanOrEqual(TEXT_CONTRAST);
		}
	});

	it("appends the role classDefs to a flowchart, after a marker line", () => {
		const source =
			'%% fabric-visual: abcdefgh12345678\nflowchart TD\nf0["Intake"]\nclass f0 surface\n';
		expect(withVisualRoleClassDefs(source, paint)).toBe(
			[source.trimEnd(), ...visualRoleClassDefs(paint)].join("\n"),
		);
		for (const header of ["graph LR", "flowchart", "  Flowchart TB  "]) {
			expect(
				withVisualRoleClassDefs(`${header}\nA --> B`, paint),
			).toContain("classDef surface ");
		}
	});

	it("leaves every other kind of diagram as it is", () => {
		for (const source of [
			"gantt\n  title Plan\n  Build :a1, 2026-01-01, 30d",
			"timeline\n  2026 : Kickoff",
			"stateDiagram-v2\n  [*] --> Draft",
			"sequenceDiagram\n  A->>B: hi",
			"---\ntitle: x\n---\nflowchart TD\nA --> B",
			"flowchartish TD\nA --> B",
			"",
			"%% only a comment",
		]) {
			expect(withVisualRoleClassDefs(source, paint)).toBe(source);
		}
	});

	it("gives the diagram renderer hex colours from the paint", () => {
		const colors = diagramColors(paint);

		for (const color of Object.values(colors)) {
			expect(color).toMatch(HEX);
		}
		expect(colors.bg).toBe(paint.surface);
		expect(colors.fg).toBe(paint.ink);
		expect(colors.accent).toBe(paint.primary);
	});
});
