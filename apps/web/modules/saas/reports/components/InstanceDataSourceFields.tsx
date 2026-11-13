"use client";

import { REPORT_DATA_TYPE_INFO } from "@repo/database/prisma/queries/lib/report-data-types";
import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import {
	type InstanceDataSourceSetup,
	isBoardSelectableProvider,
} from "@saas/reports/hooks/use-instance-data-source-setup";
import {
	findConfigsForSource,
	getMcpConfigDisplayName,
	type McpConfigForDisplay,
} from "@saas/reports/lib/mcp-utils";
import {
	type ConnectableServer,
	connectableServersForSource,
	groupReportConnections,
	reportSourceCategory,
} from "@saas/reports/lib/report-source-categories";
import { isRequiredDataSource } from "@saas/reports/lib/report-template-definition";
import {
	DATA_SOURCE_PROVIDERS,
	type DataSourceDefinition,
} from "@saas/shared/components/DataSourceDefinitionBuilder";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	ExternalLinkIcon,
	Loader2Icon,
	RotateCcwIcon,
	ServerIcon,
} from "lucide-react";
import Link from "next/link";
import { ContextFieldInput } from "./ContextFieldInput";
import { ReportConnectionSelect } from "./ReportConnectionSelect";

/**
 * The data-source part of creating a report — an MCP server per data source,
 * then the context the AI needs — shared by the create dialog and the create
 * page. State lives in `useInstanceDataSourceSetup`.
 */

/** Enough to choose from; the all-tools view and Connections hold the rest. */
const MAX_CONNECTABLE_TOOLS = 6;

/** A data source's own servers, then its category's, then every other one. */
function mcpConnectionGroups(
	provider: string,
	matchingConfigs: McpConfigForDisplay[],
	otherConfigs: McpConfigForDisplay[],
) {
	const toOption = (config: McpConfigForDisplay) => ({
		value: config.id,
		label: getMcpConfigDisplayName(config),
	});
	return groupReportConnections(
		matchingConfigs.map(toOption),
		otherConfigs,
		reportSourceCategory(
			provider,
			DATA_SOURCE_PROVIDERS,
			matchingConfigs.map((config) => config.mcpServer?.category),
		),
		(config) => ({
			option: toOption(config),
			category: config.mcpServer?.category,
		}),
	);
}

