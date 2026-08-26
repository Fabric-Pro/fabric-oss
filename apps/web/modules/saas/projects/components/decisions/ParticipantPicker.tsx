"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
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
import { useState } from "react";

type Props = {
	projectId: string;
	value: string[];
	onChange: (ids: string[]) => void;
};

/** Multi-select of project members (the "linked" half of hybrid participants). */
export function ParticipantPicker({ projectId, value, onChange }: Props) {
	const { organizationId } = useOrganizationContext();
	const [open, setOpen] = useState(false);

	const { data } = useQuery(
		orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const members = data?.members ?? [];

	const labelFor = (id: string) => {
		const m = members.find((member) => member.userId === id);
		return m?.user.name || m?.user.email || id;
	};

	const toggle = (id: string) => {
		onChange(
			value.includes(id) ? value.filter((v) => v !== id) : [...value, id],
		);
	};

	return (
		<div className="space-y-2">
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="outline"
						role="combobox"
						aria-expanded={open}
						className="w-full justify-between font-normal"
					>
						{value.length > 0
							? `${value.length} member${value.length > 1 ? "s" : ""} selected`
							: "Select project members"}
						<ChevronsUpDownIcon className="ml-2 size-4 shrink-0 opacity-50" />
					</Button>
				</PopoverTrigger>
				<PopoverContent
					className="w-[--radix-popover-trigger-width] p-0"
					align="start"
				>
					<Command>
						<CommandInput placeholder="Search members…" />
						<CommandList>
							<CommandEmpty>No members found.</CommandEmpty>
							<CommandGroup>
								{members.map((m) => {
									const selected = value.includes(m.userId);
									return (
										<CommandItem
											key={m.userId}
											value={`${m.user.name ?? ""} ${m.user.email}`}
											onSelect={() => toggle(m.userId)}
										>
											<CheckIcon
												className={cn(
													"mr-2 size-4",
													selected
														? "opacity-100"
														: "opacity-0",
												)}
											/>
											<span className="truncate">
												{m.user.name || m.user.email}
											</span>
										</CommandItem>
									);
								})}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>

			{value.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{value.map((id) => (
						<Badge
							key={id}
							variant="secondary"
							className="gap-1 pr-1"
						>
							{labelFor(id)}
							<button
								type="button"
								onClick={() => toggle(id)}
								aria-label={`Remove ${labelFor(id)}`}
								className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
							>
								<XIcon className="size-3" />
							</button>
						</Badge>
					))}
				</div>
			)}
		</div>
	);
}
