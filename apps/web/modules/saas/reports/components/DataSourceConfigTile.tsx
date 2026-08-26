"use client";

import { McpLogo } from "@saas/mcp/components/McpLogo";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { TemporalLogo } from "@saas/workflows/components/TemporalLogo";
import { Badge } from "@ui/components/badge";
import { Card, CardContent } from "@ui/components/card";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import {
	CheckCircle2Icon,
	FolderOpenIcon,
	Loader2Icon,
	PlugIcon,
	ServerIcon,
	TriangleAlertIcon,
} from "lucide-react";

// Data source types
export type DataSourceType =
	| "mcp"
	| "workflow"
	| "agent"
	| "workspace"
	| "integration";

// Connection option for dropdown
type ConnectionOption = {
	id: string;
	name: string;
	description?: string;
	type?: "mcp" | "integration";
	isRecommended?: boolean;
	isAuthenticated?: boolean;
};

// Resource option for MCP connections
type ResourceOption = {
	id: string;
	name: string;
	type: string;
	description?: string;
};

// Current binding state
export type ConnectionBinding = {
	type: "mcp" | "integration";
	id: string;
	name?: string;
	resourceId?: string;
	resourceName?: string;
	resourceType?: string;
};

type Props = {
	// Data source definition from template
	dataSourceKey: string;
	name: string;
	description?: string;
	type: DataSourceType;
	required?: boolean;

	// Current binding state
	binding?: ConnectionBinding;
	/**
	 * Whether the bound connection still resolves for the current user/tenant.
	 * `false` means the binding points at a config that no longer exists or isn't
	 * accessible here (deleted, reconnected → new id, wrong context) — so it is
	 * shown as "Reconnect required", not "Connected". Defaults to resolvable.
	 */
	bindingResolvable?: boolean;

	// Available options
	connectionOptions: ConnectionOption[];
	resources?: ResourceOption[];
	isLoadingResources?: boolean;

	// Handlers
	onConnectionChange: (
		connectionId: string | null,
		connectionType: "mcp" | "integration",
		connectionName?: string,
	) => void;
	onResourceChange?: (
		resourceId: string,
		resourceName: string,
		resourceType: string,
	) => void;
};

// Get icon for data source type
function getDataSourceIcon(type: DataSourceType, className?: string) {
	const iconClass = cn("h-5 w-5", className);
	switch (type) {
		case "mcp":
			return <McpLogo className={iconClass} size={20} />;
		case "workflow":
			return <TemporalLogo className={iconClass} size={20} />;
		case "agent":
			return <FabricLogo className={iconClass} size={20} />;
		case "workspace":
			return <FolderOpenIcon className={iconClass} />;
		case "integration":
			return <PlugIcon className={iconClass} />;
		default:
			return <ServerIcon className={iconClass} />;
	}
}

// Get color scheme for data source type
function getDataSourceColors(type: DataSourceType, isConnected: boolean) {
	if (isConnected) {
		return {
			bg: "bg-green-50 dark:bg-green-950/30",
			border: "border-green-300 dark:border-green-800",
			icon: "text-success dark:text-green-400",
			iconBg: "bg-green-100 dark:bg-green-900",
		};
	}

	switch (type) {
		case "mcp":
			return {
				bg: "bg-blue-50/50 dark:bg-blue-950/20",
				border: "border-blue-200 dark:border-blue-800",
				icon: "text-blue-600 dark:text-blue-400",
				iconBg: "bg-blue-100 dark:bg-blue-900",
			};
		case "workflow":
			return {
				bg: "bg-purple-50/50 dark:bg-purple-950/20",
				border: "border-purple-200 dark:border-purple-800",
				icon: "text-purple-600 dark:text-purple-400",
				iconBg: "bg-purple-100 dark:bg-purple-900",
			};
		case "agent":
			return {
				bg: "bg-emerald-50/50 dark:bg-emerald-950/20",
				border: "border-emerald-200 dark:border-emerald-800",
				icon: "text-emerald-600 dark:text-emerald-400",
				iconBg: "bg-emerald-100 dark:bg-emerald-900",
			};
		case "workspace":
			return {
				bg: "bg-amber-50/50 dark:bg-amber-950/20",
				border: "border-amber-200 dark:border-amber-800",
				icon: "text-amber-600 dark:text-amber-400",
				iconBg: "bg-amber-100 dark:bg-amber-900",
			};
		case "integration":
			return {
				bg: "bg-pink-50/50 dark:bg-pink-950/20",
				border: "border-pink-200 dark:border-pink-800",
				icon: "text-pink-600 dark:text-pink-400",
				iconBg: "bg-pink-100 dark:bg-pink-900",
			};
		default:
			return {
				bg: "bg-muted/30",
				border: "border-muted-foreground/30",
				icon: "text-muted-foreground",
				iconBg: "bg-muted",
			};
	}
}

