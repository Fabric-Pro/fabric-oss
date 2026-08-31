/**
 * Drift guard for the "Get started" module — the enforcement half of the
 * "always up to date" mechanism (see the "Get Started upkeep" rule in
 * CLAUDE.md / AGENTS.md). It ties BOTH the guided-tour steps and the drawer
 * content registry to the LIVE app so the guide cannot silently rot:
 *   - every anchor a step / drawer item points at must actually be placed on a
 *     live component (sidebar nav items + the project tab bar);
 *   - every project-tab reference must be a tab that still exists;
 *   - every tour step must have title + body copy in en.json;
 *   - every required area / drawer group must have coverage.
 *
 * Add / rename / remove a nav destination, project tab, or drawer item and
 * forget to update the registry (or its anchor), and this test fails.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	GET_STARTED_GROUPS,
	GET_STARTED_PAGES,
	GET_STARTED_REQUIRED_GROUPS,
	isNewlyIntroducedPage,
	ONBOARDING_PAGE_BASELINE,
	pageComponentAnchors,
	registryAnchors,
} from "../../../../modules/saas/get-started/lib/get-started-registry";
import {
	anchorIdsUsedBySteps,
	ONBOARDING_ANCHORS,
	ONBOARDING_REQUIRED_AREAS,
	ONBOARDING_STEPS,
} from "../../../../modules/saas/get-started/lib/tour-steps";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../../..");

const read = (rel: string) => readFileSync(path.resolve(repoRoot, rel), "utf8");

const navSource = read("apps/web/modules/saas/shared/components/NavBar.tsx");
const projectDetailsSource = read(
	"apps/web/modules/saas/projects/components/ProjectDetails.tsx",
);
/** The tab array moved out of ProjectDetails so the readiness panel can read it
 * without importing the component that renders it. */
const projectTabsSource = read(
	"apps/web/modules/saas/projects/lib/project-tabs.ts",
);

/**
 * The canonical project-tab id list, parsed from ProjectDetails' `tabs` array.
 * This is the LIVE → registry direction of the coverage guard: add a tab here
 * without a `GET_STARTED_PAGES` entry and the coverage test below goes red, so a
 * new feature can't ship with no "Get started" tour. Commented-out tabs (e.g.
 * the disabled "artifacts" placeholder) are skipped.
 */
function liveProjectTabIds(): string[] {
	const start = projectTabsSource.indexOf("const tabs = [");
	const end = projectTabsSource.indexOf("] as const;", start);
	const ids: string[] = [];
	for (const line of projectTabsSource.slice(start, end).split("\n")) {
		if (line.trim().startsWith("//")) {
			continue;
		}
		const m = line.match(/id:\s*"([a-z-]+)"/);
		if (m) {
			ids.push(m[1]);
		}
	}
	return ids;
}

/**
 * Project tabs deliberately shipped WITHOUT a detailed page tour. Add an id here
 * (with a reason) only when a tab genuinely shouldn't have one — the coverage
 * test forces that decision to be explicit rather than an accidental omission.
 */
