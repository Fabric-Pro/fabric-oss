"use client";

/**
 * AuditLogProjectFilter
 *
 * Org-context-only combobox for narrowing audit events to a single
 * project. Mirrors the shape of `AuditLogActorFilter` — Command-driven
 * popover, 200ms debounced server search through
 * `orpcClient.audit.searchProjects`. Selecting emits the project id.
 *
 * Personal context never renders this component — see `AuditLogFilters`.
 *
 * Spec: docs/audit-log/README.md §8.2.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ChevronDown, FolderIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

interface AuditLogProjectFilterProps {
	organizationId: string;
	selectedProjectId?: string;
	onSelect: (project: { id: string; name: string } | null) => void;
}

interface Project {
	id: string;
	name: string;
	icon: string | null;
}

function findProject(list: Project[], id?: string): Project | null {
	if (!id) {
		return null;
	}
	return list.find((p) => p.id === id) ?? null;
}

export function AuditLogProjectFilter({
	organizationId,
	selectedProjectId,
	onSelect,
}: AuditLogProjectFilterProps) {
	const t = useTranslations();
	const [open, setOpen] = useState(false);
	const [searchInput, setSearchInput] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");

	useEffect(() => {
		const handle = window.setTimeout(() => {
			setDebouncedQuery(searchInput);
		}, 200);
		return () => window.clearTimeout(handle);
	}, [searchInput]);

	const { data, isFetching } = useQuery({
		queryKey: [
			"audit-log",
			"projects",
			organizationId,
			debouncedQuery,
		] as const,
		queryFn: () =>
			orpcClient.audit.searchProjects({
				organizationId,
				query: debouncedQuery,
				limit: 50,
			}),
		staleTime: 30 * 1000,
		enabled: open || Boolean(selectedProjectId),
	});

	const projects = data?.projects ?? [];
	const selectedProject = findProject(projects, selectedProjectId);

	const label = t("settings.auditLog.projectFilter.label");
	const triggerValue = selectedProject
		? selectedProject.name
		: t("settings.auditLog.projectFilter.placeholder");

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<div className="flex items-center">
						<Popover open={open} onOpenChange={setOpen}>
							<PopoverTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									role="combobox"
									aria-expanded={open}
									aria-label={t(
										"settings.auditLog.projectFilter.ariaLabel",
									)}
									className="h-9 gap-2 text-sm"
								>
									<FolderIcon
										aria-hidden="true"
										className="size-3.5 text-muted-foreground"
									/>
									<span className="text-muted-foreground">
										{label}:
									</span>
									<span className="text-foreground">
										{triggerValue}
									</span>
									<ChevronDown
										aria-hidden="true"
										className="size-3.5 text-muted-foreground"
									/>
								</Button>
							</PopoverTrigger>
							<PopoverContent
								className="w-80 p-0"
								align="start"
								data-testid="audit-project-popover"
							>
								<Command shouldFilter={false}>
									<CommandInput
										value={searchInput}
										onValueChange={setSearchInput}
										placeholder={t(
											"settings.auditLog.projectFilter.searchPlaceholder",
										)}
										data-testid="audit-project-search"
									/>
									<CommandList>
										{isFetching && projects.length === 0 ? (
											<div className="px-3 py-4 text-center text-xs text-muted-foreground">
												{t(
													"settings.auditLog.projectFilter.loading",
												)}
											</div>
										) : null}
										<CommandEmpty>
											{t(
												"settings.auditLog.projectFilter.empty",
											)}
										</CommandEmpty>
										<CommandGroup>
											{projects.map((project) => {
												const isSelected =
													project.id ===
													selectedProjectId;
												return (
													<CommandItem
														key={project.id}
														value={project.id}
														onSelect={() => {
															onSelect({
																id: project.id,
																name: project.name,
															});
															setOpen(false);
														}}
														aria-label={t(
															"settings.auditLog.projectFilter.selectProject",
															{
																name: project.name,
															} as never,
														)}
														className="flex items-center gap-2"
													>
														{project.icon ? (
															<span
																aria-hidden="true"
																className="text-base"
															>
																{project.icon}
															</span>
														) : (
															<FolderIcon
																aria-hidden="true"
																className="size-4 text-muted-foreground"
															/>
														)}
														<span className="truncate text-sm text-foreground">
															{project.name}
														</span>
														{isSelected ? (
															<span
																aria-hidden="true"
																className="ml-auto text-primary"
															>
																•
															</span>
														) : null}
													</CommandItem>
												);
											})}
										</CommandGroup>
									</CommandList>
								</Command>
							</PopoverContent>
						</Popover>
						{selectedProjectId ? (
							<Button
								variant="ghost"
								size="icon"
								aria-label={t(
									"settings.auditLog.projectFilter.clear",
								)}
								onClick={() => onSelect(null)}
								className="ml-1 h-7 w-7"
							>
								<XIcon className="size-3.5" />
							</Button>
						) : null}
					</div>
				</TooltipTrigger>
				<TooltipContent>
					{t("settings.auditLog.tooltips.filterProject")}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