export function DataSourceConfigTile({
	dataSourceKey: _dataSourceKey,
	name,
	description,
	type,
	required,
	binding,
	bindingResolvable,
	connectionOptions,
	resources,
	isLoadingResources,
	onConnectionChange,
	onResourceChange,
}: Props) {
	// A binding can exist but no longer resolve (deleted / reconnected / wrong
	// context). That is NOT "connected" — both generation and save would fail —
	// so surface it honestly instead of a misleading green badge.
	const bindingUnavailable =
		Boolean(binding?.id) && bindingResolvable === false;
	const isConnected = Boolean(binding?.id) && !bindingUnavailable;
	const colors = getDataSourceColors(type, isConnected);

	// Separate recommended from other options
	const recommendedOptions = connectionOptions.filter((o) => o.isRecommended);
	const otherOptions = connectionOptions.filter((o) => !o.isRecommended);

	return (
		<Card
			className={cn(
				"border-2 transition-all hover:shadow-md",
				colors.bg,
				colors.border,
			)}
		>
			<CardContent className="p-4 space-y-4">
				{/* Header */}
				<div className="flex items-start gap-3">
					<div
						className={cn(
							"p-2.5 rounded-lg",
							colors.iconBg,
							colors.icon,
						)}
					>
						{getDataSourceIcon(type)}
					</div>
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2 flex-wrap">
							<h3 className="font-semibold text-base">{name}</h3>
							{required && (
								<Badge variant="secondary" className="text-xs">
									Required
								</Badge>
							)}
							{isConnected ? (
								<Badge
									variant="success"
									className="text-xs gap-1"
								>
									<CheckCircle2Icon className="h-3 w-3" />
									Connected
								</Badge>
							) : bindingUnavailable ? (
								<Badge
									variant="destructive"
									className="text-xs gap-1"
								>
									<TriangleAlertIcon className="h-3 w-3" />
									Reconnect required
								</Badge>
							) : (
								<Badge
									variant="outline"
									className="text-xs text-muted-foreground"
								>
									Not configured
								</Badge>
							)}
						</div>
						{description && (
							<p className="text-sm text-muted-foreground mt-1">
								{description}
							</p>
						)}
					</div>
				</div>

				{/* Connection Selector */}
				<div className="space-y-3">
					<Select
						value={binding ? `${binding.type}:${binding.id}` : ""}
						onValueChange={(value) => {
							if (!value) {
								onConnectionChange(null, "mcp");
								return;
							}
							const [connType, connId] = value.split(":");
							const option = connectionOptions.find(
								(o) => o.id === connId,
							);
							onConnectionChange(
								connId,
								connType as "mcp" | "integration",
								option?.name,
							);
						}}
					>
						<SelectTrigger className="w-full bg-background">
							<SelectValue placeholder="Select connection..." />
						</SelectTrigger>
						<SelectContent>
							{recommendedOptions.length > 0 && (
								<SelectGroup>
									<div className="px-2 py-1.5 text-xs font-medium text-success dark:text-green-400 flex items-center gap-1">
										<CheckCircle2Icon className="h-3 w-3" />
										Recommended
									</div>
									{recommendedOptions.map((option) => {
										const optType = option.type || "mcp";
										return (
											<SelectItem
												key={`${optType}:${option.id}`}
												value={`${optType}:${option.id}`}
												disabled={
													option.isAuthenticated ===
													false
												}
											>
												<div className="flex items-center gap-2">
													<span>{option.name}</span>
													{option.isAuthenticated ===
														false && (
														<span className="text-xs text-muted-foreground">
															(Not authenticated)
														</span>
													)}
												</div>
											</SelectItem>
										);
									})}
								</SelectGroup>
							)}
							{otherOptions.length > 0 && (
								<SelectGroup>
									<SelectLabel>Other Options</SelectLabel>
									{otherOptions.map((option) => {
										const optType = option.type || "mcp";
										return (
											<SelectItem
												key={`${optType}:${option.id}`}
												value={`${optType}:${option.id}`}
												disabled={
													option.isAuthenticated ===
													false
												}
											>
												<div className="flex items-center gap-2">
													<span>{option.name}</span>
													{option.isAuthenticated ===
														false && (
														<span className="text-xs text-muted-foreground">
															(Not authenticated)
														</span>
													)}
												</div>
											</SelectItem>
										);
									})}
								</SelectGroup>
							)}
							{connectionOptions.length === 0 && (
								<SelectItem value="_none" disabled>
									No connections available
								</SelectItem>
							)}
						</SelectContent>
					</Select>

					{/* The saved connection no longer resolves — tell the user to
					    re-pick one rather than letting Generate/Save fail cryptically. */}
					{bindingUnavailable && (
						<p className="flex items-start gap-1.5 text-xs text-destructive">
							<TriangleAlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
							<span>
								The previously saved connection is no longer
								available. Pick a connection above, then
								re-select its project below.
							</span>
						</p>
					)}

					{/* Resource Selector (for MCP connections) */}
					{binding && type === "mcp" && onResourceChange && (
						<div className="pl-4 border-l-2 border-muted">
							{isLoadingResources ? (
								<div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
									<Loader2Icon className="h-4 w-4 animate-spin" />
									Loading resources...
								</div>
							) : resources && resources.length > 0 ? (
								<div className="space-y-2">
									<p className="text-xs font-medium text-muted-foreground">
										Select Resource
									</p>
									<Select
										value={binding.resourceId || ""}
										onValueChange={(value) => {
											const resource = resources.find(
												(r) => r.id === value,
											);
											if (resource) {
												onResourceChange(
													resource.id,
													resource.name,
													resource.type,
												);
											}
										}}
									>
										<SelectTrigger className="w-full bg-background">
											<SelectValue placeholder="Select resource..." />
										</SelectTrigger>
										<SelectContent>
											{/* Group resources by type */}
											{Array.from(
												new Set(
													resources.map(
														(r) => r.type,
													),
												),
											).map((resourceType) => (
												<SelectGroup key={resourceType}>
													<SelectLabel className="capitalize">
														{resourceType}s
													</SelectLabel>
													{resources
														.filter(
															(r) =>
																r.type ===
																resourceType,
														)
														.map((resource) => (
															<SelectItem
																key={
																	resource.id
																}
																value={
																	resource.id
																}
															>
																{resource.name}
																{resource.description && (
																	<span className="text-xs text-muted-foreground ml-1">
																		-{" "}
																		{resource.description.slice(
																			0,
																			30,
																		)}
																	</span>
																)}
															</SelectItem>
														))}
												</SelectGroup>
											))}
										</SelectContent>
									</Select>
								</div>
							) : (
								<p className="text-xs text-muted-foreground py-2">
									No resources available
								</p>
							)}
						</div>
					)}
				</div>

				{/* Connected resource info */}
				{binding?.resourceName && (
					<div className="text-sm bg-muted/50 rounded-lg px-3 py-2">
						<span className="text-muted-foreground">
							Selected:{" "}
						</span>
						<span className="font-medium">
							{binding.resourceName}
						</span>
						{binding.resourceType && (
							<Badge variant="outline" className="ml-2 text-xs">
								{binding.resourceType}
							</Badge>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

// Grid container for data source config tiles
export function DataSourceConfigGrid({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("grid grid-cols-1 lg:grid-cols-2 gap-4", className)}>
			{children}
		</div>
	);
}
