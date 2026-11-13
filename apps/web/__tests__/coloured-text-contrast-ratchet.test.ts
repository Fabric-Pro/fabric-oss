/**
 * Ratchet: no NEW coloured text under WCAG AA (Fizzy #1444, AC-13/14).
 *
 * The chromatic Tailwind shades most of the app reaches for as status text —
 * `text-emerald-600`, `text-amber-600`, `text-green-700` — measured 2.5-4.4:1 on
 * the light surfaces, and a light-mode class with no `dark:` counterpart paints
 * dark mode too, where `-600` and `-700` fall to 2-3.5:1. Each was moved to the
 * nearest shade that clears the floor, and given a `dark:` shade where dark mode
 * had none.
 *
 * This file measures every class string the way the browser paints it, in
 * both themes:
 *   - on the fill the string itself states, opacity included (`bg-amber-500/10`
 *     over the card), or on every neutral surface when it states none;
 *   - a fill with no `dark:` variant paints dark mode too (`bg-green-100` stays
 *     a light chip), while a token fill (`bg-card`) takes its dark value;
 *   - a light-mode colour with no `dark:` text override is measured in dark
 *     mode as well, which is what catches an unpaired `text-emerald-700`;
 *   - a state colour (`hover:text-red-700`) outranks a plain `dark:` colour —
 *     `dark:` is a zero-specificity `:where()` — so without its own
 *     `dark:hover:` it is measured in dark mode too;
 *   - large text (24px, or 20px bold) needs 3:1, everything else 4.5:1.
 *
 * What still fails is mostly not text — ICONS (non-text contrast is out of the
 * ticket's scope) and the workflow plugins' brand-icon tints — or a label whose
 * fill is set in a different string than its colour. The counts are a ceiling
 * in both directions, like the faded-text ratchet: over means a new
 * low-contrast colour, under means lower the number.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = resolve(__dirname, "..");
const PALETTE = resolve(webRoot, "node_modules/tailwindcss/theme.css");
const SEARCH_ROOTS = ["modules", "app"];

const HUES = [
	"red",
	"orange",
	"amber",
	"yellow",
	"lime",
	"green",
	"emerald",
	"teal",
	"cyan",
	"sky",
	"blue",
	"indigo",
	"violet",
	"purple",
	"fuchsia",
	"pink",
	"rose",
] as const;
const NEUTRAL_HUES = ["slate", "gray", "zinc", "neutral", "stone"];
const isHue = (value: string) => (HUES as readonly string[]).includes(value);

// --background/--card, --muted/--secondary, --sidebar (the light high-contrast
// palette shares these values).
const LIGHT_SURFACES = ["#ffffff", "#f1f3f6", "#f6f7f9"];
// Background, card, popover, muted, secondary, sidebar — ordinary and
// high-contrast dark. The hover wash is a transient state and is left out.
const DARK_SURFACES = [
	"#11171c",
	"#182026",
	"#1f272d",
	"#1e262d",
	"#222c34",
	"#0d1216",
	"#000000",
	"#0a0d10",
	"#101418",
	"#12171c",
	"#1a2128",
];
// What a translucent fill is laid over.
const LIGHT_BASES = ["#ffffff", "#f6f7f9"];
const DARK_BASES = ["#182026", "#11171c", "#0a0d10", "#1f272d"];
// Token fills, by theme.
const TOKEN_FILLS: Record<"light" | "dark", Record<string, string>> = {
	light: {
		white: "#ffffff",
		black: "#000000",
		background: "#ffffff",
		card: "#ffffff",
		popover: "#ffffff",
		muted: "#f1f3f6",
		secondary: "#f1f3f6",
		sidebar: "#f6f7f9",
		accent: "#e8edf2",
		primary: "#bc3e0b",
	},
	dark: {
		white: "#ffffff",
		black: "#000000",
		background: "#11171c",
		card: "#182026",
		popover: "#1f272d",
		muted: "#1e262d",
		secondary: "#222c34",
		sidebar: "#0d1216",
		accent: "#26323d",
		primary: "#ff8547",
	},
};
/**
 * Token text colours measured here, by theme. `text-primary` on a tint of
 * itself (`bg-primary/10`) measured 3.7-4.6:1 in light mode; the active-state
 * ink is the one to put on a primary wash (Fizzy #1444).
 */
