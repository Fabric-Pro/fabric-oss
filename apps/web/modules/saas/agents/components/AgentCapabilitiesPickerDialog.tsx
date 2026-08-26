"use client";

import { McpLogo } from "@saas/mcp/components/McpLogo";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { SearchInput } from "@ui/components/search-input";
import { cn } from "@ui/lib";
import { CheckIcon, SearchIcon, WrenchIcon } from "lucide-react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useEffect, useMemo, useState } from "react";
import { getBuiltInCapabilitiesByType } from "../lib/builtin-capabilities";

interface SkillCatalogEntry {
	id: string;
	name: string;
	description: string;
	category?: string | null;
}

interface McpConfigEntry {
	id: string;
	displayName?: string | null;
	enabled?: boolean;
	mcpServer?: {
		name?: string | null;
		key?: string | null;
		description?: string | null;
	};
}

interface AgentCapabilitiesPickerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	selectedSkillIds: string[];
	selectedCapabilityIds: string[];
	selectedMcpServerIds: string[];
	skills: SkillCatalogEntry[];
	mcpServers: McpConfigEntry[];
	onApply: (selection: {
		skillIds: string[];
		capabilityIds: string[];
		mcpServerIds: string[];
	}) => void;
}

type PickerFilter = "all" | "skills" | "tools";