export function InstanceDataSourcePicker({
	setup,
	dataSources,
	generateProblemId,
}: {
	setup: InstanceDataSourceSetup;
	dataSources: DataSourceDefinition[];
	/** The id of the sentence saying why Generate is off, for an empty choice. */
	generateProblemId?: string;
}) {
	const { userMcpConfigs, bindings, selectMcpConfig, clearMcpConfig } = setup;
	const mcpServersPath = useContextPath("mcp-servers");

	return (
		<div className="space-y-3">
			{dataSources.map((ds) => {
				if (ds.type === "fabric") {
					return (
						<Card key={ds.id}>
							<CardContent className="pt-4 space-y-2">
								<h3 className="font-medium">
									Project knowledge
								</h3>
								<p className="text-sm text-muted-foreground">
									Reads completed Fabric-generated documents
									and shared text notes from the selected
									project. Imported files and private notes
									are excluded. No external connection is
									needed.
								</p>
							</CardContent>
						</Card>
					);
				}
				// A generic source asks which connected tool supplies its data.
				const heading = ds.dataType
					? REPORT_DATA_TYPE_INFO[ds.dataType].question
					: (ds.provider &&
							DATA_SOURCE_PROVIDERS[ds.provider]?.label) ||
						ds.provider;
				const connectHref = ds.provider
					? `${mcpServersPath}?connect=${encodeURIComponent(ds.provider)}`
					: mcpServersPath;
				const binding = bindings[ds.id];
				const isConfigured = Boolean(binding?.mcpConfigId);
				const required = isRequiredDataSource(ds);
				// The report suite's red treatment for a required choice left empty,
				// once the list of connections says it really is.
				const invalid =
					setup.suggestDefaults &&
					required &&
					!isConfigured &&
					setup.connectionsState === "answered";
				const matchingConfigs = findConfigsForSource(
					userMcpConfigs,
					ds,
				);
				const otherConfigs = userMcpConfigs.filter(
					(c) => !matchingConfigs.some((m) => m.id === c.id),
				);
				const selectId = `mcp-config-${ds.id}`;

				return (
					<Card
						key={ds.id}
						className={cn(
							"border transition-colors",
							isConfigured
								? "border-green-200 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20"
								: invalid
									? "border-destructive/60 bg-destructive/5"
									: required
										? "border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20"
										: "border-border bg-muted/30",
						)}
					>
						<CardContent className="p-4">
							<div className="flex items-center gap-3">
								<div className="p-2 rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
									<ServerIcon className="h-4 w-4" />
								</div>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2">
										<span className="font-medium text-sm">
											{heading}
										</span>
										{isConfigured ? (
											<CheckCircle2Icon className="h-4 w-4 text-success" />
										) : invalid ? (
											<AlertCircleIcon className="h-4 w-4 text-destructive" />
										) : required ? (
											<AlertCircleIcon className="h-4 w-4 text-highlight" />
										) : null}
										{!required && (
											<Badge
												variant="outline"
												className="text-xs"
											>
												Optional
											</Badge>
										)}
									</div>
									<p className="text-xs text-muted-foreground">
										{required || isConfigured
											? "AI will use read-only tools to gather data"
											: "Skipped: the report runs without this source unless you connect it"}
									</p>
								</div>
								{!required && isConfigured && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => clearMcpConfig(ds.id)}
									>
										Skip this source
									</Button>
								)}
							</div>

							<div className="mt-3">
								<Label
									htmlFor={selectId}
									className={cn(
										"text-xs",
										invalid
											? "text-destructive"
											: "text-muted-foreground",
									)}
								>
									{required ? "MCP Server *" : "MCP Server"}
								</Label>
								{setup.suggestDefaults ? (
									<div className="mt-1">
										<ReportConnectionSelect
											id={selectId}
											groups={mcpConnectionGroups(
												ds.provider ??
													ds.dataType ??
													"",
												matchingConfigs,
												otherConfigs,
											)}
											value={binding?.mcpConfigId || ""}
											onValueChange={(value) =>
												selectMcpConfig(ds.id, value)
											}
											placeholder="Select MCP server..."
											connectHref={connectHref}
											required={required}
											invalid={invalid}
											describedBy={
												required && !isConfigured
													? generateProblemId
													: undefined
											}
											connectInNewTab
											connections={setup.connectionsState}
											onRetryConnections={
												setup.retryConnections
											}
										/>
										{!isConfigured &&
											setup.connectionsState ===
												"answered" && (
												<ConnectableTools
													source={ds}
													setup={setup}
												/>
											)}
									</div>
								) : userMcpConfigs.length > 0 ? (
									<Select
										value={binding?.mcpConfigId || ""}
										onValueChange={(value) =>
											selectMcpConfig(ds.id, value)
										}
									>
										<SelectTrigger
											id={selectId}
											className="mt-1"
										>
											<SelectValue placeholder="Select MCP server..." />
										</SelectTrigger>
										<SelectContent>
											{matchingConfigs.map((config) => (
												<SelectItem
													key={config.id}
													value={config.id}
												>
													{getMcpConfigDisplayName(
														config,
													)}{" "}
													(Recommended)
												</SelectItem>
											))}
											{otherConfigs.map((config) => (
												<SelectItem
													key={config.id}
													value={config.id}
												>
													{getMcpConfigDisplayName(
														config,
													)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								) : (
									<div className="mt-1 p-3 border border-dashed rounded-lg text-center">
										<p className="text-sm text-muted-foreground">
											No MCP servers configured
										</p>
										<Button
											variant="outline"
											size="sm"
											className="mt-2"
											asChild
										>
											<Link href={connectHref}>
												<ServerIcon className="mr-1 h-3 w-3" />
												Connect MCP Server
											</Link>
										</Button>
									</div>
								)}
							</div>
						</CardContent>
					</Card>
				);
			})}
		</div>
	);
}

/**
 * The tools of the registry this data source could read through and the person
 * has not connected, each one link away. Connect opens in a new tab: the form
 * and the project stay here, and the connections refetch on return. A project's
 * board stays read-only until the person's own connection can read it.
 */
function ConnectableTools({
	source,
	setup,
}: {
	source: DataSourceDefinition;
	setup: InstanceDataSourceSetup;
}) {
	const mcpServersPath = useContextPath("mcp-servers");
	const { data: registry } = useQuery({
		...orpc.mcp.registry.list.queryOptions({
			input: { organizationId: setup.organizationId },
		}),
		staleTime: 5 * 60 * 1000,
	});
	const servers: ConnectableServer[] = Array.isArray(registry)
		? registry
		: [];
	const connectable = connectableServersForSource(
		servers,
		source,
		setup.userMcpConfigs,
	);
	const projectBoard = setup.projectBoard;
	const projectServer = projectBoard
		? connectable.find((server) => server.id === projectBoard.mcpServerId)
		: undefined;
	const showsProjectBoard =
		projectBoard !== null &&
		(source.dataType === "project-management" ||
			projectServer !== undefined);
	if (connectable.length === 0 && !showsProjectBoard) {
		return null;
	}
	const ordered = projectServer
		? [
				projectServer,
				...connectable.filter((server) => server !== projectServer),
			]
		: connectable;

	return (
		<div className="mt-3 space-y-2">
			{showsProjectBoard && (
				<p className="text-xs text-foreground/85">
					This project reads the board{" "}
					<span className="font-medium">{projectBoard.name}</span>
					{projectServer?.name ? ` in ${projectServer.name}` : ""}.
					Connect your own account to use it here.
				</p>
			)}
			{ordered.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{ordered.slice(0, MAX_CONNECTABLE_TOOLS).map((server) => (
						<Button
							key={server.id}
							type="button"
							variant="outline"
							size="sm"
							asChild
						>
							<a
								href={`${mcpServersPath}?connect=${encodeURIComponent(server.key ?? server.id)}`}
								target="_blank"
								rel="noopener noreferrer"
							>
								<ExternalLinkIcon
									aria-hidden="true"
									className="mr-1 h-3 w-3"
								/>
								Connect {server.name ?? server.key}
								<span className="sr-only">
									{" "}
									(opens in a new tab)
								</span>
							</a>
						</Button>
					))}
				</div>
			)}
			<p className="text-xs text-muted-foreground">
				Connecting opens in a new tab. Come back here and this form
				picks it up.
			</p>
		</div>
	);
}

export function InstanceContextFields({
	setup,
	className,
}: {
	setup: InstanceDataSourceSetup;
	className?: string;
}) {
	const {
		contextFields,
		contextValues,
		setContextValue,
		setContextValues,
		boards,
		isLoadingBoards,
		boardsError,
		boardsMcpConfigId,
		autoDetect,
		suggestDefaults,
	} = setup;

	return (
		<div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2", className)}>
			{contextFields.map((field) => {
				const id = `context-${field.key}`;
				const value = contextValues[field.key] || "";
				const detects =
					autoDetect && isBoardSelectableProvider(field.provider);

				// The account slug is read from the selected MCP server.
				if (
					field.key === "accountSlug" &&
					detects &&
					boardsMcpConfigId
				) {
					return (
						<ContextFieldInput
							key={field.key}
							id={id}
							label={field.label}
							required={field.required}
							value={value}
							onChange={(next) =>
								setContextValue(field.key, next)
							}
							placeholder={
								isLoadingBoards
									? "Detecting..."
									: field.placeholder
							}
							disabled={isLoadingBoards}
							markMissing={suggestDefaults}
							helpText={
								value
									? "Auto-detected from your MCP server"
									: field.helpText
							}
							adornment={
								value && !isLoadingBoards ? (
									<CheckCircle2Icon className="h-4 w-4 text-success shrink-0" />
								) : null
							}
						/>
					);
				}

				// One board picker stands for both boardId and boardName.
				if (
					detects &&
					(field.key === "boardId" || field.key === "boardName")
				) {
					if (field.key === "boardName") {
						return null;
					}
					return (
						<BoardPicker
							key="board-selector"
							required={suggestDefaults && field.required}
							value={contextValues.boardId || ""}
							boards={boards}
							isLoading={isLoadingBoards}
							error={boardsError}
							hasServer={Boolean(boardsMcpConfigId)}
							onSelect={(boardId, boardName) =>
								setContextValues((prev) => ({
									...prev,
									boardId,
									boardName,
								}))
							}
							onType={(boardId) =>
								setContextValue("boardId", boardId)
							}
							onRetry={
								suggestDefaults ? setup.retryBoards : undefined
							}
						/>
					);
				}

				return (
					<ContextFieldInput
						key={field.key}
						id={id}
						label={field.label}
						required={field.required}
						value={value}
						onChange={(next) => setContextValue(field.key, next)}
						placeholder={field.placeholder}
						helpText={field.helpText}
						markMissing={suggestDefaults}
					/>
				);
			})}
		</div>
	);
}

function BoardPicker({
	required,
	value,
	boards,
	isLoading,
	error,
	hasServer,
	onSelect,
	onType,
	onRetry,
}: {
	/** Mark the board as required and show it red while it is unset. */
	required: boolean;
	value: string;
	boards: Array<{ id: string; name: string }>;
	isLoading: boolean;
	error: string | null;
	hasServer: boolean;
	onSelect: (boardId: string, boardName: string) => void;
	onType: (boardId: string) => void;
	/** Asks the server for its boards again; typing an ID stays possible. */
	onRetry?: () => void;
}) {
	const missing = required && !value.trim();
	const id = "context-boardId";
	const noteId = `${id}-note`;
	const typedBoard = (
		<Input
			id={id}
			value={value}
			onChange={(e) => onType(e.target.value)}
			placeholder="12345"
			aria-required={required || undefined}
			aria-invalid={missing || undefined}
			aria-describedby={noteId}
		/>
	);
	const retry = onRetry && (
		<Button
			type="button"
			variant="outline"
			size="sm"
			className="h-7 text-xs"
			onClick={onRetry}
		>
			<RotateCcwIcon aria-hidden="true" className="mr-1 h-3 w-3" />
			Try again
		</Button>
	);

	return (
		<div className="space-y-1 sm:col-span-2">
			<Label
				htmlFor={id}
				className={cn("text-sm", missing && "text-destructive")}
			>
				Board
				{required && (
					<>
						<span
							aria-hidden="true"
							className="ml-1 text-destructive"
						>
							*
						</span>
						<span className="sr-only"> (required)</span>
					</>
				)}
			</Label>
			{isLoading ? (
				<div className="flex items-center gap-2 text-sm text-muted-foreground p-2">
					<Loader2Icon className="h-4 w-4 motion-safe:animate-spin" />
					Loading boards...
				</div>
			) : boards.length > 0 ? (
				<Select
					value={value}
					onValueChange={(next) =>
						onSelect(
							next,
							boards.find((b) => b.id === next)?.name || "",
						)
					}
				>
					<SelectTrigger
						id={id}
						aria-required={required || undefined}
						aria-invalid={missing || undefined}
					>
						<SelectValue placeholder="Select a board..." />
					</SelectTrigger>
					<SelectContent>
						{boards.map((board) => (
							<SelectItem key={board.id} value={board.id}>
								{board.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : error ? (
				<>
					{typedBoard}
					<p id={noteId} className="text-xs text-destructive">
						{error}
					</p>
					{retry}
				</>
			) : hasServer && onRetry ? (
				<>
					{typedBoard}
					<p id={noteId} className="text-xs text-muted-foreground">
						No boards found from this server. Enter the board's ID,
						or try again.
					</p>
					{retry}
				</>
			) : hasServer ? (
				<p className="text-[10px] text-muted-foreground">
					No boards found from this server.
				</p>
			) : (
				<Input
					id={id}
					disabled
					placeholder="Select an MCP server first..."
				/>
			)}
		</div>
	);
}
