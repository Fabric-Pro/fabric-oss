"use client";

/**
 * What a row can DO, and the three rules every one of those acts obeys
 * (Fizzy #2340).
 *
 * The list is a page people work down rather than read, so each act has to
 * land visibly and instantly while still being honest about what the server
 * said. That is three rules, and all three are here rather than in the row so
 * they cannot drift apart between one control and the next:
 *
 *  1. ONE CALL PER ROW AT A TIME. The guard is a ref, checked and set in the
 *     same synchronous turn as the click. `disabled` from state is not enough
 *     on its own: two clicks inside one React batch both read the pre-render
 *     value and both fire, which is exactly what a double-click is. The ref
 *     closes that window; the state drives what the person sees.
 *  2. OPTIMISTIC, THEN RELEASED. The override is the row's claim about a call
 *     in flight. `onSuccess` AWAITS the invalidation, so by the time
 *     `onSettled` drops the override the refetched response already carries
 *     the same fact and nothing flickers through the old value. On failure the
 *     same drop IS the rollback, and a toast says so — a row that silently
 *     snaps back reads as a click that missed.
 *  3. NOTHING TYPED IS THROWN AWAY. Only optimistic values are cleared in
 *     `onSettled`. Draft state — a half-filled contact — belongs to the
 *     person, and discarding it because a save failed makes them retype it to
 *     find out whether the retry works (the lesson `OrganizationContactsList`
 *     records).
 *
 * Every write refreshes the list through `invalidateTodoList`, which derives
 * its filter from the read's own key. A hand-built `["todos","list"]` matches
 * none of the three key shapes in this app and `invalidateQueries` reports no
 * error, so the bug would read as a stale server rather than as a typo.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { TodoListItem, TodoOverride } from "./todo-list-model";
import {
	forgetJustCompletedTodo,
	invalidateTodoList,
	rememberJustCompletedTodo,
} from "./todos-api";
import { useInFlightGuard } from "./use-in-flight-guard";

const T = "todos.list";

/** A person a row can be handed to: a member, or a contact with no account. */
export interface TodoAssigneeTarget {
	kind: "user" | "contact";
	id: string;
	name: string;
}

/** Everything a row's controls can ask for. */
export interface TodoRowActionsApi {
	/** A call is in flight for this row; its controls are inert until it lands. */
	isBusy: (todoId: string) => boolean;
	setCompleted: (item: TodoListItem, completed: boolean) => void;
	snooze: (item: TodoListItem, until: Date) => void;
	unsnooze: (item: TodoListItem) => void;
	/** `null` unassigns — the same call, because the row holds one or nobody. */
	assign: (item: TodoListItem, target: TodoAssigneeTarget | null) => void;
	openAssignee: (item: TodoListItem) => void;
	openSnooze: (item: TodoListItem) => void;
	openNewContact: (item: TodoListItem, seedName: string) => void;
}

/** A row waiting on a dialog, and what that dialog opened with. */
export interface TodoNewContactRequest {
	item: TodoListItem;
	/** The transcript's owner name when there is one, otherwise empty. */
	seedName: string;
}

export interface UseTodoRowActionsResult {
	actions: TodoRowActionsApi;
	/** Claims about calls in flight, by to-do id. */
	overrides: Record<string, TodoOverride>;
	assigneeFor: TodoListItem | null;
	snoozeFor: TodoListItem | null;
	newContactFor: TodoNewContactRequest | null;
	closeAssignee: () => void;
	closeSnooze: () => void;
	closeNewContact: () => void;
}

