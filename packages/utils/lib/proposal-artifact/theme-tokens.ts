/**
 * Brand tokens for a client-document Proposal (Fizzy #2946): one shape that
 * the live Main page, the print page and the diagram renderers all read.
 *
 * A token is a value plus the source it came from. Colours are `#rrggbb`,
 * fonts are family names, and assets are storage references; the caller turns
 * a reference into a signed URL for the page or a data URL for print, so the
 * bytes never travel with the tokens. The stored value always keeps its
 * source, even when the theme paints a safer colour in its place: what to
 * paint is decided by {@link resolveThemePaint}, at render time, against the
 * theme's own paper.
 *
 * Pure functions and data only: client components import this module, so it
 * must not pull in anything the browser bundle cannot carry.
 */

import { contrastRatio, rgbToHex } from "../brand-colors";
import {
	GRAPHIC_CONTRAST,
	strictHexColor as strictHex,
	TEXT_CONTRAST,
} from "../glossy/visual-colors";
import {
	canonicalize,
	FNV_OFFSET_BASIS,
	fnv1a,
	SECOND_SEED,
} from "../glossy/visual-spec";

/**
 * Where a token's value came from, in precedence order for the proposer:
 * a person's choice on the document or project, the organization's own brand
 * settings, the vendor's website or brand page, a fetched value nobody has
 * confirmed yet (shown, never applied), and the neutral default.
 */
export const THEME_TOKEN_SOURCES = [
	"MANUAL",
	"BRAND_KIT",
	"VENDOR_SITE",
	"FETCHED_UNCONFIRMED",
	"DEFAULT",
] as const;
export type ThemeTokenSource = (typeof THEME_TOKEN_SOURCES)[number];

export interface SourcedValue<T> {
	value: T;
	source: ThemeTokenSource;
}

/**
 * A stored asset the tokens point at, never its bytes or a URL. The resolver
 * only produces a reference after checking the key against the one prefix
 * its upload writes, and whoever signs or inlines it checks again.
 */
export type ThemeAssetRef =
	| { kind: "organization-logo"; key: string }
	| { kind: "recipient-logo"; key: string };

/** An asset as the live page receives it: a short-lived signed read. */
export interface ThemeAssetUrl {
	url: string;
}

export interface ThemeFonts {
	display: SourcedValue<string>;
	body: SourcedValue<string>;
	mono: SourcedValue<string>;
}

/**
 * The proposer (the organization writing the Proposal) and the recipient
 * (the client it is for) are separate groups and never fill in for each
 * other. `TAsset` is the asset representation: references on the server,
 * signed URLs on the page, data URLs in print.
 */
export interface ProposalThemeTokens<TAsset = ThemeAssetRef> {
	proposer: {
		name: SourcedValue<string | null>;
		logo: SourcedValue<TAsset | null>;
		primary: SourcedValue<string>;
		accents: SourcedValue<string[]>;
		surface: SourcedValue<string>;
		ink: SourcedValue<string>;
		fonts: ThemeFonts;
		hero: SourcedValue<TAsset | null>;
	};
	recipient: {
		name: SourcedValue<string | null>;
		logo: SourcedValue<TAsset | null>;
		colors: SourcedValue<string[]>;
	};
}

/** The neutral professional style a document gets without brand values. */
export const NEUTRAL_THEME = {
	primary: "#334155",
	accents: ["#475569"],
	surface: "#ffffff",
	ink: "#111827",
	font: "Inter",
} as const;

/** Most accent and recipient colours a token carries. */
const MAX_COLORS = 3;

/**
 * Letters, digits, spaces and hyphens only: a family name is written into CSS
 * and into DOCX styles, so anything that could close a string or a rule is
 * refused, not stripped.
 */
const FONT_FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{0,62}[A-Za-z0-9]$/;

/** The family name, or null when it is not one the theme may write. */
export function safeFontFamily(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim().replace(/\s+/g, " ");
	return FONT_FAMILY_PATTERN.test(trimmed) ? trimmed : null;
}

function validColors(values: readonly unknown[] | null | undefined): string[] {
	const colors: string[] = [];
	for (const value of values ?? []) {
		const color = strictHex(value);
		if (color && !colors.includes(color)) {
			colors.push(color);
		}
	}
	return colors.slice(0, MAX_COLORS);
}

function fromDefault<T>(value: T): SourcedValue<T> {
	return { value, source: "DEFAULT" };
}

/**
 * What the part-1 sources hold for one document. The organization logo key
 * must already have passed the trusted-key check of whoever read it.
 */
