"use client";

/**
 * The organization's register of non-member contacts (Fizzy #2340).
 *
 * A contact is a person the workspace tracks work for who has NO Fabric
 * account: a client's project manager, an external reviewer, a supplier. They
 * never sign in and they grant nobody access, which is why this list sits
 * beside the members list rather than inside it — and why every row here is
 * built to be told apart from a member row at a glance rather than on
 * inspection. A member row leads with the person's real avatar; a contact row
 * leads with a dashed placeholder mark and carries a "no account" badge, so
 * someone scanning the settings page cannot read one as the other.
 *
 * Email and company are optional and exist for ONE reason: two people at one
 * client really can share a name, and the register has to keep them apart. The
 * first of them that is filled in is therefore always rendered as the row's
 * second line, never hidden behind an edit dialog.
 */

import { useEffectiveOrganizationId } from "@saas/organizations/hooks";
import { organizationContactsQueryKey } from "@saas/organizations/lib/contacts-api";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	EmptyState,
	EmptyStateDescription,
	EmptyStateIcon,
	EmptyStateTitle,
} from "@ui/components/empty-state";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Table, TableBody, TableCell, TableRow } from "@ui/components/table";
import {
	ContactRoundIcon,
	MoreVerticalIcon,
	PencilIcon,
	TrashIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { trimmedOrUndefined } from "../lib/contacts-api";

type Contact = {
	id: string;
	name: string;
	email: string | null;
	company: string | null;
	createdAt: string;
};

type ContactDraft = {
	name: string;
	email: string;
	company: string;
};

const EMPTY_DRAFT: ContactDraft = { name: "", email: "", company: "" };

const T = "organizations.settings.members.contacts";

/**
 * `""` means "not given", and the API distinguishes that from "cleared" only by
 * receiving `undefined` on a create and `""` on an update. Both are normalized
 * to NULL server-side, so the form only has to avoid sending whitespace.
 */
export function OrganizationContactsList({
	organizationId: propOrganizationId,
}: {
	organizationId?: string | null;
}) {
	const t = useTranslations();
	const queryClient = useQueryClient();
	const organizationId = useEffectiveOrganizationId(propOrganizationId);

	const [draft, setDraft] = useState<ContactDraft>(EMPTY_DRAFT);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editDraft, setEditDraft] = useState<ContactDraft>(EMPTY_DRAFT);
	const [pendingDeletion, setPendingDeletion] = useState<Contact | null>(
		null,
	);
	/**
	 * A same-name create is refused once and handed back the existing match(es);
	 * this holds both halves of that exchange, so the confirmation can show who
	 * is already in the register AND still have the values to re-send.
	 */
	const [duplicatePrompt, setDuplicatePrompt] = useState<{
		values: ContactDraft;
		duplicates: Contact[];
	} | null>(null);

	const { data, isPending } = useQuery({
		...orpc.todos.contacts.list.queryOptions({
			input: { organizationId },
		}),
		enabled: !!organizationId,
	});

	const contacts: Contact[] = data?.contacts ?? [];

	// Every write invalidates through the shared base key — see the note on
	// `organizationContactsQueryKey` for why this is never hand-built here.
	const invalidateContacts = () =>
		queryClient.invalidateQueries({
			queryKey: organizationContactsQueryKey(),
		});

	const createContact = useMutation({
		mutationFn: (values: ContactDraft & { confirmDuplicate?: boolean }) =>
			orpc.todos.contacts.create.call({
				organizationId,
				name: values.name.trim(),
				email: trimmedOrUndefined(values.email),
				company: trimmedOrUndefined(values.company),
				confirmDuplicate: values.confirmDuplicate,
			}),
		onSuccess: async (result, values) => {
			// The response is a discriminated union precisely so this branch
			// cannot be skipped: on "duplicate" nothing was written and
			// `contact` is null, so reading it would be reading a create that
			// did not happen.
			if (result.status === "duplicate") {
				setDuplicatePrompt({
					values,
					duplicates: result.duplicates,
				});
				return;
			}

			setDraft(EMPTY_DRAFT);
			await invalidateContacts();
			toast.success(
				t(`${T}.notifications.created.description`, {
					name: result.contact.name,
				}),
			);
		},
		onError: () => {
			toast.error(t(`${T}.notifications.created.error`));
		},
		// Only the CONFIRMED attempt closes the confirmation, and it closes it
		// on the error path too. Clearing unconditionally here would wipe the
		// prompt that `onSuccess` had just opened for the first attempt.
		onSettled: (_result, _error, values) => {
			if (values.confirmDuplicate) {
				setDuplicatePrompt(null);
			}
		},
	});

	const updateContact = useMutation({
		mutationFn: (values: ContactDraft & { contactId: string }) =>
			orpc.todos.contacts.update.call({
				organizationId,
				contactId: values.contactId,
				name: values.name.trim(),
				// `""` clears the field rather than leaving it untouched, which
				// is what an emptied input means.
				email: values.email.trim(),
				company: values.company.trim(),
			}),
		onSuccess: async () => {
			await invalidateContacts();
			toast.success(t(`${T}.notifications.updated.description`));
			// Closing the editor belongs on success, not on settle. The
			// clear-in-onSettled rule is about optimistic values, which must be
			// released on both paths; a half-typed correction is the person's
			// work, and throwing it away because the save failed makes them type
			// it again to find out whether the retry works.
			setEditingId(null);
		},
		onError: () => {
			toast.error(t(`${T}.notifications.updated.error`));
		},
	});

	const deleteContact = useMutation({
		mutationFn: (contactId: string) =>
			orpc.todos.contacts.delete.call({ organizationId, contactId }),
		onSuccess: async (result) => {
			await invalidateContacts();
			// Deleting redacts the person and detaches their to-dos rather than
			// removing them, so the count is the whole point of the message:
			// it tells the operator exactly how much work is now unassigned.
			toast.success(
				t(`${T}.notifications.deleted.description`, {
					count: result.detachedTodoCount,
				}),
			);
		},
		onError: () => {
			toast.error(t(`${T}.notifications.deleted.error`));
		},
		onSettled: () => {
			setPendingDeletion(null);
		},
	});

	const startEditing = (contact: Contact) => {
		setEditingId(contact.id);
		setEditDraft({
			name: contact.name,
			email: contact.email ?? "",
			company: contact.company ?? "",
		});
	};

	return (
		<div className="flex w-full min-w-0 flex-col gap-4">
			<form
				className="@container"
				onSubmit={(event) => {
					event.preventDefault();
					if (!draft.name.trim()) {
						return;
					}
					createContact.mutate(draft);
				}}
			>
				<div className="flex flex-col gap-2 @xl:flex-row">
					<div className="min-w-0 flex-1">
						<Label htmlFor="new-contact-name">
							{t(`${T}.form.name`)}
						</Label>
						<Input
							id="new-contact-name"
							value={draft.name}
							required
							onChange={(event) =>
								setDraft((current) => ({
									...current,
									name: event.target.value,
								}))
							}
						/>
					</div>
					<div className="min-w-0 flex-1">
						<Label htmlFor="new-contact-email">
							{t(`${T}.form.email`)}
						</Label>
						<Input
							id="new-contact-email"
							type="email"
							value={draft.email}
							onChange={(event) =>
								setDraft((current) => ({
									...current,
									email: event.target.value,
								}))
							}
						/>
					</div>
					<div className="min-w-0 flex-1">
						<Label htmlFor="new-contact-company">
							{t(`${T}.form.company`)}
						</Label>
						<Input
							id="new-contact-company"
							value={draft.company}
							onChange={(event) =>
								setDraft((current) => ({
									...current,
									company: event.target.value,
								}))
							}
						/>
					</div>
				</div>
				<p className="mt-2 text-muted-foreground text-xs">
					{t(`${T}.form.hint`)}
				</p>
				<div className="mt-3 flex justify-end">
					<Button
						type="submit"
						loading={createContact.isPending}
						disabled={!draft.name.trim() || !organizationId}
					>
						{t(`${T}.form.submit`)}
					</Button>
				</div>
			</form>

			<div className="w-full min-w-0 rounded-md border">
				{contacts.length === 0 ? (
					<EmptyState>
						<EmptyStateIcon>
							<ContactRoundIcon className="size-8" />
						</EmptyStateIcon>
						<EmptyStateTitle>
							{t(`${T}.empty.title`)}
						</EmptyStateTitle>
						<EmptyStateDescription>
							{isPending
								? t(`${T}.empty.loading`)
								: t(`${T}.empty.description`)}
						</EmptyStateDescription>
					</EmptyState>
				) : (
					<Table>
						<TableBody>
							{contacts.map((contact) => {
								const secondaryLine =
									contact.email?.trim() ||
									contact.company?.trim() ||
									null;
								const isEditing = editingId === contact.id;

								return isEditing ? (
									// The editor takes the WHOLE row rather than sharing it with the actions
									// column. Three inputs squeezed beside two buttons is what overflows a
									// settings column at phone width; stacked in a full-width cell, nothing
									// has to shrink below its content.
									<TableRow
										key={contact.id}
										data-testid="contact-row"
									>
										<TableCell colSpan={2}>
											<div className="flex flex-col gap-2">
												<div>
													<Label
														htmlFor={`edit-contact-name-${contact.id}`}
													>
														{t(`${T}.form.name`)}
													</Label>
													<Input
														id={`edit-contact-name-${contact.id}`}
														value={editDraft.name}
														onChange={(event) =>
															setEditDraft(
																(current) => ({
																	...current,
																	name: event
																		.target
																		.value,
																}),
															)
														}
													/>
												</div>
												<div>
													<Label
														htmlFor={`edit-contact-email-${contact.id}`}
													>
														{t(`${T}.form.email`)}
													</Label>
													<Input
														id={`edit-contact-email-${contact.id}`}
														type="email"
														value={editDraft.email}
														onChange={(event) =>
															setEditDraft(
																(current) => ({
																	...current,
																	email: event
																		.target
																		.value,
																}),
															)
														}
													/>
												</div>
												<div>
													<Label
														htmlFor={`edit-contact-company-${contact.id}`}
													>
														{t(`${T}.form.company`)}
													</Label>
													<Input
														id={`edit-contact-company-${contact.id}`}
														value={
															editDraft.company
														}
														onChange={(event) =>
															setEditDraft(
																(current) => ({
																	...current,
																	company:
																		event
																			.target
																			.value,
																}),
															)
														}
													/>
												</div>
												<div className="flex flex-wrap justify-end gap-2">
													<Button
														size="sm"
														variant="outline"
														type="button"
														onClick={() =>
															setEditingId(null)
														}
													>
														{t(`${T}.form.cancel`)}
													</Button>
													<Button
														size="sm"
														type="button"
														loading={
															updateContact.isPending
														}
														disabled={
															!editDraft.name.trim()
														}
														onClick={() =>
															updateContact.mutate(
																{
																	...editDraft,
																	contactId:
																		contact.id,
																},
															)
														}
													>
														{t(`${T}.form.save`)}
													</Button>
												</div>
											</div>
										</TableCell>
									</TableRow>
								) : (
									<TableRow
										key={contact.id}
										data-testid="contact-row"
									>
										{/*
										 * `max-w-0` is what lets the truncation below actually
										 * bite: a table cell otherwise refuses to shrink under
										 * its content, and the row would push the settings
										 * column sideways on a phone.
										 */}
										<TableCell className="max-w-0">
											<div className="flex min-w-0 items-center gap-2">
												{/*
												 * A member row leads with the person's real
												 * avatar. This dashed, empty mark is the
												 * deliberate visual opposite of one: there is no
												 * account behind it.
												 */}
												<span
													aria-hidden="true"
													data-testid="contact-no-account-mark"
													className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border border-dashed bg-muted text-muted-foreground"
												>
													<ContactRoundIcon className="size-4" />
												</span>
												<div className="min-w-0 leading-normal">
													<div className="flex flex-wrap items-center gap-1.5">
														<strong className="truncate">
															{contact.name}
														</strong>
														<Badge
															variant="outline"
															className="shrink-0"
														>
															{t(
																`${T}.noAccountBadge`,
															)}
														</Badge>
													</div>
													<small className="block truncate text-foreground/60">
														{secondaryLine ??
															t(`${T}.noDetails`)}
													</small>
												</div>
											</div>
										</TableCell>
										<TableCell className="w-px whitespace-nowrap align-top">
											<div className="flex flex-row justify-end gap-2">
												<DropdownMenu>
													<DropdownMenuTrigger
														asChild
													>
														<Button
															size="icon"
															variant="ghost"
															aria-label={t(
																`${T}.rowActions`,
															)}
														>
															<MoreVerticalIcon className="size-4" />
														</Button>
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end">
														<DropdownMenuItem
															onClick={() =>
																startEditing(
																	contact,
																)
															}
														>
															<PencilIcon className="mr-2 size-4" />
															{t(`${T}.edit`)}
														</DropdownMenuItem>
														<DropdownMenuItem
															className="text-destructive"
															onClick={() =>
																setPendingDeletion(
																	contact,
																)
															}
														>
															<TrashIcon className="mr-2 size-4" />
															{t(`${T}.delete`)}
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>
											</div>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				)}
			</div>

			<AlertDialog
				open={duplicatePrompt !== null}
				onOpenChange={(open) => {
					if (!open) {
						setDuplicatePrompt(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t(`${T}.duplicate.title`)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t(`${T}.duplicate.description`, {
								name: duplicatePrompt?.values.name ?? "",
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<ul className="flex flex-col gap-2 rounded-md border p-3 text-sm">
						{duplicatePrompt?.duplicates.map((duplicate) => (
							<li key={duplicate.id} className="min-w-0">
								<strong className="block truncate">
									{duplicate.name}
								</strong>
								<small className="block truncate text-foreground/60">
									{duplicate.email?.trim() ||
										duplicate.company?.trim() ||
										t(`${T}.noDetails`)}
								</small>
							</li>
						))}
					</ul>
					<AlertDialogFooter>
						<AlertDialogCancel>
							{t(`${T}.duplicate.cancel`)}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								// Radix closes on activate; the mutation owns
								// this dialog's lifetime instead, so the
								// confirmation stays up until the retry settles.
								event.preventDefault();
								if (!duplicatePrompt) {
									return;
								}
								createContact.mutate({
									...duplicatePrompt.values,
									confirmDuplicate: true,
								});
							}}
						>
							{t(`${T}.duplicate.confirm`)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				open={pendingDeletion !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDeletion(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t(`${T}.deleteConfirm.title`)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t(`${T}.deleteConfirm.description`, {
								name: pendingDeletion?.name ?? "",
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							{t(`${T}.deleteConfirm.cancel`)}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								event.preventDefault();
								if (!pendingDeletion) {
									return;
								}
								deleteContact.mutate(pendingDeletion.id);
							}}
						>
							{t(`${T}.deleteConfirm.confirm`)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
