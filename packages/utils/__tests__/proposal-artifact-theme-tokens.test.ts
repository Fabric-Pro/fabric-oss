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
		expect(tokens.proposer.fonts.display.value).toBe("Inter");
		expect(tokens.proposer.fonts.body.value).toBe("Inter");
		expect(tokens.proposer.fonts.mono.value).toBe("Inter");
		expect(tokens.proposer.name.value).toBeNull();
		expect(tokens.proposer.logo.value).toBeNull();
		expect(tokens.proposer.hero.value).toBeNull();
		expect(tokens.recipient.name.value).toBeNull();
		expect(tokens.recipient.logo.value).toBeNull();
		expect(tokens.recipient.colors.value).toEqual([]);

		// Ten proposer values (three of them fonts) and three recipient ones.
		const values = sourcedValues(tokens);
		expect(values).toHaveLength(13);
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
			display: "Inter",
			body: "Inter",
			mono: "Inter",
		});
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
		const { fonts, recipient, ...colors } = paint;

		for (const color of [...Object.values(colors), ...recipient]) {
			expect(color).toMatch(HEX);
		}
		expect(fonts.body).toBe("Inter");
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
			expect(value).toMatch(/^(#[0-9a-f]{6}|"[A-Za-z0-9 -]+")$/);
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

		expect(paint.fonts).toEqual({
			display: "Inter",
			body: "Example Sans",
			mono: "Inter",
		});
		expect(properties["--pa-font-display"]).toBe('"Inter"');
		expect(properties["--pa-font-body"]).toBe('"Example Sans"');
		expect(properties["--pa-font-mono"]).toBe('"Inter"');
	});

	it("checks a paint that did not come from the resolver", () => {
		const paint = {
			...resolveThemePaint(buildProposalThemeTokens(sources({}))),
			primary: "red; background: url(https://example.com/x)",
			tint: "#fff",
			recipient: ["#0b3d91", "expression(alert(1))"],
			fonts: { display: 'x"}', body: "Example Sans", mono: "" },
		};
		const properties = themeCustomProperties(paint);

		for (const value of Object.values(properties)) {
			expect(value).toMatch(/^(#[0-9a-f]{6}|"[A-Za-z0-9 -]+")$/);
		}
		expect(properties["--pa-primary"]).toBe(NEUTRAL_THEME.primary);
		expect(properties["--pa-tint"]).toBe(NEUTRAL_THEME.surface);
		expect(properties["--pa-recipient-1"]).toBe("#0b3d91");
		expect(properties["--pa-recipient-2"]).toBeUndefined();
		expect(properties["--pa-font-display"]).toBe('"Inter"');
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
		expect(hash).toMatch(/^t1:[0-9a-f]{16}$/);
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
