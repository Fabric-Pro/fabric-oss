"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	DatabaseIcon,
	PlugIcon,
	PlusIcon,
	ServerIcon,
	TrashIcon,
} from "lucide-react";

// Data source definition for templates (provider only for agentic approach)
// The AI agent will automatically use read-only tools based on the provider
// Parameters and context are configured at instance level
export type DataSourceDefinition = {
	id: string;
	type: "integration" | "mcp" | "workspace" | "user-input";
	provider: string;
	// Operation is optional - only used for legacy non-agentic templates
	operation?: string;
};

// Operation parameter definition for instance-level configuration
export type OperationParameter = {
	key: string;
	label: string;
	placeholder: string;
	required?: boolean;
};

// Provider information with available operations (exported for instance configuration)
export const DATA_SOURCE_PROVIDERS: Record<
	string,
	{
		label: string;
		type: "integration" | "mcp";
		operations: { value: string; label: string; description: string }[];
	}
> = {
	// Azure DevOps MCP Server - Primary provider for sprint and work item reports
	// Tool names from: https://github.com/microsoft/azure-devops-mcp (actual MCP tool names)
	azure_devops: {
		label: "Azure DevOps",
		type: "mcp",
		operations: [
			// Sprint/Iteration operations
			{
				value: "work_list_iterations",
				label: "List Sprints/Iterations",
				description: "List all sprints/iterations for a project",
			},
			{
				value: "work_list_team_iterations",
				label: "List Team Iterations",
				description: "List iterations assigned to a team",
			},
			{
				value: "wit_get_work_items_for_iteration",
				label: "Get Sprint Work Items",
				description:
					"Get all work items in a specific sprint/iteration",
			},
			// Work item operations
			{
				value: "wit_get_work_item",
				label: "Get Work Item",
				description:
					"Get detailed information about a specific work item",
			},
			{
				value: "wit_get_work_items_batch_by_ids",
				label: "Get Work Items by IDs",
				description: "Get multiple work items by their IDs",
			},
			{
				value: "wit_my_work_items",
				label: "My Work Items",
				description: "Get work items assigned to the current user",
			},
			{
				value: "wit_get_query_results_by_id",
				label: "Run Saved Query",
				description: "Execute a saved work item query by ID",
			},
			{
				value: "wit_list_backlog_work_items",
				label: "List Backlog Items",
				description: "Get work items from the backlog",
			},
			// Team/Capacity operations
			{
				value: "work_get_team_capacity",
				label: "Get Team Capacity",
				description: "Get team capacity for a sprint",
			},
			{
				value: "work_get_iteration_capacities",
				label: "Get Iteration Capacities",
				description: "Get capacity details for an iteration",
			},
		],
	},

	// Fizzy PM - Kanban board and project management
	fizzy: {
		label: "Fizzy",
		type: "mcp",
		operations: [
			{
				value: "fizzy_get_boards",
				label: "Get Boards",
				description: "Get all boards in a Fizzy account",
			},
			{
				value: "fizzy_get_cards",
				label: "Get Cards",
				description:
					"Get all cards with optional filtering by status, column, assignees, or tags",
			},
			{
				value: "fizzy_get_card",
				label: "Get Card Details",
				description:
					"Get detailed information about a specific card including description, assignees, and steps",
			},
			{
				value: "fizzy_get_columns",
				label: "Get Columns",
				description:
					"Get all workflow columns on a board (e.g., To Do, In Progress, Done)",
			},
			{
				value: "fizzy_get_tags",
				label: "Get Tags",
				description: "Get all tags in an account",
			},
			{
				value: "fizzy_get_users",
				label: "Get Users",
				description: "Get all users in an account",
			},
			{
				value: "fizzy_get_card_comments",
				label: "Get Card Comments",
				description: "Get comments on a specific card",
			},
		],
	},

	// Hidden providers - kept for future use
	// microsoft_graph: {
	// 	label: "Microsoft Teams / Graph",
	// 	type: "integration",
	// 	operations: [
	// 		{ value: "get_channel_messages", label: "Get Channel Messages", description: "Fetch messages from a Teams channel" },
	// 		{ value: "list_channels", label: "List Channels", description: "List all channels in a team" },
	// 		{ value: "list_teams", label: "List Teams", description: "List all teams the user has access to" },
	// 		{ value: "get_user_info", label: "Get User Info", description: "Get information about the current user" },
	// 	],
	// },
	// slack: {
	// 	label: "Slack",
	// 	type: "integration",
	// 	operations: [
	// 		{ value: "slack_get_channel_history", label: "Get Channel History", description: "Fetch message history from a channel" },
	// 		{ value: "slack_list_channels", label: "List Channels", description: "List all channels in a workspace" },
	// 		{ value: "slack_search_messages", label: "Search Messages", description: "Search for messages across channels" },
	// 		{ value: "slack_list_users", label: "List Users", description: "List all users in the workspace" },
	// 	],
	// },
	// github: {
	// 	label: "GitHub",
	// 	type: "integration",
	// 	operations: [
	// 		{ value: "github_list_repos", label: "List Repositories", description: "List repositories for a user or organization" },
	// 		{ value: "github_list_prs", label: "List Pull Requests", description: "List pull requests for a repository" },
	// 		{ value: "github_list_issues", label: "List Issues", description: "List issues for a repository" },
	// 		{ value: "github_get_commits", label: "Get Commits", description: "Get commit history for a repository" },
	// 	],
	// },
	// linear: {
	// 	label: "Linear",
	// 	type: "integration",
	// 	operations: [
	// 		{ value: "linear_search_issues", label: "Search Issues", description: "Search for issues with filters" },
	// 		{ value: "linear_list_projects", label: "List Projects", description: "List all projects" },
	// 	],
	// },
	// jira: {
	// 	label: "Jira",
	// 	type: "integration",
	// 	operations: [
	// 		{ value: "jira_search_issues", label: "Search Issues (JQL)", description: "Search issues using JQL query" },
	// 		{ value: "jira_get_issue", label: "Get Issue", description: "Get a specific issue by key" },
	// 		{ value: "jira_list_projects", label: "List Projects", description: "List all projects" },
	// 	],
	// },
};

