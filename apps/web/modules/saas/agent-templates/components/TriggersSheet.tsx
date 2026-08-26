"use client";

/**
 * Triggers Sheet
 * Side drawer for configuring agent triggers (schedule, webhook, Slack, etc.)
 */

import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { ScrollArea } from "@ui/components/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Switch } from "@ui/components/switch";
import { cn } from "@ui/lib";
import {
	CalendarIcon,
	InfoIcon,
	MessageSquareIcon,
	RouteIcon,
	WebhookIcon,
	ZapIcon,
} from "lucide-react";
import { useState } from "react";

// Trigger type definitions
export interface TriggerConfig {
	type: string;
	enabled: boolean;
	config?: Record<string, unknown>;
}

interface ScheduleConfig {
	[key: string]: unknown;
	cron?: string;
	timezone?: string;
}

interface WebhookConfig {
	[key: string]: unknown;
	path?: string;
	secret?: string;
}

interface SlackConfig {
	[key: string]: unknown;
	channelId?: string;
	teamId?: string;
	mentionOnly?: boolean;
	/** Whether to reply in Slack threads */
	replyInThreads?: boolean;
	/** How long to keep Slack conversations active (hours) */
	threadTimeoutHours?: number;
	/** Whether to respond to direct messages */
	respondToDms?: boolean;
}

interface LifecycleConfig {
	[key: string]: unknown;
	resource?: "story" | "task" | "comment" | "coding_run";
	event?: "created" | "status_changed" | "completed";
	conditions?: Record<string, unknown>;
}

const TRIGGER_TYPES = [
	{
		id: "manual",
		label: "Manual",
		icon: RobotIcon,
		description: "Run manually via chat interface or API calls",
		alwaysEnabled: true,
		configurable: false,
	},
	{
		id: "schedule",
		label: "Schedule",
		icon: CalendarIcon,
		description: "Run automatically on a schedule using cron expressions",
		alwaysEnabled: false,
		configurable: true,
	},
	{
		id: "webhook",
		label: "Webhook",
		icon: WebhookIcon,
		description: "Trigger via HTTP POST requests to a unique endpoint",
		alwaysEnabled: false,
		configurable: true,
	},
	{
		id: "slack",
		label: "Slack",
		icon: MessageSquareIcon,
		description: "Respond to messages in Slack channels",
		alwaysEnabled: false,
		configurable: true,
		requiresIntegration: "SLACK",
	},
	{
		id: "lifecycle",
		label: "Lifecycle event",
		icon: RouteIcon,
		description:
			"Run when project work changes, such as task completion or feature status changes",
		alwaysEnabled: false,
		configurable: true,
	},
];

const COMMON_SCHEDULES = [
	{ label: "Every hour", cron: "0 * * * *" },
	{ label: "Every day at 9 AM", cron: "0 9 * * *" },
	{ label: "Weekdays at 9 AM", cron: "0 9 * * 1-5" },
	{ label: "Every Monday at 9 AM", cron: "0 9 * * 1" },
	{ label: "First of month at 9 AM", cron: "0 9 1 * *" },
];

const LIFECYCLE_EVENT_OPTIONS = {
	story: [
		{ value: "created", label: "Created" },
		{ value: "status_changed", label: "Status changed" },
	],
	task: [
		{ value: "created", label: "Created" },
		{ value: "completed", label: "Completed" },
	],
	comment: [{ value: "created", label: "Created" }],
	coding_run: [{ value: "completed", label: "Completed" }],
} as const;

// Suggested condition keys per (resource, event). The dispatcher forwards the
// `data` payload from each emitter; only fields that actually appear there are
// useful as conditions. Users can still type free-form keys for fields we
// haven't documented yet.
const LIFECYCLE_CONDITION_SUGGESTIONS: Record<
	string,
	Record<string, Array<{ key: string; placeholder: string; hint?: string }>>
