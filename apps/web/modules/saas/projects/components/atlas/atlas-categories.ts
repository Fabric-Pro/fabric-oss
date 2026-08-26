/**
 * Smart, design-token-driven categorisation for the Atlas graph.
 *
 * Every node (technical module / business capability / file …) is mapped to one
 * of seven product categories. The category drives the node's colour-chip, the
 * legend, the node-detail card, and the neighbour chips — one source of truth so
 * the whole surface stays visually coherent.
 *
 * Colours are CSS-variable design tokens (`var(--atlas-cat-*)`, declared in
 * `apps/web/app/globals.css` for both themes), never hardcoded hex — so the
 * graph themes correctly in light AND dark (see CLAUDE.md "Design system").
 *
 * `categorizeNode` is a pure, first-match-wins keyword matcher over a lowercased
 * haystack of the node's label + file path + description. The rules are ordered
 * by specificity (security before AI before infra…) so e.g. an auth module beats
 * a generic "app" match. It is intentionally dependency-free and unit-tested.
 */
import type { AtlasNodeKind } from "@repo/atlas/types";
import {
	CloudIcon,
	DatabaseIcon,
	LayoutDashboardIcon,
	type LucideIcon,
	PlugIcon,
	SettingsIcon,
	ShieldIcon,
	SparklesIcon,
	TagIcon,
} from "lucide-react";

export type AtlasCategory =
	| "ai"
	| "integration"
	| "security"
	| "infra"
	| "data"
	| "experience"
	| "ops";

/** Stable display order (AI value first, platform/ops last). */
export const CATEGORY_ORDER: AtlasCategory[] = [
	"ai",
	"integration",
	"security",
	"infra",
	"data",
	"experience",
	"ops",
];

/**
 * Per-category presentation metadata: the i18n key for the human label, the CSS
 * colour-variable token, and the lucide glyph used in chips. Colours resolve to
 * `--atlas-cat-*` so every swatch matches the node it describes in both themes.
 */
export const CATEGORY_META: Record<
	AtlasCategory,
	{ labelKey: string; colorVar: string; Icon: LucideIcon }
> = {
	ai: {
		labelKey: "projects.atlas.category.ai",
		colorVar: "var(--atlas-cat-ai)",
		Icon: SparklesIcon,
	},
	integration: {
		labelKey: "projects.atlas.category.integration",
		colorVar: "var(--atlas-cat-integration)",
		Icon: PlugIcon,
	},
	security: {
		labelKey: "projects.atlas.category.security",
		colorVar: "var(--atlas-cat-security)",
		Icon: ShieldIcon,
	},
	infra: {
		labelKey: "projects.atlas.category.infra",
		colorVar: "var(--atlas-cat-infra)",
		Icon: CloudIcon,
	},
	data: {
		labelKey: "projects.atlas.category.data",
		colorVar: "var(--atlas-cat-data)",
		Icon: DatabaseIcon,
	},
	experience: {
		labelKey: "projects.atlas.category.experience",
		colorVar: "var(--atlas-cat-experience)",
		Icon: LayoutDashboardIcon,
	},
	ops: {
		labelKey: "projects.atlas.category.ops",
		colorVar: "var(--atlas-cat-ops)",
		Icon: SettingsIcon,
	},
};

/** The CSS `var(--atlas-cat-*)` colour token for a category. */
export function categoryColorVar(cat: AtlasCategory): string {
	return CATEGORY_META[cat].colorVar;
}

/**
 * i18n key for each category's one-line meaning, surfaced as a hover tooltip in
 * the legend and the node card. Typed as a literal union (like `EDGE_KIND_KEY`)
 * so next-intl's typed-key check accepts the dynamic lookup.
 */
export const CATEGORY_DESC_KEY: Record<
	AtlasCategory,
	| "aiDesc"
	| "integrationDesc"
	| "securityDesc"
	| "infraDesc"
	| "dataDesc"
	| "experienceDesc"
	| "opsDesc"
> = {
	ai: "aiDesc",
	integration: "integrationDesc",
	security: "securityDesc",
	infra: "infraDesc",
	data: "dataDesc",
	experience: "experienceDesc",
	ops: "opsDesc",
};

/**
 * Neutral token used for a USER-DEFINED custom category (any value that isn't one
 * of the seven presets). Design-token only — never a hardcoded hex — so a custom
 * category reads as "other" in both themes without colliding with a preset hue.
 */
export const CUSTOM_CATEGORY_COLOR_VAR = "var(--muted-foreground)";

/** Narrow a raw category string to one of the seven presets, or null if custom/empty. */
export function asAtlasCategory(
	value: string | null | undefined,
): AtlasCategory | null {
	if (value && (CATEGORY_ORDER as string[]).includes(value)) {
		return value as AtlasCategory;
	}
	return null;
}

/**
 * The EFFECTIVE category of a node, resolved for display. A `known` preset carries
 * its design-token colour + glyph; any other (user-typed) value is a `custom`
 * category shown with a neutral token + a generic tag glyph.
 */