const TOKEN_TEXT: Record<"light" | "dark", Record<string, string>> = {
	light: { primary: "#bc3e0b", "primary-active": "#8a2a05" },
	dark: { primary: "#ff8547", "primary-active": "#ffaa7d" },
};
const isTokenText = (t: Token) =>
	t.kind === "text" && t.shade === null && t.colour in TOKEN_TEXT.light;

const CEILING: Record<string, number> = {
	"app/(saas)/app/(organizations)/[organizationSlug]/agents/[agentId]/page.tsx": 3,
	"modules/saas/agent-templates/components/AgentMemoryPanel.tsx": 2,
	"modules/saas/agent-templates/components/CreateAgentPage.tsx": 2,
	"modules/saas/agent-templates/components/CreateTemplatePage.tsx": 1,
	"modules/saas/agent-templates/components/DataSourcesSheet.tsx": 1,
	"modules/saas/agent-templates/components/ToolsSheet.tsx": 1,
	"modules/saas/agent-templates/components/TriggersSheet.tsx": 2,
	"modules/saas/agent-templates/components/WorkspacesSheet.tsx": 3,
	"modules/saas/agents/components/CreateAgentDialog.tsx": 6,
	"modules/saas/agents/components/FabricChat/ContextCompactionNotice.tsx": 1,
	"modules/saas/agents/components/FabricChat/FabricTemporalOrchestratorChat.tsx": 2,
	"modules/saas/agents/components/FabricChat/TrajectorySteps.tsx": 1,
	"modules/saas/agents/components/FabricChat/cards/ResearchProgressCard.tsx": 2,
	"modules/saas/agents/components/FabricChat/orchestrator/ArtifactsPanel.tsx": 9,
	"modules/saas/agents/components/FabricChat/orchestrator/ConnectionRequiredDialog.tsx": 1,
	"modules/saas/agents/components/FabricChat/orchestrator/PhaseIndicator.tsx": 8,
	"modules/saas/agents/components/FabricChat/orchestrator/TaskPlanView.tsx": 1,
	"modules/saas/agents/components/HITLDialog.tsx": 1,
	"modules/saas/agents/components/OrgAgentRegistryView.tsx": 1,
	"modules/saas/agents/components/RegisterExternalAgent.tsx": 1,
	"modules/saas/agents/components/UnifiedAgentListView.tsx": 1,
	"modules/saas/agents/components/UnifiedAgentView.tsx": 3,
	"modules/saas/agents/components/WorkflowTemplateChat/SubAgentCard.tsx": 2,
	"modules/saas/agents/components/WorkflowTemplateChat/WorkflowProgressPanel.tsx": 1,
	"modules/saas/agents/components/WorkflowTemplateChat/WorkflowResultViewer.tsx": 1,
	"modules/saas/agents/components/WorkflowTemplateChat/WorkflowTemplateChat.tsx": 1,
	"modules/saas/agents/components/WorkspacePanel/WorkspacePanel.tsx": 1,
	"modules/saas/agents/components/cuga/CugaSubtaskTree.tsx": 1,
	"modules/saas/agents/components/fabric-ai/FabricAIClient.tsx": 1,
	"modules/saas/agents/sidekick/cards/InstructionsSuggestionCard.tsx": 1,
	"modules/saas/ai/components/ChatApprovalCard.tsx": 1,
	"modules/saas/get-started/components/GetStartedDrawer.tsx": 1,
	"modules/saas/get-started/components/GetStartedSpotlight.tsx": 1,
	"modules/saas/mcp/components/McpServersView.tsx": 1,
	"modules/saas/mcp/components/authority/AuthorityApprovalCard.tsx": 1,
	"modules/saas/mcp/components/authority/AuthorityDashboard.tsx": 4,
	"modules/saas/projects/components/ConfluencePageSelector.tsx": 1,
	"modules/saas/projects/components/DocumentVersionHistory.tsx": 1,
	"modules/saas/projects/components/DocumentsList.tsx": 2,
	"modules/saas/projects/components/InvitationsList.tsx": 1,
	"modules/saas/projects/components/ProjectCreationWizard.tsx": 2,
	"modules/saas/projects/components/ProjectImplementationDefaultsSettings.tsx": 1,
	"modules/saas/projects/components/ProjectMembersSettings.tsx": 1,
	"modules/saas/projects/components/TeamsChatPickerDialog.tsx": 2,
	"modules/saas/projects/components/TeamsChatSelectorDialog.tsx": 3,
	"modules/saas/projects/components/coding-runs/CodingRunTimeline.tsx": 1,
	"modules/saas/projects/components/decisions/DecisionDetailSheet.tsx": 1,
	"modules/saas/projects/components/decisions/DecisionsList.tsx": 2,
	"modules/saas/projects/components/decisions/DecisionsTable.tsx": 1,
	"modules/saas/projects/components/decisions/LivingMemoryCandidatesStrip.tsx": 2,
	"modules/saas/projects/components/instructions/PluginAccessPanel.tsx": 1,
	"modules/saas/projects/components/instructions/RuleSuggestionsResult.tsx": 1,
	"modules/saas/projects/components/publishing-suite/SnoozeTopicDialog.tsx": 1,
	"modules/saas/projects/components/repository-import/RepositoryImportPanel.tsx": 1,
	"modules/saas/projects/components/stories/CopyLinkButton.tsx": 1,
	"modules/saas/projects/components/stories/StoryEvidence.tsx": 1,
	"modules/saas/projects/components/stories/StoryWorkspace.tsx": 2,
	"modules/saas/projects/components/wizard/DocumentGenerationStep.tsx": 1,
	"modules/saas/projects/components/wizard/WizardFileUploader.tsx": 1,
	"modules/saas/reports/components/ArtifactDeliveryHistoryDialog.tsx": 2,
	"modules/saas/reports/components/EvidenceConfigSection.tsx": 1,
	"modules/saas/reports/components/FabricAiConfigSection.tsx": 1,
	"modules/saas/reports/components/IntegrationSetupGuide.tsx": 3,
	"modules/saas/reports/components/ReportTemplateForm.tsx": 4,
	"modules/saas/reports/components/TemplateInstanceDetail.tsx": 4,
	"modules/saas/settings/components/ActiveSessionsBlock.tsx": 1,
	"modules/saas/settings/components/ConnectedAccountsBlock.tsx": 1,
	"modules/saas/settings/components/PasskeysBlock.tsx": 1,
	"modules/saas/shared/components/copilot/CopilotSidebarAttachments.tsx": 1,
	"modules/saas/shared/components/copilot/ReasoningCollapsible.tsx": 1,
	"modules/saas/skills/components/SkillEditor.tsx": 1,
	"modules/saas/weave/components/CheckpointReviewModal.tsx": 1,
	"modules/saas/weave/components/ProjectWeaveConfigSettings.tsx": 2,
	"modules/saas/weave/components/WeavePlanList.tsx": 2,
	"modules/saas/workflows/components/ExecutionPanel.tsx": 1,
	"modules/saas/workflows/lib/plugins/ai-gateway/index.ts": 1,
	"modules/saas/workflows/lib/plugins/asana/index.ts": 1,
	"modules/saas/workflows/lib/plugins/attio/index.ts": 1,
	"modules/saas/workflows/lib/plugins/bitbucket/index.ts": 1,
	"modules/saas/workflows/lib/plugins/canva/index.ts": 1,
	"modules/saas/workflows/lib/plugins/clerk/index.ts": 1,
	"modules/saas/workflows/lib/plugins/clickup/index.ts": 1,
	"modules/saas/workflows/lib/plugins/confluence/index.ts": 1,
	"modules/saas/workflows/lib/plugins/databricks-vector-search/index.ts": 1,
	"modules/saas/workflows/lib/plugins/fal/index.ts": 1,
	"modules/saas/workflows/lib/plugins/firecrawl/index.ts": 1,
	"modules/saas/workflows/lib/plugins/freshservice/index.ts": 1,
	"modules/saas/workflows/lib/plugins/front/index.ts": 1,
	"modules/saas/workflows/lib/plugins/gitlab/index.ts": 1,
	"modules/saas/workflows/lib/plugins/google-drive/index.ts": 1,
	"modules/saas/workflows/lib/plugins/hubspot/index.ts": 1,
	"modules/saas/workflows/lib/plugins/intercom/index.ts": 1,
	"modules/saas/workflows/lib/plugins/jira/index.ts": 1,
	"modules/saas/workflows/lib/plugins/linear/index.ts": 1,
	"modules/saas/workflows/lib/plugins/microsoft-teams/MicrosoftTeamsSettings.tsx": 1,
	"modules/saas/workflows/lib/plugins/microsoft-teams/index.ts": 1,
	"modules/saas/workflows/lib/plugins/nhtsa-vpic/index.ts": 1,
	"modules/saas/workflows/lib/plugins/perplexity/index.ts": 1,
	"modules/saas/workflows/lib/plugins/resend/index.ts": 1,
	"modules/saas/workflows/lib/plugins/salesforce/index.ts": 1,
	"modules/saas/workflows/lib/plugins/slack/SlackSettings.tsx": 3,
	"modules/saas/workflows/lib/plugins/slack/index.ts": 1,
	"modules/saas/workflows/lib/plugins/stripe/index.ts": 1,
	"modules/saas/workflows/lib/plugins/superagent/index.ts": 1,
	"modules/saas/workflows/lib/plugins/webflow/index.ts": 1,
	"modules/saas/workflows/lib/plugins/zendesk/index.ts": 1,
	"modules/saas/workspaces/components/WorkspaceCard.tsx": 1,
	"modules/saas/workspaces/components/WorkspaceDetail.tsx": 2,
};