const PAGE_COVERAGE_EXEMPT = new Set<string>([]);
// Files that carry the in-page component anchors the detailed page tours point
// at. New page anchors must live in one of these (extend the list if a covered
// component moves to a new file).
const inPageSource = [
	"apps/web/modules/saas/projects/components/ProjectOverview.tsx",
	"apps/web/modules/saas/projects/components/DocumentsList.tsx",
	"apps/web/modules/saas/projects/components/stories/StoriesRoadmap.tsx",
	"apps/web/modules/saas/projects/components/stories/RoadmapSectionSwitcher.tsx",
	"apps/web/modules/saas/projects/components/stories/PendingProposalsButton.tsx",
	"apps/web/modules/saas/projects/components/security/SecurityAccessibilityPage.tsx",
	"apps/web/modules/saas/projects/components/security/ScanConfigCard.tsx",
	"apps/web/modules/saas/projects/components/ProjectContextsList.tsx",
	"apps/web/modules/saas/projects/components/ContextSummaryPanel.tsx",
	"apps/web/modules/saas/projects/components/ProjectPipeline.tsx",
	"apps/web/modules/saas/projects/components/ProjectReports.tsx",
	// Top-level app / sidebar pages (anchors live in the list/view component).
	"apps/web/modules/saas/agents/components/UnifiedAgentView.tsx",
	"apps/web/modules/saas/prompts/components/PromptsList.tsx",
	"apps/web/modules/saas/projects/components/ProjectsList.tsx",
	"apps/web/modules/saas/workflows/components/WorkflowsList.tsx",
	"apps/web/modules/saas/data-connections/components/ConnectionsPageContent.tsx",
	"apps/web/modules/saas/workspaces/components/WorkspacesList.tsx",
	"apps/web/modules/saas/workspaces/components/WorkspaceCard.tsx",
	"apps/web/modules/saas/mcp/components/McpServersView.tsx",
	"apps/web/modules/saas/reports/components/ReportTemplatesPageTabs.tsx",
	"apps/web/modules/saas/reports/components/ReportTemplatesList.tsx",
	"apps/web/modules/saas/reports/components/ReportTemplateCard.tsx",
	"apps/web/modules/saas/skills/components/SkillsLibrary.tsx",
	"apps/web/modules/saas/agent-templates/components/AgentTemplatesList.tsx",
	"apps/web/modules/saas/automation-templates/components/TemplatesList.tsx",
	"apps/web/modules/saas/settings/components/SettingsMenu.tsx",
	// Remaining project tabs (custom-header pages).
	"apps/web/modules/saas/daily-brief/components/DailyBriefHeader.tsx",
	"apps/web/modules/saas/daily-brief/components/PriorityActionsPanel.tsx",
	"apps/web/modules/saas/meeting-digest/components/MeetingDigestTab.tsx",
	"apps/web/modules/saas/projects/components/ReleaseNotesList.tsx",
	"apps/web/modules/saas/projects/components/decisions/DecisionsList.tsx",
	"apps/web/modules/saas/projects/components/test-cases/TestCasesList.tsx",
	// The per-segment "About" lives in its own component rather than inline in
	// the list, so its anchor is here too — otherwise this guard reports it as
	// pointing at nothing, which is exactly what it did when it was added.
	"apps/web/modules/saas/projects/components/test-cases/SegmentAbout.tsx",
	// The cases table's own chrome — column header, empty states and the
	// pagination footer — lives beside the list rather than inside it, so the
	// anchors on those carry from here.
	"apps/web/modules/saas/projects/components/test-cases/CasesTable.tsx",
	// Shared by the Testing tab AND the feature-editor Testing tab.
	"apps/web/modules/saas/projects/components/test-cases/pipeline/UnmatchedTestsSection.tsx",
	"apps/web/modules/saas/projects/components/publishing-suite/PublishingSuiteList.tsx",
	// The refresh-history table (1C-4a) sits beside the topic list rather than
	// inside it — its own query, its own states — so its anchor lives here.
	"apps/web/modules/saas/projects/components/publishing-suite/PublishingCycleHistory.tsx",
	// The Snooze/Unsnooze control (1D-2) is per-row chrome rendered by the row
	// component itself rather than the list, so its anchor lives here.
	"apps/web/modules/saas/projects/components/publishing-suite/TopicRow.tsx",
	"apps/web/modules/saas/weave/components/WeaveDashboard.tsx",
	"apps/web/modules/saas/projects/components/AgentActivityTab.tsx",
	"apps/web/modules/saas/projects/components/DiagramsList.tsx",
	"apps/web/modules/saas/projects/components/ProjectUsage.tsx",
	"apps/web/modules/saas/projects/components/atlas/ProjectAtlas.tsx",
	"apps/web/modules/saas/projects/components/ProjectSettingsNav.tsx",
	"apps/web/modules/saas/projects/components/ProjectSettings.tsx",
	"apps/web/modules/saas/projects/components/ProjectDatabricksKnowledgeSettings.tsx",
	// Kanban ("Coding Agents") chrome is rendered inline by ProjectDetails.
	"apps/web/modules/saas/projects/components/ProjectDetails.tsx",
]
	.map(read)
	.join("\n");