export interface ResolvedNodeCategory {
	/** Raw effective value — a preset key (e.g. "ai") or a custom string. */
	value: string;
	/** The matching preset, or null when the value is a custom category. */
	known: AtlasCategory | null;
	/** Display colour token: the preset's `--atlas-cat-*`, or the neutral token. */
	colorVar: string;
	/** Glyph: the preset's icon, or a generic tag for custom categories. */
	Icon: LucideIcon;
}

/**
 * Resolve a node's EFFECTIVE category for display across the graph, legend, node
 * card, and overview. Prefers the persisted `category` (a user override or the
 * AI-assigned value); when absent, falls back to the keyword `categorizeNode`. A
 * value matching one of the seven presets keeps its token colour + glyph; any
 * other string is treated as a user-defined custom category (neutral token).
 */
export function resolveNodeCategory(input: {
	label: string;
	filePath?: string | null;
	description?: string | null;
	kind: AtlasNodeKind;
	category?: string | null;
}): ResolvedNodeCategory {
	const raw = input.category?.trim() || categorizeNode(input);
	const known = asAtlasCategory(raw);
	if (known) {
		return {
			value: known,
			known,
			colorVar: categoryColorVar(known),
			Icon: CATEGORY_META[known].Icon,
		};
	}
	return {
		value: raw,
		known: null,
		colorVar: CUSTOM_CATEGORY_COLOR_VAR,
		Icon: TagIcon,
	};
}

/**
 * Ordered keyword rules. First category whose keyword appears in the haystack
 * wins, so the array order encodes priority. Keywords are matched as substrings
 * of a slash-normalised, space-padded haystack — so `" ai "` / `" ui"` only hit
 * whole path/word segments ("modules/ui" → "modules ui"), while bare keywords
 * like "orchestrat" still match by substring ("orchestration").
 */
const CATEGORY_RULES: Array<{ category: AtlasCategory; keywords: string[] }> = [
	{
		category: "security",
		keywords: [
			"auth",
			"authn",
			"authz",
			"authentication",
			"authorization",
			"login",
			"signin",
			"sign-in",
			"permission",
			"rbac",
			"role-based",
			"tenant",
			"isolation",
			"session",
			"sso",
			"oauth",
			"encrypt",
			"secret",
			"credential",
			"audit",
			"access control",
		],
	},
	{
		category: "ai",
		keywords: [
			"agent",
			" ai ",
			"llm",
			"prompt",
			"weave",
			"copilot",
			"nexus",
			"orchestrat",
			"inference",
			"langchain",
			"langgraph",
			"assistant",
			"completion",
			"reasoning",
			"embedding model",
		],
	},
	{
		category: "integration",
		keywords: [
			"integration",
			"connector",
			"github",
			"gitlab",
			"slack",
			"linear",
			"notion",
			"jira",
			"azure devops",
			" ado",
			"mcp",
			"webhook",
			"channel",
			"email",
			"notification",
			"devtool",
			"pm-integration",
			"third-party",
		],
	},
	{
		category: "data",
		keywords: [
			"database",
			"storage",
			"prisma",
			"persistence",
			"migration",
			"schema",
			"rag",
			"embedding",
			"vector",
			"qdrant",
			"asset",
			"upload",
			"blob",
			"index",
			"query",
			"sql",
			"postgres",
			"redis",
			"cache",
			"context store",
		],
	},
	{
		category: "infra",
		keywords: [
			"infra",
			"deploy",
			"temporal",
			"worker",
			"runtime",
			"container",
			"hosting",
			"release",
			"edge",
			"serverless",
			"build",
			"sandbox",
			"exec",
			"docker",
			"kubernetes",
			"aspire",
			"bicep",
			"terraform",
			"pipeline",
			"ci/cd",
		],
	},
	{
		category: "experience",
		keywords: [
			"web",
			" ui",
			"component",
			"document",
			"editor",
			"collab",
			"roadmap",
			"dashboard",
			"project",
			"page",
			"view",
			"design",
			"navigation",
			"marketing",
			"story",
			"kanban",
			"frame",
			"layout",
			"frontend",
			"tailwind",
			"css",
		],
	},
	{
		category: "ops",
		keywords: [
			"billing",
			"payment",
			"observability",
			"monitoring",
			"config",
			"settings",
			"admin",
			"usage",
			"metric",
			"trace",
			"logging",
			"platform",
			"tooling",
			"test",
			"quota",
			"subscription",
		],
	},
];

/** Collapse path separators to spaces so word-boundary keywords match segments. */
function normalize(value: string): string {
	return value.toLowerCase().replace(/[/\\]+/g, " ");
}

/**
 * Map a node to its Atlas category via first-match-wins keyword rules. Builds a
 * lowercased haystack from label + file path + description (padded with spaces so
 * `" ai "` / `" ui"` keywords resolve at segment boundaries) and returns the
 * first matching category, falling back to "ops" when nothing matches.
 */
export function categorizeNode(input: {
	label: string;
	filePath?: string | null;
	description?: string | null;
	kind: AtlasNodeKind;
}): AtlasCategory {
	const haystack = ` ${normalize(
		`${input.label} ${input.filePath ?? ""} ${input.description ?? ""}`,
	)} `;
	for (const rule of CATEGORY_RULES) {
		for (const keyword of rule.keywords) {
			if (haystack.includes(normalize(keyword))) {
				return rule.category;
			}
		}
	}
	return "ops";
}
