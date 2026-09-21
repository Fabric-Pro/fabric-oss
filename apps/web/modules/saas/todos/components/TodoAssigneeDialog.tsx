"use client";

import { UserAvatar } from "@shared/components/UserAvatar";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	ContactRoundIcon,
	UserRoundPlusIcon,
	UserRoundXIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import { isUnassigned, type TodoListItem } from "../lib/todo-list-model";
import type {
	TodoAssigneeTarget,
	TodoRowActionsApi,
} from "../lib/todo-row-actions";

const T = "todos.list";

/**
 * Who owes this — chosen from everyone the workspace knows (Fizzy #2340).
 *
 * THIS IS NOT THE CONFIRM CHIP. The chip can only offer names the extraction
 * matched; when it matched nobody the row would otherwise be unassignable
 * forever, which is the exact state this page exists to end. So this opens
 * from ANY row, including one the matcher never had a guess for, one somebody
 * already assigned, and one that was typed by hand.
 *
 * MEMBERS AND CONTACTS IN ONE LIST, because the question a person is asking is
 * "who is doing this", and whether that human happens to hold a Fabric account
 * is not part of the question. They stay visibly different once they are in it
 * — a contact carries the same dashed mark and "no account" badge as in the
 * register — so nobody reads a client's PM as a colleague with access.
 *
 * SEARCH IS THE SERVER'S, not a filter over a loaded page: the member search
 * returns ten matches at a time and the register is workspace-wide, so
 * filtering whatever happened to be fetched would hide people who exist.
 */
export function TodoAssigneeDialog({
	item,
	organizationId,
	actions,
	onClose,
}: {
	/** The row being assigned, or `null` while the dialog is closed. */
	item: TodoListItem | null;
	organizationId: string | null;
	actions: TodoRowActionsApi;
	onClose: () => void;
}) {
	const t = useTranslations();
	const [query, setQuery] = useState("");
	// Both reads below run `contains`/`insensitive` scans that no index covers,
	// and the contacts one also runs a count. Undebounced, typing a ten-letter
	// name fires twenty of them, all in flight against each other. The input
	// itself stays on `query`, so typing is as responsive as before — only the
	// request waits. Same 300ms the sibling typeaheads in this app use.
	const [debouncedQuery] = useDebounceValue(query, 300);

	const itemId = item?.id ?? null;
	useEffect(() => {
		setQuery("");
	}, [itemId]);

	const open = item !== null;
	const enabled = open && Boolean(organizationId);

	const membersQuery = useQuery({
		...orpc.organizations.searchMembers.queryOptions({
			input: { organizationId, query: debouncedQuery },
		}),
		enabled,
	});

	const contactsQuery = useQuery({
		...orpc.todos.contacts.list.queryOptions({
			input: { organizationId, search: debouncedQuery },
		}),
		enabled,
	});

	const members = membersQuery.data?.members ?? [];
	const contacts = contactsQuery.data?.contacts ?? [];

	const choose = (target: TodoAssigneeTarget | null) => {
		if (!item) {
			return;
		}
		actions.assign(item, target);
		onClose();
	};

	const typedName = query.trim();

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
		>
			<DialogContent data-testid="todo-assignee-dialog" className="p-0">
				<DialogHeader className="p-6 pb-2">
					<DialogTitle>{t(`${T}.assignDialog.title`)}</DialogTitle>
					<DialogDescription>
						{t(`${T}.assignDialog.description`)}
					</DialogDescription>
				</DialogHeader>

				<Command shouldFilter={false}>
					<CommandInput
						value={query}
						onValueChange={setQuery}
						placeholder={t(`${T}.assignDialog.search`)}
						data-testid="todo-assignee-search"
					/>
					<CommandList>
						<CommandEmpty>
							{t(`${T}.assignDialog.empty`)}
						</CommandEmpty>

						{members.length > 0 ? (
							<CommandGroup
								heading={t(`${T}.assignDialog.members`)}
							>
								{members.map((member) => (
									<CommandItem
										key={member.id}
										value={`user:${member.id}`}
										data-testid="todo-assignee-member"
										onSelect={() =>
											choose({
												kind: "user",
												id: member.id,
												name: member.name,
											})
										}
										className="flex items-center gap-2"
									>
										<UserAvatar
											className="size-6 shrink-0"
											name={member.name}
											avatarUrl={member.avatarUrl}
										/>
										<span className="min-w-0 truncate">
											{member.name}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						) : null}

						{contacts.length > 0 ? (
							<CommandGroup
								heading={t(`${T}.assignDialog.contacts`)}
							>
								{contacts.map((contact) => (
									<CommandItem
										key={contact.id}
										value={`contact:${contact.id}`}
										data-testid="todo-assignee-contact"
										onSelect={() =>
											choose({
												kind: "contact",
												id: contact.id,
												name: contact.name,
											})
										}
										className="flex items-center gap-2"
									>
										<span
											aria-hidden="true"
											data-testid="contact-no-account-mark"
											className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border border-dashed bg-muted text-muted-foreground"
										>
											<ContactRoundIcon className="size-3.5" />
										</span>
										<span className="min-w-0 truncate">
											{contact.name}
										</span>
										<Badge
											variant="outline"
											className="shrink-0"
										>
											{t(
												"organizations.settings.members.contacts.noAccountBadge",
											)}
										</Badge>
									</CommandItem>
								))}
							</CommandGroup>
						) : null}

						<CommandGroup>
							{/*
							 * The register is filled from here rather than from
							 * settings, because this is where somebody finds out
							 * it is missing a person. The typed search doubles as
							 * that person's name — they have already typed it
							 * once looking for them.
							 */}
							<CommandItem
								value="create-contact"
								data-testid="todo-assignee-create-contact"
								onSelect={() => {
									if (!item) {
										return;
									}
									actions.openNewContact(item, typedName);
									onClose();
								}}
								className="flex items-center gap-2"
							>
								<UserRoundPlusIcon
									aria-hidden="true"
									className="size-4"
								/>
								{typedName
									? t(`${T}.assignDialog.createNamed`, {
											name: typedName,
										})
									: t(`${T}.assignDialog.create`)}
							</CommandItem>

							{item && !isUnassigned(item) ? (
								<CommandItem
									value="unassign"
									data-testid="todo-assignee-unassign"
									onSelect={() => choose(null)}
									className="flex items-center gap-2"
								>
									<UserRoundXIcon
										aria-hidden="true"
										className="size-4"
									/>
									{t(`${T}.assignDialog.unassign`)}
								</CommandItem>
							) : null}
						</CommandGroup>
					</CommandList>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
