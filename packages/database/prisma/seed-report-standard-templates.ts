/**
 * The standard report templates: generic over the tool that supplies the data.
 * Each declares the data types it needs, required or optional, and names no
 * provider; the person says which connected tool supplies each type. Their
 * prompts name no tool either.
 *
 * Every source sets `useAgentic`, so a run gathers through the tool the person
 * bound whether or not that tool asks for any context.
 */

import {
	REPORT_DATA_TYPE_INFO,
	type ReportDataType,
} from "./queries/lib/report-data-types";
import {
	analysisSection,
	footerSection,
	headerSection,
} from "./seed-report-sections";

const CATEGORY_DEVELOPMENT = "Development";
const CATEGORY_BUSINESS = "Business";

type SourceDeclaration = { dataType: ReportDataType; required: boolean };

function dataSources(sources: SourceDeclaration[]) {
	return sources.map(({ dataType, required }) => ({
		id: dataType,
		type: "mcp" as const,
		dataType,
		required,
		useAgentic: true,
	}));
}

function connections(sources: SourceDeclaration[]) {
	return {
		mcpServers: sources.map(({ dataType, required }) => ({
			key: dataType,
			name: REPORT_DATA_TYPE_INFO[dataType].sourceName,
			description: required
				? `Reads the ${REPORT_DATA_TYPE_INFO[dataType].label.toLowerCase()} tool you connect`
				: `Uses the ${REPORT_DATA_TYPE_INFO[dataType].label.toLowerCase()} tool when one is connected`,
			required,
			dataType,
		})),
	};
}

const PROJECT_MANAGEMENT_REQUIRED: SourceDeclaration = {
	dataType: "project-management",
	required: true,
};
const REPOSITORY_OPTIONAL: SourceDeclaration = {
	dataType: "repository",
	required: false,
};

const READING_THE_DATA = `## Reading the Data

The data comes from the tools connected to this report, which may be any project management or repository tool.

1. **When a Board Facts block opens this prompt, take every board-wide number from it: \`total\`, \`open\`, \`closed\`, \`postponed\`, \`byStatus\`, \`byColumn\` (open work only), \`byAssignee\` and \`byTag\` (each \`{open, closed}\`), \`unassigned\`, \`overdue\`, \`stale\`, \`closedPerPeriod\` and \`createdPerPeriod\`. Do not count them from the items you can see: a large board's list is shortened to fit. To name what closed in a period, read the days in that period in \`closedCardsByDay\`, which lists closed items by number under the day they closed, and take each title from the list.**
2. **Say coverage is partial only when the Board Facts have \`complete: false\`, and name what \`gaps\` lists. Never call the data a sample.**
3. A null fact means the source does not provide that field: say it is not available, never zero.
4. Without Board Facts, count from the gathered items and say what each count covers.
5. **Report a number only when the gathered data supplies it. When no connected source supplies a metric, write "Not available" and name what would supply it. Never estimate or invent a metric.**
6. An optional source that is not connected gets one line saying so. It is not a failure.
7. Use the item fields only for per-item detail and for groupings the facts lack.`;

const CHANGES_FROM_THE_REPOSITORY =
	"From the repository source when one is connected: pull requests merged and releases published in the period, by title. Quote counts only when the tool returned them.";

function parameters(
	periodDefault: string,
	extraProperties: Record<string, unknown> = {},
) {
	return {
		required: ["projectName"],
		properties: {
			projectName: {
				type: "string",
				description: "Project or team name for the report title",
			},
			reportPeriod: {
				type: "string",
				description:
					"Time period to cover (e.g., 'Sprint 42', 'Last 2 weeks', 'March 2026')",
				default: periodDefault,
			},
			...extraProperties,
		},
	};
}

/**
 * What a person adds that no connected tool holds. Quoted as given, so it is
 * never filled in for them.
 */
const BUSINESS_CONTEXT_PARAMETER = {
	businessContext: {
		type: "string",
		description:
			"Figures and notes no connected tool holds, such as revenue, targets, budget, hiring or customer feedback",
		aiDefault: false,
	},
};