export interface ProposalThemeSources {
	organization: { name: string | null; logoKey: string | null } | null;
	style: { primaryColor: string | null; accentColors: string[] } | null;
	brandKit: { accentColors: string[] } | null;
	recipient: {
		name: string | null;
		logoKey: string | null;
		colors: string[];
	} | null;
}

/**
 * Tokens from today's sources. The document's Style is a person's choice
 * (MANUAL); the organization's name, logo and Brand kit accents are its own
 * brand settings (BRAND_KIT); the recipient brand on the project was typed or
 * confirmed by a person (MANUAL). Everything else is the neutral default.
 * Invalid colours are dropped rather than repaired.
 */
export function buildProposalThemeTokens(
	sources: ProposalThemeSources,
): ProposalThemeTokens {
	const stylePrimary = strictHex(sources.style?.primaryColor);
	const styleAccents = validColors(sources.style?.accentColors);
	const kitAccents = validColors(sources.brandKit?.accentColors);
	const organizationName = sources.organization?.name?.trim() || null;
	const organizationLogo = sources.organization?.logoKey ?? null;
	const recipientName = sources.recipient?.name?.trim() || null;
	const recipientLogo = sources.recipient?.logoKey ?? null;
	const recipientColors = validColors(sources.recipient?.colors);

	return {
		proposer: {
			name: organizationName
				? { value: organizationName, source: "BRAND_KIT" }
				: fromDefault(null),
			logo: organizationLogo
				? {
						value: {
							kind: "organization-logo",
							key: organizationLogo,
						},
						source: "BRAND_KIT",
					}
				: fromDefault(null),
			primary: stylePrimary
				? { value: stylePrimary, source: "MANUAL" }
				: fromDefault(NEUTRAL_THEME.primary),
			accents:
				styleAccents.length > 0
					? { value: styleAccents, source: "MANUAL" }
					: kitAccents.length > 0
						? { value: kitAccents, source: "BRAND_KIT" }
						: fromDefault([...NEUTRAL_THEME.accents]),
			surface: fromDefault(NEUTRAL_THEME.surface),
			ink: fromDefault(NEUTRAL_THEME.ink),
			fonts: {
				display: fromDefault(NEUTRAL_THEME.font),
				body: fromDefault(NEUTRAL_THEME.font),
				mono: fromDefault(NEUTRAL_THEME.font),
			},
			hero: fromDefault(null),
		},
		recipient: {
			name: recipientName
				? { value: recipientName, source: "MANUAL" }
				: fromDefault(null),
			logo: recipientLogo
				? {
						value: { kind: "recipient-logo", key: recipientLogo },
						source: "MANUAL",
					}
				: fromDefault(null),
			colors:
				recipientColors.length > 0
					? { value: recipientColors, source: "MANUAL" }
					: fromDefault([]),
		},
	};
}

/**
 * The same tokens with every asset converted, for example a reference into a
 * signed URL. A conversion that yields null leaves no asset, keeping the
 * source, so the page and print lay out as though there were no logo.
 */
export async function mapThemeAssets<A, B>(
	tokens: ProposalThemeTokens<A>,
	convert: (asset: A) => Promise<B | null>,
): Promise<ProposalThemeTokens<B>> {
	const map = async (
		token: SourcedValue<A | null>,
	): Promise<SourcedValue<B | null>> => ({
		value: token.value === null ? null : await convert(token.value),
		source: token.source,
	});
	const [proposerLogo, hero, recipientLogo] = await Promise.all([
		map(tokens.proposer.logo),
		map(tokens.proposer.hero),
		map(tokens.recipient.logo),
	]);
	return {
		proposer: { ...tokens.proposer, logo: proposerLogo, hero },
		recipient: { ...tokens.recipient, logo: recipientLogo },
	};
}

/** The WCAG 2.1 AA floors the paint is checked against, text and graphics. */
export { GRAPHIC_CONTRAST, TEXT_CONTRAST };

/**
 * Text for a filled box: pure black or pure white, whichever reads better.
 * One of the two always clears 4.5:1 (the worst case, a mid grey, still
 * measures about 4.58:1), so a brand fill never needs its own fallback.
 */
function textOn(fill: string): string {
	return contrastRatio(fill, "#000000") >= contrastRatio(fill, "#ffffff")
		? "#000000"
		: "#ffffff";
}

/** `weight` of `color` over `base`, as `#rrggbb`. */
function mix(color: string, base: string, weight: number): string {
	const channel = (hex: string, offset: number) =>
		Number.parseInt(hex.slice(offset, offset + 2), 16);
	const blend = (offset: number) =>
		channel(color, offset) * weight + channel(base, offset) * (1 - weight);
	return rgbToHex(blend(1), blend(3), blend(5));
}

