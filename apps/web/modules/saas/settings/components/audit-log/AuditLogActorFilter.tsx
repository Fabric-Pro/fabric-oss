"use client";

/**
 * AuditLogActorFilter
 *
 * Org-context-only combobox for selecting a single member as the audit
 * actor filter. Renders a popover with shadcn/ui Command — server-side
 * typeahead search (debounced 200ms) against
 * `orpcClient.audit.searchMembers`. Selecting a member emits
 * `actorIds: [member.id]` upward.
 *
 * Also surfaces a "Custom" sub-section (Slack-style "Direct match") with
 * checkboxes for actor type buckets: user / api_key / system / agent.
 * The buckets are independent from the member selection and the API
 * accepts both filters concurrently (AND semantics).
 *
 * Personal context never renders this component — see `AuditLogFilters`
 * which conditionally mounts it with `mode === "organization"`.
 *
 * Accessibility: combobox role, search input, keyboard navigation through
 * Command primitive, focus return on close.
 *
 * Spec: docs/audit-log/README.md §8.2.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
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
import { ChevronDown, UsersIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { AuditActorType } from "./types";

interface AuditLogActorFilterProps {
	organizationId: string;
	selectedActorId?: string;
	selectedActorTypes: AuditActorType[];
	onSelect: (member: { id: string; email: string } | null) => void;
	onActorTypesChange: (next: AuditActorType[]) => void;
}

interface Member {
	id: string;
	name: string | null;
	email: string;
	image: string | null;
	role: string;
}

const ACTOR_TYPE_OPTIONS: AuditActorType[] = [
	"user",
	"api_key",
	"system",
	"agent",
];

/**
 * Find one previously-selected member's display in the query result.
 * The query may not include the selected id (e.g. the user typed a
 * filter that excludes them), so we surface a fallback "selected
 * member" pill that still allows clearing.
 */
function findMember(list: Member[], id?: string): Member | null {
	if (!id) {
		return null;
	}
	return list.find((m) => m.id === id) ?? null;
}

export function AuditLogActorFilter({
	organizationId,
	selectedActorId,
	selectedActorTypes,
	onSelect,
	onActorTypesChange,
}: AuditLogActorFilterProps) {
	const t = useTranslations();
	const [open, setOpen] = useState(false);
	const [searchInput, setSearchInput] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");

	// Debounce the query for 200ms so each keystroke doesn't hit the
	// server. The debounce is intentionally short — the audit log viewer
	// is admin-only and the request is cheap (single org, capped at 50).
	useEffect(() => {
		const handle = window.setTimeout(() => {
			setDebouncedQuery(searchInput);
		}, 200);
		return () => window.clearTimeout(handle);
	}, [searchInput]);

	const { data, isFetching } = useQuery({
		queryKey: [
			"audit-log",
			"members",
			organizationId,
			debouncedQuery,
		] as const,
		queryFn: () =>
			orpcClient.audit.searchMembers({
				organizationId,
				query: debouncedQuery,
				limit: 50,
			}),
		staleTime: 30 * 1000,
		enabled: open || Boolean(selectedActorId),
	});

	const members = data?.members ?? [];
	const selectedMember = findMember(members, selectedActorId);

	const label = t("settings.auditLog.actorFilter.label");
	const triggerValue = selectedMember
		? (selectedMember.email ?? selectedMember.id)
		: selectedActorTypes.length > 0
			? selectedActorTypes
					.map((tp) =>
						t(
							`settings.auditLog.filters.actorType.${tp}` as Parameters<
								typeof t
							>[0],
						),
					)
					.join(", ")
			: t("settings.auditLog.actorFilter.placeholder");

	const toggleActorType = (type: AuditActorType) => {
		const next = selectedActorTypes.includes(type)
			? selectedActorTypes.filter((t) => t !== type)
			: [...selectedActorTypes, type];
		onActorTypesChange(next);
	};

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
										"settings.auditLog.actorFilter.ariaLabel",
									)}
									className="h-9 gap-2 text-sm"
								>
									<UsersIcon
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
								data-testid="audit-actor-popover"
							>
								<Command shouldFilter={false}>
									<CommandInput
										value={searchInput}
										onValueChange={setSearchInput}
										placeholder={t(
											"settings.auditLog.actorFilter.searchPlaceholder",
										)}
										data-testid="audit-actor-search"
									/>
									<CommandList>
										{isFetching && members.length === 0 ? (
											<div className="px-3 py-4 text-center text-xs text-muted-foreground">
												{t(
													"settings.auditLog.actorFilter.loading",
												)}
											</div>
										) : null}
										<CommandEmpty>
											{t(
												"settings.auditLog.actorFilter.empty",
											)}
										</CommandEmpty>
										<CommandGroup>
											{members.map((member) => {
												const isSelected =
													member.id ===
													selectedActorId;
												const display =
													member.name ?? member.email;
												return (
													<CommandItem
														key={member.id}
														value={member.id}
														onSelect={() => {
															onSelect({
																id: member.id,
																email: member.email,
															});
															setOpen(false);
														}}
														aria-label={t(
															"settings.auditLog.actorFilter.selectMember",
															{
																name: display,
															} as never,
														)}
														className="flex items-center gap-2"
													>
														<Avatar className="size-6">
															{member.image ? (
																<AvatarImage
																	src={
																		member.image
																	}
																	alt=""
																/>
															) : null}
															<AvatarFallback className="text-[10px]">
																{(
																	display ??
																	"?"
																)
																	.slice(0, 1)
																	.toUpperCase()}
															</AvatarFallback>
														</Avatar>
														<div className="flex min-w-0 flex-1 flex-col">
															<span className="truncate text-sm text-foreground">
																{member.name ??
																	member.email}
															</span>
															{member.name ? (
																<span className="truncate text-[11px] text-muted-foreground">
																	{
																		member.email
																	}
																</span>
															) : null}
														</div>
														<Badge
															variant="outline"
															className="ml-1 text-[10px] uppercase tracking-wider text-muted-foreground"
														>
															{member.role}
														</Badge>
														{isSelected ? (
															<span
																aria-hidden="true"
																className="ml-1 text-primary"
															>
																•
															</span>
														) : null}
													</CommandItem>
												);
											})}
										</CommandGroup>
										<CommandSeparator />
										<CommandGroup
											heading={t(
												"settings.auditLog.filters.actorType.sectionLabel",
											)}
										>
											{ACTOR_TYPE_OPTIONS.map((type) => {
												const checked =
													selectedActorTypes.includes(
														type,
													);
												const display = t(
													`settings.auditLog.filters.actorType.${type}` as Parameters<
														typeof t
													>[0],
												);
												return (
													<CommandItem
														key={type}
														value={`type:${type}`}
														onSelect={() =>
															toggleActorType(
																type,
															)
														}
														className="flex items-center gap-2"
														data-testid={`audit-actor-type-${type}`}
													>
														<Checkbox
															checked={checked}
															aria-label={display}
															className="size-4"
															onCheckedChange={() =>
																toggleActorType(
																	type,
																)
															}
														/>
														<span className="text-sm">
															{display}
														</span>
													</CommandItem>
												);
											})}
										</CommandGroup>
									</CommandList>
								</Command>
							</PopoverContent>
						</Popover>
						{selectedActorId ? (
							<Button
								variant="ghost"
								size="icon"
								aria-label={t(
									"settings.auditLog.actorFilter.clear",
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
					{t("settings.auditLog.tooltips.filterActor")}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