// Operation parameters for instance-level configuration (exported for CreateInstanceDialog)
// Parameter names must match the Azure DevOps MCP tool parameter schemas
export const OPERATION_PARAMS: Record<string, OperationParameter[]> = {
	// Azure DevOps operation parameters
	work_list_iterations: [
		{
			key: "project",
			label: "Project",
			placeholder: "MyProject",
			required: true,
		},
	],
	work_list_team_iterations: [
		{
			key: "project",
			label: "Project",
			placeholder: "MyProject",
			required: true,
		},
		{
			key: "team",
			label: "Team",
			placeholder: "MyTeam",
			required: true,
		},
	],
	wit_get_work_items_for_iteration: [
		{
			key: "project",
			label: "Project",
			placeholder: "MyProject",
			required: true,
		},
		{
			key: "team",
			label: "Team",
			placeholder: "MyTeam",
			required: true,
		},
		{
			key: "iteration",
			label: "Iteration Path",
			placeholder: "MyProject\\Sprint 1",
			required: true,
		},
	],
	wit_get_work_item: [
		{
			key: "project",
			label: "Project",
			placeholder: "MyProject",
			required: true,
		},
		{
			key: "id",
			label: "Work Item ID",
			placeholder: "12345",
			required: true,
		},
	],
	wit_get_work_items_batch_by_ids: [
		{
			key: "project",
			label: "Project",
			placeholder: "MyProject",
			required: true,
		},
		{
			key: "ids",
			label: "Work Item IDs",
			placeholder: "123,456,789",
			required: true,
		},
	],
	wit_my_work_items: [
		{
			key: "project",
			label: "Project",
			placeholder: "MyProject",
			required: true,
		},
	],
	wit_get_query_results_by_id: [
		{
			key: "project",
			label: "Project",
			placeholder: "MyProject",
			required: true,
		},
		{
			key: "query_id",
			label: "Saved Query ID",
			placeholder: "12345678-1234-1234-1234-123456789012",
			required: true,
		},
	],
	wit_list_backlog_work_items: [
		{
			key: "project",
			label: "Project",
			placeholder: "MyProject",
			required: true,
		},
		{
			key: "team",
			label: "Team",
			placeholder: "MyTeam",
			required: true,
		},
	],
	work_get_team_capacity: [
		{
			key: "project",
			label: "Project",
			placeholder: "MyProject",
			required: true,
		},
		{
			key: "team",
			label: "Team",
			placeholder: "MyTeam",
			required: true,
		},
		{
			key: "iteration_id",
			label: "Iteration ID",
			placeholder: "12345678-1234-1234-1234-123456789012",
			required: true,
		},
	],
	work_get_iteration_capacities: [
		{
			key: "project",
			label: "Project",
			placeholder: "MyProject",
			required: true,
		},
		{
			key: "team",
			label: "Team",
			placeholder: "MyTeam",
			required: true,
		},
		{
			key: "iteration_id",
			label: "Iteration ID",
			placeholder: "12345678-1234-1234-1234-123456789012",
			required: true,
		},
	],

	// Fizzy operation parameters
	fizzy_get_boards: [
		{
			key: "account_slug",
			label: "Account Slug",
			placeholder: "123456",
			required: true,
		},
	],
	fizzy_get_cards: [
		{
			key: "account_slug",
			label: "Account Slug",
			placeholder: "123456",
			required: true,
		},
		{
			key: "column_id",
			label: "Column ID",
			placeholder: "Filter by column (optional)",
		},
		{
			key: "status",
			label: "Status",
			placeholder: "draft | published | archived",
		},
	],
	fizzy_get_card: [
		{
			key: "account_slug",
			label: "Account Slug",
			placeholder: "123456",
			required: true,
		},
		{
			key: "card_id",
			label: "Card ID",
			placeholder: "123",
			required: true,
		},
	],
	fizzy_get_columns: [
		{
			key: "account_slug",
			label: "Account Slug",
			placeholder: "123456",
			required: true,
		},
		{
			key: "board_id",
			label: "Board ID",
			placeholder: "12345",
			required: true,
		},
	],
	fizzy_get_tags: [
		{
			key: "account_slug",
			label: "Account Slug",
			placeholder: "123456",
			required: true,
		},
	],
	fizzy_get_users: [
		{
			key: "account_slug",
			label: "Account Slug",
			placeholder: "123456",
			required: true,
		},
	],
	fizzy_get_card_comments: [
		{
			key: "account_slug",
			label: "Account Slug",
			placeholder: "123456",
			required: true,
		},
		{
			key: "card_id",
			label: "Card ID",
			placeholder: "123",
			required: true,
		},
	],

	// Hidden provider parameters - kept for future use
	// get_channel_messages: [
	// 	{ key: "channelId", label: "Channel ID", placeholder: "{{channelId}} or specific ID" },
	// 	{ key: "limit", label: "Limit", placeholder: "100" },
	// ],
	// list_channels: [{ key: "teamId", label: "Team ID", placeholder: "{{teamId}}" }],
	// slack_get_channel_history: [
	// 	{ key: "channel", label: "Channel ID", placeholder: "C01234567", required: true },
	// 	{ key: "limit", label: "Limit", placeholder: "100" },
	// ],
	// slack_list_channels: [{ key: "limit", label: "Limit", placeholder: "100" }],
	// slack_search_messages: [{ key: "query", label: "Search Query", placeholder: "from:@user keyword" }],
	// github_list_repos: [{ key: "org", label: "Organization", placeholder: "my-org (optional)" }],
	// github_list_prs: [
	// 	{ key: "owner", label: "Owner", placeholder: "owner", required: true },
	// 	{ key: "repo", label: "Repository", placeholder: "repo", required: true },
	// 	{ key: "state", label: "State", placeholder: "open | closed | all" },
	// ],
	// github_list_issues: [
	// 	{ key: "owner", label: "Owner", placeholder: "owner", required: true },
	// 	{ key: "repo", label: "Repository", placeholder: "repo", required: true },
	// 	{ key: "state", label: "State", placeholder: "open | closed | all" },
	// ],
	// github_get_commits: [
	// 	{ key: "owner", label: "Owner", placeholder: "owner", required: true },
	// 	{ key: "repo", label: "Repository", placeholder: "repo", required: true },
	// ],
	// linear_search_issues: [
	// 	{ key: "filter", label: "Filter (JSON)", placeholder: '{"state": {"name": {"eq": "In Progress"}}}' },
	// ],
	// jira_search_issues: [
	// 	{ key: "jql", label: "JQL Query", placeholder: 'project = "PROJ" AND status = "In Progress"', required: true },
	// ],
	// jira_get_issue: [{ key: "issueKey", label: "Issue Key", placeholder: "PROJ-123", required: true }],
};

