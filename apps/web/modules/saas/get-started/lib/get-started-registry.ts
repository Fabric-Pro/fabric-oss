import { config } from "@repo/config";
import {
	BarChart3Icon,
	BotIcon,
	BrainCircuitIcon,
	CalendarDaysIcon,
	ClipboardCheckIcon,
	ClipboardListIcon,
	CombineIcon,
	CreditCardIcon,
	FileTextIcon,
	FolderIcon,
	FolderKanbanIcon,
	HeartPulseIcon,
	HomeIcon,
	KeyIcon,
	LayersIcon,
	LayoutDashboardIcon,
	LinkIcon,
	LockIcon,
	MapIcon,
	MegaphoneIcon,
	NetworkIcon,
	NewspaperIcon,
	PenToolIcon,
	PlugIcon,
	ReceiptIcon,
	RocketIcon,
	ScrollTextIcon,
	ServerIcon,
	SettingsIcon,
	ShieldCheckIcon,
	SparklesIcon,
	Users2Icon,
	WorkflowIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { anchorForProjectTab, type ProjectTabId } from "./tour-steps";

/**
 * Single source of truth for the "Get started" drawer — a flag-aware overview
 * of every area of Fabric and its components. This is the SELF-DOCUMENTING
 * registry: the drawer, and the drift-guard test, both read it, so the guide
 * stays honest as the product changes.
 *
 * ── Keeping this up to date (enforced by CI) ──────────────────────────────
 * When you add / rename / remove a nav destination, project tab, or settings
 * page, update the matching entry here (and, for a "Show me" spotlight, its
 * `data-onboarding-target` anchor on the live component). Gate anything a
 * feature flag can hide with `enabled`. `drift.test.ts` fails when an item's
 * anchor no longer exists or a required area loses coverage. See the
 * "Get Started upkeep" rule in CLAUDE.md / AGENTS.md.
 */

// ── Build-time feature-flag resolution ────────────────────────────────────
// Opt-in flags (default OFF) use literal env reads so Next.js can inline them.
const ATLAS_ENABLED =
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_ATLAS === "true" ||
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_CODE_UNDERSTANDING === "true";
const TEST_CASES_ENABLED =
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES === "true";
const PUBLISHING_SUITE_ENABLED =
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE === "true";
const PROMPTS_ENABLED = config.prompts.enabled;
const ACCOUNT_BILLING_ENABLED = config.users.enableBilling;

export type GsContext = "workspace" | "project" | "settings";

/** Which workspace an item applies to (settings differ personal vs org). */
type GsScope = "both" | "personal" | "org";

type GsHrefContext = {
	basePath: string;
	projectId?: string | null;
};

export type GsItem = {
	/** Stable id (used for progress + drift test). */
	id: string;
	label: string;
	/** Smart, short, value-focused (best practice: keep it to a sentence). */
	description: string;
	icon: ComponentType<{ className?: string }>;
	/** false → hidden because a feature flag turns the component off. */
	enabled?: boolean;
	/** Hide unless the signed-in user has this role. */
	requiresRole?: "admin";
	/** Only show in this workspace context. */
	scope?: GsScope;
	/** `data-onboarding-target` to spotlight for "Show me" (workspace items). */
	anchor?: string;
	/** Project tab id — deep-links + spotlights the tab (project items). */
	projectTab?: ProjectTabId;
	/** Builds the "Open / Configure" destination. */
	href?: (ctx: GsHrefContext) => string;
	/** Sub-group label (used to cluster the Settings section). */
	cluster?: string;
};

export type GsGroup = {
	id: string;
	context: GsContext;
	label: string;
	intro: string;
	items: GsItem[];
};

// ── Workspace navigation ──────────────────────────────────────────────────
const WORKSPACE_GROUP: GsGroup = {
	id: "workspace",
	context: "workspace",
	label: "Get around Fabric",
	intro: "The main areas in the sidebar — what each one is for.",
	items: [
		{
			id: "home",
			label: "Home",
			description:
				"Your dashboard — recent activity, key metrics, and quick actions across every project and agent.",
			icon: HomeIcon,
			anchor: "nav-home",
			href: ({ basePath }) => basePath,
		},
		{
			id: "nexus",
			label: "Fabric AI",
			description:
				"Your always-on AI assistant — plan work, draft specs, and answer questions about your projects. The same conversation the floating button opens, as a full page.",
			icon: SparklesIcon,
			anchor: "nav-nexus",
			href: ({ basePath }) => `${basePath}/agents/fabric-ai`,
		},
		{
			id: "prompts",
			label: "Prompts",
			description:
				"A reusable library of prompts you and your team can save, share, and run.",
			icon: FileTextIcon,
			enabled: PROMPTS_ENABLED,
			anchor: "nav-prompts",
			href: ({ basePath }) => `${basePath}/prompts`,
		},
		{
			id: "projects",
			label: "Projects",
			description:
				"Each project is a workspace for one initiative — its docs, roadmap, agents, and code map live together.",
			icon: FolderKanbanIcon,
			anchor: "nav-projects",
			href: ({ basePath }) => `${basePath}/projects`,
		},
		{
			id: "agents",
			label: "AI Agents",
			description:
				"Build and manage AI agents, plus the Skills and Templates that extend what they can do. Fabric Loom is the full-page agent chat — the same conversation the floating button opens.",
			icon: BotIcon,
			anchor: "nav-agents",
			href: ({ basePath }) => `${basePath}/agents`,
		},
		{
			id: "workflows",
			label: "Workflows",
			description:
				"Design multi-step automations that chain agents, tools, and approvals together.",
			icon: WorkflowIcon,
			anchor: "nav-workflows",
			href: ({ basePath }) => `${basePath}/workflows`,
		},
		{
			id: "integrations",
			label: "Integrations",
			description:
				"Connect the tools Fabric works with — GitHub/GitLab, Jira, Teams, Slack, and more.",
			icon: PlugIcon,
			anchor: "nav-integrations",
			href: ({ basePath }) => `${basePath}/settings/integrations`,
		},
		{
			id: "workspaces",
			label: "Workspaces",
			description:
				"Group documents and context into shared spaces your team and agents can draw on.",
			icon: LayersIcon,
			anchor: "nav-workspaces",
			href: ({ basePath }) => `${basePath}/workspaces`,
		},
		{
			id: "mcp-servers",
			label: "MCP Servers",
			description:
				"Register Model Context Protocol servers to give agents new tools and data sources.",
			icon: ServerIcon,
			anchor: "nav-mcp-servers",
			href: ({ basePath }) => `${basePath}/mcp-servers`,
		},
		{
			id: "reports",
			label: "Reports",
			description:
				"Turn project activity into recurring summaries and AI-assisted check-ins from report templates.",
			icon: ClipboardListIcon,
			anchor: "nav-reports",
			href: ({ basePath }) => `${basePath}/report-templates`,
		},
		{
			id: "system-health",
			label: "System Health",
			description:
				"Check live platform status and whether a problem is on our side or yours, without waiting on support.",
			icon: HeartPulseIcon,
			anchor: "nav-system-health",
			href: ({ basePath }) => `${basePath}/system-health`,
		},
	],
};

// ── Inside a project ──────────────────────────────────────────────────────
const projectHref = (tab: string) => (ctx: GsHrefContext) =>
	`${ctx.basePath}/projects/${ctx.projectId}?tab=${tab}`;

const PROJECT_GROUP: GsGroup = {
	id: "project",
	context: "project",
	label: "Inside a project",
	intro: "Every tab in a project and what it does.",
	items: [
		{
			id: "overview",
			label: "Overview",
			description:
				"Mission control — a snapshot of the project's scope, goals, and how ready it is to ship.",
			icon: LayoutDashboardIcon,
			projectTab: "overview",
			anchor: anchorForProjectTab("overview"),
			href: projectHref("overview"),
		},
		{
			id: "daily-brief",
			label: "Daily Brief",
			description:
				"An auto-generated digest of what changed — commits, docs, features, meetings — over your chosen window.",
			icon: NewspaperIcon,
			projectTab: "daily-brief",
			anchor: anchorForProjectTab("daily-brief"),
			href: projectHref("daily-brief"),
		},
		{
			id: "meeting-digest",
			label: "Meeting Digest",
			description:
				"Sync meeting transcripts and get AI summaries and action items you can turn into work.",
			icon: CalendarDaysIcon,
			projectTab: "meeting-digest",
			anchor: anchorForProjectTab("meeting-digest"),
			href: projectHref("meeting-digest"),
		},
		{
			id: "release-notes",
			label: "Release Notes",
			description:
				"AI-curated, newsletter-style summaries of the major features shipped in this project.",
			icon: RocketIcon,
			projectTab: "release-notes",
			anchor: anchorForProjectTab("release-notes"),
			href: projectHref("release-notes"),
		},
		{
			id: "documents",
			label: "Documents",
			description:
				"One home for source docs, AI-generated specs, and editable working artifacts kept in sync.",
			icon: FileTextIcon,
			projectTab: "documents",
			anchor: anchorForProjectTab("documents"),
			href: projectHref("documents"),
		},
		{
			id: "decisions",
			label: "Decisions",
			description:
				"A living decision log — capture, endorse, and pin key project decisions, with AI suggestions.",
			icon: ScrollTextIcon,
			projectTab: "decisions",
			anchor: anchorForProjectTab("decisions"),
			href: projectHref("decisions"),
		},
		{
			id: "context",
			label: "Context",
			description:
				"Reference material — files, links, notes, integrations — that grounds AI recommendations.",
			icon: FolderIcon,
			projectTab: "context",
			anchor: anchorForProjectTab("context"),
			href: projectHref("context"),
		},
		{
			id: "pipeline",
			label: "Pipeline",
			description:
				"Move from product intent to generated technical docs, then push the feature structure into the roadmap.",
			icon: WorkflowIcon,
			projectTab: "pipeline",
			anchor: anchorForProjectTab("pipeline"),
			href: projectHref("pipeline"),
		},
		{
			id: "roadmap",
			label: "Roadmap",
			description:
				"Track features and tasks through delivery stages, spot bottlenecks, and sync to your PM tool. Switch to the Priority view for a shared, scored worklist with a full history of every priority change.",
			icon: MapIcon,
			projectTab: "stories",
			anchor: anchorForProjectTab("stories"),
			href: projectHref("stories"),
		},
		{
			id: "test-cases",
			label: "Testing",
			description:
				"Draft test cases with ordered steps, group them into plans, link them to the work they verify, and read what CI reported back.",
			icon: ClipboardCheckIcon,
			enabled: TEST_CASES_ENABLED,
			projectTab: "test-cases",
			anchor: anchorForProjectTab("test-cases"),
			href: projectHref("test-cases"),
		},
		{
			id: "publishing-suite",
			label: "Publishing Suite",
			description:
				"Fabric surfaces publishing topics from your project's work — triage them here or add your own.",
			icon: MegaphoneIcon,
			enabled: PUBLISHING_SUITE_ENABLED,
			projectTab: "publishing-suite",
			anchor: anchorForProjectTab("publishing-suite"),
			href: projectHref("publishing-suite"),
		},
		{
			id: "weave",
			label: "Weave",
			description:
				"Multi-agent orchestration — plan work, delegate to specialized agents, and track it with checkpoints.",
			icon: CombineIcon,
			projectTab: "weave",
			anchor: anchorForProjectTab("weave"),
			href: projectHref("weave"),
		},
		{
			id: "coding-agents",
			label: "Coding Agents",
			description:
				"Run local AI coding agents from your repo — they pick up features and sync progress back to Fabric.",
			icon: BotIcon,
			projectTab: "kanban",
			anchor: anchorForProjectTab("kanban"),
			href: projectHref("kanban"),
		},
		{
			id: "agent-activity",
			label: "Agent Activity",
			description:
				"An audit feed of human-approved Fabric Agent actions across the project.",
			icon: BotIcon,
			projectTab: "agent-activity",
			anchor: anchorForProjectTab("agent-activity"),
			href: projectHref("agent-activity"),
		},
		{
			id: "diagrams",
			label: "Diagrams",
			description:
				"Create and manage Excalidraw canvases, including diagrams auto-inserted from chat.",
			icon: PenToolIcon,
			projectTab: "diagrams",
			anchor: anchorForProjectTab("diagrams"),
			href: projectHref("diagrams"),
		},
		{
			id: "project-reports",
			label: "Reports",
			description:
				"Turn this project's activity into recurring summaries and snapshots you can revisit over time.",
			icon: ClipboardListIcon,
			projectTab: "reports",
			anchor: anchorForProjectTab("reports"),
			href: projectHref("reports"),
		},
		{
			id: "usage",
			label: "Usage",
			description:
				"AI token and cost usage for this project, including own-key usage Fabric doesn't bill.",
			icon: ReceiptIcon,
			projectTab: "usage",
			anchor: anchorForProjectTab("usage"),
			href: projectHref("usage"),
		},
		{
			id: "atlas",
			label: "Atlas",
			description:
				"Map and explore your codebase — modules and dependencies (technical) and capabilities (business).",
			icon: NetworkIcon,
			enabled: ATLAS_ENABLED,
			projectTab: "atlas",
			anchor: anchorForProjectTab("atlas"),
			href: projectHref("atlas"),
		},
		{
			id: "security",
			label: "Security & Accessibility",
			description:
				"Run AI scans against OWASP Top 10 and WCAG 2.1 AA, gate risky changes, and triage findings.",
			icon: ShieldCheckIcon,
			projectTab: "security",
			anchor: anchorForProjectTab("security"),
			href: projectHref("security"),
		},
		{
			id: "project-settings",
			label: "Project Settings",
			description:
				"Configure the project — details, PM/integration credentials, context import, deployment environments, the QA testing policy (including which branch each repo's CI results come from), and danger zone.",
			icon: SettingsIcon,
			projectTab: "settings",
			anchor: anchorForProjectTab("settings"),
			href: projectHref("settings"),
		},
	],
};

// ── Configure Fabric (Settings) ───────────────────────────────────────────
const settingsHref = (page: string) => (ctx: GsHrefContext) =>
	`${ctx.basePath}/settings/${page}`;

const SETTINGS_GROUP: GsGroup = {
	id: "settings",
	context: "settings",
	label: "Configure Fabric",
	intro: "Set up your account and workspace. Each item opens the page where you configure it.",
	items: [
		{
			id: "settings-general",
			label: "General",
			description:
				"Your profile — name, avatar, and account basics (org name, logo, and slug in an organization).",
			icon: SettingsIcon,
			cluster: "Account & profile",
			href: settingsHref("general"),
		},
		{
			id: "settings-security",
			label: "Security",
			description:
				"Password, passkeys, two-factor authentication, and your active sessions.",
			icon: LockIcon,
			cluster: "Account & profile",
			scope: "personal",
			href: settingsHref("security"),
		},
		{
			id: "settings-members",
			label: "Members",
			description:
				"Invite teammates, manage roles, and handle pending invitations for your organization.",
			icon: Users2Icon,
			cluster: "Account & profile",
			scope: "org",
			href: settingsHref("members"),
		},
		{
			id: "settings-ai-providers",
			label: "AI Providers",
			description:
				"Connect LLM providers and API keys (OpenAI, Anthropic, Azure, and more).",
			icon: BrainCircuitIcon,
			cluster: "AI configuration",
			href: settingsHref("ai-providers"),
		},
		{
			id: "settings-ai-models",
			label: "AI Models",
			description:
				"Choose the default model for each AI task so every feature uses the right one.",
			icon: SparklesIcon,
			cluster: "AI configuration",
			href: settingsHref("ai-models"),
		},
		{
			id: "settings-integrations",
			label: "Integrations",
			description:
				"Connect GitHub/GitLab, Jira, Teams, Slack and other tools, and check their health.",
			icon: PlugIcon,
			cluster: "Tools & connections",
			href: settingsHref("integrations"),
		},
		{
			id: "settings-mcp",
			label: "MCP Registry",
			description:
				"Register Model Context Protocol servers that give agents extra tools and data.",
			icon: ServerIcon,
			cluster: "Tools & connections",
			href: settingsHref("mcp"),
		},
		{
			id: "settings-openapi",
			label: "OpenAPI Services",
			description:
				"Register OpenAPI/REST services so agents can call them as tools.",
			icon: LinkIcon,
			cluster: "Tools & connections",
			href: settingsHref("openapi"),
		},
		{
			id: "settings-api-keys",
			label: "API Keys",
			description:
				"Create and revoke Fabric API keys for programmatic access.",
			icon: KeyIcon,
			cluster: "Tools & connections",
			href: settingsHref("api-keys"),
		},
		{
			id: "settings-billing",
			label: "Billing",
			description: "Manage your subscription, plan, and payment details.",
			icon: CreditCardIcon,
			cluster: "Billing & usage",
			scope: "personal",
			enabled: ACCOUNT_BILLING_ENABLED,
			href: settingsHref("billing"),
		},
		{
			id: "settings-usage",
			label: "AI Usage",
			description:
				"Track AI token and cost usage, and manage usage limits.",
			icon: BarChart3Icon,
			cluster: "Billing & usage",
			href: settingsHref("usage"),
		},
		{
			id: "settings-audit-log",
			label: "Audit Log",
			description:
				"Review a tamper-evident trail of security-relevant events (admins in an organization).",
			icon: ScrollTextIcon,
			cluster: "Admin & records",
			href: settingsHref("audit-log"),
		},
	],
};

export const GET_STARTED_GROUPS: readonly GsGroup[] = [
	WORKSPACE_GROUP,
	PROJECT_GROUP,
	SETTINGS_GROUP,
];

/** Areas the drawer MUST always document (drift test asserts coverage). */
export const GET_STARTED_REQUIRED_GROUPS: readonly GsContext[] = [
	"workspace",
	"project",
	"settings",
];

/** All `data-onboarding-target` anchors the registry depends on (drift test). */
export function registryAnchors(): string[] {
	const ids = new Set<string>();
	for (const group of GET_STARTED_GROUPS) {
		for (const item of group.items) {
			if (item.anchor) {
				ids.add(item.anchor);
			}
		}
	}
	return [...ids];
}

// ── Per-page detailed tours ────────────────────────────────────────────────
// Each covered project page has its own mini-tour that spotlights the real
// in-page components (not just the tab). These drive the "Tour this page"
// action in the drawer and the first-visit auto-open. Copy is inline (like the
// drawer descriptions) so ad-hoc spotlight steps render without i18n keys.

/** An in-page component the detailed page tour spotlights. */
type GsPageComponent = {
	id: string;
	/** `data-onboarding-target` on the live component. */
	anchor: string;
	title: string;
	body: string;
	/**
	 * Rendered only in some states (e.g. a button that appears when proposals
	 * exist). The mini-tour skips it when the anchor isn't in the DOM.
	 */
	conditional?: boolean;
};

/** A covered page and the components its detailed tour walks through. */
export type GsPage = {
	/**
	 * Page id — a project tab id (`overview`, `security`, …) or a top-level app
	 * page id (`agents`, `prompts`, `settings`, …). Matched by `pageForTab`
	 * and the `getStartedPageId` header prop.
	 */
	tab: string;
	/** True for top-level app/sidebar pages (not a project tab). */
	app?: boolean;
	label: string;
	icon: ComponentType<{ className?: string }>;
	/** Gate the whole page tour behind a feature flag. */
	enabled?: boolean;
	/**
	 * ISO date the page's tour was introduced. A page added AFTER
	 * `ONBOARDING_PAGE_BASELINE` auto-opens once for EXISTING users too — not
	 * just the new-account cohort — so a new feature announces itself. Omit it
	 * for the original rollout pages; existing users reach those via the Compass.
	 */
	since?: string;
	components: readonly GsPageComponent[];
};

export const GET_STARTED_PAGES: readonly GsPage[] = [
	{
		tab: "overview",
		label: "Overview",
		icon: LayoutDashboardIcon,
		components: [
			{
				id: "overview-readiness",
				anchor: "overview-readiness",
				title: "Delivery readiness",
				body: "Not a vanity score — it tracks how many of the six core planning docs are complete. When this bar fills, the AI and the Pipeline finally have enough to build from.",
			},
			{
				id: "overview-metrics",
				anchor: "overview-metrics",
				title: "What the AI has to work with",
				body: "These four counts are the raw material behind every generated doc and roadmap item. A low Context number is usually why AI output feels thin — top it up in the Context tab.",
			},
			{
				id: "overview-pipeline",
				anchor: "overview-pipeline",
				title: "Your planning checklist",
				body: "The six artifacts a project needs before build — PRD, tech spec, frontend, backend, security, implementation plan. Each gap here is exactly what the Pipeline tab fills in.",
			},
		],
	},
	{
		tab: "documents",
		label: "Documents",
		icon: FileTextIcon,
		components: [
			{
				id: "documents-create",
				anchor: "documents-create",
				title: "Draft a doc with AI",
				body: "Pick a typed kind (PRD, architecture, tech spec, API spec…) — Generate with AI starts on by default, drafting from a type-scoped prompt plus any instructions you add. Paste in source text to steer the draft, or use it verbatim instead. No AI configured? A title alone still creates it.",
			},
			{
				id: "documents-list",
				anchor: "documents-list",
				title: "Versioned, exportable, non-destructive",
				body: "Each card exports to Markdown/PDF/DOCX, renames inline, and regenerates without losing the old version. The rule that matters: only the one 'Active' doc per type flows into the Pipeline and the AI.",
				conditional: true,
			},
		],
	},
	{
		tab: "stories",
		label: "Roadmap",
		icon: MapIcon,
		components: [
			{
				id: "roadmap-ai-update",
				anchor: "roadmap-ai-update",
				title: "AI Update — restructure in plain English",
				body: "Say 'split the auth feature into three and add rate-limiting tasks' and it drafts the change — never applied silently: you review, approve, and can cancel mid-apply. It can even build the update from what was discussed in linked meetings and channels.",
			},
			{
				id: "roadmap-add",
				anchor: "roadmap-add",
				title: "One Add button, on purpose",
				body: "You don't pre-sort work — an AI classifier reads what you type and decides Bug vs Feature for you. (Backend still models these as features and tasks, shown as F-XXX.)",
			},
			{
				id: "roadmap-priority",
				anchor: "roadmap-priority",
				title: "Priority — what to work on next",
				body: "The roadmap has two views. 'Work items' is your full list; 'Priority' is a shared, scored worklist of the same items, with blockers and open questions surfaced inline. 'Re-prioritize' asks the AI to re-assess every item's P0–P3 band together and writes back only what it actually moves — over the whole roadmap, or, when filters are on, whichever set you choose. The sparkle beside any priority control does the same for a single item on its own, without weighing the rest of the list. You can override any priority by hand with a comment, and every change is kept in a per-item history — so you can always see who changed it, when and why. Priority lives in Fabric and is never pushed to your PM tool.",
			},
			{
				id: "roadmap-board",
				anchor: "roadmap-board",
				title: "A two-way board, not just a Kanban",
				body: "Dragging a card between stages syncs its status out to your PM tool (Jira/GitLab/ADO); 'Pull' brings changes back. Switch Table/Board/Plain views, save your own layout, and 'Scan for duplicates' semantically merges overlaps.",
			},
			{
				id: "roadmap-review-proposals",
				anchor: "roadmap-review-proposals",
				title: "Your approval inbox",
				body: "Roadmap changes proposed automatically — chiefly by the monitor watching your linked Teams/Slack channels — queue here. Nothing reaches the board until you approve it; the amber count means decisions are waiting.",
				conditional: true,
			},
		],
	},
	{
		tab: "security",
		label: "Security & Accessibility",
		icon: ShieldCheckIcon,
		components: [
			{
				id: "security-run-scan",
				anchor: "security-run-scan",
				title: "Run a scan",
				body: "A split button: the primary click runs an incremental scan (only what changed since last time); the dropdown does a full re-analysis or purges findings. It stays disabled until you enable at least one engine below.",
			},
			{
				id: "security-scan-config",
				anchor: "security-scan-config",
				title: "Four engines — including your specs",
				body: "Two AI reviewers read your features and docs against the OWASP Top 10 and WCAG 2.1 AA — flagging insecure design before code exists — while Semgrep scans connected-repo code and gitleaks scans git history for leaked secrets. Switch on 'Block' to auto-gate the work items a finding touches.",
			},
			{
				id: "security-results",
				anchor: "security-results",
				title: "Triage, don't just read",
				body: "Each finding carries severity, the rule that fired, and a fix — and an AI reviewer reversibly auto-dismisses likely false positives. Turn a real one into a work-item block in a click; secrets are redacted before they're ever stored.",
			},
		],
	},
	{
		tab: "context",
		label: "Context",
		icon: FolderIcon,
		components: [
			{
				id: "context-add",
				anchor: "context-add",
				title: "This is the AI's memory",
				body: "Not just file uploads — pull from Teams, Slack, Notion, Confluence and Google Docs, or point the Link tab at a docs site and crawl the whole thing (up to 500 pages) on a refresh cadence. Everything here is what the AI retrieves and cites.",
			},
			{
				id: "context-readiness",
				anchor: "context-readiness",
				title: "Watch for 'Embedded'",
				body: "A source only helps the AI once it's been extracted and embedded — not the moment it's uploaded. These counts track that pipeline live and self-refresh, so wait for Ready before expecting grounded output.",
			},
			{
				id: "context-summary",
				anchor: "context-summary",
				title: "Compressed project memory",
				body: "As context piles up, Fabric compresses the older history into one traceable summary — goals, decisions, constraints, and open items — that the AI reads instead of the full backlog, so prompts stay small without losing knowledge. Each point links back to its original source, and raw context is never deleted. Open it for the full read.",
				conditional: true,
			},
		],
	},
	{
		tab: "pipeline",
		label: "Pipeline",
		icon: WorkflowIcon,
		components: [
			{
				id: "pipeline-generate-docs",
				anchor: "pipeline-generate-docs",
				title: "The generation engine",
				body: "Pick which specs to generate, and per document choose a prompt template and add custom instructions — output is tunable, not one-shot. It's PRD-first: the PRD is built first, then everything runs from it (or reuses docs you already have).",
			},
			{
				id: "pipeline-features",
				anchor: "pipeline-features",
				title: "Prose becomes trackable work",
				body: "Fabric parses the generated spec into an Epic → Feature → Feature-Item breakdown with acceptance criteria — the bridge between a document and cards you can deliver. Preview the structure before you commit it.",
			},
			{
				id: "pipeline-push-roadmap",
				anchor: "pipeline-push-roadmap",
				title: "Seed the board in one move",
				body: "This creates the actual feature cards and tasks on the Roadmap — choose append or replace-all — then drops you on the board. It won't double up: it disables to 'Already Pushed'.",
				conditional: true,
			},
		],
	},
	{
		tab: "reports",
		label: "Reports",
		icon: ClipboardListIcon,
		components: [
			{
				id: "reports-browse-templates",
				anchor: "reports-browse-templates",
				title: "Templates are recipes",
				body: "A template is the shape of a report; you turn it into a running instance with a cadence — daily, weekly, monthly — so project activity becomes a scheduled AI summary that arrives on rhythm, not a one-time export.",
			},
			{
				id: "reports-tabs",
				anchor: "reports-tabs",
				title: "Instances vs templates",
				body: "'My Report Instances' are what's actually running — each shows its last run and Active/Paused state; 'Available Templates' are what you can start from. The instance is the live, scheduled thing.",
			},
		],
	},

	{
		tab: "daily-brief",
		label: "Daily Brief",
		icon: NewspaperIcon,
		components: [
			{
				id: "daily-brief-window",
				anchor: "daily-brief-window",
				title: "Each window is its own brief",
				body: "24h / 7d / 2w aren't client filters — each fetches a separately generated brief that fans out across commits, docs, features, meetings and deploys, then has AI write the summary.",
			},
			{
				id: "daily-brief-since-review",
				anchor: "daily-brief-since-review",
				title: "Your catch-up switch",
				body: "Flips every source to just what changed since you last opened the brief — it tracks a private read cursor. A real standup replacement; it unlocks after your first visit.",
			},
			{
				id: "daily-brief-priority-actions",
				anchor: "daily-brief-priority-actions",
				title: "Start here: Priority Actions",
				body: "The AI's ranked 'do these next', synthesized across every source — and deliberately never hidden by the 'since' filter, because urgency isn't a time window.",
				conditional: true,
			},
			{
				id: "daily-brief-regenerate",
				anchor: "daily-brief-regenerate",
				title: "Regenerate on demand",
				body: "Rebuild after a burst of activity instead of waiting for the next auto-run; the page then live-polls until the fresh brief is ready. (It's gently rate-limited.)",
			},
		],
	},
	{
		tab: "meeting-digest",
		label: "Meeting Digest",
		icon: CalendarDaysIcon,
		components: [
			{
				id: "meeting-digest-header",
				anchor: "meeting-digest-header",
				title: "Meetings become tracked work",
				body: "AI reads each synced Teams transcript and pulls out decisions, action items and open questions — so nobody re-watches a recording. Decisions flow into your Decisions log; action items become tasks.",
			},
			{
				id: "meeting-digest-configure",
				anchor: "meeting-digest-configure",
				title: "Choose what's analyzed",
				body: "Pick which meeting series feed the digest. A series can be included but still say 'no transcripts yet' until Fabric's scheduled sync pulls one — inclusion isn't instant.",
				conditional: true,
			},
			{
				id: "meeting-digest-view-toggle",
				anchor: "meeting-digest-view-toggle",
				title: "Calendar vs Agenda",
				body: "Month is a heatmap of where meetings landed; Agenda is the working feed — day-grouped decisions and check-off-able action items, each meeting showing how many tasks it spawned.",
				conditional: true,
			},
		],
	},
	{
		tab: "release-notes",
		label: "Release Notes",
		icon: RocketIcon,
		components: [
			{
				id: "release-notes-panel",
				anchor: "release-notes-panel",
				title: "An auto-published newsletter",
				body: "Not a static changelog — each row is a release newsletter AI writes from what shipped and actually sends to your team. 'Being prepared…' rows are still generating; click any to read the full notes.",
			},
			{
				id: "release-notes-settings",
				anchor: "release-notes-settings",
				title: "Set up the delivery loop",
				body: "The gear is where the value lives: who receives it (email subscribers or a Teams/Slack channel), how often, and how detailed — Brief, Standard or Detailed. You can even embed it as a public widget.",
				conditional: true,
			},
		],
	},
	{
		tab: "decisions",
		label: "Decisions",
		icon: ScrollTextIcon,
		components: [
			{
				id: "decisions-header",
				anchor: "decisions-header",
				title: "A constraint set the AI obeys",
				body: "This isn't a doc — an Accepted decision becomes a binding rule the AI plans around, and a Rejected one is never re-proposed. The (i) by the title explains how; there's a Markdown export too.",
			},
			{
				id: "decisions-meeting-candidates",
				anchor: "decisions-meeting-candidates",
				title: "Decisions caught from meetings",
				body: "AI spots decisions in recent meeting transcripts and queues them here — review the side-by-side, and nothing is saved until you accept. The transcript-to-record pipeline, automated.",
				conditional: true,
			},
			{
				id: "decisions-new",
				anchor: "decisions-new",
				title: "Capture the 'why'",
				body: "Record context, the decision, and alternatives so the reasoning is permanent — then set its status, since status is what tells the AI whether to treat it as binding.",
				conditional: true,
			},
			{
				id: "decisions-status-tabs",
				anchor: "decisions-status-tabs",
				title: "Status changes AI behavior",
				body: "More than a filter: Accepted / Rejected / Superseded each steer the AI differently (see the Legend). Endorse and Pin add weight to the ones that matter most.",
				conditional: true,
			},
		],
	},
	{
		tab: "test-cases",
		label: "Testing",
		icon: ClipboardCheckIcon,
		enabled: TEST_CASES_ENABLED,
		components: [
			{
				id: "test-cases-health",
				anchor: "test-cases-health",
				title: "The three numbers that matter",
				body: 'How big the suite is, how much of it passes, and how much of it runs without a person.\n\nPassing is measured over cases that actually have a verdict — passed plus failed plus blocked — NOT over the total. Over the total, a project with 200 cases where 10 have run and all 10 passed would report "5% passing", which reads as a catastrophe rather than as "barely started". The bar beside it splits those verdicts so you can see whether the misses are failures or blockages.\n\nAutomation counts only cases that are marked automated AND carry a real automation reference, so intent recorded without a link cannot inflate it. It turns amber when it falls under the coverage target set in Settings ▸ Testing ▸ Confidence & coverage.\n\nEvery figure describes the whole filtered set, not the page on screen — so narrowing the table changes them, but paging through it does not. Hover any of them for the underlying counts.',
			},
			{
				id: "test-cases-segment",
				anchor: "test-cases-segment",
				title: "Six views of the same suite — and when to switch",
				body: 'These are not six features; they are six angles on one body of work, and each one answers a question the others cannot.\n\nStart at CASES when you know what you are looking for — it is the full table, one row per test, with the filters and the sort. Move to COVERAGE when you want the opposite question: not "what have we written" but "what have we missed". It lists work items with no case at all, and its badge counts the gap rather than the total, so it falls as you close it. Pick a feature there and it drops you back on Cases, filtered to that feature — the two tabs are meant to be used in a loop.\n\nPLANS is for when "run everything" is the wrong answer: a smoke set, a release checklist. A plan references cases rather than copying them, so editing a case updates every plan holding it. RUNS is the execution history from both sources — Fabric\'s own runs and whatever your CI reported — and it is where a failure becomes a finding someone can triage. PULL REQUESTS holds the diffs Fabric has read, so you can see what a review would be based on. QUESTIONS collects the ambiguities raised while drafting, so the thing actually blocking coverage is visible without opening every case; its badge counts only the open ones.\n\nEvery tab remembers its place in the address bar, so moving between them and pressing Back does what you expect. Hover any tab to see this again for that one.',
			},
			{
				id: "test-cases-attention",
				anchor: "test-cases-attention",
				title: "Start with what is broken",
				body: "Four one-press filters, in the order worth acting on them.\n\nFAILING is a known defect — the last run said so. BLOCKED could not reach a verdict at all: a broken environment, missing data, a dependency that never came up. That distinction matters, because blocked proves nothing in either direction while failing proves something is wrong. AWAITING REVIEW is cases an adversarial AI reviewer proposed that nobody has ruled on; accepting moves one to Draft, rejecting closes it, and either way it stays on the record rather than vanishing. NEVER RUN is the quiet one — an untested case looks exactly like a passing one in every total except this chip.\n\nEach chip is a real server-side query, so pressing it takes you to a page of exactly those cases rather than highlighting a few on the page you happened to be on. A chip only appears when its count is above zero: an invitation to a guaranteed-empty list is worse than no invitation. Pressing a second chip replaces the first rather than compounding with it, so you cannot accidentally filter your way to nothing.",
				conditional: true,
			},
			{
				id: "test-cases-about",
				anchor: "test-cases-about",
				title: "What am I looking at?",
				body: "Every tab explains itself here — what belongs in it, and what it deliberately does not do, which is usually the part that saves you looking in the wrong place. It describes whichever tab is selected, so it changes as you move along the bar.",
			},
			{
				id: "test-cases-generate-ai",
				anchor: "test-cases-generate-ai",
				title: "Draft from acceptance criteria",
				body: "This doesn't invent tests — it reads a feature's acceptance criteria and drafts editable cases with steps from them. Write good ACs on the roadmap, then generate the coverage here.",
				conditional: true,
			},
			{
				id: "test-cases-untracked",
				anchor: "test-cases-untracked",
				title: "Tests CI runs that Fabric isn't tracking",
				body: "When a pipeline reports a test that matches no case here, it still counts as work your suite does but your coverage numbers ignore. This list collects those, failing ones first, and creating a case from a row seeds it with that test's own name and file so the next sync links them automatically. It disappears once nothing is untracked.",
				conditional: true,
			},
			{
				id: "test-cases-new",
				anchor: "test-cases-new",
				title: "Author, then sync out",
				body: "Add a manual case with ordered steps and mark run results inline, then bulk-sync to your PM tool — but only tools that hold native test cases (Azure DevOps, Xray, Zephyr) accept them, which is why Sync sometimes greys out.",
				conditional: true,
			},
			{
				id: "test-cases-pagination",
				anchor: "test-cases-pagination",
				title: "A view you can send to someone",
				body: "Filters, sort and page all live in the address bar, so this exact view is a link — paste it into a ticket and the other person lands on the same rows. It also means Back works: open a case, press Back, and your filters are still there rather than reset to an unfiltered first page.",
				conditional: true,
			},
		],
	},
	{
		tab: "publishing-suite",
		label: "Publishing Suite",
		icon: MegaphoneIcon,
		enabled: PUBLISHING_SUITE_ENABLED,
		since: "2026-07-13T00:00:00.000Z",
		components: [
			{
				id: "publishing-suite-list",
				anchor: "publishing-suite-list",
				title: "Topics worth writing about",
				body: "Fabric analyses your project's code changes, calls, release notes and features to surface publishing topics. Set each one's status to triage your queue.",
			},
			{
				id: "publishing-suite-inbox",
				anchor: "publishing-suite-inbox",
				title: "Two sections, not one long list",
				body: "With no filter selected the queue splits in two: Recently Modified holds what you and your team are actively working on, newest first and capped at three so it stays a shortlist, and Suggested holds everything Fabric has surfaced that nobody has picked up yet. Choosing a status chip swaps back to a single flat list of just that status.",
				conditional: true,
			},
			{
				id: "publishing-suite-snooze",
				anchor: "publishing-suite-snooze",
				title: "Not now, but not never",
				body: "Snoozing hides a topic from the Inbox for a week, a month or three months, and it comes back on its own when that time is up — in whichever section its status belongs to by then. It keeps its status the whole time, so snoozing something you had already started does not lose that you started it. Declining is the permanent version; this is the one you can forget about safely.",
				conditional: true,
			},
			{
				id: "publishing-suite-new",
				anchor: "publishing-suite-new",
				title: "Add your own topic",
				body: "Have something to write about that Fabric hasn't surfaced yet? Add it manually and it joins the same queue.",
				conditional: true,
			},
			{
				id: "publishing-history",
				anchor: "publishing-history",
				title: "Every refresh, not just the last one",
				body: "The list above shows the current set of topics. This table shows every refresh behind them — when each ran, whether it was scheduled or someone asked for it, how long it took and how many topics it produced. A run that failed or found nothing stays here after the next one starts, which is where you look when the list above is emptier than you expected.",
			},
		],
	},
	{
		tab: "weave",
		label: "Weave",
		icon: CombineIcon,
		components: [
			{
				id: "weave-tabs",
				anchor: "weave-tabs",
				title: "Plan, monitor, create",
				body: "Three views: your plans, a live Monitor that streams a running plan's steps as they execute, and New Plan. The hero badges tell you where a plan is awaiting review or already running.",
			},
			{
				id: "weave-new-plan",
				anchor: "weave-new-plan",
				title: "Brief the agents",
				body: "Describe a task and the Pattern agent writes a step-by-step plan, each step assigned to a specialist. 'Refine with AI' has it ask clarifying questions first — a sharper brief yields sharper steps. Linking a plan to a Feature is what unlocks cloud Background Agents.",
			},
			{
				id: "weave-plan-list",
				anchor: "weave-plan-list",
				title: "Nothing runs until you approve",
				body: "Generated plans wait in 'Pending approval' — you review, revise, or approve before a single step executes. This is the safety checkpoint on autonomous agents.",
			},
		],
	},
	{
		tab: "kanban",
		label: "Coding Agents",
		icon: BotIcon,
		components: [
			{
				id: "kanban-quickstart",
				anchor: "kanban-quickstart",
				title: "Connect your machine",
				body: "This bridges to AI coding agents running on your laptop against your real repo — not the cloud. Install the CLI and run it in embed mode from your project; the board stays empty until it's live.",
			},
			{
				id: "kanban-board",
				anchor: "kanban-board",
				title: "A live window, not server data",
				body: "Once the CLI connects, this embeds your locally-running board — agents move cards as they work on your machine and push status back to Fabric. Blank here means the CLI isn't connected yet.",
			},
		],
	},
	{
		tab: "agent-activity",
		label: "Agent Activity",
		icon: BotIcon,
		components: [
			{
				id: "agent-activity-header",
				anchor: "agent-activity-header",
				title: "The agent's audit trail",
				body: "A read-only record of what the Fabric Agent actually did here — and every entry is something a human approved. It fills in only as you use and approve agent flows; nothing lands passively.",
			},
			{
				id: "agent-activity-list",
				anchor: "agent-activity-list",
				title: "Approved actions, by type",
				body: "Each row is a signed-off action — a task created, an update drafted, a session started, a skill saved. Read it as accountability ('what did the AI do?'), not a task inbox.",
			},
		],
	},
	{
		tab: "diagrams",
		label: "Diagrams",
		icon: PenToolIcon,
		components: [
			{
				id: "diagrams-header",
				anchor: "diagrams-header",
				title: "Diagrams the AI can draw",
				body: "Excalidraw canvases for this project — but the point is the AI can generate and iterate on them from chat (they land here automatically), and the editor is checkpointed so you can roll back.",
			},
			{
				id: "diagrams-new",
				anchor: "diagrams-new",
				title: "Draw it, or ask for it",
				body: "Start a blank canvas — or just ask the AI in chat to draw the architecture or flow, and it appears in this same list.",
			},
		],
	},
	{
		tab: "usage",
		label: "Usage",
		icon: ReceiptIcon,
		components: [
			{
				id: "usage-range",
				anchor: "usage-range",
				title: "Time range",
				body: "Scopes every tile, chart, and breakdown below to 7 / 30 / 90 days or all-time.",
			},
			{
				id: "usage-summary",
				anchor: "usage-summary",
				title: "Platform spend vs your own keys",
				body: "The distinction that matters: usage on your own API keys (BYOK) runs on your account and Fabric doesn't bill it — shown separately from platform spend. Check here before worrying about a bill.",
			},
			{
				id: "usage-breakdown",
				anchor: "usage-breakdown",
				title: "Find what's burning budget",
				body: "Re-pivot spend by model, provider, task type, or agent — the fastest way to spot which agent or task is driving cost.",
			},
		],
	},
	{
		tab: "atlas",
		label: "Atlas",
		icon: NetworkIcon,
		enabled: ATLAS_ENABLED,
		components: [
			{
				id: "atlas-analyze",
				anchor: "atlas-analyze",
				title: "Map your codebase with AI",
				body: "One click runs an AI pass that reads the repo and derives two lenses over the same graph — a Business view of capabilities and a Technical view of modules and dependencies. Re-run anytime to refresh after changes.",
				conditional: true,
			},
			{
				id: "atlas-view-switch",
				anchor: "atlas-view-switch",
				title: "Three views — and a code chat",
				body: "Overview (dashboard + export), Graph (interactive, with an always-on AI chat that answers questions and links to real nodes), and System — the cross-repo map that unlocks once you've analyzed two or more connected repos.",
				conditional: true,
			},
		],
	},
	{
		tab: "settings",
		label: "Project Settings",
		icon: SettingsIcon,
		components: [
			{
				id: "project-settings-nav",
				anchor: "project-settings-nav",
				title: "This is the project's AI wiring",
				body: "Not cosmetics: Knowledge = what agents can read, Development = where they run and push code, Project Management = where roadmap work syncs to your PM tool, Retrieval = how RAG chunks it, Environments = the deployment targets automation points at, Testing = the QA policy (rigor, evidence, sceptic roles) agents follow. The green dot means an area is configured, so it doubles as a setup checklist.",
			},
			{
				id: "project-settings-content",
				anchor: "project-settings-content",
				title: "Start with Knowledge and Development",
				body: "The highest-leverage stops for a new project: connect a PRD source under Knowledge so specs and agents have ground truth, connect your repo under Development so delegation works, and connect your PM tool under Project Management so roadmap sync works.",
			},
			{
				id: "project-databricks-knowledge",
				anchor: "project-databricks-knowledge",
				title: "Bring your Databricks corpus along",
				body: "If your org connected Databricks Vector Search, bind this project to specific indexes here (read-only). Agents in the project get a search tool over that corpus, and 'Update using context' folds matching chunks in as an external, undated source — reconnect or disconnect freely, nothing is copied.",
				// Renders only on the Knowledge sub-tab, and only when the
				// workspace has an active Databricks connection.
				conditional: true,
			},
		],
	},

	// ── Top-level app / sidebar pages ──────────────────────────────────────
	{
		tab: "agents",
		app: true,
		label: "AI Agents",
		icon: BotIcon,
		components: [
			{
				id: "agents-scope-filter",
				anchor: "agents-scope-filter",
				title: "Three kinds of agent, unified",
				body: "One registry for Fabric's built-in system agents, the ones you build, and external agents you register over A2A/MCP. The scope pills separate them — and that split is real tenant isolation, not just a filter.",
			},
			{
				id: "agents-new",
				anchor: "agents-new",
				title: "An agent is what you attach to it",
				body: "The power isn't the prompt — it's the Knowledge (workspaces, integrations), Capabilities (Skills + built-in tools + MCP), and Triggers you compose in. It can loop autonomously toward a goal, or be exposed as a callable API.",
			},
			{
				id: "agents-featured",
				anchor: "agents-featured",
				title: "Start with Fabric Loom",
				body: "Loom is the orchestrator — rather than answering itself, it reads your task and routes it to the best specialist agent. Not sure which agent you need? Start here. (Clicking any agent drops you into a Nexus chat with it.)",
			},
		],
	},
	{
		tab: "prompts",
		app: true,
		label: "Prompts",
		icon: FileTextIcon,
		enabled: PROMPTS_ENABLED,
		components: [
			{
				id: "prompts-tabs",
				anchor: "prompts-tabs",
				title: "The control panel for Fabric's AI",
				body: "Prompts is the library: every prompt you and your team own, filtered by whose default is in force. Actions flips to the same prompts grouped by the work they do — pick the thing you are trying to do and see every prompt that could serve it, with the one currently running marked.",
			},
			{
				id: "prompts-scope",
				anchor: "prompts-scope",
				title: "System, org, or yours",
				body: "Prompts come in three scopes. You can't edit a SYSTEM prompt in place — the pattern is Duplicate → edit → 'Set as Default', which makes your version win by precedence without touching the global one.",
			},
			{
				id: "prompts-new",
				anchor: "prompts-new",
				title: "Reusable and templated",
				body: "Prompts support variables and Handlebars/Mustache/Liquid/Jinja templating, and the same prompt can drive documents, agents, or workflows — write once, parameterize everywhere.",
			},
		],
	},
	{
		tab: "projects",
		app: true,
		label: "Projects",
		icon: FolderKanbanIcon,
		components: [
			{
				id: "projects-status-filter",
				anchor: "projects-status-filter",
				title: "The delivery lifecycle",
				body: "Projects move through Draft → Active → Completed → Archived. A Draft is one you started but never finished setting up — the Draft pill and the resume banner are how you get back into it.",
			},
			{
				id: "projects-search",
				anchor: "projects-search",
				title: "Find any project",
				body: "Jump to a project by name. In your personal space, projects shared with you from other orgs show up in their own 'Shared with me' section.",
			},
			{
				id: "projects-new",
				anchor: "projects-new",
				title: "A project is a whole initiative",
				body: "Not just a name — it scaffolds the full workspace: documents, pipeline, roadmap, agents, code map, reports. (A 'workspace', by contrast, is just a document knowledge base.) This is the real starting move in Fabric.",
			},
		],
	},
	{
		tab: "workflows",
		app: true,
		label: "Workflows",
		icon: WorkflowIcon,
		components: [
			{
				id: "workflows-new",
				anchor: "workflows-new",
				title: "A visual node canvas",
				body: "Drag AI, integration, scraping, and logic nodes onto a canvas and wire outputs into inputs with {{Node.field}}. Don't build it by hand — press ⌘K or use the Workflow Assistant to generate the graph from a prompt.",
			},
			{
				id: "workflows-status-filter",
				anchor: "workflows-status-filter",
				title: "Publish is what goes live",
				body: "The lifecycle is Draft → Published → Active → Paused, and here's the trap: triggers (manual or webhook) only fire once you Publish, which snapshots an immutable version. 'Active' alone isn't enough.",
			},
			{
				id: "workflows-search",
				anchor: "workflows-search",
				title: "Workflow vs Weave",
				body: "Reach for a workflow when you want a fixed, repeatable pipeline you author node-by-node; Weave is autonomous multi-agent orchestration inside a project. Different tools for different jobs.",
			},
		],
	},
	{
		tab: "integrations",
		app: true,
		label: "Integrations",
		icon: PlugIcon,
		components: [
			{
				id: "integrations-add",
				anchor: "integrations-add",
				title: "The reliable way to connect a tool",
				body: "Connect GitHub/GitLab, Jira, Teams, Slack and more here — the OAuth-managed, first-class path (more reliable than wiring the same system as a raw MCP server). Everything you connect feeds agents, workflows, and report data sources.",
			},
			{
				id: "integrations-capability-filter",
				anchor: "integrations-capability-filter",
				title: "Search vs Actions — the key idea",
				body: "Every connector has two independent powers: Search (Fabric can retrieve from that tool) and Actions (agents can operate it) — or Hybrid for both. The count badges show your current reach at a glance.",
			},
			{
				id: "integrations-search",
				anchor: "integrations-search",
				title: "Find a connector",
				body: "Search the catalog by name, or by the kind of data you want to reach.",
			},
		],
	},
	{
		tab: "workspaces",
		app: true,
		label: "Workspaces",
		icon: LayersIcon,
		components: [
			{
				id: "workspaces-new",
				anchor: "workspaces-new",
				title: "A knowledge base you can chat with",
				body: "A workspace is a document bucket agents retrieve from — and you can chat with its docs directly. It's the reusable knowledge layer Reports and agents point at (different from a Project, which runs an initiative).",
			},
			{
				id: "workspaces-card",
				anchor: "workspaces-card",
				title: "What a workspace holds",
				body: "Each card shows its document count against the limit, how many chats you've had with it, and its type — plus archive/reactivate. This is where the value lives, not the name.",
				conditional: true,
			},
			{
				id: "workspaces-status-filter",
				anchor: "workspaces-status-filter",
				title: "Archived are hidden by default",
				body: "You're seeing Active workspaces only. Archiving is non-destructive — flip this to find and reactivate an old one anytime.",
			},
		],
	},
	{
		tab: "mcp-servers",
		app: true,
		label: "MCP Servers",
		icon: ServerIcon,
		components: [
			{
				id: "mcp-servers-add-registry",
				anchor: "mcp-servers-add-registry",
				title: "The fastest path: the registry",
				body: "Pick a known server (GitHub, Slack, Notion, GitLab…) and it prefills transport and auth. Note: if Fabric already offers a first-class Integration for that tool, the built-in connector is usually the better choice.",
			},
			{
				id: "mcp-servers-add-custom",
				anchor: "mcp-servers-add-custom",
				title: "Custom servers — and how agents pick",
				body: "Register any server by URL. The Description, Domain Keywords and Example Queries fields aren't decoration — they drive which server an agent reaches for when you have many. Keys are stored encrypted; 'Test Connection' verifies before use.",
			},
			{
				id: "mcp-servers-search",
				anchor: "mcp-servers-search",
				title: "MCP vs Integrations",
				body: "MCP is the open 'bring anything' surface; Integrations is the curated, first-class list. Use an Integration when one exists for your tool; use MCP for everything else.",
			},
		],
	},
	{
		tab: "reports-hub",
		app: true,
		label: "Reports",
		icon: ClipboardListIcon,
		components: [
			{
				id: "reports-hub-tabs",
				anchor: "reports-hub-tabs",
				title: "Templates vs My Instances",
				body: "A template is a recipe — it declares data sources, required integrations, AI agents, and a schedule. 'My Instances' are the ones you've configured and are actually running. New users conflate the two.",
			},
			{
				id: "reports-template-card",
				anchor: "reports-template-card",
				title: "The card is a readiness checklist",
				body: "A template's chips turn green when the MCP server it needs is connected, amber 'Needs configuration' when not — so you can see whether a report will run before you start it. 'Use Template' opens the instance wizard.",
				conditional: true,
			},
			{
				id: "reports-category-filter",
				anchor: "reports-category-filter",
				title: "Browse by what you're summarizing",
				body: "Categories map to the source material — Development, Communication, Video & Audio, Business — each needing different data connections.",
				conditional: true,
			},
			{
				id: "reports-new-template",
				anchor: "reports-new-template",
				title: "Roll your own recipe",
				body: "When no gallery template fits, build a custom one — pick its data sources, agents, output format, and schedule.",
				conditional: true,
			},
		],
	},
	{
		tab: "skills",
		app: true,
		label: "Skills",
		icon: SparklesIcon,
		components: [
			{
				id: "skills-new",
				anchor: "skills-new",
				title: "A skill is know-how, not code",
				body: "You author Markdown — one focused capability (a process, guidelines, examples) that's injected into an agent's system prompt at runtime. Write it once and any agent reuses it; keep it single-purpose so it doesn't dilute the agent.",
			},
			{
				id: "skills-sort",
				anchor: "skills-sort",
				title: "Find battle-tested ones",
				body: "Sort by Popular to surface skills agents actually rely on, and use the scope control to separate Fabric's built-in SYSTEM skills from your org's and your own.",
			},
			{
				id: "skills-search",
				anchor: "skills-search",
				title: "Skill vs tool vs prompt",
				body: "A skill teaches how to do something well; a built-in tool or MCP gives an agent a new action; a prompt is a bound instruction template. Skills are the know-how layer you attach to agents.",
			},
		],
	},
	{
		tab: "agent-templates",
		app: true,
		label: "Agent Templates",
		icon: BotIcon,
		components: [
			{
				id: "agent-templates-category-filter",
				anchor: "agent-templates-category-filter",
				title: "Blueprints by the job",
				body: "Templates are pre-written agent blueprints organized by function — Engineering, Data, Sales, Support, Product. Each card previews the actual instructions and its use count, so you can judge fit before you commit.",
			},
			{
				id: "agent-templates-create-agent",
				anchor: "agent-templates-create-agent",
				title: "A template just seeds the builder",
				body: "'Use this template' pre-fills the same agent builder you'd get from scratch — you still add knowledge, tools, and a name before the agent exists. A blueprint you customize, not a finished agent. (Different from Automation Templates, which are browser macros.)",
			},
			{
				id: "agent-templates-search",
				anchor: "agent-templates-search",
				title: "Find and @-mention",
				body: "Search the gallery by name — and note templates are @-mentionable elsewhere in Fabric, so a good one becomes shared team infrastructure.",
			},
		],
	},
	{
		tab: "automation-templates",
		app: true,
		label: "Automation Templates",
		icon: CombineIcon,
		components: [
			{
				id: "automation-templates-new",
				anchor: "automation-templates-new",
				title: "Record once, replay with inputs",
				body: "These are real browser automations, not LLM calls — usually born from a browser task you already ran, then saved as a reusable, parameterized template (URLs, selectors, JSON) you replay deterministically. A different subsystem from Workflows.",
			},
			{
				id: "automation-templates-visibility",
				anchor: "automation-templates-visibility",
				title: "Share proven automations",
				body: "Private vs Public is a sharing control — make one public and a working automation becomes team infrastructure. Cards show run counts and last-used as social proof.",
			},
			{
				id: "automation-templates-search",
				anchor: "automation-templates-search",
				title: "Find a saved automation",
				body: "Search your saved browser automations by name.",
			},
		],
	},
	{
		tab: "app-settings",
		app: true,
		label: "Settings",
		icon: SettingsIcon,
		components: [
			{
				id: "settings-nav",
				anchor: "settings-nav",
				title: "Do this first: AI Providers",
				body: "This menu spans your whole account — but the make-or-break page is AI Providers: connect an LLM key (OpenAI, Anthropic, Azure…) or nothing AI in Fabric works. Then AI Models routes each task to the right model. Everything else — integrations, MCP, billing, audit log — clusters below.",
			},
		],
	},
];

/** Look up the detailed page tour for a project tab (if one exists + enabled). */
export function pageForTab(tab: string | null | undefined): GsPage | null {
	if (!tab) {
		return null;
	}
	const page = GET_STARTED_PAGES.find((p) => p.tab === tab);
	return page && page.enabled !== false ? page : null;
}

/**
 * Pages introduced on/before this instant are treated as already-known to users
 * who existed before the get-started rollout — they aren't auto-opened for them.
 * A page whose `since` is AFTER this baseline is a genuinely new feature and
 * auto-opens once for everyone (see the first-visit effect in
 * GetStartedController). Bump the `since` on a page — never this constant.
 */
export const ONBOARDING_PAGE_BASELINE = "2026-07-09T00:00:00.000Z";

/** True when a page's tour was introduced after the baseline (a new feature). */
export function isNewlyIntroducedPage(page: GsPage): boolean {
	return page.since != null && page.since > ONBOARDING_PAGE_BASELINE;
}

/** All in-page component anchors the page tours depend on (drift test). */
export function pageComponentAnchors(): string[] {
	const ids = new Set<string>();
	for (const page of GET_STARTED_PAGES) {
		for (const component of page.components) {
			ids.add(component.anchor);
		}
	}
	return [...ids];
}