/**
 * A business review runs from what a person gives it alone, and reports made
 * before it read any tool still have to generate, so it requires nothing.
 */
function businessReviewParameters(
	periodDefault: string,
	extraProperties: Record<string, unknown> = {},
) {
	return {
		...parameters(periodDefault, {
			...BUSINESS_CONTEXT_PARAMETER,
			...extraProperties,
		}),
		required: [] as string[],
	};
}

const BUSINESS_FIGURES_RULE = `## Business Figures

Revenue, targets, budget, hiring and customer satisfaction do not come from a project management or repository tool. Take them only from the \`businessContext\` parameter, quote them as given and attribute them to it. Without one, write "Not available: add it in the report's parameters" in that row or section. Never fill these in from the delivery data.

With no source connected, write the structure below from the parameters and \`businessContext\`, and write "Not available" for every delivery number.`;

const OPENING_LINE =
	"Open with one line naming the project from the `projectName` parameter and the period from the `reportPeriod` parameter. Leave out a value that is not set, and when no period is set, say so. Never write an empty label or a placeholder.";

/**
 * The renderer substitutes `{{name}}` only for a parameter the report has and
 * leaves any other as literal text, with no conditional. So these sections are
 * static: the prompt's opening line carries the values, and the renderer's own
 * heading carries the generation time.
 */
function markdownReport(options: {
	title: string;
	sectionTitle: string;
	outputVariable: string;
	subtitle?: string;
}) {
	return [
		headerSection({
			titleTemplate: options.title,
			subtitleTemplate: options.subtitle,
		}),
		analysisSection(
			"report",
			options.sectionTitle,
			options.outputVariable,
			{ wrapperTemplate: "{{content}}" },
		),
		footerSection({ includeTimestamp: false, includeDisclaimer: true }),
	];
}

const SPRINT_STATUS_SOURCES = [
	PROJECT_MANAGEMENT_REQUIRED,
	REPOSITORY_OPTIONAL,
];
const BURN_CHART_SOURCES = [PROJECT_MANAGEMENT_REQUIRED, REPOSITORY_OPTIONAL];
const RELEASE_SOURCES = [PROJECT_MANAGEMENT_REQUIRED, REPOSITORY_OPTIONAL];
const VELOCITY_SOURCES = [PROJECT_MANAGEMENT_REQUIRED, REPOSITORY_OPTIONAL];
const ENGINEERING_METRICS_SOURCES: SourceDeclaration[] = [
	{ dataType: "repository", required: true },
	{ dataType: "project-management", required: false },
];
const BUSINESS_REVIEW_SOURCES: SourceDeclaration[] = [
	{ dataType: "project-management", required: false },
	REPOSITORY_OPTIONAL,
];
const CUSTOM_SOURCES = BUSINESS_REVIEW_SOURCES;