> = {
	story: {
		created: [
			{
				key: "aiDrafted",
				placeholder: "true",
				hint: "true | false",
			},
			{ key: "statusId", placeholder: "status id" },
		],
		status_changed: [
			{
				key: "statusName",
				placeholder: "In Review",
				hint: "matches the new column name",
			},
			{
				key: "previousStatusId",
				placeholder: "previous status id",
			},
		],
	},
	task: {
		created: [{ key: "storyId", placeholder: "feature id" }],
		completed: [{ key: "storyId", placeholder: "feature id" }],
	},
	comment: {
		created: [
			{
				key: "hasFabricMention",
				placeholder: "true",
				hint: "true | false",
			},
			{ key: "storyId", placeholder: "feature id" },
		],
	},
	coding_run: {
		completed: [
			{ key: "storyId", placeholder: "feature id" },
			{ key: "storyTaskId", placeholder: "task id" },
		],
	},
};

const LIFECYCLE_RESOURCE_LABELS = {
	story: "Feature",
	task: "Task",
	comment: "Comment",
	coding_run: "Implementation session",
} as const;

const TIMEZONES = [
	{ value: "UTC", label: "UTC" },
	{ value: "America/New_York", label: "Eastern Time (US)" },
	{ value: "America/Chicago", label: "Central Time (US)" },
	{ value: "America/Denver", label: "Mountain Time (US)" },
	{ value: "America/Los_Angeles", label: "Pacific Time (US)" },
	{ value: "Europe/London", label: "London" },
	{ value: "Europe/Paris", label: "Paris" },
	{ value: "Asia/Tokyo", label: "Tokyo" },
	{ value: "Asia/Singapore", label: "Singapore" },
	{ value: "Australia/Sydney", label: "Sydney" },
];

function getDefaultTriggerConfig(type: string): Record<string, unknown> {
	switch (type) {
		case "schedule":
			return {
				cron: "0 9 * * 1-5",
				timezone: "UTC",
			};
		case "webhook":
			return {};
		case "slack":
			return {
				replyInThreads: true,
				threadTimeoutHours: 24,
				mentionOnly: true,
				respondToDms: true,
			};
		case "lifecycle":
			return {
				resource: "story",
				event: "status_changed",
				conditions: {},
			};
		default:
			return {};
	}
}

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	triggers: TriggerConfig[];
	onTriggersChange: (triggers: TriggerConfig[]) => void;
	configuredIntegrations?: string[];
	integrationsUrl?: string;
	organizationId?: string | null;
};

