/**
 * Ratchet: no NEW faded text colours (Fizzy #1444, AC-13/15/16).
 *
 * Tailwind's opacity modifier mixes a text token toward transparent, and on the
 * app's surfaces that takes it under the WCAG 2.1 AA floor of 4.5:1:
 * `text-muted-foreground/70` measures about 3:1, `text-foreground/50` about
 * 3.3:1 in the light theme, and the raw greys `text-gray-400`/`-500` 2.2-4.1:1.
 * Those classes were the grey captions, labels and helper text the ticket was
 * raised about, and they were rewritten to `text-muted-foreground`, which
 * clears AA on every surface in every palette (theme-token-contrast.test.ts).
 *
 * What is left below is not text: decorative and empty-state ICONS (non-text
 * contrast is out of the ticket's scope), DISABLED controls (exempt under WCAG
 * 1.4.3), and one dot-grid texture painted with `currentColor`. The counts are a
 * ceiling. A file over its count — or any file not listed — is a new faded text
 * colour: use `text-muted-foreground` for secondary text instead. A file under
 * its count fails too, so the ceiling comes down with it; lower the number.
 *
 * `text-foreground/70` and stronger clear AA in every palette and are allowed.
 * `dark:` greys are not counted: a light grey is the right ink on a dark page.
 * Marketing pages and tests are out of scope.
 */

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = resolve(__dirname, "..");
const SEARCH_ROOTS = ["modules", "app"];