// ── Colour maths ──────────────────────────────────────────────────────────

type Rgb = [number, number, number];

function hex(value: string): Rgb {
	const raw = value.replace("#", "");
	return [0, 2, 4].map(
		(i) => Number.parseInt(raw.slice(i, i + 2), 16) / 255,
	) as Rgb;
}

function oklch(l: number, c: number, h: number): Rgb {
	const rad = (h * Math.PI) / 180;
	const a = c * Math.cos(rad);
	const b = c * Math.sin(rad);
	const lms = [
		(l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
		(l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
		(l - 0.0894841775 * a - 1.291485548 * b) ** 3,
	] as const;
	const linear = [
		4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
		-1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
		-0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
	];
	return linear.map((v) => {
		const x = Math.min(1, Math.max(0, v));
		return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
	}) as Rgb;
}

function luminance(rgb: Rgb): number {
	const [r, g, b] = rgb.map((c) =>
		c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
	) as Rgb;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
		number,
		number,
	];
	return (hi + 0.05) / (lo + 0.05);
}

function over(colour: Rgb, alpha: number, ground: Rgb): Rgb {
	return colour.map((c, i) => alpha * c + (1 - alpha) * ground[i]) as Rgb;
}

const palette = new Map<string, Rgb>();
for (const m of readFileSync(PALETTE, "utf8").matchAll(
	/--color-([a-z]+)-(\d+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g,
)) {
	palette.set(
		`${m[1]}-${m[2]}`,
		oklch(Number(m[3]) / 100, Number(m[4]), Number(m[5])),
	);
}

// ── Class strings ─────────────────────────────────────────────────────────

type Token = {
	variants: string[];
	kind: "text" | "bg";
	colour: string;
	shade: number | null;
	alpha: number;
};

const TOKEN =
	/^((?:[^\s:]+:)*)!?(text|bg)-([a-z]+(?:-[a-z]+)*)(?:-(\d{2,3}))?(?:\/(\d+|\[[\d.]+\]))?$/;
const RESPONSIVE = new Set(["sm", "md", "lg", "xl", "2xl"]);

function parse(classes: string): Token[] {
	const tokens: Token[] = [];
	for (const raw of classes.split(/\s+/)) {
		const m = raw.match(TOKEN);
		if (!m) {
			continue;
		}
		const alpha = m[5]
			? m[5].startsWith("[")
				? Number(m[5].slice(1, -1))
				: Number(m[5]) / 100
			: 1;
		tokens.push({
			variants: (m[1] ?? "")
				.split(":")
				.filter(Boolean)
				.filter((v) => !RESPONSIVE.has(v)),
			kind: m[2] as "text" | "bg",
			colour: m[3] as string,
			shade: m[4] ? Number(m[4]) : null,
			alpha,
		});
	}
	return tokens;
}

const isDark = (t: Token) => t.variants.includes("dark");
/** Variants other than `dark` — hover, focus, group-hover, data-[…], … */
const stateOf = (t: Token) => t.variants.filter((v) => v !== "dark").join(":");

function fillColour(t: Token, theme: "light" | "dark"): Rgb | null | "unknown" {
	if (t.colour === "transparent") {
		return null;
	}
	if (t.shade !== null) {
		const c = palette.get(`${t.colour}-${t.shade}`);
		return c && (isHue(t.colour) || NEUTRAL_HUES.includes(t.colour))
			? c
			: "unknown";
	}
	const token = TOKEN_FILLS[theme][t.colour];
	return token ? hex(token) : "unknown";
}

/**
 * Every ground the string's text can sit on in a theme and state, or null if
 * unknowable. A state's own fill wins (`hover:bg-red-50` under
 * `hover:text-red-700`), then the plain fill; in dark mode a `dark:` fill wins
 * over one without, which still paints dark mode when it is alone.
 */
function grounds(
	tokens: Token[],
	theme: "light" | "dark",
	state = "",
): Rgb[] | null {
	const fillsFor = (s: string) =>
		tokens.filter((t) => t.kind === "bg" && stateOf(t) === s);
	const pick = (s: string) => {
		const fills = fillsFor(s);
		if (theme === "light") {
			return fills.filter((t) => !isDark(t));
		}
		const dark = fills.filter(isDark);
		return dark.length ? dark : fills.filter((t) => !isDark(t));
	};
	const stated = state && pick(state).length ? pick(state) : pick("");
	const bases = (theme === "light" ? LIGHT_BASES : DARK_BASES).map(hex);
	const out: Rgb[] = [];
	for (const fill of stated) {
		const colour = fillColour(fill, theme);
		if (colour === "unknown") {
			return null;
		}
		if (colour === null) {
			continue;
		}
		for (const base of bases) {
			out.push(over(colour, fill.alpha, base));
		}
	}
	if (out.length) {
		return out;
	}
	return (theme === "light" ? LIGHT_SURFACES : DARK_SURFACES).map(hex);
}

function textColour(t: Token, theme: "light" | "dark"): Rgb | undefined {
	if (t.shade === null) {
		const token = TOKEN_TEXT[theme][t.colour];
		return token ? hex(token) : undefined;
	}
	return palette.get(`${t.colour}-${t.shade}`);
}

function fails(
	t: Token,
	ground: Rgb[],
	floor: number,
	theme: "light" | "dark",
): boolean {
	const colour = textColour(t, theme);
	if (!colour) {
		return false;
	}
	return ground.some((g) => ratio(over(colour, t.alpha, g), g) < floor);
}

type Failure = { token: string; theme: "light" | "dark" };

/** The coloured text classes in a class string that miss AA, both themes. */
function failuresIn(classes: string): Failure[] {
	const tokens = parse(classes);
	const coloured = tokens.filter(
		(t) =>
			(t.kind === "text" && isHue(t.colour) && t.shade !== null) ||
			isTokenText(t),
	);
	if (coloured.length === 0) {
		return [];
	}
	const large =
		/(^|\s)text-([3-9]xl|2xl)(\s|$)/.test(classes) ||
		(/(^|\s)text-xl(\s|$)/.test(classes) &&
			/(^|\s)font-(bold|extrabold|black)(\s|$)/.test(classes));
	const floor = large ? 3 : 4.5;
	const anyDarkText = (state: string) =>
		tokens.some(
			(t) => t.kind === "text" && isDark(t) && stateOf(t) === state,
		);

	const out: Failure[] = [];
	for (const t of coloured) {
		const token = `${t.variants.map((v) => `${v}:`).join("")}text-${t.colour}${t.shade === null ? "" : `-${t.shade}`}`;
		const light = grounds(tokens, "light", stateOf(t));
		const dark = grounds(tokens, "dark", stateOf(t));
		if (isDark(t)) {
			if (dark && fails(t, dark, floor, "dark")) {
				out.push({ token, theme: "dark" });
			}
			continue;
		}
		if (light && fails(t, light, floor, "light")) {
			out.push({ token, theme: "light" });
			continue;
		}
		// The same class paints dark mode unless a `dark:` colour for the same
		// state overrides it.
		if (dark && !anyDarkText(stateOf(t)) && fails(t, dark, floor, "dark")) {
			out.push({ token, theme: "dark" });
		}
	}
	return out;
}

const details: string[] = [];

const LITERAL = /"([^"\n\\]*)"|'([^'\n\\]*)'|`([^`\n\\]*)`/g;