/** The editor's own review hues (DocumentEditor.css), not brand values. */
const REVIEW_INSERT = "#22c55e";
const REVIEW_DELETE = "#f98181";

/**
 * The colours and fonts the theme actually paints, every one checked against
 * the paper it sits on. A token that fails its check is painted with the
 * neutral fallback; the token itself, and its source, are left as they are.
 */
export interface ProposalThemePaint {
	surface: string;
	ink: string;
	/** Headings: the primary when it reads as text on the paper, else ink. */
	heading: string;
	/** Rules, tile top borders, table header fills. */
	primary: string;
	/** Text on a primary fill. */
	onPrimary: string;
	accent: string;
	onAccent: string;
	/** Secondary text, captions, eyebrows. */
	muted: string;
	border: string;
	/** A light wash of the primary for callouts and zebra rows. */
	tint: string;
	/**
	 * The editor's review green and red, mixed onto the paper, behind text a
	 * pending AI change inserts or removes. Opaque, so the ink reads on them
	 * inside a filled header cell too.
	 */
	reviewInsert: string;
	reviewDelete: string;
	/** Recipient colours that hold up as graphics on the paper. */
	recipient: string[];
	fonts: { display: string; body: string; mono: string };
}

export function resolveThemePaint(
	tokens: ProposalThemeTokens<unknown>,
): ProposalThemePaint {
	const proposer = tokens.proposer;
	let surface = strictHex(proposer.surface.value) ?? NEUTRAL_THEME.surface;
	let ink = strictHex(proposer.ink.value) ?? NEUTRAL_THEME.ink;
	if (contrastRatio(ink, surface) < TEXT_CONTRAST) {
		surface = NEUTRAL_THEME.surface;
		ink = NEUTRAL_THEME.ink;
	}

	const graphicOr = (color: string | null, fallback: string) =>
		color && contrastRatio(color, surface) >= GRAPHIC_CONTRAST
			? color
			: fallback;

	const brandPrimary = strictHex(proposer.primary.value);
	const primary = graphicOr(brandPrimary, NEUTRAL_THEME.primary);
	const heading =
		brandPrimary && contrastRatio(brandPrimary, surface) >= TEXT_CONTRAST
			? brandPrimary
			: ink;
	const accent =
		validColors(proposer.accents.value).find(
			(color) => contrastRatio(color, surface) >= GRAPHIC_CONTRAST,
		) ?? primary;

	let muted = mix(ink, surface, 0.72);
	if (contrastRatio(muted, surface) < TEXT_CONTRAST) {
		muted = ink;
	}
	let tint = mix(primary, surface, 0.08);
	if (contrastRatio(ink, tint) < TEXT_CONTRAST) {
		tint = mix(ink, surface, 0.04);
	}

	return {
		surface,
		ink,
		heading,
		primary,
		onPrimary: textOn(primary),
		accent,
		onAccent: textOn(accent),
		muted,
		border: mix(ink, surface, 0.18),
		tint,
		reviewInsert: mix(REVIEW_INSERT, surface, 0.35),
		reviewDelete: mix(REVIEW_DELETE, surface, 0.31),
		recipient: validColors(tokens.recipient.colors.value).filter(
			(color) => contrastRatio(color, surface) >= GRAPHIC_CONTRAST,
		),
		fonts: {
			display:
				safeFontFamily(proposer.fonts.display.value) ??
				NEUTRAL_THEME.font,
			body:
				safeFontFamily(proposer.fonts.body.value) ?? NEUTRAL_THEME.font,
			mono:
				safeFontFamily(proposer.fonts.mono.value) ?? NEUTRAL_THEME.font,
		},
	};
}

/**
 * The paint as CSS custom properties for the theme root. Every value is a
 * `#rrggbb` colour or one quoted family name from the allowed character set,
 * so nothing a brand source holds can reach CSS as anything else. Keys are
 * the `--pa-*` names the theme stylesheet reads.
 */