// Files that WIRE a page's header Compass launcher — either the shared-hero
// `getStartedPageId` prop or an inline `<PageTourButton pageId="…">`. Every
// GET_STARTED_PAGES entry must have exactly one wired launcher here, and every
// wired id must resolve to a page (the bijection test below). Add a launcher on
// a new page → add its file here in the same change.
const launcherSource = [
	// Sidebar page heroes (getStartedPageId on PageHeader).
	"apps/web/modules/saas/agents/components/AgentsHero.tsx",
	"apps/web/modules/saas/prompts/components/PromptsHero.tsx",
	"apps/web/modules/saas/projects/components/ProjectsHero.tsx",
	"apps/web/modules/saas/workflows/components/WorkflowsHero.tsx",
	"apps/web/modules/saas/workspaces/components/WorkspacesHero.tsx",
	"apps/web/modules/saas/mcp/components/MCPServersHero.tsx",
	"apps/web/modules/saas/reports/components/ReportsHero.tsx",
	"apps/web/modules/saas/skills/components/SkillsHero.tsx",
	"apps/web/modules/saas/agent-templates/components/AgentTemplatesHero.tsx",
	"apps/web/modules/saas/automation-templates/components/TemplatesHero.tsx",
	// Settings shell hero (default app-settings) + the Integrations override.
	// One override, not two: the personal settings tree is gone, so the
	// organization page is the only place the launcher lives.
	"apps/web/modules/saas/settings/components/SettingsHero.tsx",
	"apps/web/app/(saas)/app/(organizations)/[organizationSlug]/settings/integrations/page.tsx",
	// Project pages (getStartedPageId on ProjectSectionHero, or inline button).
	"apps/web/modules/saas/projects/components/ProjectOverview.tsx",
	"apps/web/modules/saas/projects/components/DocumentsList.tsx",
	"apps/web/modules/saas/projects/components/ProjectContextsList.tsx",
	"apps/web/modules/saas/projects/components/ProjectPipeline.tsx",
	"apps/web/modules/saas/projects/components/ProjectReports.tsx",
	"apps/web/modules/saas/projects/components/security/SecurityAccessibilityPage.tsx",
	"apps/web/modules/saas/projects/components/ProjectDetails.tsx",
	"apps/web/modules/saas/projects/components/stories/StoriesRoadmap.tsx",
	"apps/web/modules/saas/weave/components/WeaveDashboard.tsx",
	"apps/web/modules/saas/daily-brief/components/DailyBriefHeader.tsx",
	"apps/web/modules/saas/meeting-digest/components/MeetingDigestTab.tsx",
	"apps/web/modules/saas/projects/components/ReleaseNotesList.tsx",
	"apps/web/modules/saas/projects/components/decisions/DecisionsList.tsx",
	"apps/web/modules/saas/projects/components/test-cases/TestCasesList.tsx",
	"apps/web/modules/saas/projects/components/publishing-suite/PublishingSuiteList.tsx",
	"apps/web/modules/saas/projects/components/AgentActivityTab.tsx",
	"apps/web/modules/saas/projects/components/DiagramsList.tsx",
	"apps/web/modules/saas/projects/components/ProjectUsage.tsx",
	"apps/web/modules/saas/projects/components/atlas/ProjectAtlas.tsx",
	"apps/web/modules/saas/projects/components/ProjectSettings.tsx",
];

/** The page ids wired to a header Compass launcher across the app. */
function wiredLauncherIds(): Set<string> {
	const src = launcherSource.map(read).join("\n");
	const ids = new Set<string>();
	const re =
		/(?:getStartedPageId\s*=\s*|PageTourButton\s+pageId=)"([a-z-]+)"/g;
	for (let m = re.exec(src); m !== null; m = re.exec(src)) {
		ids.add(m[1]);
	}
	return ids;
}

const pageAnchorSet = new Set(pageComponentAnchors());
const messages = JSON.parse(
	read("packages/i18n/translations/en.json"),
) as Record<string, unknown>;

function messageAt(dotted: string): unknown {
	return dotted.split(".").reduce<unknown>((acc, key) => {
		if (acc && typeof acc === "object") {
			return (acc as Record<string, unknown>)[key];
		}
		return undefined;
	}, messages);
}

const isProjectTabAnchor = (id: string) => id.startsWith("project-tab-");

/** Assert a non-project anchor is placed on a live component in NavBar. */
function expectNavAnchor(anchor: string) {
	expect(
		navSource.includes(`"${anchor}"`),
		`anchor "${anchor}" is not placed in NavBar.tsx — a step/drawer item points at a component that no longer exists`,
	).toBe(true);
}

