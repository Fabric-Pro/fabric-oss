"use client";

import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	BookOpenIcon,
	BrainIcon,
	FlaskConicalIcon,
	GlobeIcon,
	ListTodoIcon,
	MailIcon,
	MegaphoneIcon,
	SettingsIcon,
	UsersIcon,
	WorkflowIcon,
} from "lucide-react";
import type { ComponentType } from "react";

export type SettingsTab =
	| "general"
	| "knowledge"
	| "development"
	| "project-management"
	| "members"
	| "retrieval"
	| "environments"
	| "testing"
	| "newsletter"
	| "publishing"
	| "danger";

type TabItem = {
	id: SettingsTab;
	label: string;
	icon: ComponentType<{ className?: string }>;
	description: string;
	destructive?: boolean;
};

const TABS: TabItem[] = [
	{
		id: "general",
		label: "General",
		icon: SettingsIcon,
		description: "Name, description, types",
	},
	{
		id: "knowledge",
		label: "Knowledge",
		icon: BookOpenIcon,
		description: "PRD sources, transcripts",
	},
	{
		id: "development",
		label: "Development",
		icon: WorkflowIcon,
		description: "Repos, local dev",
	},
	{
		id: "project-management",
		label: "Project Management",
		icon: ListTodoIcon,
		description: "PM tool connection & field mapping",
	},
	{
		id: "members",
		label: "Members",
		icon: UsersIcon,
		description: "Team access & invitations",
	},
	{
		id: "retrieval",
		label: "Retrieval",
		icon: BrainIcon,
		description: "RAG config & chunking",
	},
	{
		id: "environments",
		label: "Environments",
		icon: GlobeIcon,
		description: "Deployment targets",
	},
	{
		id: "testing",
		label: "Testing",
		icon: FlaskConicalIcon,
		description: "Policy, depth, CI, sceptics",
	},
	{
		id: "newsletter",
		label: "Newsletter",
		icon: MailIcon,
		description: "External release notes & subscribers",
	},
	{
		id: "publishing",
		label: "Publishing Suite",
		icon: MegaphoneIcon,
		description: "Suggestion cadence & lookback",
	},
	{
		id: "danger",
		label: "Danger Zone",
		icon: AlertTriangleIcon,
		description: "Delete project",
		destructive: true,
	},
];

type StatusMap = Partial<Record<SettingsTab, boolean>>;

type Props = {
	activeTab: SettingsTab;
	onTabChange: (tab: SettingsTab) => void;
	status?: StatusMap;
	showDanger?: boolean;
	/** Gates the new Project Management tab behind the per-project
	 *  `pmFieldMappingEnabled` flag. When off, the PM card lives on Development. */
	showProjectManagement?: boolean;
	/** Gates the QA pair (Environments, Testing) behind the same flag as the QA
	 *  project tab. Both configure QA only, so showing them while the QA page is
	 *  hidden offers settings for a surface the user cannot open. */
	showQa?: boolean;
	/** Gates the Publishing Suite tab behind `NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE`,
	 *  same reasoning as `showQa` — no settings for a surface the flag hides. */
	showPublishing?: boolean;
};

export function ProjectSettingsNav({
	activeTab,
	onTabChange,
	status,
	showDanger = false,
	showProjectManagement = false,
	showQa = false,
	showPublishing = false,
}: Props) {
	const visibleTabs = TABS.filter((tab) => {
		if (tab.id === "danger") {
			return showDanger;
		}
		if (tab.id === "project-management") {
			return showProjectManagement;
		}
		if (tab.id === "environments" || tab.id === "testing") {
			return showQa;
		}
		if (tab.id === "publishing") {
			return showPublishing;
		}
		return true;
	});

	return (
		<nav
			data-onboarding-target="project-settings-nav"
			className="flex flex-row gap-1 overflow-x-auto pb-2 lg:w-[200px] lg:shrink-0 lg:flex-col lg:overflow-x-visible lg:pb-0"
			aria-label="Settings sections"
		>
			{visibleTabs.map((tab) => {
				const Icon = tab.icon;
				const isActive = activeTab === tab.id;
				const isConfigured = status?.[tab.id];

				return (
					<button
						key={tab.id}
						type="button"
						onClick={() => onTabChange(tab.id)}
						className={cn(
							"group flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors whitespace-nowrap lg:whitespace-normal cursor-pointer",
							isActive
								? "bg-accent text-foreground"
								: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
							tab.destructive &&
								isActive &&
								"bg-destructive/10 text-destructive",
							tab.destructive &&
								!isActive &&
								"hover:bg-destructive/5 hover:text-destructive",
						)}
					>
						<Icon
							className={cn(
								"size-4 shrink-0",
								tab.destructive && "text-destructive/70",
							)}
						/>
						<div className="hidden min-w-0 lg:block">
							<div className="flex items-center gap-2">
								<span className="font-medium text-[13px]">
									{tab.label}
								</span>
								{isConfigured && !tab.destructive && (
									<span className="size-1.5 rounded-full bg-emerald-500" />
								)}
							</div>
							<p
								className={cn(
									"text-xs text-muted-foreground/70 truncate",
									isActive && "text-muted-foreground",
								)}
							>
								{tab.description}
							</p>
						</div>
						{/* Mobile: show dot inline */}
						{isConfigured && !tab.destructive && (
							<span className="size-1.5 rounded-full bg-emerald-500 lg:hidden" />
						)}
					</button>
				);
			})}
		</nav>
	);
}
