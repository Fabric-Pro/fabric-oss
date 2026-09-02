/**
 * The project tab bar's full static tab list, flag-gated tabs included.
 *
 * It lives in its own module because two components need it and one of them is
 * rendered by the other: `ProjectDetails` owns the tab bar, and the readiness
 * panel needs the same list to tell whether a checklist item's call to action
 * leads anywhere THIS viewer can reach. A checklist item targeting a tab that is
 * filtered out for them lands on Overview in silence, so the button reads as
 * broken — and `ProjectDetails` already imports the panel, so the panel cannot
 * import back without a cycle.
 *
 * Flag-gated tabs stay in the list: this is the set of tabs that exist, not the
 * set a given viewer sees. `resolveProjectTabs` narrows it per viewer.
 *
 * Three tests parse this array by source rather than importing it, so that a tab
 * renamed here cannot silently orphan a readiness target, a Get Started tour, or
 * a stored tab preference. Keep the literal shape (`const tabs = [` ... `] as
 * const;`) they look for.
 */

import {
	ActivityIcon,
	BotIcon,
	CalendarDaysIcon,
	ClipboardCheckIcon,
	ClipboardListIcon,
	CombineIcon,
	FileTextIcon,
	FolderIcon,
	LayoutDashboardIcon,
	MapIcon,
	MegaphoneIcon,
	NetworkIcon,
	NewspaperIcon,
	PenToolIcon,
	ReceiptIcon,
	RocketIcon,
	ScrollTextIcon,
	SettingsIcon,
	ShieldCheckIcon,
	WorkflowIcon,
} from "lucide-react";

export const tabs = [
	{
		id: "overview",
		label: "Overview",
		icon: LayoutDashboardIcon,
	},
	{
		id: "daily-brief",
		label: "Daily Brief",
		icon: NewspaperIcon,
	},
	{ id: "meeting-digest", label: "Meeting Digest", icon: CalendarDaysIcon },
	{
		id: "release-notes",
		label: "Release Notes",
		icon: RocketIcon,
	},
	{
		id: "documents",
		label: "Documents",
		icon: FileTextIcon,
	},
	{
		id: "decisions",
		label: "Decisions",
		icon: ScrollTextIcon,
	},
	{
		id: "context",
		label: "Context",
		icon: FolderIcon,
	},
	{
		id: "pipeline",
		label: "Pipeline",
		icon: WorkflowIcon,
	},
	{
		id: "stories",
		label: "Roadmap",
		icon: MapIcon,
	},
	{
		id: "test-cases",
		// Displayed as "Testing": the tab covers the whole quality surface —
		// cases, plans, runs, findings and coverage — not just case authoring,
		// and "Testing" says what happens here to someone who does not read "QA"
		// as a job title. The ID stays `test-cases` deliberately: it is persisted
		// in sessionStorage and is the onboarding anchor
		// (`project-tab-test-cases`), so renaming it would strand open sessions
		// and break "Show me" for no visible gain. Same display-name-vs-identifier
		// split as UserStory/"Features".
		label: "Testing",
		icon: ClipboardCheckIcon,
	},
	{
		id: "publishing-suite",
		label: "Publishing Suite",
		icon: MegaphoneIcon,
	},
	{
		id: "weave",
		label: "Weave",
		icon: CombineIcon,
	},
	{
		id: "kanban",
		label: "Coding Agents",
		icon: BotIcon,
	},
	{
		id: "agent-activity",
		label: "Agent Activity",
		// Not BotIcon: Coding Agents already owns it, and the tab bar shows
		// icons without labels, so two tabs on one glyph are indistinguishable.
		icon: ActivityIcon,
	},
	{
		id: "diagrams",
		label: "Diagrams",
		icon: PenToolIcon,
	},
	{
		id: "reports",
		label: "Reports",
		icon: ClipboardListIcon,
	},
	{
		id: "usage",
		label: "Usage",
		icon: ReceiptIcon,
	},
	// {
	// 	id: "artifacts",
	// 	label: "Artifacts",
	// 	icon: CodeIcon,
	// },
	{
		id: "atlas",
		label: "Atlas",
		icon: NetworkIcon,
	},
	{
		id: "security",
		label: "Security",
		icon: ShieldCheckIcon,
	},
	{
		id: "settings",
		label: "Settings",
		icon: SettingsIcon,
	},
] as const;

export type TabId = (typeof tabs)[number]["id"];

/** Whether a stored or deep-linked value names a tab that exists at all. */
export const isTabId = (value: string): value is TabId =>
	tabs.some((t) => t.id === value);