export function TriggersSheet({
	open,
	onOpenChange,
	triggers,
	onTriggersChange,
	configuredIntegrations = [],
	integrationsUrl = "/app/settings/integrations",
	organizationId = null,
}: Props) {
	const [localTriggers, setLocalTriggers] =
		useState<TriggerConfig[]>(triggers);
	const [expandedTrigger, setExpandedTrigger] = useState<string | null>(null);

	// Auto-default Slack triggers to the connected workspace so users don't
	// have to copy team/bot IDs by hand. Only fetched when Slack is configured.
	const slackConfigured = configuredIntegrations.includes("SLACK");
	const { data: slackContext } = useQuery({
		...orpc.integrations.slack.getContext.queryOptions({
			input: { organizationId },
		}),
		enabled: open && slackConfigured,
		staleTime: 5 * 60 * 1000,
	});

	// Initialize local state when sheet opens
	const handleOpenChange = (newOpen: boolean) => {
		if (newOpen) {
			setLocalTriggers(triggers);
		}
		onOpenChange(newOpen);
	};

	const getTriggerConfig = (type: string): TriggerConfig | undefined => {
		return localTriggers.find((t) => t.type === type);
	};

	const isTriggerEnabled = (type: string): boolean => {
		const trigger = getTriggerConfig(type);
		return trigger?.enabled ?? false;
	};

	const slackContextDefaults = (): Record<string, unknown> => {
		if (!slackContext) {
			return {};
		}
		return {
			teamId: slackContext.teamId,
			...(slackContext.botUserId && {
				botUserId: slackContext.botUserId,
			}),
		};
	};

	const toggleTrigger = (type: string) => {
		const triggerDef = TRIGGER_TYPES.find((t) => t.id === type);
		if (triggerDef?.alwaysEnabled) {
			return;
		}

		setLocalTriggers((prev) => {
			const existing = prev.find((t) => t.type === type);
			if (existing) {
				return prev.map((t) =>
					t.type === type ? { ...t, enabled: !t.enabled } : t,
				);
			}
			const config = {
				...getDefaultTriggerConfig(type),
				...(type === "slack" ? slackContextDefaults() : {}),
			};
			return [...prev, { type, enabled: true, config }];
		});
	};

	const updateTriggerConfig = (
		type: string,
		config: Record<string, unknown>,
	) => {
		setLocalTriggers((prev) => {
			const existing = prev.find((t) => t.type === type);
			if (existing) {
				return prev.map((t) =>
					t.type === type
						? {
								...t,
								config: {
									...getDefaultTriggerConfig(type),
									...t.config,
									...config,
								},
							}
						: t,
				);
			}
			return [
				...prev,
				{
					type,
					enabled: true,
					config: { ...getDefaultTriggerConfig(type), ...config },
				},
			];
		});
	};

	const handleSave = () => {
		onTriggersChange(
			localTriggers
				.filter((t) => t.enabled)
				.map((trigger) => ({
					...trigger,
					config: {
						...getDefaultTriggerConfig(trigger.type),
						...trigger.config,
						// Slack workspace identity always reflects the
						// currently-connected tenant integration, so a
						// re-save after reconnecting picks up the new IDs
						// instead of replaying whatever was first captured.
						...(trigger.type === "slack"
							? slackContextDefaults()
							: {}),
					},
				})),
		);
		onOpenChange(false);
	};

	const isIntegrationConfigured = (integration: string) => {
		return configuredIntegrations.includes(integration);
	};

	const handleTriggerCardKeyDown = (
		event: React.KeyboardEvent<HTMLButtonElement>,
		trigger: (typeof TRIGGER_TYPES)[number],
		isEnabled: boolean,
		isExpanded: boolean,
	) => {
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}

		event.preventDefault();

		if (trigger.configurable && isEnabled) {
			setExpandedTrigger(isExpanded ? null : trigger.id);
		} else if (!trigger.alwaysEnabled) {
			toggleTrigger(trigger.id);
		}
	};

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent className="w-full sm:max-w-xl flex flex-col p-0">
				<SheetHeader className="px-6 pt-6 pb-4 border-b">
					<SheetTitle className="text-xl flex items-center gap-2">
						<ZapIcon className="h-5 w-5" />
						Configure Triggers
					</SheetTitle>
					<SheetDescription>
						Choose how your agent can be activated
					</SheetDescription>
				</SheetHeader>

				<ScrollArea className="flex-1">
					<div className="p-6 space-y-4">
						{TRIGGER_TYPES.map((trigger) => {
							const isEnabled =
								trigger.alwaysEnabled ||
								isTriggerEnabled(trigger.id);
							const isExpanded = expandedTrigger === trigger.id;
							const config =
								getTriggerConfig(trigger.id)?.config || {};
							const Icon = trigger.icon;
							const needsIntegration =
								trigger.requiresIntegration;
							const hasIntegration = needsIntegration
								? isIntegrationConfigured(needsIntegration)
								: true;

							return (
								<Card
									key={trigger.id}
									className={cn(
										"overflow-hidden transition-all",
										isEnabled &&
											"border-primary/30 bg-primary/5",
									)}
								>
									<div className="flex items-center justify-between p-4">
										<button
											type="button"
											className="flex min-w-0 flex-1 items-center gap-3 text-left"
											onClick={() => {
												if (
													trigger.configurable &&
													isEnabled
												) {
													setExpandedTrigger(
														isExpanded
															? null
															: trigger.id,
													);
												} else if (
													!trigger.alwaysEnabled
												) {
													toggleTrigger(trigger.id);
												}
											}}
											onKeyDown={(event) =>
												handleTriggerCardKeyDown(
													event,
													trigger,
													isEnabled,
													isExpanded,
												)
											}
										>
											<div className="flex items-center gap-3">
												<div
													className={cn(
														"p-2.5 rounded-lg",
														isEnabled
															? "bg-primary/10"
															: "bg-muted",
													)}
												>
													<Icon
														className={cn(
															"h-5 w-5",
															isEnabled
																? "text-primary"
																: "text-muted-foreground",
														)}
													/>
												</div>
												<div>
													<div className="flex items-center gap-2">
														<p className="font-medium">
															{trigger.label}
														</p>
														{trigger.alwaysEnabled && (
															<Badge
																variant="secondary"
																className="text-xs"
															>
																Always on
															</Badge>
														)}
														{needsIntegration &&
															!hasIntegration && (
																<Badge
																	variant="outline"
																	className="text-xs text-amber-600 border-amber-500/50"
																>
																	Needs setup
																</Badge>
															)}
													</div>
													<p className="text-sm text-muted-foreground">
														{trigger.description}
													</p>
												</div>
											</div>
										</button>
										{!trigger.alwaysEnabled && (
											<Switch
												checked={isEnabled}
												disabled={Boolean(
													needsIntegration &&
														!hasIntegration,
												)}
												onClick={(e) => {
													e.stopPropagation();
													toggleTrigger(trigger.id);
												}}
											/>
										)}
									</div>

									{/* Configuration Panel */}
									{trigger.configurable &&
										isEnabled &&
										isExpanded && (
											<div className="px-4 pb-4 pt-2 border-t bg-muted/30">
												{trigger.id === "schedule" && (
													<ScheduleConfigPanel
														config={
															config as ScheduleConfig
														}
														onChange={(newConfig) =>
															updateTriggerConfig(
																"schedule",
																newConfig,
															)
														}
													/>
												)}
												{trigger.id === "webhook" && (
													<WebhookConfigPanel
														config={
															config as WebhookConfig
														}
														onChange={(newConfig) =>
															updateTriggerConfig(
																"webhook",
																newConfig,
															)
														}
													/>
												)}
												{trigger.id === "slack" && (
													<SlackConfigPanel
														config={
															config as SlackConfig
														}
														onChange={(newConfig) =>
															updateTriggerConfig(
																"slack",
																newConfig,
															)
														}
														isConfigured={
															hasIntegration
														}
														integrationsUrl={
															integrationsUrl
														}
													/>
												)}
												{trigger.id === "lifecycle" && (
													<LifecycleConfigPanel
														config={
															config as LifecycleConfig
														}
														onChange={(newConfig) =>
															updateTriggerConfig(
																"lifecycle",
																newConfig,
															)
														}
													/>
												)}
											</div>
										)}

									{/* Expand hint */}
									{trigger.configurable &&
										isEnabled &&
										!isExpanded && (
											<div className="px-4 pb-3 text-xs text-muted-foreground flex items-center gap-1">
												<InfoIcon className="h-3 w-3" />
												Click to configure
											</div>
										)}
								</Card>
							);
						})}
					</div>
				</ScrollArea>

				<SheetFooter className="border-t px-6 py-4 bg-muted/30">
					<div className="flex items-center justify-between w-full">
						<div className="flex items-center gap-2">
							<ZapIcon className="h-4 w-4 text-primary" />
							<span className="text-sm font-medium">
								{localTriggers.filter((t) => t.enabled).length}{" "}
								trigger
								{localTriggers.filter((t) => t.enabled)
									.length !== 1
									? "s"
									: ""}{" "}
								enabled
							</span>
						</div>
						<div className="flex gap-3">
							<Button
								variant="outline"
								onClick={() => onOpenChange(false)}
							>
								Cancel
							</Button>
							<Button
								onClick={handleSave}
								className="bg-emerald-500 hover:bg-emerald-600"
							>
								Save Triggers
							</Button>
						</div>
					</div>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}

