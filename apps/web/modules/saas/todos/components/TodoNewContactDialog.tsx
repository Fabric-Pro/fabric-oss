"use client";

import {
	organizationContactsQueryKey,
	trimmedOrUndefined,
} from "@saas/organizations/lib/contacts-api";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
	TodoNewContactRequest,
	TodoRowActionsApi,
} from "../lib/todo-row-actions";

const T = "todos.list";

interface ContactDraft {
	name: string;
	email: string;
	company: string;
}

const EMPTY_DRAFT: ContactDraft = { name: "", email: "", company: "" };

/** `""` means "not given"; the API normalizes either that or `null` to NULL. */
interface ContactRow {
	id: string;
	name: string;
	email: string | null;
	company: string | null;
}

/**
 * Add the person the transcript named, and hand them the row — one act
 * (Fizzy #2340).
 *
 * WHY IT ASSIGNS TOO. A contact created from here and left unassigned solves
 * nothing: the reader came to this dialog from a row nobody owns, and making
 * them close it, find the row again and open a picker is how a two-step flow
 * ends up abandoned at step one. The create and the assign are one gesture,
 * so the register fills as a side effect of doing the work.
 *
 * THE DUPLICATE BRANCH IS NOT AN ERROR. Two people at one client really can
 * share a name, so `contacts.create` refuses a same-name create ONCE and hands
 * back who is already there. That answer is a discriminated union precisely so
 * this branch cannot be skipped — `contact` is `null` on it, and reading it
 * blindly would be reading a create that did not happen. The reader then gets
 * the choice that actually matters: use the person who already exists, or say
 * plainly that this is a different one.
 *
 * WHAT WAS TYPED SURVIVES A FAILURE. The draft is cleared when the dialog
 * closes or the contact is created, never in `onSettled` — a save that failed
 * and took the name with it makes the person retype it just to find out
 * whether the retry works.
 */
export function TodoNewContactDialog({
	request,
	organizationId,
	actions,
	onClose,
}: {
	/** The row waiting for a contact, or `null` while the dialog is closed. */
	request: TodoNewContactRequest | null;
	organizationId: string | null;
	actions: TodoRowActionsApi;
	onClose: () => void;
}) {
	const t = useTranslations();
	const queryClient = useQueryClient();

	const [draft, setDraft] = useState<ContactDraft>(EMPTY_DRAFT);
	/**
	 * Both halves of the refused create: who is already in the register, and
	 * the values to re-send if this really is somebody else.
	 */
	const [duplicatePrompt, setDuplicatePrompt] = useState<{
		values: ContactDraft;
		duplicates: ContactRow[];
	} | null>(null);

	// Seeded from the transcript's owner name, and re-seeded when the dialog is
	// opened for a different row — otherwise the second row would arrive
	// carrying the first row's person.
	const requestKey = request
		? `${request.item.id}:${request.seedName}`
		: null;
	useEffect(() => {
		setDraft({ ...EMPTY_DRAFT, name: request?.seedName ?? "" });
		setDuplicatePrompt(null);
	}, [requestKey]);

	const assignToContact = (contact: ContactRow) => {
		if (request) {
			actions.assign(request.item, {
				kind: "contact",
				id: contact.id,
				name: contact.name,
			});
		}
		onClose();
	};

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
			if (result.status === "duplicate") {
				setDuplicatePrompt({ values, duplicates: result.duplicates });
				return;
			}
			// The register is a read of its own; the to-do list is refreshed by
			// the assign that follows. Both keys are derived, never spelled out.
			await queryClient.invalidateQueries({
				queryKey: organizationContactsQueryKey(),
			});
			toast.success(
				t(`${T}.newContact.created`, { name: result.contact.name }),
			);
			assignToContact(result.contact);
		},
		onError: (error) => {
			// Adding to the register is the same kind of act as inviting
			// someone in, so it is gated on `ORG_MEMBERS_INVITE` — a member
			// without it is not having a bad moment, and telling them to try
			// again would send them round the same refusal indefinitely.
			const forbidden =
				(error as { code?: string } | null)?.code === "FORBIDDEN";
			toast.error(
				t(
					forbidden
						? `${T}.newContact.forbidden`
						: `${T}.newContact.error`,
				),
			);
		},
	});

	const canSubmit = draft.name.trim().length > 0 && Boolean(organizationId);

	return (
		<Dialog
			open={request !== null}
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<DialogContent data-testid="todo-new-contact-dialog">
				<DialogHeader>
					<DialogTitle>{t(`${T}.newContact.title`)}</DialogTitle>
					<DialogDescription>
						{t(`${T}.newContact.description`)}
					</DialogDescription>
				</DialogHeader>

				{duplicatePrompt ? (
					<div
						data-testid="todo-new-contact-duplicate"
						className="space-y-3"
					>
						<p className="text-sm">
							{t(`${T}.newContact.duplicate.description`, {
								name: duplicatePrompt.values.name.trim(),
							})}
						</p>
						<ul className="flex flex-col gap-2 rounded-md border p-3 text-sm">
							{duplicatePrompt.duplicates.map((duplicate) => (
								<li
									key={duplicate.id}
									className="flex min-w-0 items-center gap-2"
								>
									<span className="min-w-0 flex-1">
										<strong className="block truncate">
											{duplicate.name}
										</strong>
										<small className="block truncate text-foreground/60">
											{duplicate.email?.trim() ||
												duplicate.company?.trim() ||
												t(
													"organizations.settings.members.contacts.noDetails",
												)}
										</small>
									</span>
									<Button
										type="button"
										size="sm"
										variant="outline"
										data-testid="todo-new-contact-use-existing"
										onClick={() =>
											assignToContact(duplicate)
										}
									>
										{t(`${T}.newContact.duplicate.useThis`)}
									</Button>
								</li>
							))}
						</ul>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setDuplicatePrompt(null)}
							>
								{t(`${T}.newContact.duplicate.cancel`)}
							</Button>
							<Button
								type="button"
								loading={createContact.isPending}
								data-testid="todo-new-contact-confirm-duplicate"
								onClick={() =>
									createContact.mutate({
										...duplicatePrompt.values,
										confirmDuplicate: true,
									})
								}
							>
								{t(`${T}.newContact.duplicate.confirm`)}
							</Button>
						</DialogFooter>
					</div>
				) : (
					<form
						className="space-y-3"
						onSubmit={(event) => {
							event.preventDefault();
							if (!canSubmit) {
								return;
							}
							createContact.mutate(draft);
						}}
					>
						<div>
							<Label htmlFor="todo-new-contact-name">
								{t(`${T}.newContact.name`)}
							</Label>
							<Input
								id="todo-new-contact-name"
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
						<div>
							<Label htmlFor="todo-new-contact-email">
								{t(`${T}.newContact.email`)}
							</Label>
							<Input
								id="todo-new-contact-email"
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
						<div>
							<Label htmlFor="todo-new-contact-company">
								{t(`${T}.newContact.company`)}
							</Label>
							<Input
								id="todo-new-contact-company"
								value={draft.company}
								onChange={(event) =>
									setDraft((current) => ({
										...current,
										company: event.target.value,
									}))
								}
							/>
						</div>
						<p className="text-muted-foreground text-xs">
							{t(`${T}.newContact.hint`)}
						</p>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={onClose}
							>
								{t(`${T}.newContact.cancel`)}
							</Button>
							<Button
								type="submit"
								disabled={!canSubmit}
								loading={createContact.isPending}
								data-testid="todo-new-contact-submit"
							>
								{t(`${T}.newContact.submit`)}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