const CEILING: Record<string, number> = {
	"modules/saas/admin/component/monitoring/HelpTooltip.tsx": 1,
	"modules/saas/agent-templates/components/AgentInstanceDetail.tsx": 3,
	"modules/saas/agent-templates/components/AgentInstanceDuplicate.tsx": 2,
	"modules/saas/agent-templates/components/AgentInstanceEdit.tsx": 2,
	"modules/saas/agent-templates/components/AgentMemoryPanel.tsx": 3,
	"modules/saas/agent-templates/components/AgentTemplatesList.tsx": 1,
	"modules/saas/agent-templates/components/CreateAgentPage.tsx": 2,
	"modules/saas/agent-templates/components/DataSourcesSheet.tsx": 1,
	"modules/saas/agent-templates/components/WorkspacesSheet.tsx": 1,
	"modules/saas/agents/components/CreateAgentDialog.tsx": 4,
	"modules/saas/agents/components/FabricChat/TrajectorySteps.tsx": 1,
	"modules/saas/agents/components/FabricChat/multi-agent/AgentResponseBlock.tsx": 1,
	"modules/saas/agents/components/FabricChat/orchestrator/ArtifactsPanel.tsx": 1,
	"modules/saas/agents/components/FabricChat/orchestrator/MemoryPanel.tsx": 3,
	"modules/saas/agents/components/FabricChat/orchestrator/TaskPlanView.tsx": 1,
	"modules/saas/agents/components/FabricChat/shared/ActiveContextIndicator.tsx": 1,
	"modules/saas/agents/components/FabricChat/shared/AgentModelPicker.tsx": 1,
	"modules/saas/agents/components/UnifiedAgentListView.tsx": 1,
	"modules/saas/ai/components/ChatHistorySidebar.tsx": 2,
	"modules/saas/ai/components/CopilotPage.tsx": 3,
	"modules/saas/ai/components/SwipeableChatItem.tsx": 1,
	"modules/saas/dashboard/components/MetricCard.tsx": 1,
	"modules/saas/dashboard/components/MyWorkPanel.tsx": 2,
	"modules/saas/dashboard/components/RecentChats.tsx": 1,
	"modules/saas/data-connections/components/IntegrationIncidentDrawer.tsx": 1,
	"modules/saas/data-connections/components/ProviderCard.tsx": 1,
	"modules/saas/get-started/components/GetStartedDrawer.tsx": 1,
	"modules/saas/jobs/components/JobCard.tsx": 2,
	"modules/saas/mcp/components/authority/AuthorityDashboard.tsx": 2,
	"modules/saas/payments/components/AiUsageActivityView.tsx": 2,
	"modules/saas/projects/components/DocumentVersionHistory.tsx": 1,
	"modules/saas/projects/components/ProjectDetails.tsx": 1,
	"modules/saas/projects/components/ProjectImplementationDefaultsSettings.tsx": 1,
	"modules/saas/projects/components/ProjectRepositoryIntegrationSettings.tsx": 2,
	"modules/saas/projects/components/ProjectSettingsNav.tsx": 1,
	"modules/saas/projects/components/RagSettingsForm.tsx": 1,
	"modules/saas/projects/components/SlackChannelPickerDialog.tsx": 6,
	"modules/saas/projects/components/SlackChannelSelectorDialog.tsx": 5,
	"modules/saas/projects/components/TeamsChannelPickerDialog.tsx": 5,
	"modules/saas/projects/components/TeamsChatPickerDialog.tsx": 2,
	"modules/saas/projects/components/TeamsChatSelectorDialog.tsx": 8,
	"modules/saas/projects/components/atlas/AtlasConnectionsList.tsx": 1,
	"modules/saas/projects/components/atlas/AtlasOverview.tsx": 1,
	"modules/saas/projects/components/coding-runs/CodingRunTimeline.tsx": 1,
	"modules/saas/projects/components/coding-runs/StartCodingRunDialog.tsx": 1,
	"modules/saas/projects/components/copilot/CopilotSidebarHeader.tsx": 1,
	"modules/saas/projects/components/decisions/DecisionsList.tsx": 2,
	"modules/saas/projects/components/repository-import/RepositoryImportPanel.tsx": 1,
	"modules/saas/projects/components/security/ScanInfo.tsx": 1,
	"modules/saas/projects/components/stories/BacklogHistoryShared.tsx": 1,
	"modules/saas/projects/components/stories/RoadmapFiltersPanel.tsx": 1,
	"modules/saas/projects/components/stories/RoadmapSortControl.tsx": 1,
	"modules/saas/projects/components/stories/SourceChip.tsx": 1,
	"modules/saas/projects/components/stories/StoriesRoadmap.tsx": 2,
	"modules/saas/projects/components/stories/StoryCard.tsx": 1,
	"modules/saas/projects/components/stories/StoryWorkspace.tsx": 1,
	"modules/saas/projects/components/stories/maturation/ReadinessBar.tsx": 1,
	"modules/saas/projects/components/stories/priority/PriorityRow.tsx": 1,
	"modules/saas/projects/components/stories/priority/PriorityTrail.tsx": 2,
	"modules/saas/projects/components/stories/priority/StoryPriorityControl.tsx": 1,
	"modules/saas/projects/components/test-cases/FeatureCoverageList.tsx": 1,
	"modules/saas/projects/components/test-cases/OpenQuestionsPanel.tsx": 1,
	"modules/saas/projects/components/test-cases/PmSyncControls.tsx": 1,
	"modules/saas/projects/components/test-cases/SectionHint.tsx": 1,
	"modules/saas/projects/components/test-cases/TestPlansList.tsx": 1,
	"modules/saas/projects/components/wizard/GitHubRepoPicker.tsx": 4,
	"modules/saas/projects/components/wizard/GitLabProjectPicker.tsx": 4,
	"modules/saas/prompts/components/PromptCard.tsx": 2,
	"modules/saas/reports/components/ArtifactDeliveryHistoryDialog.tsx": 1,
	"modules/saas/reports/components/InfoHint.tsx": 1,
	"modules/saas/settings/components/ActiveSessionsBlock.tsx": 1,
	"modules/saas/settings/components/ConnectedAccountsBlock.tsx": 1,
	"modules/saas/settings/components/PasskeysBlock.tsx": 1,
	"modules/saas/settings/components/audit-log/AuditLogActionsHelpButton.tsx": 1,
	"modules/saas/shared/components/Footer.tsx": 2,
	"modules/saas/skills/components/SkillsLibrary.tsx": 1,
	"modules/saas/weave/components/ExecutionTimeline.tsx": 1,
	"modules/saas/workflows/components/ExecutionPanel.tsx": 1,
	"modules/saas/workflows/components/editor/EditorHeader.tsx": 2,
	"modules/saas/workflows/components/editor/WorkflowOverview.tsx": 1,
	"modules/saas/workspaces/components/WorkspaceRagSettingsForm.tsx": 1,
};