// Provider-level context fields for AI-driven data gathering
// These are human-readable values that the AI uses to find specific resources
export type ProviderContextField = {
	key: string;
	label: string;
	placeholder: string;
	required: boolean;
	helpText: string;
};

export const PROVIDER_CONTEXT_FIELDS: Record<string, ProviderContextField[]> = {
	azure_devops: [
		{
			key: "project",
			label: "Project Name",
			placeholder: "MyProject",
			required: true,
			helpText: "The Azure DevOps project name",
		},
		{
			key: "team",
			label: "Team Name",
			placeholder: "MyTeam",
			required: false,
			helpText: "The team name within the project (optional)",
		},
	],
	fizzy: [
		{
			key: "accountSlug",
			label: "Account Slug",
			placeholder: "123456",
			required: true,
			helpText:
				"The Fizzy account slug (e.g., '123456'). Find it via fizzy_get_identity.",
		},
		{
			key: "boardId",
			label: "Board",
			placeholder: "12345",
			required: true,
			helpText: "The Fizzy board to report on",
		},
		{
			key: "boardName",
			label: "Board Name",
			placeholder: "My Board",
			required: false,
			helpText:
				"Board name to help AI identify the right board (optional)",
		},
	],
	github: [
		{
			key: "organization",
			label: "Organization",
			placeholder: "my-org",
			required: true,
			helpText: "GitHub organization or username",
		},
		{
			key: "repository",
			label: "Repository",
			placeholder: "my-repo",
			required: false,
			helpText: "Repository name (optional, for repo-specific reports)",
		},
	],
	slack: [
		{
			key: "channels",
			label: "Channels",
			placeholder: "general, engineering",
			required: false,
			helpText: "Comma-separated channel names to focus on (optional)",
		},
	],
	linear: [
		{
			key: "team",
			label: "Team Name",
			placeholder: "Engineering",
			required: true,
			helpText: "Linear team name",
		},
	],
	jira: [
		{
			key: "project",
			label: "Project Key",
			placeholder: "PROJ",
			required: true,
			helpText: "Jira project key",
		},
	],
	microsoft_graph: [
		{
			key: "team",
			label: "Team Name",
			placeholder: "Engineering Team",
			required: false,
			helpText: "Microsoft Teams team name (optional)",
		},
		{
			key: "channels",
			label: "Channels",
			placeholder: "General, Announcements",
			required: false,
			helpText: "Comma-separated channel names (optional)",
		},
	],
};