/** Assert a project-tab anchor maps to a tab that still exists in ProjectDetails. */
function expectProjectTabAnchor(anchor: string) {
	const tab = anchor.replace("project-tab-", "");
	expect(projectDetailsSource).toContain("data-onboarding-target");
	expect(
		projectTabsSource.includes(`id: "${tab}"`),
		`project tab "${tab}" (anchor "${anchor}") no longer exists in ProjectDetails.tsx`,
	).toBe(true);
}

/** Assert an in-page component anchor is placed on a live project component. */
function expectInPageAnchor(anchor: string) {
	expect(
		inPageSource.includes(`data-onboarding-target="${anchor}"`),
		`in-page anchor "${anchor}" is not placed on any covered project component — a page tour points at a component that no longer exists`,
	).toBe(true);
}

/** Route an anchor to the source it must resolve in. */
function expectAnchorResolves(anchor: string) {
	if (pageAnchorSet.has(anchor)) {
		expectInPageAnchor(anchor);
	} else if (isProjectTabAnchor(anchor)) {
		expectProjectTabAnchor(anchor);
	} else {
		expectNavAnchor(anchor);
	}
}

describe("get-started tour — structure & copy", () => {
	it("has unique, stable step ids", () => {
		const ids = ONBOARDING_STEPS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("covers every required area", () => {
		const areas = new Set(ONBOARDING_STEPS.map((s) => s.area));
		for (const required of ONBOARDING_REQUIRED_AREAS) {
			expect(areas.has(required)).toBe(true);
		}
	});

	it("uses a valid side and has i18n copy for every step", () => {
		for (const step of ONBOARDING_STEPS) {
			if (step.target.kind !== "center" && step.target.side) {
				expect(["top", "bottom"]).toContain(step.target.side);
			}
			for (const field of ["title", "body"] as const) {
				const value = messageAt(
					`onboarding.tour.steps.${step.id}.${field}`,
				);
				expect(
					typeof value === "string" && value.length > 0,
					`missing onboarding.tour.steps.${step.id}.${field}`,
				).toBe(true);
			}
		}
	});
});

describe("get-started drawer — chrome copy", () => {
	it("has i18n copy for every reusable drawer chrome label", () => {
		const keys = [
			"title",
			"subtitle",
			"showMe",
			"open",
			"configure",
			"tourThisPage",
			"takeTour",
			"readDocs",
			"compassHint",
		];
		for (const key of keys) {
			const value = messageAt(`onboarding.getStarted.${key}`);
			expect(
				typeof value === "string" && value.length > 0,
				`missing onboarding.getStarted.${key}`,
			).toBe(true);
		}
	});
});

describe("get-started drawer registry — structure", () => {
	it("documents every required group", () => {
		const contexts = new Set(GET_STARTED_GROUPS.map((g) => g.context));
		for (const required of GET_STARTED_REQUIRED_GROUPS) {
			expect(contexts.has(required)).toBe(true);
		}
	});

	it("every item has a unique id, a label, and a description", () => {
		const ids = new Set<string>();
		for (const group of GET_STARTED_GROUPS) {
			for (const item of group.items) {
				expect(ids.has(item.id), `duplicate item id ${item.id}`).toBe(
					false,
				);
				ids.add(item.id);
				expect(item.label.length).toBeGreaterThan(0);
				expect(item.description.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("get-started — anchors are placed on live components", () => {
	it("places every sidebar/launcher/mobile anchor in NavBar", () => {
		for (const anchor of Object.values(ONBOARDING_ANCHORS)) {
			expectNavAnchor(anchor);
		}
	});

	it("every anchor a tour step or drawer item depends on resolves", () => {
		const anchors = new Set([
			...anchorIdsUsedBySteps(),
			...registryAnchors(),
		]);
		expect(projectDetailsSource).toContain("project-tab-");
		for (const anchor of anchors) {
			expectAnchorResolves(anchor);
		}
	});

	it("places every detailed page-tour component anchor on a live component", () => {
		for (const anchor of pageComponentAnchors()) {
			expectInPageAnchor(anchor);
		}
	});
});

describe("get-started — detailed page tours", () => {
	it("every project page maps to a real project tab and has components", () => {
		for (const page of GET_STARTED_PAGES) {
			// App/sidebar pages aren't project tabs, so skip the tab check.
			if (!page.app) {
				expect(
					projectTabsSource.includes(`id: "${page.tab}"`),
					`page tour tab "${page.tab}" no longer exists in ProjectDetails.tsx`,
				).toBe(true);
			}
			expect(page.components.length).toBeGreaterThan(0);
		}
	});

	it("has unique component ids and non-empty copy across all pages", () => {
		const ids = new Set<string>();
		for (const page of GET_STARTED_PAGES) {
			for (const component of page.components) {
				expect(
					ids.has(component.id),
					`duplicate page component id ${component.id}`,
				).toBe(false);
				ids.add(component.id);
				expect(component.title.length).toBeGreaterThan(0);
				// A real explanation, not a label restatement. The old placeholder
				// bodies ("Search the skill catalog.") were ~25 chars; a 40-char
				// floor forces at least a sentence that teaches something.
				expect(
					component.body.length,
					`page component ${component.id} body is too short (${component.body.length} chars) — write a real, non-placeholder explanation`,
				).toBeGreaterThanOrEqual(40);
			}
		}
	});

	it("has a unique tab id per page (pageForTab must not shadow)", () => {
		// pageForTab() resolves by first match over a flat array holding both
		// project-tab and app-page ids; a duplicate tab would silently shadow.
		const tabs = GET_STARTED_PAGES.map((p) => p.tab);
		expect(new Set(tabs).size).toBe(tabs.length);
	});

	it("wires exactly one launcher per page, and no orphan launchers", () => {
		// The header Compass is what users actually click. This bijection keeps
		// the wiring honest: a page with a tour but no launcher (unreachable), or
		// a launcher pointing at a non-existent page (renders nothing), fails here.
		const registryTabs = new Set(GET_STARTED_PAGES.map((p) => p.tab));
		const wired = wiredLauncherIds();
		for (const tab of registryTabs) {
			expect(
				wired.has(tab),
				`page "${tab}" has no header launcher wired — add getStartedPageId/PageTourButton on its header (and its file to launcherSource)`,
			).toBe(true);
		}
		for (const id of wired) {
			expect(
				registryTabs.has(id),
				`launcher pageId "${id}" resolves to no GET_STARTED_PAGES entry — a Compass that renders nothing`,
			).toBe(true);
		}
	});
});

describe("get-started — new-page auto-open eligibility", () => {
	it("original rollout pages (no `since`) never count as new", () => {
		// Existing (pre-rollout) users must not be replayed the whole app; only
		// pages introduced after the baseline auto-open for them.
		for (const page of GET_STARTED_PAGES) {
			if (page.since == null) {
				expect(isNewlyIntroducedPage(page)).toBe(false);
			}
		}
	});

	it("a page introduced after the baseline is new; before is not", () => {
		const base = GET_STARTED_PAGES[0];
		expect(
			isNewlyIntroducedPage({
				...base,
				since: "2999-01-01T00:00:00.000Z",
			}),
		).toBe(true);
		expect(
			isNewlyIntroducedPage({
				...base,
				since: "2000-01-01T00:00:00.000Z",
			}),
		).toBe(false);
		// The baseline instant itself is not "after" the baseline.
		expect(
			isNewlyIntroducedPage({ ...base, since: ONBOARDING_PAGE_BASELINE }),
		).toBe(false);
	});
});

describe("get-started — coverage (new features can't ship untoured)", () => {
	it("the tab extractor actually finds the live tabs (guards itself)", () => {
		// A coverage check that silently parses zero tabs would pass vacuously.
		// Pin a floor so a broken extractor fails loudly instead.
		expect(liveProjectTabIds().length).toBeGreaterThanOrEqual(15);
	});

	it("every live project tab has a detailed page tour (or a documented exemption)", () => {
		const covered = new Set(GET_STARTED_PAGES.map((p) => p.tab));
		for (const tab of liveProjectTabIds()) {
			if (PAGE_COVERAGE_EXEMPT.has(tab)) {
				continue;
			}
			expect(
				covered.has(tab),
				`project tab "${tab}" exists in ProjectDetails but has no GET_STARTED_PAGES tour — add one (or add "${tab}" to PAGE_COVERAGE_EXEMPT with a reason)`,
			).toBe(true);
		}
	});
});