const FADED_TEXT =
	/(?<![\w-])((?:[^\s"'`:]+:)*)text-(?:muted-foreground\/(?:\d+|\[[^\]]+\])|foreground\/(\d+)|(?:success|highlight|destructive|primary|primary-ink|highlight-ink)\/(?:\d+|\[[^\]]+\])|(?:gray|slate|zinc|neutral|stone)-(?:300|400|500))(?![\w/-])/g;

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

/**
 * A text element faded as a whole: `<span className="… opacity-70">3</span>`.
 * Same failure as a faded token, through a different utility. Decorative
 * separators and disabled wrappers are the exceptions the ceiling holds.
 */
const FADED_ELEMENT =
	/<(?:span|p|div|small|em|strong|code|kbd|li|dd|dt|label)\s+className="([^"]*)"/g;

function countFadedText(source: string): number {
	let count = 0;
	for (const match of source.matchAll(FADED_TEXT)) {
		const variants = match[1] ?? "";
		// A light grey is the right ink on a dark page; a faded token is not,
		// in either theme.
		if (
			/(^|:)dark:/.test(variants) &&
			/text-(gray|slate|zinc|neutral|stone)-/.test(match[0])
		) {
			continue;
		}
		const foregroundAlpha = match[2];
		if (foregroundAlpha !== undefined && Number(foregroundAlpha) >= 70) {
			continue;
		}
		count++;
	}
	for (const match of source.matchAll(FADED_ELEMENT)) {
		const classes = match[1] ?? "";
		if (
			/(^|\s)opacity-([1-9][05])(\s|$)/.test(classes) &&
			// Not text: disabled wrappers, hover reveals, icons, and the
			// absolutely-positioned texture overlays some panels paint.
			!/cursor-not-allowed|disabled|hover:opacity|animate-|size-\d|h-\d+ w-\d+|absolute inset-0/.test(
				classes,
			)
		) {
			count++;
		}
	}
	return count;
}

const found = new Map<string, number>();
for (const root of SEARCH_ROOTS) {
	for (const file of walk(resolve(webRoot, root))) {
		const count = countFadedText(readFileSync(file, "utf8"));
		if (count > 0) {
			found.set(relative(webRoot, file).split(sep).join("/"), count);
		}
	}
}

describe("faded text colour ratchet", () => {
	it("recognises the classes it is meant to catch", () => {
		// Guards the guard: a pattern that matched nothing would pass forever.
		expect(
			countFadedText('className="text-xs text-muted-foreground/70"'),
		).toBe(1);
		expect(
			countFadedText('"text-foreground/50 hover:text-foreground"'),
		).toBe(1);
		expect(countFadedText('"placeholder:text-muted-foreground/60"')).toBe(
			1,
		);
		expect(countFadedText('"text-gray-400 text-slate-500"')).toBe(2);
		// Dark mode is not a pass for a faded token, only for a raw grey.
		expect(countFadedText('"dark:text-success/10"')).toBe(1);
		expect(countFadedText('"dark:hover:text-primary/50"')).toBe(1);
		expect(countFadedText('"dark:text-muted-foreground/60"')).toBe(1);
		expect(countFadedText('"dark:text-gray-400"')).toBe(0);
		// A whole text element faded with opacity, and the exceptions.
		expect(countFadedText('<span className="font-mono opacity-70">')).toBe(
			1,
		);
		expect(
			countFadedText(
				'<div className="flex cursor-not-allowed opacity-60">',
			),
		).toBe(0);
		expect(countFadedText('<span className="size-4 opacity-50">')).toBe(0);
		expect(
			countFadedText(
				'<div className="pointer-events-none absolute inset-0 opacity-40">',
			),
		).toBe(0);
		expect(
			countFadedText('"text-foreground/80 text-muted-foreground"'),
		).toBe(0);
		expect(countFadedText('"dark:text-gray-400 text-gray-600"')).toBe(0);
		expect(countFadedText('"text-muted-foreground/[0.5]"')).toBe(1);
		// The status and brand inks fade under AA the same way (Fizzy #1444).
		expect(countFadedText('"text-success/80 text-highlight/80"')).toBe(2);
		expect(countFadedText('"hover:text-primary/80"')).toBe(1);
		expect(countFadedText('"text-success text-primary-hover"')).toBe(0);
	});

	it("finds no faded text colour outside the listed files", () => {
		const unlisted = [...found.keys()].filter((file) => !(file in CEILING));
		expect(
			unlisted,
			"new faded text colour — use text-muted-foreground (AA on every surface)",
		).toEqual([]);
	});

	for (const [file, ceiling] of Object.entries(CEILING)) {
		it(`${file} stays at ${ceiling}`, () => {
			const count = found.get(file) ?? 0;
			expect(
				count,
				count > ceiling
					? "new faded text colour — use text-muted-foreground"
					: "fewer than the ceiling: lower it to the new count",
			).toBe(ceiling);
		});
	}
});