// Schedule configuration panel
function ScheduleConfigPanel({
	config,
	onChange,
}: {
	config: ScheduleConfig;
	onChange: (config: ScheduleConfig) => void;
}) {
	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label>Schedule Preset</Label>
				<Select
					value=""
					onValueChange={(value) => {
						const preset = COMMON_SCHEDULES.find(
							(s) => s.cron === value,
						);
						if (preset) {
							onChange({ ...config, cron: preset.cron });
						}
					}}
				>
					<SelectTrigger>
						<SelectValue placeholder="Choose a preset or enter custom" />
					</SelectTrigger>
					<SelectContent>
						{COMMON_SCHEDULES.map((schedule) => (
							<SelectItem
								key={schedule.cron}
								value={schedule.cron}
							>
								{schedule.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-2">
				<Label htmlFor="cron">Cron Expression</Label>
				<Input
					id="cron"
					value={config.cron || "0 9 * * 1-5"}
					onChange={(e) =>
						onChange({ ...config, cron: e.target.value })
					}
					placeholder="0 9 * * 1-5"
					className="font-mono"
				/>
				<p className="text-xs text-muted-foreground">
					Format: minute hour day month weekday
				</p>
			</div>

			<div className="space-y-2">
				<Label>Timezone</Label>
				<Select
					value={config.timezone || "UTC"}
					onValueChange={(value) =>
						onChange({ ...config, timezone: value })
					}
				>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{TIMEZONES.map((tz) => (
							<SelectItem key={tz.value} value={tz.value}>
								{tz.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		</div>
	);
}

// Webhook configuration panel
function WebhookConfigPanel({
	config,
	onChange,
}: {
	config: WebhookConfig;
	onChange: (config: WebhookConfig) => void;
}) {
	return (
		<div className="space-y-4">
			<div className="p-3 bg-muted rounded-lg">
				<p className="text-sm font-medium mb-1">Webhook URL</p>
				<p className="text-xs text-muted-foreground font-mono break-all">
					https://api.fabric.ai/webhooks/agents/{"{agent-id}"}/trigger
				</p>
			</div>

			<div className="space-y-2">
				<Label htmlFor="webhook-path">Custom Path (optional)</Label>
				<Input
					id="webhook-path"
					value={config.path || ""}
					onChange={(e) =>
						onChange({ ...config, path: e.target.value })
					}
					placeholder="/custom-path"
				/>
			</div>

			<div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
				<InfoIcon className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
				<p className="text-xs text-highlight">
					A webhook secret will be generated when the agent is
					deployed. Use it to verify incoming requests.
				</p>
			</div>
		</div>
	);
}

// Slack configuration panel
function SlackConfigPanel({
	config,
	onChange,
	isConfigured,
	integrationsUrl = "/app/settings/integrations",
}: {
	config: SlackConfig;
	onChange: (config: SlackConfig) => void;
	isConfigured: boolean;
	integrationsUrl?: string;
}) {
	if (!isConfigured) {
		return (
			<div className="p-4 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
				<p className="text-sm font-medium text-highlight mb-2">
					Slack integration required
				</p>
				<p className="text-xs text-highlight/80 mb-3">
					Connect your Slack workspace to enable this trigger.
				</p>
				<Button variant="outline" size="sm" asChild>
					<a href={integrationsUrl}>Configure Slack</a>
				</Button>
			</div>
		);
	}

	const timeoutOptions = [
		{ value: "1", label: "1 hour" },
		{ value: "8", label: "8 hours" },
		{ value: "24", label: "24 hours" },
		{ value: "168", label: "7 days" },
		{ value: "0", label: "Never auto-close" },
	];

	return (
		<div className="space-y-6">
			{/* Section: Conversational Threads */}
			<div className="space-y-3">
				<div className="flex items-center gap-2">
					<MessageSquareIcon className="h-4 w-4 text-primary" />
					<h4 className="text-sm font-medium">
						Conversational Threads
					</h4>
				</div>
				<p className="text-xs text-muted-foreground">
					Keep conversations going in Slack threads for better
					context.
				</p>

				<div className="flex items-center justify-between py-2">
					<div className="space-y-0.5">
						<Label className="text-sm">
							Reply in Slack threads
						</Label>
						<p className="text-xs text-muted-foreground">
							Post agent responses back into the same thread
						</p>
					</div>
					<Switch
						checked={config.replyInThreads ?? true}
						onCheckedChange={(checked) =>
							onChange({ ...config, replyInThreads: checked })
						}
					/>
				</div>

				<div className="flex items-center justify-between py-2">
					<div className="space-y-0.5">
						<Label className="text-sm">
							Keep conversations active for
						</Label>
						<p className="text-xs text-muted-foreground">
							Continue existing thread conversations within this
							time
						</p>
					</div>
					<Select
						value={String(config.threadTimeoutHours ?? 24)}
						onValueChange={(value) =>
							onChange({
								...config,
								threadTimeoutHours: Number.parseInt(value, 10),
							})
						}
					>
						<SelectTrigger className="w-40">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{timeoutOptions.map((option) => (
								<SelectItem
									key={option.value}
									value={option.value}
								>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{/* Section: Trigger Behavior */}
			<div className="space-y-3 pt-4 border-t">
				<div className="flex items-center gap-2">
					<ZapIcon className="h-4 w-4 text-primary" />
					<h4 className="text-sm font-medium">Trigger Behavior</h4>
				</div>

				<div className="flex items-center justify-between py-2">
					<div className="space-y-0.5">
						<Label className="text-sm">
							Respond to @Fabric mentions
						</Label>
						<p className="text-xs text-muted-foreground">
							Trigger when @mentioned in channels
						</p>
					</div>
					<Switch
						checked={config.mentionOnly ?? true}
						onCheckedChange={(checked) =>
							onChange({ ...config, mentionOnly: checked })
						}
					/>
				</div>

				<div className="flex items-center justify-between py-2">
					<div className="space-y-0.5">
						<Label className="text-sm">
							Respond to direct messages
						</Label>
						<p className="text-xs text-muted-foreground">
							Trigger on DMs to the bot
						</p>
					</div>
					<Switch
						checked={config.respondToDms ?? true}
						onCheckedChange={(checked) =>
							onChange({ ...config, respondToDms: checked })
						}
					/>
				</div>
				<div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 p-3">
					<InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
					<p className="text-xs text-muted-foreground">
						Slack conversational replies require your workspace
						Slack connection plus the server-side signing secret
						used by the Slack Events API.
					</p>
				</div>
			</div>

			{/* Section: Advanced */}
			<div className="space-y-3 pt-4 border-t">
				<div className="space-y-2">
					<Label htmlFor="slack-team" className="text-sm">
						Workspace/team ID
					</Label>
					<Input
						id="slack-team"
						value={config.teamId || ""}
						onChange={(e) =>
							onChange({ ...config, teamId: e.target.value })
						}
						placeholder="T01234567"
						className="font-mono text-sm"
					/>
					<p className="text-xs text-muted-foreground">
						Required for Slack Events API routing. Use the workspace
						team ID from your Slack app event payload.
					</p>
				</div>

				<div className="space-y-2">
					<Label htmlFor="channel" className="text-sm">
						Channel ID (optional)
					</Label>
					<Input
						id="channel"
						value={config.channelId || ""}
						onChange={(e) =>
							onChange({ ...config, channelId: e.target.value })
						}
						placeholder="C01234567"
						className="font-mono text-sm"
					/>
					<p className="text-xs text-muted-foreground">
						Restrict to a specific channel. Leave empty to work in
						any channel.
					</p>
				</div>
			</div>
		</div>
	);
}

function LifecycleConfigPanel({
	config,
	onChange,
}: {
	config: LifecycleConfig;
	onChange: (config: LifecycleConfig) => void;
}) {
	const resource = config.resource ?? "story";
	const eventOptions = LIFECYCLE_EVENT_OPTIONS[resource];
	const configuredEvent = config.event ?? "status_changed";
	const event = eventOptions.some(
		(option) => option.value === configuredEvent,
	)
		? configuredEvent
		: eventOptions[0].value;

	return (
		<div className="space-y-4">
			<div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950/20">
				<InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
				<p className="text-xs text-blue-700 dark:text-blue-300">
					Lifecycle triggers run published agents when project work
					changes. Use them for lightweight, human-visible automation
					such as summarizing completed tasks or drafting follow-ups
					after feature changes.
				</p>
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-2">
					<Label>Resource</Label>
					<Select
						value={resource}
						onValueChange={(value) => {
							const nextResource = value as NonNullable<
								LifecycleConfig["resource"]
							>;
							onChange({
								...config,
								resource: nextResource,
								event: LIFECYCLE_EVENT_OPTIONS[nextResource][0]
									.value,
							});
						}}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(LIFECYCLE_RESOURCE_LABELS).map(
								([value, label]) => (
									<SelectItem key={value} value={value}>
										{label}
									</SelectItem>
								),
							)}
						</SelectContent>
					</Select>
				</div>

				<div className="space-y-2">
					<Label>Event</Label>
					<Select
						value={event}
						onValueChange={(value) =>
							onChange({
								...config,
								event: value as LifecycleConfig["event"],
							})
						}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{eventOptions.map((option) => (
								<SelectItem
									key={option.value}
									value={option.value}
								>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			<LifecycleConditionsEditor
				resource={resource}
				event={event}
				conditions={config.conditions ?? {}}
				onChange={(conditions) => onChange({ ...config, conditions })}
			/>

			<div className="rounded-lg border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground">
				Saved config:{" "}
				<code>
					{resource}.{event}
				</code>
				{Object.keys(config.conditions ?? {}).length > 0 ? (
					<>
						{" with "}
						<code>
							{Object.entries(config.conditions ?? {})
								.map(([k, v]) => `${k}=${String(v)}`)
								.join(", ")}
						</code>
					</>
				) : (
					". Add conditions above to narrow when this trigger fires."
				)}
			</div>
		</div>
	);
}

/** Convert a free-form text value into a primitive: boolean, number, or string. */
function coerceConditionValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return "";
	}
	if (trimmed === "true") {
		return true;
	}
	if (trimmed === "false") {
		return false;
	}
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		return Number(trimmed);
	}
	return trimmed;
}

function LifecycleConditionsEditor({
	resource,
	event,
	conditions,
	onChange,
}: {
	resource: NonNullable<LifecycleConfig["resource"]>;
	event: NonNullable<LifecycleConfig["event"]>;
	conditions: Record<string, unknown>;
	onChange: (conditions: Record<string, unknown>) => void;
}) {
	const suggestions =
		LIFECYCLE_CONDITION_SUGGESTIONS[resource]?.[event] ?? [];
	const entries = Object.entries(conditions);

	const updateKey = (oldKey: string, nextKey: string) => {
		if (nextKey === oldKey) {
			return;
		}
		const next: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(conditions)) {
			next[k === oldKey ? nextKey : k] = v;
		}
		onChange(next);
	};

	const updateValue = (key: string, raw: string) => {
		onChange({ ...conditions, [key]: coerceConditionValue(raw) });
	};

	const removeRow = (key: string) => {
		const next = { ...conditions };
		delete next[key];
		onChange(next);
	};

	const addRow = (key?: string) => {
		const baseKey = key ?? "field";
		let candidate = baseKey;
		let i = 2;
		while (Object.hasOwn(conditions, candidate)) {
			candidate = `${baseKey}_${i++}`;
		}
		onChange({ ...conditions, [candidate]: "" });
	};

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<Label className="text-xs">
					Conditions{" "}
					<span className="font-normal text-muted-foreground">
						(all must match)
					</span>
				</Label>
				{suggestions.length > 0 && entries.length === 0 && (
					<span className="text-[11px] text-muted-foreground">
						Suggestions: {suggestions.map((s) => s.key).join(", ")}
					</span>
				)}
			</div>

			{entries.length === 0 ? (
				<div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
					Trigger fires for every{" "}
					<code>
						{resource}.{event}
					</code>{" "}
					event.
				</div>
			) : (
				<div className="space-y-2">
					{entries.map(([key, value]) => {
						const suggestion = suggestions.find(
							(s) => s.key === key,
						);
						return (
							<div key={key} className="flex items-center gap-2">
								<input
									type="text"
									value={key}
									onChange={(e) =>
										updateKey(key, e.target.value)
									}
									className="h-8 w-1/3 min-w-0 rounded-md border border-border/60 bg-background px-2 text-xs"
									placeholder="field"
								/>
								<input
									type="text"
									value={String(value ?? "")}
									onChange={(e) =>
										updateValue(key, e.target.value)
									}
									className="h-8 flex-1 min-w-0 rounded-md border border-border/60 bg-background px-2 text-xs"
									placeholder={
										suggestion?.placeholder ?? "value"
									}
									title={suggestion?.hint}
								/>
								<button
									type="button"
									onClick={() => removeRow(key)}
									className="rounded p-1 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
									aria-label={`Remove ${key} condition`}
								>
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
									>
										<line x1="18" y1="6" x2="6" y2="18" />
										<line x1="6" y1="6" x2="18" y2="18" />
									</svg>
								</button>
							</div>
						);
					})}
				</div>
			)}

			<div className="flex flex-wrap items-center gap-1.5">
				{suggestions
					.filter((s) => !Object.hasOwn(conditions, s.key))
					.map((s) => (
						<button
							key={s.key}
							type="button"
							onClick={() => addRow(s.key)}
							className="inline-flex items-center gap-1 rounded border border-border/60 bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
						>
							+ {s.key}
						</button>
					))}
				<button
					type="button"
					onClick={() => addRow()}
					className="inline-flex items-center gap-1 rounded border border-dashed border-border/60 bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
				>
					+ Custom field
				</button>
			</div>
		</div>
	);
}