function countFile(source: string, file?: string): number {
	let count = 0;
	for (const m of source.matchAll(LITERAL)) {
		const literal = m[1] ?? m[2] ?? m[3] ?? "";
		if (!/text-([a-z]+-\d|primary\b)/.test(literal)) {
			continue;
		}
		const failures = failuresIn(literal);
		count += failures.length;
		if (file && failures.length) {
			const line = source.slice(0, m.index).split("\n").length;
			for (const f of failures) {
				details.push(
					`${file}:${line} ${f.theme} ${f.token} | ${literal}`,
				);
			}
		}
	}
	return count;
}

function walk(dir: string, out: string[] = []): string[] {
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			if (
				entry.name === "node_modules" ||
				entry.name === "__tests__" ||
				entry.name === "marketing" ||
				entry.name === "(marketing)"
			) {
				continue;
			}
			walk(full, out);
			continue;
		}
		if (
			!/\.tsx?$/.test(entry.name) ||
			/\.(test|spec|stories)\./.test(entry.name)
		) {
			continue;
		}
		out.push(full);
	}
	return out;
}

const found = new Map<string, number>();
for (const root of SEARCH_ROOTS) {
	for (const file of walk(resolve(webRoot, root))) {
		const name = relative(webRoot, file).split(sep).join("/");
		const count = countFile(readFileSync(file, "utf8"), name);
		if (count > 0) {
			found.set(name, count);
		}
	}
}