type DataSourceItemProps = {
	dataSource: DataSourceDefinition;
	index: number;
	onUpdate: (updates: Partial<DataSourceDefinition>) => void;
	onRemove: () => void;
	onMoveUp?: () => void;
	onMoveDown?: () => void;
	isFirst: boolean;
	isLast: boolean;
	readOnly?: boolean;
};

function DataSourceItem({
	dataSource,
	index: _index,
	onUpdate,
	onRemove,
	onMoveUp,
	onMoveDown,
	isFirst,
	isLast,
	readOnly = false,
}: DataSourceItemProps) {
	const provider = DATA_SOURCE_PROVIDERS[dataSource.provider];

	const typeColors = {
		integration: {
			bg: "bg-pink-50 dark:bg-pink-950/30",
			border: "border-pink-200 dark:border-pink-800",
			icon: "text-pink-600 dark:text-pink-400",
			iconBg: "bg-pink-100 dark:bg-pink-900",
		},
		mcp: {
			bg: "bg-blue-50 dark:bg-blue-950/30",
			border: "border-blue-200 dark:border-blue-800",
			icon: "text-muted-foreground",
			iconBg: "bg-blue-100 dark:bg-blue-900",
		},
		workspace: {
			bg: "bg-amber-50 dark:bg-amber-950/30",
			border: "border-amber-200 dark:border-amber-800",
			icon: "text-highlight",
			iconBg: "bg-amber-100 dark:bg-amber-900",
		},
		"user-input": {
			bg: "bg-slate-50 dark:bg-slate-950/30",
			border: "border-slate-200 dark:border-slate-800",
			icon: "text-slate-600 dark:text-slate-400",
			iconBg: "bg-slate-100 dark:bg-slate-900",
		},
	};

	const colors = typeColors[dataSource.type];

	// Get context fields for this provider (for display)
	const contextFields = PROVIDER_CONTEXT_FIELDS[dataSource.provider] || [];

	return (
		<Card className={cn("border transition-all", colors.bg, colors.border)}>
			<CardContent className="p-4">
				<div className="flex items-center gap-3">
					{/* Reorder buttons */}
					{!readOnly && (
						<div className="flex flex-col gap-0.5">
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="h-5 w-5"
								onClick={onMoveUp}
								disabled={isFirst}
							>
								<ChevronUpIcon className="h-3 w-3" />
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="h-5 w-5"
								onClick={onMoveDown}
								disabled={isLast}
							>
								<ChevronDownIcon className="h-3 w-3" />
							</Button>
						</div>
					)}

					{/* Icon */}
					<div
						className={cn(
							"p-2 rounded-lg",
							colors.iconBg,
							colors.icon,
						)}
					>
						{dataSource.type === "integration" ? (
							<PlugIcon className="h-4 w-4" />
						) : (
							<ServerIcon className="h-4 w-4" />
						)}
					</div>

					{/* Provider Select only - tools are auto-configured */}
					<div className="flex-1">
						<Select
							value={dataSource.provider}
							onValueChange={(value) => {
								const newProvider =
									DATA_SOURCE_PROVIDERS[value];
								onUpdate({
									provider: value,
									type: newProvider?.type || "mcp",
								});
							}}
							disabled={readOnly}
						>
							<SelectTrigger
								className={cn(
									"h-9 max-w-xs",
									readOnly ? "bg-muted" : "",
								)}
							>
								<SelectValue placeholder="Select data source" />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(DATA_SOURCE_PROVIDERS).map(
									([key, prov]) => (
										<SelectItem key={key} value={key}>
											{prov.label}
										</SelectItem>
									),
								)}
							</SelectContent>
						</Select>
					</div>

					{/* Info & Delete */}
					<div className="flex items-center gap-2">
						{contextFields.length > 0 && (
							<Badge
								variant="secondary"
								className="text-xs whitespace-nowrap"
							>
								{contextFields.filter((f) => f.required).length}{" "}
								required field
								{contextFields.filter((f) => f.required)
									.length !== 1
									? "s"
									: ""}
							</Badge>
						)}
						{!readOnly && (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="h-8 w-8 text-destructive hover:text-destructive"
								onClick={onRemove}
							>
								<TrashIcon className="h-4 w-4" />
							</Button>
						)}
					</div>
				</div>

				{/* Provider description - explain what tools will be used */}
				{provider && (
					<p className="mt-2 text-xs text-muted-foreground ml-[52px]">
						AI will automatically use read-only{" "}
						{provider.label.toLowerCase()} tools to gather data
						based on your context
					</p>
				)}
			</CardContent>
		</Card>
	);
}