export const STANDARD_REPORT_TEMPLATES = [
	{
		key: "sprint-status",
		name: "Sprint / Status Report",
		description:
			"Where the work stands for a sprint or period: status, what closed, what is in flight, workload and risks, from your project management tool.",
		heroEmojis: ["🏃", "📋", "✅"],
		templateType: "SPRINT_COMPLETION" as const,
		category: CATEGORY_DEVELOPMENT,
		tags: ["sprint", "status", "standard"],
		outputFormat: "MARKDOWN" as const,
		connections: connections(SPRINT_STATUS_SOURCES),
		definition: {
			dataSources: dataSources(SPRINT_STATUS_SOURCES),
			aiAgents: [
				{
					agentId: "default",
					task: `Write a sprint or status report for the period in the \`reportPeriod\` parameter.

${OPENING_LINE}

${READING_THE_DATA}

## Report Structure

### Executive Summary
Two or three sentences: where the work stands, and the one thing a reader must act on.

### Status at a Glance
A table of \`open\`, \`closed\` and \`postponed\`, then open work by column from \`byColumn\`, or \`byStatus\` when the source has no columns.

### Completed
The number closed in the period from \`closedPerPeriod\`, then the notable items by title.

### In Progress
Open work by column, naming the items closest to finishing.

### Workload
\`byAssignee\` per person and \`unassigned\`. When \`assigneeListsCut\` is above zero, say some assignee lists were cut short, so workload may be low.

### Risks
\`overdue\` and \`stale\` with its \`afterDays\`, naming the items most at risk.

### Code Activity
${CHANGES_FROM_THE_REPOSITORY}

### Next Steps
Three to five actions, each tied to a number or item above.`,
					outputVariable: "sprint_status",
				},
			],
			sections: markdownReport({
				title: "Status Report",
				sectionTitle: "Status",
				outputVariable: "sprint_status",
			}),
		},
		parameters: parameters("Current Sprint"),
	},
	{
		key: "burndown-burnup",
		name: "Burndown / Burnup Chart",
		description:
			"Scope and completed work over time, charted from your project management tool, with remaining work and the recent rate of closing.",
		heroEmojis: ["📉", "📈", "🎯"],
		templateType: "BURNDOWN" as const,
		category: CATEGORY_DEVELOPMENT,
		tags: ["burndown", "burnup", "chart", "standard"],
		outputFormat: "HTML" as const,
		connections: connections(BURN_CHART_SOURCES),
		definition: {
			dataSources: dataSources(BURN_CHART_SOURCES),
			aiAgents: [
				{
					agentId: "default",
					task: `Generate a burndown and burnup chart report as a visual HTML page for the period in the \`reportPeriod\` parameter.

${READING_THE_DATA}

## Building the Series

1. Use \`createdPerPeriod.byWeek\` and \`closedPerPeriod.byWeek\`, whose keys are the Monday that starts each week. Use \`byMonth\` when the period is longer than six months.
2. **Burnup**: one line for scope (running total of created items) and one for done (running total of closed items).
3. **Burndown**: remaining work is scope minus done, for each week.
4. Count items. Use points or estimates only when the item fields carry them on the items you chart, and say which you used.
5. Show an ideal line only when the \`targetDate\` parameter gives an end date. Without one, leave it out and say so.
6. Show a projected finish only as arithmetic: remaining work divided by the mean closed per week over the last four weeks. Label it a projection.
7. When the source gives no per-period counts, show the current \`open\` and \`closed\` totals and say the charts are not available and why.

## Output Format

Generate a complete, self-contained HTML page: a headline with remaining work and the recent rate of closing, the burnup chart, the burndown chart, and a table of the weekly numbers behind them.
The HTML must be production-quality: responsive, accessible, light-only self-contained theme (no @media (prefers-color-scheme: dark) block; declare <meta name="color-scheme" content="light"> and color-scheme: light), charts drawn with inline SVG, no external dependencies.

IMPORTANT: The output must be a complete HTML document starting with <!DOCTYPE html>. Do not wrap in markdown code fences. Do not include any text before or after the HTML.`,
					outputVariable: "html_report",
				},
			],
			sections: [
				{
					id: "visual-report",
					title: "",
					type: "ai-generated" as const,
					config: {
						outputVariable: "html_report",
						wrapperTemplate: "{{content}}",
					},
				},
			],
		},
		parameters: parameters("Last 3 months", {
			targetDate: {
				type: "string",
				format: "date",
				description: "The date the work should finish (optional)",
			},
		}),
	},
	{
		key: "release-summary",
		name: "Release Notes / Release Summary",
		description:
			"What shipped in a period or release, grouped for readers, from the work your project management tool closed and, when connected, your repository.",
		heroEmojis: ["🚀", "📝", "📦"],
		templateType: "FEATURE_SUMMARY" as const,
		category: CATEGORY_DEVELOPMENT,
		tags: ["release-notes", "release", "standard"],
		outputFormat: "MARKDOWN" as const,
		connections: connections(RELEASE_SOURCES),
		definition: {
			dataSources: dataSources(RELEASE_SOURCES),
			aiAgents: [
				{
					agentId: "default",
					task: `Write release notes for the period in the \`reportPeriod\` parameter, under the name in the \`releaseName\` parameter when it is set. Do not make up a version number.

${OPENING_LINE}

${READING_THE_DATA}

## Choosing What Goes In

An item belongs in these notes when it closed in the period: \`closedCardsByDay\` lists it under a day in the period or, without that fact, its own close date or last activity falls in the period. The number closed in the period comes from \`closedPerPeriod\`. \`byTag\` covers the whole board, not the period, so use it only to read how the team names its work.

## Report Structure

### Summary
Two or three sentences on what this release gives its readers.

### New
### Improved
### Fixed
Group items under these by their tags or titles, written for someone who does not read the board. Leave out a heading with nothing under it. Drop internal chores.

### Changes in Code
${CHANGES_FROM_THE_REPOSITORY}

### Breaking Changes and Known Issues
Only what an item or pull request states. Otherwise say none were recorded.`,
					outputVariable: "release_notes",
				},
			],
			sections: markdownReport({
				title: "Release Notes",
				sectionTitle: "Release Notes",
				outputVariable: "release_notes",
			}),
		},
		parameters: parameters("Last 2 weeks", {
			releaseName: {
				type: "string",
				description: "Release name or version (optional)",
				aiDefault: false,
			},
		}),
	},
	{
		key: "velocity",
		name: "Velocity Report",
		description:
			"How much work the team closes per week and month, how that is trending, and whether scope is growing faster than it closes.",
		heroEmojis: ["⚡", "📊", "📈"],
		templateType: "SPRINT_COMPLETION" as const,
		category: CATEGORY_DEVELOPMENT,
		tags: ["velocity", "throughput", "standard"],
		outputFormat: "MARKDOWN" as const,
		connections: connections(VELOCITY_SOURCES),
		definition: {
			dataSources: dataSources(VELOCITY_SOURCES),
			aiAgents: [
				{
					agentId: "default",
					task: `Write a velocity report for the period in the \`reportPeriod\` parameter.

${OPENING_LINE}

${READING_THE_DATA}

## Report Structure

### Summary
Two or three sentences: the current rate of closing and which way it is moving.

### Throughput
A table per week from \`closedPerPeriod.byWeek\` and \`createdPerPeriod.byWeek\`, with closed, created and the difference. Add a monthly table from \`byMonth\` when the period is longer than eight weeks.

### Trend
The mean and median closed per week over the last four weeks and over the whole period, worked out from the table. Say plainly whether scope is growing faster than it closes.

### Unit
Velocity here counts items. Use points or estimates only when the item fields carry them on the closed items, and say so. Otherwise write "Story points: Not available".

### By Person
Closed work from \`byAssignee\`, as context for capacity, never as a ranking.

### Code Throughput
${CHANGES_FROM_THE_REPOSITORY}

### Recommendations
Two or three suggestions, each tied to a number above.`,
					outputVariable: "velocity_report",
				},
			],
			sections: markdownReport({
				title: "Velocity Report",
				sectionTitle: "Velocity",
				outputVariable: "velocity_report",
			}),
		},
		parameters: parameters("Last 3 months"),
	},
	{
		key: "engineering-metrics",
		name: "Engineering Metrics Report (DORA-style)",
		description:
			"Deployment frequency, lead time, change failure rate and time to restore, from what your repository records. A metric your tools cannot supply is reported as not available.",
		heroEmojis: ["🛠️", "📏", "🔁"],
		templateType: "INTEGRATION_ACTIVITY" as const,
		category: CATEGORY_DEVELOPMENT,
		tags: ["dora", "engineering", "devops", "standard"],
		outputFormat: "MARKDOWN" as const,
		connections: connections(ENGINEERING_METRICS_SOURCES),
		definition: {
			dataSources: dataSources(ENGINEERING_METRICS_SOURCES),
			aiAgents: [
				{
					agentId: "default",
					task: `Write a DORA-style engineering metrics report for the period in the \`reportPeriod\` parameter.

${OPENING_LINE}

${READING_THE_DATA}

## The Four Metrics

Report each with its value, what it was worked out from, and how many records it rests on:

1. **Deployment frequency**: from deployment records in the period. Without them, count the releases published in the period, labelled as a proxy. Without releases, count merges to the default branch, labelled as a proxy. Deployment records can come from many sources, such as commits a deployment pipeline writes; when the records you could read cover only part of the period and the releases you read reach back to its start, report the release count for the whole period as the value, labelled as a proxy, and give the deployment-record count with the dates it covers beside it.
2. **Lead time for changes**: from commit to deployment when both are recorded. Otherwise the median time from opened to merged for the pull requests merged in the period, labelled as a proxy.
3. **Change failure rate**: failed deployments divided by deployments. Without failure records, count the pull requests merged in the period whose titles mark a revert or a hotfix and divide by the deployment count above, labelled as a proxy.
4. **Time to restore service**: from incident or outage records with start and end times.

Listings are read back to the start of the period for you where the tool allows it. When a listing still covers only part of the period, work out the value over the dates it covers, give those dates and the count, and label it partial. A partial value is a result, not "Not available".

A metric is "Not available" only when neither its records nor its proxy can be read from the connected tools, naming the record that would supply it. A proxy with a stated count is a result: report it rather than "Not available". Do not place a metric in an Elite, High, Medium or Low band unless its value rests on the real records rather than a proxy.

## Report Structure

### Summary
What the available metrics say, and which ones cannot be measured from the connected tools.

### Metrics
A table with Metric, Value, Basis, Records.

### Delivery Flow
From the project management source when one is connected: \`closedPerPeriod\` and \`createdPerPeriod\`, as context for the metrics above and never as a substitute for them.

### What to Improve
Two or three suggestions, each tied to a number above, including the records worth starting to keep.`,
					outputVariable: "engineering_metrics",
				},
			],
			sections: markdownReport({
				title: "Engineering Metrics",
				sectionTitle: "Engineering Metrics",
				outputVariable: "engineering_metrics",
			}),
		},
		parameters: parameters("Last 3 months"),
	},
	{
		key: "monthly-review",
		name: "Monthly Business Review",
		description:
			"The month's delivery, scope, risks and priorities for leadership, from your connected tools, with space for the business figures only you hold.",
		heroEmojis: ["🗓️", "📊", "💼"],
		templateType: "MONTHLY_REPORT" as const,
		category: CATEGORY_BUSINESS,
		tags: ["monthly", "review", "executive", "standard"],
		outputFormat: "MARKDOWN" as const,
		connections: connections(BUSINESS_REVIEW_SOURCES),
		definition: {
			dataSources: dataSources(BUSINESS_REVIEW_SOURCES),
			aiAgents: [
				{
					agentId: "default",
					task: `Write an executive-ready Monthly Business Review for the period in the \`reportPeriod\` parameter.

${OPENING_LINE}

${READING_THE_DATA}

${BUSINESS_FIGURES_RULE}

## Report Structure

### Executive Summary
Two or three short paragraphs on the month.

### Month Highlights
Top three to five achievements, from closed work.

### Key Performance Indicators
| KPI | Target | Actual | Status |
|-----|--------|--------|--------|
Delivery rows from the facts: items closed this month and last from \`closedPerPeriod.byMonth\`, items created from \`createdPerPeriod.byMonth\`, \`overdue\`, \`stale\`. A target comes only from \`businessContext\`; without one write "Not available" and leave the status out. Business rows only as the Business Figures rule allows.

### Project Delivery
Open work by \`byColumn\`, and the major items closed or in flight.

### Risks and Challenges
\`overdue\`, \`stale\` and what the items say.

### Budget, People and Customers
As the Business Figures rule allows.

### Engineering Activity
${CHANGES_FROM_THE_REPOSITORY}

### Next Month's Priorities
Three to five, tied to open work or to \`businessContext\`.`,
					outputVariable: "mbr_report",
				},
			],
			sections: markdownReport({
				title: "Monthly Business Review",
				sectionTitle: "Monthly Review",
				outputVariable: "mbr_report",
			}),
		},
		parameters: businessReviewParameters("This month"),
	},
	{
		key: "quarterly-review",
		name: "Quarterly Business Review",
		description:
			"Executive-ready quarterly review with achievements, metrics, challenges, and next quarter goals, from your connected tools and the business figures you add.",
		heroEmojis: ["📈", "🎯", "💼"],
		templateType: "QUARTERLY_REPORT" as const,
		category: CATEGORY_BUSINESS,
		tags: ["quarterly", "review", "executive", "standard"],
		outputFormat: "MARKDOWN" as const,
		connections: connections(BUSINESS_REVIEW_SOURCES),
		definition: {
			dataSources: dataSources(BUSINESS_REVIEW_SOURCES),
			aiAgents: [
				{
					agentId: "default",
					task: `Write an executive-ready Quarterly Business Review. The quarter is Q\`quarter\` \`year\` from those parameters when they are set, otherwise the \`reportPeriod\` parameter. When neither is set, say no period was given.

Open with one line naming the quarter and, when each is set, the \`projectName\`, \`department\` and \`presenter\` parameters. Leave out a value that is not set. Never write an empty label or a placeholder.

${READING_THE_DATA}

${BUSINESS_FIGURES_RULE}

## Report Structure

### Executive Summary
Two or three paragraphs on the quarter.

### Quarter Highlights
Top three to five achievements with their impact, from closed work.

### Key Performance Indicators
| KPI | Target | Actual | Status |
|-----|--------|--------|--------|
Delivery rows from the facts: items closed in each month of the quarter from \`closedPerPeriod.byMonth\`, items created from \`createdPerPeriod.byMonth\`, \`overdue\`, \`stale\`. A target comes only from \`businessContext\`; without one write "Not available" and leave the status out. Business rows only as the Business Figures rule allows.

### Project Delivery
Major work completed or in flight, with open work by \`byColumn\`.

### Team Updates
Hiring, departures and structure, as the Business Figures rule allows. Workload from \`byAssignee\` is context, never a ranking.

### Challenges and Learnings
\`overdue\`, \`stale\` and what the items say.

### Customer and Stakeholder Feedback
### Budget and Resources
As the Business Figures rule allows.

### Engineering Activity
${CHANGES_FROM_THE_REPOSITORY}

### Next Quarter's Goals
Top priorities, tied to open work or to \`businessContext\`.

### Strategic Initiatives
Long-running work and its progress, from the items or \`businessContext\`.

### Appendix
The per-month numbers behind the tables above.`,
					outputVariable: "qbr_structure",
				},
			],
			sections: markdownReport({
				title: "Quarterly Business Review",
				subtitle: "Quarterly Performance Report",
				sectionTitle: "Quarterly Review",
				outputVariable: "qbr_structure",
			}),
		},
		parameters: businessReviewParameters("This quarter", {
			quarter: {
				type: "string",
				description: "Quarter (1-4)",
				aiDefault: false,
			},
			year: { type: "string", description: "Year", aiDefault: false },
			department: {
				type: "string",
				description: "Department name",
				aiDefault: false,
			},
			presenter: {
				type: "string",
				description: "Presenter name",
				aiDefault: false,
			},
		}),
	},
	{
		key: "custom-report",
		name: "Custom report",
		description:
			"Describe the report you want. It reads your connected tools when you connect them, and follows your instructions.",
		heroEmojis: ["✍️", "📄", "✨"],
		templateType: "CUSTOM" as const,
		category: "General",
		tags: ["custom", "prompt", "standard"],
		outputFormat: "MARKDOWN" as const,
		connections: connections(CUSTOM_SOURCES),
		definition: {
			dataSources: dataSources(CUSTOM_SOURCES),
			aiAgents: [
				{
					agentId: "default",
					task: `Write the report the report instructions below ask for, in the structure they ask for. Without any instructions, summarize the gathered data plainly and say that no instructions were given.

${READING_THE_DATA}

Use only the gathered data and the parameters. When no source is connected, or the instructions need data no source supplies, say what is missing rather than writing the numbers yourself.`,
					outputVariable: "custom_report",
				},
			],
			sections: [
				analysisSection("report", "Report", "custom_report", {
					wrapperTemplate: "{{content}}",
				}),
				footerSection({
					includeTimestamp: false,
					includeDisclaimer: true,
				}),
			],
		},
		parameters: { required: [], properties: {} },
	},
];
