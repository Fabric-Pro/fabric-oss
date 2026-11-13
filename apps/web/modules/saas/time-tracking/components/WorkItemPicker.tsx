"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
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
import { cn } from "@ui/lib";
import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import type { StoryRef } from "../lib/entry-draft";

/** Enough to find an item by typing; the search narrows the rest. */
const MAX_OPTIONS = 50;

/**
 * Optional single work item for an entry, from the entry's project.
 *
 * Reads the project's existing board (`projects.stories.board`, the source
 * the meeting digest's link picker uses) only once the list is opened, and
 * filters it here: a project's backlog is a few hundred items at most.
 */
export function WorkItemPicker({
	projectId,
	organizationId,
	value,
	onChange,
	id,
}: {
	projectId: string;
	organizationId: string;
	value: StoryRef | null;
	onChange: (story: StoryRef | null) => void;
	id?: string;
}) {
	const t = useTranslations("timeTracking.form");
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");

	const { data, isLoading, isError } = useQuery({
		...orpc.projects.stories.board.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: open,
		staleTime: 60_000,
	});

	const matches = useMemo(() => {
		const term = search.trim().toLowerCase();
		return (data?.stories ?? [])
			.filter((story) =>
				term === ""
					? true
					: `${story.identifier} ${story.title}`
							.toLowerCase()
							.includes(term),
			)
			.slice(0, MAX_OPTIONS);
	}, [data, search]);

	return (
		<div className="flex min-w-0 flex-1 basis-56 items-center gap-1">
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						id={id}
						type="button"
						variant="outline"
						role="combobox"
						aria-expanded={open}
						aria-label={t("workItem")}
						className={cn(
							"min-w-0 flex-1 justify-between font-normal",
							!value && "text-muted-foreground",
						)}
					>
						<span className="min-w-0 truncate">
							{value
								? `${value.identifier} · ${value.title}`
								: t("workItemPlaceholder")}
						</span>
						<ChevronsUpDownIcon
							aria-hidden="true"
							className="size-4 shrink-0 opacity-50"
						/>
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-80 p-0">
					<Command shouldFilter={false}>
						<CommandInput
							value={search}
							onValueChange={setSearch}
							placeholder={t("workItemSearch")}
						/>
						<CommandList>
							{isLoading ? (
								<div className="py-6 text-center text-muted-foreground text-sm">
									{t("workItemLoading")}
								</div>
							) : isError ? (
								<div className="py-6 text-center text-destructive text-sm">
									{t("workItemLoadFailed")}
								</div>
							) : (
								<>
									<CommandEmpty>
										{t("workItemNoMatches")}
									</CommandEmpty>
									<CommandGroup>
										{matches.map((story) => (
											<CommandItem
												key={story.id}
												value={story.id}
												onSelect={() => {
													onChange({
														id: story.id,
														identifier:
															story.identifier,
														title: story.title,
													});
													setSearch("");
													setOpen(false);
												}}
											>
												<CheckIcon
													aria-hidden="true"
													className={cn(
														"size-4 shrink-0",
														value?.id === story.id
															? "opacity-100"
															: "opacity-0",
													)}
												/>
												<span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
													{story.identifier}
												</span>
												<span className="min-w-0 flex-1 truncate">
													{story.title}
												</span>
											</CommandItem>
										))}
									</CommandGroup>
								</>
							)}
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
			{value ? (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t("clearWorkItem")}
					onClick={() => onChange(null)}
				>
					<XIcon aria-hidden="true" />
				</Button>
			) : null}
		</div>
	);
}