export function themeCustomProperties(
	paint: ProposalThemePaint,
): Record<`--pa-${string}`, string> {
	// Checked again on the way out, so a paint assembled anywhere other than
	// `resolveThemePaint` still cannot write anything else into CSS.
	const color = (value: string, fallback: string) =>
		strictHex(value) ?? fallback;
	const family = (value: string) =>
		`"${safeFontFamily(value) ?? NEUTRAL_THEME.font}"`;
	const properties: Record<`--pa-${string}`, string> = {
		"--pa-surface": color(paint.surface, NEUTRAL_THEME.surface),
		"--pa-ink": color(paint.ink, NEUTRAL_THEME.ink),
		"--pa-heading": color(paint.heading, NEUTRAL_THEME.ink),
		"--pa-primary": color(paint.primary, NEUTRAL_THEME.primary),
		"--pa-on-primary": color(paint.onPrimary, NEUTRAL_THEME.surface),
		"--pa-accent": color(paint.accent, NEUTRAL_THEME.primary),
		"--pa-on-accent": color(paint.onAccent, NEUTRAL_THEME.surface),
		"--pa-muted": color(paint.muted, NEUTRAL_THEME.ink),
		"--pa-border": color(paint.border, NEUTRAL_THEME.ink),
		"--pa-tint": color(paint.tint, NEUTRAL_THEME.surface),
		"--pa-review-insert": color(paint.reviewInsert, NEUTRAL_THEME.surface),
		"--pa-review-delete": color(paint.reviewDelete, NEUTRAL_THEME.surface),
		"--pa-font-display": family(paint.fonts.display),
		"--pa-font-body": family(paint.fonts.body),
		"--pa-font-mono": family(paint.fonts.mono),
	};
	validColors(paint.recipient).forEach((value, index) => {
		properties[`--pa-recipient-${index + 1}`] = value;
	});
	return properties;
}

/** The roles a generated diagram may assign to a node with `class <id> <role>`. */
export const VISUAL_ROLES = ["primary", "accent", "surface", "border"] as const;
export type VisualRole = (typeof VISUAL_ROLES)[number];

export interface VisualRoleColors {
	fill: string;
	stroke: string;
	color: string;
}

/**
 * One role resolver for every diagram renderer, live and export, so a role
 * paints the same everywhere. Fills carry a readable label colour.
 */
export function resolveVisualRoleColors(
	paint: ProposalThemePaint,
): Record<VisualRole, VisualRoleColors> {
	return {
		primary: {
			fill: paint.primary,
			stroke: paint.primary,
			color: paint.onPrimary,
		},
		accent: {
			fill: paint.accent,
			stroke: paint.accent,
			color: paint.onAccent,
		},
		surface: { fill: paint.tint, stroke: paint.border, color: paint.ink },
		border: {
			fill: paint.surface,
			stroke: paint.primary,
			color: paint.ink,
		},
	};
}

/** Mermaid `classDef` lines for the roles, appended to a diagram's source. */
export function visualRoleClassDefs(paint: ProposalThemePaint): string[] {
	const roles = resolveVisualRoleColors(paint);
	return VISUAL_ROLES.map((role) => {
		const { fill, stroke, color } = roles[role];
		return `classDef ${role} fill:${fill},stroke:${stroke},color:${color}`;
	});
}

/**
 * The seven colour options beautiful-mermaid takes, as hex, so a diagram
 * drawn outside the editor needs no surrounding stylesheet.
 */
export function diagramColors(paint: ProposalThemePaint): {
	bg: string;
	fg: string;
	line: string;
	accent: string;
	muted: string;
	surface: string;
	border: string;
} {
	return {
		bg: paint.surface,
		fg: paint.ink,
		line: paint.muted,
		accent: paint.primary,
		muted: paint.muted,
		surface: paint.tint,
		border: paint.border,
	};
}

/** One 32-bit FNV-1a pass as eight hex digits. */
function hashHex(value: string, seed: number): string {
	return fnv1a(value, seed).toString(16).padStart(8, "0");
}

/** Version prefix: a later change to what is hashed reads as "unknown". */
const TOKEN_HASH_VERSION = "t1";

/**
 * A stable hash of what the tokens look like (values, not sources), so a
 * later export can tell whether the brand changed since the last one. Not an
 * integrity check: two-pass FNV-1a over a canonical encoding, browser-safe.
 */
export function themeTokenHash(tokens: ProposalThemeTokens): string {
	const strip = <T>(token: SourcedValue<T>) => token.value;
	const canonical = canonicalize({
		proposer: {
			name: strip(tokens.proposer.name),
			logo: strip(tokens.proposer.logo),
			primary: strip(tokens.proposer.primary),
			accents: strip(tokens.proposer.accents),
			surface: strip(tokens.proposer.surface),
			ink: strip(tokens.proposer.ink),
			fonts: {
				display: strip(tokens.proposer.fonts.display),
				body: strip(tokens.proposer.fonts.body),
				mono: strip(tokens.proposer.fonts.mono),
			},
			hero: strip(tokens.proposer.hero),
		},
		recipient: {
			name: strip(tokens.recipient.name),
			logo: strip(tokens.recipient.logo),
			colors: strip(tokens.recipient.colors),
		},
	});
	return `${TOKEN_HASH_VERSION}:${hashHex(canonical, FNV_OFFSET_BASIS)}${hashHex(canonical, SECOND_SEED)}`;
}
