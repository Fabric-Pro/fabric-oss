"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { UsersIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { toast } from "sonner";

// Owner is left out: it is the one role a project admin cannot grant.
const ROLES = [
	{ value: "PROJECT_ADMIN", label: "Project admin" },
	{ value: "EDITOR", label: "Editor" },
	{ value: "COMMENTER", label: "Commenter" },
	{ value: "VIEWER", label: "Viewer" },
] as const;
type PickerRole = (typeof ROLES)[number]["value"];

type Person = { id: string; name: string | null; email: string };

const eligibleQueryKey = (projectId: string) =>
	["projects", "members", "eligible", projectId] as const;

function failureMessage(error: unknown): string {
	const { data, message } = error as {
		data?: { message?: string };
		message?: string;
	};
	return data?.message ?? message ?? "Failed to send invitation";
}

export function ProjectOrgMemberPicker({
	projectId,
	organizationId,
	onAdded,
}: {
	projectId: string;
	organizationId: string;
	onAdded: () => void;
}) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const term = useDeferredValue(search.trim());
	// Keyed by id and held apart from the results, so someone stays selected
	// after a new search stops showing them.
	const [selected, setSelected] = useState<Map<string, Person>>(new Map());
	const [role, setRole] = useState<PickerRole>("VIEWER");
	const [failures, setFailures] = useState<string[]>([]);

	const { data, isLoading, isError, refetch } = useQuery({
		queryKey: [...eligibleQueryKey(projectId), term],
		queryFn: () =>
			orpcClient.projects.members.getEligible({
				projectId,
				organizationId,
				search: term || undefined,
			}),
		enabled: open,
		// The invite form and revoke action beside this dialog change who is
		// eligible, so a result kept from the last time it was open can be wrong.
		staleTime: 0,
	});
	const people = data?.users ?? [];

	const toggle = (person: Person) => {
		setSelected((current) => {
			const next = new Map(current);
			if (!next.delete(person.id)) {
				next.set(person.id, person);
			}
			return next;
		});
	};

	const reset = () => {
		setSearch("");
		setSelected(new Map());
		setRole("VIEWER");
		setFailures([]);
	};

	const add = useMutation({
		mutationFn: async () => {
			const invited: Person[] = [];
			const failed: Array<{ person: Person; message: string }> = [];
			for (const person of selected.values()) {
				try {
					await orpcClient.projects.members.invite({
						projectId,
						email: person.email,
						role,
					});
					invited.push(person);
				} catch (error) {
					failed.push({ person, message: failureMessage(error) });
				}
			}
			return { invited, failed };
		},
		onSuccess: ({ invited, failed }) => {
			if (invited.length > 0) {
				toast.success(
					invited.length === 1
						? "Invitation sent"
						: `${invited.length} invitations sent`,
				);
				queryClient.invalidateQueries({
					queryKey: eligibleQueryKey(projectId),
				});
				onAdded();
			}
			if (failed.length > 0) {
				toast.error("Some invitations could not be sent");
				setSelected(
					new Map(failed.map(({ person }) => [person.id, person])),
				);
				setFailures(
					failed.map(
						({ person, message }) => `${person.email}: ${message}`,
					),
				);
				return;
			}
			setOpen(false);
			reset();
		},
	});

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// A batch that is still sending owns this dialog's state.
				if (add.isPending) {
					return;
				}
				setOpen(next);
				if (!next) {
					reset();
				}
			}}
		>
			<DialogTrigger asChild>
				<Button size="sm" variant="outline">
					<UsersIcon className="size-4 mr-2" />
					Add from organization
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add from organization</DialogTitle>
					<DialogDescription>
						Choose people who are already in your organization. They
						join the project when they accept the invitation.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<Input
						type="search"
						aria-label="Search organization members"
						placeholder="Search by name or email"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
					<ul className="max-h-64 divide-y overflow-y-auto rounded-md border text-sm">
						{people.map((person) => {
							const label = person.name
								? `${person.name} (${person.email})`
								: person.email;
							return (
								<li key={person.id}>
									<div className="flex items-center gap-3 px-3 py-2">
										<Checkbox
											aria-label={label}
											checked={selected.has(person.id)}
											disabled={add.isPending}
											onCheckedChange={() =>
												toggle(person)
											}
										/>
										<span className="min-w-0 break-all">
											{person.name ?? person.email}
											{person.name && (
												<span className="block text-muted-foreground text-xs">
													{person.email}
												</span>
											)}
										</span>
									</div>
								</li>
							);
						})}
						{isError && (
							<li className="flex items-center justify-between gap-3 px-3 py-4">
								<span className="text-destructive">
									Could not load members
								</span>
								<Button
									size="sm"
									variant="outline"
									onClick={() => refetch()}
								>
									Retry
								</Button>
							</li>
						)}
						{!isLoading && !isError && people.length === 0 && (
							<li className="px-3 py-6 text-center text-muted-foreground">
								No members found
							</li>
						)}
					</ul>
					<Select
						value={role}
						disabled={add.isPending}
						onValueChange={(value) => setRole(value as PickerRole)}
					>
						<SelectTrigger aria-label="Project role">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{ROLES.map((option) => (
								<SelectItem
									key={option.value}
									value={option.value}
								>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{failures.length > 0 && (
						<ul role="alert" className="text-destructive text-sm">
							{failures.map((failure) => (
								<li key={failure}>{failure}</li>
							))}
						</ul>
					)}
				</div>
				<DialogFooter>
					<Button
						loading={add.isPending}
						disabled={selected.size === 0}
						onClick={() => add.mutate()}
					>
						{`Add ${selected.size || ""}`.trim()}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
