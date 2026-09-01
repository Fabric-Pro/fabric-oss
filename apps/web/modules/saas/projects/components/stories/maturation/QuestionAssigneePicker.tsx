"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
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
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { QuestionAssignee } from "./types";

export type AssignableMember = {
	id: string;
	name: string | null;
	email: string | null;
	avatarUrl: string | null;
};

/** Two initials from a display name, falling back to the email's first letter. */
function initials(member: { name: string | null; email: string | null }) {
	const source = member.name?.trim() || member.email?.trim() || "?";
	const parts = source.split(/\s+/).filter(Boolean);
	if (parts.length >= 2) {
		return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
	}
	return source.slice(0, 2).toUpperCase();
}

type Props = {
	assignees: QuestionAssignee[];
	members: AssignableMember[];
	/** Toggling a member submits the COMPLETE new set — the server takes set semantics. */
	onChange: (assigneeUserIds: string[]) => void;
	/** Drives the search so a large project does not ship its whole roster. */
	onQueryChange: (query: string) => void;
	disabled?: boolean;
	saving?: boolean;
};

/**
 * Who a question is waiting on (Fizzy #1751, AC-1/2/3/5/6/21/22).
 *
 * Open to every project member, not just the author: assignment routes
 * accountability, it does not restrict who may answer or reassign (AC-7). There
 * is deliberately no ownership check here or on the procedure behind it.
 *
 * Unassigned questions render a dashed placeholder rather than nothing, so
 * "nobody is on this" reads as a state rather than as missing UI (AC-22).
 */
export function QuestionAssigneePicker({
	assignees,
	members,
	onChange,
	onQueryChange,
	disabled = false,
	saving = false,
}: Props) {
	const t = useTranslations("projects.stories.maturation.summaryQuestions");
	const [open, setOpen] = useState(false);

	const assignedIds = new Set(assignees.map((a) => a.id));

	const toggle = (memberId: string) => {
		const next = assignedIds.has(memberId)
			? assignees.filter((a) => a.id !== memberId).map((a) => a.id)
			: [...assignees.map((a) => a.id), memberId];
		onChange(next);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={disabled || saving}
					className="h-7 gap-1.5 px-1.5"
					aria-label={
						assignees.length > 0
							? t("assigneesLabel", { count: assignees.length })
							: t("assignLabel")
					}
				>
					{assignees.length > 0 ? (
						<span className="flex -space-x-1.5">
							{assignees.slice(0, 3).map((a) => (
								<Avatar
									key={a.id}
									className="size-5 border border-background"
								>
									{a.avatarUrl && (
										<AvatarImage
											src={a.avatarUrl}
											alt={a.name ?? ""}
										/>
									)}
									<AvatarFallback className="text-[9px]">
										{initials({
											name: a.name,
											email: null,
										})}
									</AvatarFallback>
								</Avatar>
							))}
							{assignees.length > 3 && (
								<span className="flex size-5 items-center justify-center rounded-full border border-background bg-muted text-[9px] text-muted-foreground">
									+{assignees.length - 3}
								</span>
							)}
						</span>
					) : (
						<span className="flex size-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground">
							<UserPlusIcon className="size-3" />
						</span>
					)}
					<span className="text-[11px] text-muted-foreground">
						{assignees.length > 0
							? t("assignedState")
							: t("unassignedState")}
					</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-64 p-0" align="start">
				<Command shouldFilter={false}>
					<CommandInput
						placeholder={t("assigneeSearchPlaceholder")}
						onValueChange={onQueryChange}
					/>
					<CommandList>
						<CommandEmpty>{t("assigneeSearchEmpty")}</CommandEmpty>
						<CommandGroup>
							{members.map((member) => {
								const isAssigned = assignedIds.has(member.id);
								return (
									<CommandItem
										key={member.id}
										value={member.id}
										onSelect={() => toggle(member.id)}
										className="gap-2"
									>
										<Avatar className="size-5">
											{member.avatarUrl && (
												<AvatarImage
													src={member.avatarUrl}
													alt={member.name ?? ""}
												/>
											)}
											<AvatarFallback className="text-[9px]">
												{initials(member)}
											</AvatarFallback>
										</Avatar>
										<span className="truncate text-xs">
											{member.name ?? member.email}
										</span>
										{isAssigned && (
											<CheckIcon className="ml-auto size-3.5 text-primary" />
										)}
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