export function useTodoRowActions({
	organizationId,
}: {
	organizationId: string | null;
}): UseTodoRowActionsResult {
	const t = useTranslations();
	const queryClient = useQueryClient();

	const [overrides, setOverrides] = useState<Record<string, TodoOverride>>(
		{},
	);
	const { busyIds, claim, release } = useInFlightGuard();

	const [assigneeFor, setAssigneeFor] = useState<TodoListItem | null>(null);
	const [snoozeFor, setSnoozeFor] = useState<TodoListItem | null>(null);
	const [newContactFor, setNewContactFor] =
		useState<TodoNewContactRequest | null>(null);

	const override = useCallback((todoId: string, values: TodoOverride) => {
		setOverrides((current) => ({
			...current,
			[todoId]: { ...current[todoId], ...values },
		}));
	}, []);

	const clearOverride = useCallback((todoId: string) => {
		setOverrides((current) => {
			if (!(todoId in current)) {
				return current;
			}
			const { [todoId]: _dropped, ...rest } = current;
			return rest;
		});
	}, []);

	/** Every mutation settles the same way: refetch landed, claim released. */
	const settle = useCallback(
		(todoId: string) => {
			clearOverride(todoId);
			release(todoId);
		},
		[clearOverride, release],
	);

	const completeMutation = useMutation({
		mutationFn: (variables: { todoId: string; completed: boolean }) =>
			orpc.todos.complete.call({
				organizationId,
				todoId: variables.todoId,
				completed: variables.completed,
			}),
		onSuccess: async () => {
			await invalidateTodoList(queryClient);
		},
		onError: (_error, variables) => {
			// The row is about to snap back to what the server still says, so
			// the pin into the open view has to go with it — otherwise a
			// completion that never happened keeps a row in a view it does not
			// belong to for the rest of the session.
			if (variables.completed) {
				forgetJustCompletedTodo(queryClient, variables.todoId);
			}
			toast.error(t(`${T}.actions.errors.complete`));
		},
		onSettled: (_data, _error, variables) => settle(variables.todoId),
	});

	const snoozeMutation = useMutation({
		mutationFn: (variables: { todoId: string; snoozedUntil: string }) =>
			orpc.todos.snooze.call({
				organizationId,
				todoId: variables.todoId,
				snoozedUntil: variables.snoozedUntil,
			}),
		onSuccess: async () => {
			await invalidateTodoList(queryClient);
		},
		onError: () => {
			toast.error(t(`${T}.actions.errors.snooze`));
		},
		onSettled: (_data, _error, variables) => settle(variables.todoId),
	});

	const unsnoozeMutation = useMutation({
		mutationFn: (variables: { todoId: string }) =>
			orpc.todos.unsnooze.call({
				organizationId,
				todoId: variables.todoId,
			}),
		onSuccess: async () => {
			await invalidateTodoList(queryClient);
		},
		onError: () => {
			toast.error(t(`${T}.actions.errors.unsnooze`));
		},
		onSettled: (_data, _error, variables) => settle(variables.todoId),
	});

	const assignMutation = useMutation({
		mutationFn: (variables: {
			todoId: string;
			assigneeUserId: string | null;
			assigneeContactId: string | null;
		}) =>
			orpc.todos.assign.call({
				organizationId,
				todoId: variables.todoId,
				assigneeUserId: variables.assigneeUserId,
				assigneeContactId: variables.assigneeContactId,
			}),
		onSuccess: async () => {
			await invalidateTodoList(queryClient);
		},
		onError: () => {
			toast.error(t(`${T}.actions.errors.assign`));
		},
		onSettled: (_data, _error, variables) => settle(variables.todoId),
	});

	const setCompleted = useCallback(
		(item: TodoListItem, completed: boolean) => {
			if (!claim(item.id)) {
				return;
			}
			override(item.id, {
				isCompleted: completed,
				completedAt: completed ? new Date().toISOString() : null,
			});
			// Pinned BEFORE the answer, and kept afterwards: this is not an
			// optimistic value, it is a record of what this person did in this
			// session, and the refetch that reports the completion is exactly
			// what would otherwise drop the row out of the view.
			if (completed) {
				rememberJustCompletedTodo(queryClient, item.id);
			} else {
				forgetJustCompletedTodo(queryClient, item.id);
			}
			completeMutation.mutate({ todoId: item.id, completed });
		},
		[claim, completeMutation, override, queryClient],
	);

	const snooze = useCallback(
		(item: TodoListItem, until: Date) => {
			if (!claim(item.id)) {
				return;
			}
			const snoozedUntil = until.toISOString();
			override(item.id, { snoozedUntil });
			snoozeMutation.mutate({ todoId: item.id, snoozedUntil });
		},
		[claim, override, snoozeMutation],
	);

	const unsnooze = useCallback(
		(item: TodoListItem) => {
			if (!claim(item.id)) {
				return;
			}
			override(item.id, { snoozedUntil: null });
			unsnoozeMutation.mutate({ todoId: item.id });
		},
		[claim, override, unsnoozeMutation],
	);

	const assign = useCallback(
		(item: TodoListItem, target: TodoAssigneeTarget | null) => {
			if (!claim(item.id)) {
				return;
			}
			const assigneeUserId = target?.kind === "user" ? target.id : null;
			const assigneeContactId =
				target?.kind === "contact" ? target.id : null;
			override(item.id, {
				assigneeUserId,
				assigneeUser: assigneeUserId
					? {
							id: assigneeUserId,
							name: target?.name ?? "",
							image: null,
						}
					: null,
				assigneeContactId,
				assigneeContact: assigneeContactId
					? { id: assigneeContactId, name: target?.name ?? "" }
					: null,
				// The write sets `assignedManually` and clears the suggestion;
				// showing the confirm chip beside the name it just confirmed
				// would keep asking a question that has been answered.
				assignedManually: true,
				suggestedUserId: null,
				suggestedContactId: null,
				suggestionCandidates: [],
			});
			assignMutation.mutate({
				todoId: item.id,
				assigneeUserId,
				assigneeContactId,
			});
		},
		[assignMutation, claim, override],
	);

	const actions = useMemo<TodoRowActionsApi>(
		() => ({
			isBusy: (todoId: string) => busyIds.includes(todoId),
			setCompleted,
			snooze,
			unsnooze,
			assign,
			openAssignee: setAssigneeFor,
			openSnooze: setSnoozeFor,
			openNewContact: (item: TodoListItem, seedName: string) =>
				setNewContactFor({ item, seedName }),
		}),
		[assign, busyIds, setCompleted, snooze, unsnooze],
	);

	const closeAssignee = useCallback(() => setAssigneeFor(null), []);
	const closeSnooze = useCallback(() => setSnoozeFor(null), []);
	const closeNewContact = useCallback(() => setNewContactFor(null), []);

	return {
		actions,
		overrides,
		assigneeFor,
		snoozeFor,
		newContactFor,
		closeAssignee,
		closeSnooze,
		closeNewContact,
	};
}