type DataSourceDefinitionBuilderProps = {
	dataSources: DataSourceDefinition[];
	onChange: (dataSources: DataSourceDefinition[]) => void;
	readOnly?: boolean;
};

export function DataSourceDefinitionBuilder({
	dataSources,
	onChange,
	readOnly = false,
}: DataSourceDefinitionBuilderProps) {
	const addDataSource = () => {
		const newId = `ds-${Date.now()}`;
		const newDataSource: DataSourceDefinition = {
			id: newId,
			type: "mcp",
			provider: "azure_devops",
			// No operation - AI will auto-select read-only tools based on provider
		};
		onChange([...dataSources, newDataSource]);
	};

	const updateDataSource = (
		index: number,
		updates: Partial<DataSourceDefinition>,
	) => {
		const updated = [...dataSources];
		updated[index] = { ...updated[index], ...updates };
		onChange(updated);
	};

	const removeDataSource = (index: number) => {
		onChange(dataSources.filter((_, i) => i !== index));
	};

	const moveDataSource = (index: number, direction: "up" | "down") => {
		const newIndex = direction === "up" ? index - 1 : index + 1;
		if (newIndex < 0 || newIndex >= dataSources.length) {
			return;
		}
		const updated = [...dataSources];
		[updated[index], updated[newIndex]] = [
			updated[newIndex],
			updated[index],
		];
		onChange(updated);
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<h3 className="text-lg font-semibold flex items-center gap-2">
						<DatabaseIcon className="h-5 w-5 text-primary" />
						Data Sources
					</h3>
					<p className="text-sm text-muted-foreground">
						Select the data sources for this report. The AI will
						automatically use read-only tools to gather the
						necessary data.
					</p>
				</div>
				{!readOnly && (
					<Button
						type="button"
						variant="outline"
						onClick={addDataSource}
					>
						<PlusIcon className="mr-2 h-4 w-4" />
						Add Data Source
					</Button>
				)}
			</div>

			{dataSources.length === 0 ? (
				<Card className="border-dashed">
					<CardContent className="py-8 text-center">
						<DatabaseIcon className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
						<h4 className="font-medium text-muted-foreground">
							No data sources defined
						</h4>
						<p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
							{readOnly
								? "This template has no data sources configured."
								: "Add a data source provider. The AI will automatically use read-only tools to gather the data needed for report generation."}
						</p>
						{!readOnly && (
							<Button
								type="button"
								variant="default"
								className="mt-4"
								onClick={addDataSource}
							>
								<PlusIcon className="mr-2 h-4 w-4" />
								Add First Data Source
							</Button>
						)}
					</CardContent>
				</Card>
			) : (
				<div className="space-y-3">
					{dataSources.map((dataSource, index) => (
						<DataSourceItem
							key={dataSource.id}
							dataSource={dataSource}
							index={index}
							onUpdate={(updates) =>
								updateDataSource(index, updates)
							}
							onRemove={() => removeDataSource(index)}
							onMoveUp={() => moveDataSource(index, "up")}
							onMoveDown={() => moveDataSource(index, "down")}
							isFirst={index === 0}
							isLast={index === dataSources.length - 1}
							readOnly={readOnly}
						/>
					))}
				</div>
			)}
		</div>
	);
}