describe("coloured text contrast ratchet", () => {
	it("read the palette", () => {
		// Guards the guard: a palette that failed to parse would make every
		// colour unknown and every count zero.
		expect(palette.size).toBeGreaterThan(200);
	});

	it.each([
		// The ticket's own failures.
		['"text-emerald-600"', 1],
		['"text-amber-600 dark:text-amber-400"', 1],
		// A tinted badge is measured on its tint, opacity included.
		['"bg-amber-500/10 text-amber-700 dark:text-amber-400"', 1],
		['"bg-amber-500/10 text-amber-800 dark:text-amber-400"', 0],
		// Light-safe but unpaired: emerald-700 paints dark mode too.
		['"text-emerald-700"', 1],
		['"text-emerald-700 dark:text-emerald-400"', 0],
		// A non-chromatic dark override counts as an override.
		['"text-emerald-700 dark:text-foreground"', 0],
		// A light chip with no dark fill stays a light chip in dark mode.
		['"bg-green-100 text-green-800"', 0],
		// ...while a token fill turns dark.
		['"bg-card text-green-800"', 1],
		// An always-dark panel.
		['"bg-zinc-900 text-green-400"', 0],
		// A state colour outranks the plain dark one.
		['"text-red-700 hover:text-red-800 dark:text-red-400"', 1],
		[
			'"text-red-700 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"',
			0,
		],
		// ...unless the hover paints its own light fill in both themes.
		['"text-destructive hover:text-red-700 hover:bg-red-50"', 0],
		// A dark hover fill under the light hover colour is the real failure.
		[
			'"text-destructive hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950"',
			1,
		],
		// The primary ink on a tint of itself, and the ink meant for it.
		['"bg-primary/[0.12] dark:bg-primary/[0.20] text-primary"', 1],
		['"bg-primary/[0.12] dark:bg-primary/[0.20] text-primary-active"', 0],
		['"bg-primary/15 text-primary"', 1],
		['"text-primary"', 0],
		['"hover:bg-primary/10 hover:text-primary"', 1],
		// Hyphenated token names are read too: the active ink is for a wash,
		// not for the solid fill it is a shade of.
		['"bg-primary text-primary-active"', 1],
		['"bg-primary/10 dark:text-primary-active text-primary-active"', 0],
		// Large text needs 3:1.
		['"text-2xl text-yellow-700 dark:text-yellow-600"', 0],
		['"text-sm text-yellow-700 dark:text-yellow-600"', 1],
		// A fill this file cannot price is not guessed at.
		['"bg-brand/10 text-emerald-600 dark:text-emerald-400"', 0],
	] as const)("counts %s as %i", (source, expected) => {
		expect(countFile(source)).toBe(expected);
	});

	it("finds no low-contrast coloured text outside the listed files", () => {
		const unlisted = [...found.keys()].filter((file) => !(file in CEILING));
		expect(
			unlisted,
			"new coloured text under AA — use a darker shade, and a dark: one",
		).toEqual([]);
	});

	for (const [file, ceiling] of Object.entries(CEILING)) {
		it(`${file} stays at ${ceiling}`, () => {
			const count = found.get(file) ?? 0;
			expect(
				count,
				count > ceiling
					? "new coloured text under AA — use a darker shade, and a dark: one"
					: "fewer than the ceiling: lower it to the new count",
			).toBe(ceiling);
		});
	}

	it("writes the current counts when asked", () => {
		// `COLOURED_TEXT_CEILING_OUT=<file>` writes the map this file pins, for
		// lowering the ceiling after a fix.
		const out = process.env.COLOURED_TEXT_CEILING_OUT;
		if (out) {
			writeFileSync(
				out,
				JSON.stringify(
					Object.fromEntries([...found].sort()),
					null,
					"\t",
				),
			);
			writeFileSync(`${out}.details`, details.join("\n"));
		}
		expect(found.size).toBeGreaterThan(0);
	});
});