export function AgentCapabilitiesPickerDialog({
	open,
	onOpenChange,
	selectedSkillIds,
	selectedCapabilityIds,
	selectedMcpServerIds,
	skills,
	mcpServers,
	onApply,
}: AgentCapabilitiesPickerDialogProps) {
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState<PickerFilter>("all");
	const [pendingSkillIds, setPendingSkillIds] = useState<Set<string>>(
		new Set(),
	);
	const [pendingCapabilityIds, setPendingCapabilityIds] = useState<
		Set<string>
	>(new Set());
	const [pendingMcpServerIds, setPendingMcpServerIds] = useState<Set<string>>(
		new Set(),
	);

	useEffect(() => {
		if (!open) {
			return;
		}
		setSearch("");
		setFilter("all");
		setPendingSkillIds(new Set(selectedSkillIds));
		setPendingCapabilityIds(new Set(selectedCapabilityIds));
		setPendingMcpServerIds(new Set(selectedMcpServerIds));
	}, [open, selectedCapabilityIds, selectedMcpServerIds, selectedSkillIds]);

	const query = search.trim().toLowerCase();

	const filteredSkills = useMemo(() => {
		return skills.filter((skill) => {
			if (!query) {
				return true;
			}
			return [skill.name, skill.description, skill.category ?? ""].some(
				(value) => value.toLowerCase().includes(query),
			);
		});
	}, [skills, query]);

	const builtInTools = useMemo(
		() => getBuiltInCapabilitiesByType("tool"),
		[],
	);

	const filteredBuiltInTools = useMemo(() => {
		return builtInTools.filter((tool) => {
			if (!query) {
				return true;
			}
			return [tool.name, tool.description].some((value) =>
				value.toLowerCase().includes(query),
			);
		});
	}, [builtInTools, query]);

	const filteredMcpServers = useMemo(() => {
		return mcpServers.filter((config) => {
			const name =
				config.displayName ||
				config.mcpServer?.name ||
				"Connected Tool";
			const description = config.mcpServer?.description || "";
			if (!query) {
				return true;
			}
			return [name, description].some((value) =>
				value.toLowerCase().includes(query),
			);
		});
	}, [mcpServers, query]);

	const selectedCount =
		pendingSkillIds.size +
		pendingCapabilityIds.size +
		pendingMcpServerIds.size;

	const toggleSetValue = (
		setter: Dispatch<SetStateAction<Set<string>>>,
		value: string,
	) => {
		setter((previous) => {
			const next = new Set(previous);
			if (next.has(value)) {
				next.delete(value);
			} else {
				next.add(value);
			}
			return next;
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-4xl">
				<DialogHeader>
					<DialogTitle>Add capabilities</DialogTitle>
					<DialogDescription>
						Select skills and tools that should be available when
						this agent runs.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="relative">
						<SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<SearchInput
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search capabilities..."
							className="pl-9"
						/>
					</div>

					<div className="flex items-center gap-2">
						{(["all", "skills", "tools"] as const).map((value) => (
							<Button
								key={value}
								type="button"
								size="sm"
								variant={
									filter === value ? "default" : "outline"
								}
								onClick={() => setFilter(value)}
								className="capitalize"
							>
								{value}
							</Button>
						))}
					</div>

					<div className="max-h-[60vh] overflow-y-auto pr-1">
						<div className="space-y-6">
							{(filter === "all" || filter === "skills") && (
								<section className="space-y-3">
									<div>
										<h3 className="text-lg font-semibold">
											Skills
										</h3>
										<p className="text-sm text-muted-foreground">
											Reusable behavior modules that
											specialize the agent.
										</p>
									</div>
									{filteredSkills.length === 0 ? (
										<EmptyState label="No skills match your search." />
									) : (
										<div className="grid gap-3 md:grid-cols-2">
											{filteredSkills.map((skill) => (
												<SelectionCard
													key={skill.id}
													title={skill.name}
													description={
														skill.description
													}
													selected={pendingSkillIds.has(
														skill.id,
													)}
													badge={
														skill.category ??
														"Skill"
													}
													onToggle={() =>
														toggleSetValue(
															setPendingSkillIds,
															skill.id,
														)
													}
												/>
											))}
										</div>
									)}
								</section>
							)}

							{(filter === "all" || filter === "tools") && (
								<section className="space-y-3">
									<div>
										<h3 className="text-lg font-semibold">
											Tools
										</h3>
										<p className="text-sm text-muted-foreground">
											Tools that let the agent retrieve
											data and take actions.
										</p>
									</div>

									{filteredBuiltInTools.length === 0 &&
									filteredMcpServers.length === 0 ? (
										<EmptyState label="No tools match your search." />
									) : (
										<div className="grid gap-3 md:grid-cols-2">
											{filteredBuiltInTools.map(
												(tool) => (
													<SelectionCard
														key={tool.id}
														title={tool.name}
														description={
															tool.description
														}
														selected={pendingCapabilityIds.has(
															tool.id,
														)}
														onToggle={() =>
															toggleSetValue(
																setPendingCapabilityIds,
																tool.id,
															)
														}
														stake={tool.stake}
														leadingIcon={
															<div
																className={cn(
																	"flex h-10 w-10 items-center justify-center rounded-xl",
																	tool.iconBgClassName,
																)}
															>
																{tool.icon(
																	"size-5 text-foreground",
																)}
															</div>
														}
													/>
												),
											)}

											{filteredMcpServers.map(
												(config) => {
													const name =
														config.displayName ||
														config.mcpServer
															?.name ||
														"Connected Tool";
													return (
														<SelectionCard
															key={config.id}
															title={name}
															description={
																config.mcpServer
																	?.description ||
																"Tool provided by a connected MCP server."
															}
															selected={pendingMcpServerIds.has(
																config.id,
															)}
															onToggle={() =>
																toggleSetValue(
																	setPendingMcpServerIds,
																	config.id,
																)
															}
															leadingIcon={
																<div className="flex h-10 w-10 items-center justify-center rounded-xl border bg-background">
																	{config
																		.mcpServer
																		?.key ? (
																		<McpLogo
																			size={
																				20
																			}
																		/>
																	) : (
																		<WrenchIcon className="size-5 text-foreground" />
																	)}
																</div>
															}
															badge="Connected"
														/>
													);
												},
											)}
										</div>
									)}
								</section>
							)}
						</div>
					</div>
				</div>

				<DialogFooter className="items-center justify-between">
					<div className="text-sm text-muted-foreground">
						{selectedCount} selected
					</div>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							onClick={() => {
								onApply({
									skillIds: Array.from(pendingSkillIds),
									capabilityIds:
										Array.from(pendingCapabilityIds),
									mcpServerIds:
										Array.from(pendingMcpServerIds),
								});
								onOpenChange(false);
							}}
						>
							Add capabilities
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type StakeLevel = "never" | "low" | "medium" | "high";

const STAKE_BADGE: Record<
	Exclude<StakeLevel, "never">,
	{ label: string; className: string }
> = {
	low: { label: "Auto-executes", className: "text-muted-foreground" },
	medium: {
		label: "May ask for approval",
		className: "text-amber-600 border-amber-300",
	},
	high: {
		label: "Always asks for approval",
		className: "text-destructive border-destructive/40",
	},
};

function SelectionCard({
	title,
	description,
	selected,
	onToggle,
	leadingIcon,
	badge,
	stake,
}: {
	title: string;
	description: string;
	selected: boolean;
	onToggle: () => void;
	leadingIcon?: ReactNode;
	badge?: string;
	stake?: StakeLevel;
}) {
	const stakeBadge = stake && stake !== "never" ? STAKE_BADGE[stake] : null;

	return (
		<div className="rounded-2xl border bg-card p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 gap-3">
					{leadingIcon}
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h4 className="font-medium">{title}</h4>
							{badge ? (
								<Badge
									variant="outline"
									className="text-[10px] uppercase"
								>
									{badge}
								</Badge>
							) : null}
						</div>
						<p className="mt-2 text-sm text-muted-foreground">
							{description}
						</p>
						{stakeBadge ? (
							<Badge
								variant="outline"
								className={cn(
									"mt-2 text-[10px]",
									stakeBadge.className,
								)}
							>
								{stakeBadge.label}
							</Badge>
						) : null}
					</div>
				</div>
				<Button
					type="button"
					size="sm"
					variant={selected ? "secondary" : "outline"}
					onClick={onToggle}
					className="shrink-0"
				>
					{selected ? (
						<>
							<CheckIcon className="mr-1 size-4" />
							Added
						</>
					) : (
						<>+ Add</>
					)}
				</Button>
			</div>
		</div>
	);
}

function EmptyState({ label }: { label: string }) {
	return (
		<div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
			{label}
		</div>
	);
}
