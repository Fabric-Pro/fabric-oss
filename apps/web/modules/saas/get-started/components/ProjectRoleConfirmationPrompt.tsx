"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import {
	FunctionTagSelect,
	type FunctionTagValue,
} from "@saas/shared/components/FunctionTagSelect";
import { useRoleTagSnapshot } from "@saas/shared/components/RoleTagSnapshotProvider";
import { FUNCTION_TAG_LABELS } from "@repo/database/src/function-tags";
import { ORPCError } from "@orpc/client";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useEffect, useRef, useState } from "react";
import { createSessionFlag, useSessionFlag } from "../lib/session-flag";
import { isEnforcementLive, shouldEnforce } from "./FunctionTagsRequiredGate";

/**
 * Per-tab-session suppression, keyed by `${userId}:${projectId}` so dismissing
 * on one project does not suppress the prompt on the next. The helper's
 * "userId" parameter is just its keying string; passing a composite needs no
 * change to it.
 */
const rolePromptShown = createSessionFlag("fabric:project-role-prompt-shown");

type Props = {
	projectId: string;
	organizationId: string | null;
};

/**
 * Per-project role confirmation prompt (Fizzy #2264, AC6-AC10).
 *
 * DISMISSIBLE, unlike the account gate (D2). X / Esc / Cancel all close it and
 * nothing is persisted, so it re-fires on the next visit — the PERSISTENCE is
 * what AC6 guarantees, not the modality. FR10's "no dismissal path" names the
 * account modal only; a member of twelve projects should not meet twelve hard
 * gates.
 *
 * Never fires while the account gate is up: a user with no account tags has no
 * sensible pre-fill and is already blocked, so the account gate wins.
 */
export function ProjectRoleConfirmationPrompt({
	projectId,
	organizationId,
}: Props) {
	const queryClient = useQueryClient();
	const { user } = useSession();
	const flagFromPayload = useFeatureFlag("ROLE_TAG_ENFORCEMENT");
	const snapshot = useRoleTagSnapshot();

	// Read the flag and both queries UNCONDITIONALLY at the top level. Folding
	// any of these into the `open` chain below would change the hook count
	// between renders once a query resolves, and crash React.
	const { data: myTags } = useQuery({
		...orpc.functionTags.getMyDefault.queryOptions(),
		enabled: flagFromPayload,
	});

	const statusInput = { projectId, organizationId };
	const statusQueryKey = orpc.functionTags.getMyProjectStatus.queryKey({
		input: statusInput,
	});
	const { data: status } = useQuery({
		...orpc.functionTags.getMyProjectStatus.queryOptions({
			input: statusInput,
		}),
		enabled: flagFromPayload,
	});

	// `${userId}:${projectId}` — see `rolePromptShown`.
	const sessionKey = `${user?.id ?? ""}:${projectId}`;
	// `shownThisSession` itself goes UNUSED below: the open decision reads
	// `rolePromptShown` directly instead (see `openedForKeyRef`'s effect),
	// because this hook's own re-seed is asynchronous — in the commit where
	// `sessionKey` changes, `shownThisSession` still holds the PREVIOUS
	// project's value. Still call the hook for `markShown`, which persists
	// the flag AND keeps this component's usage consistent with the
	// account gate's.
	const [, markShown] = useSessionFlag(rolePromptShown, sessionKey);

	const [value, setValue] = useState<FunctionTagValue[]>([]);
	const [conflicted, setConflicted] = useState(false);
	// ELIGIBILITY, SESSION SUPPRESSION and VISIBILITY are three different
	// things and must be three different pieces of state.
	//
	// Deriving `open` from `!shownThisSession` and then marking shown in an
	// effect is a closed loop: `markShown` sets that state true, the next
	// render makes the condition false, and the dialog unmounts before the
	// member can touch it. `GetStartedController` avoids exactly this by
	// holding a `mode` separate from its `functionTagsPromptPending`
	// predicate; this mirrors that.
	const [open, setOpen] = useState(false);
	// Keyed by `sessionKey`, not a bare boolean flag: this is what lets a
	// transient INELIGIBLE render (e.g. project B, already confirmed) pass
	// through without erasing the marker for a key already decided. See the
	// effect below for why the update is gated on `eligible`.
	const openedForKeyRef = useRef<string | null>(null);

	// Pre-fill per D5: the member's EFFECTIVE role on this project — project
	// tags when the row has any, the account default otherwise.
	//
	// AC7 says "account default", and the two agree in the ordinary case
	// because invite-accept already copies the account default into the
	// project row. They differ in exactly one situation: an admin assigned
	// project-specific tags, which by AC12/AC13 is also what re-triggered this
	// prompt. Obeying AC7 there would make an uninspected Confirm silently
	// revert the admin's assignment, with the admin never told. Resolved
	// 2026-08-21 in favour of D5, with the divergence DISCLOSED below.
	const projectTags = status?.tags ?? [];
	const defaultTags = status?.defaultTags ?? [];
	const prefill = projectTags.length > 0 ? projectTags : defaultTags;

	// Seed only from a read that actually returned; re-seed when a CONFLICT
	// refetch brings back the administrator's new tags, which is what makes
	// the second confirmation land on the right values.
	useEffect(() => {
		if (status) {
			setValue(prefill as FunctionTagValue[]);
		}
		// `prefill` is derived from `status`; React Query's default
		// structuralSharing keeps its identity stable across a deeply-equal
		// refetch, so this does not wipe an in-progress selection.
	}, [status, prefill]);

	const confirm = useMutation({
		mutationFn: () =>
			orpcClient.functionTags.confirmForProject({
				projectId,
				organizationId,
				tags: value,
				// The CURRENT `status.version` at click time — not
				// necessarily the version the prompt first opened with. A
				// CONFLICT triggers a refetch that lands a NEW version, and
				// the retry must send THAT one; resending the stale one
				// would just conflict again. If the row moves once more
				// before this fires, the server refuses rather than
				// reverting the admin.
				expectedVersion: status?.version ?? null,
			}),
		onSuccess: (result) => {
			setConflicted(false);
			// Close locally AND patch the cache BEFORE invalidating.
			//
			// Invalidation only SCHEDULES a refetch. This app sets
			// `retry: false`, so a refetch that fails leaves the retained
			// response still saying `confirmed: false` — and a prompt whose
			// visibility came from the query alone would sit open over a
			// confirmation that already succeeded, inviting the member to fire
			// the mutation and its audit row again. That is the same "reached
			// through success" failure PR A had to fix on the account gate.
			//
			// `queryKey`, not `key()`: `setQueryData` hashes the key EXACTLY,
			// so a partial key would land on a cache entry nothing subscribes
			// to and the write would vanish with no error and no re-render.
			setOpen(false);
			queryClient.setQueryData(statusQueryKey, (old) =>
				old
					? {
							...old,
							confirmed: true,
							tags: result.tags,
							version: result.version,
						}
					: undefined,
			);
			queryClient.invalidateQueries({ queryKey: statusQueryKey });
		},
		onError: (error) => {
			if (error instanceof ORPCError && error.code === "CONFLICT") {
				// The row moved while this was open. Refetch and re-render
				// over the NEW tags rather than reporting success: one extra
				// click for the member, and the administrator's intent
				// survives.
				setConflicted(true);
				queryClient.invalidateQueries({ queryKey: statusQueryKey });
				return;
			}
			// A later failure that is NOT a version conflict must clear any
			// conflict banner left over from an earlier attempt. Without
			// this, a CONFLICT followed by, say, a transient network error
			// leaves the stale "changed while this was open" copy on
			// screen while ALSO suppressing the generic error alert
			// (`confirm.isError && !conflicted` below) — the member clicks
			// Confirm again and gets no feedback for the second failure at
			// all.
			setConflicted(false);
			// Never render a raw server error string into this dialog — this
			// repo is public and a server message can carry an internal
			// detail that has no business in UI copy.
			console.error("Failed to confirm project role", error);
		},
	});

	// The account gate wins. It can never actually stack with this prompt,
	// because `shouldEnforce` requires enforcement to be live, which is also
	// this prompt's own precondition.
	const accountGateUp = shouldEnforce(flagFromPayload, snapshot, myTags);

	// `status !== undefined` — a read that has NEVER succeeded must not open a
	// prompt whose Confirm would write `[]`; and a LATER failed refetch must
	// not close a prompt already open over good data, which is why this feeds
	// the OPEN transition and never the visibility itself.
	const eligible =
		isEnforcementLive(flagFromPayload, myTags) &&
		!accountGateUp &&
		status !== undefined &&
		!status.confirmed;

	// One transition per `sessionKey`, and mark shown AT open rather than at
	// close so an incidental dismissal cannot reopen the prompt later in the
	// session.
	//
	// Reads `rolePromptShown` DIRECTLY rather than through `shownThisSession`:
	// `useSessionFlag`'s re-seed on a `sessionKey` change only SCHEDULES a
	// state update, so in the commit where `sessionKey` flips back from B to
	// A, a React-state `shownThisSession` would still hold B's value, not
	// A's. Reading the flag synchronously here avoids that staleness.
	//
	// `openedForKeyRef.current` is updated only past the `eligible` check,
	// never unconditionally — this is what keeps an A -> B -> A round trip
	// safe if it ever happens WITHOUT an unmount. `ProjectDetails` currently
	// mounts this component WITH `key={projectId}`, which remounts (and so
	// resets this ref for free) on every project switch — but this ref is
	// what still holds the line if that key is ever removed: if project B is
	// ineligible (e.g. already confirmed) and this effect advanced the ref to
	// B's key anyway, the return trip to A would see
	// `openedForKeyRef.current !== sessionKey` and treat A as never having
	// been decided, re-opening a prompt the member already dismissed this
	// session. Leaving the ref untouched on an ineligible key means it still
	// remembers "A was already handled" when A comes back around.
	useEffect(() => {
		if (!eligible || openedForKeyRef.current === sessionKey) {
			return;
		}
		openedForKeyRef.current = sessionKey;
		if (rolePromptShown.read(sessionKey)) {
			return;
		}
		markShown();
		setOpen(true);
	}, [eligible, sessionKey, markShown]);

	// `open` alone is not enough: visibility is local state so the effect
	// above cannot close its own dialog, but a withdrawn flag still must
	// close an ALREADY-OPEN prompt.
	//
	// In practice this only fires on whatever refetch happens to land while
	// the prompt is open, not an active poll: `getMyDefault`'s kill-switch
	// interval (`killSwitchRefetchInterval`) is driven by `shouldEnforce`,
	// which is FALSE precisely while this prompt is open (its own
	// precondition is `!accountGateUp`) — so nothing is actively polling
	// `myTags` here. A window-focus refetch, or the member navigating away
	// and back, is what actually delivers the flip. Still correct to check
	// locally: the alternative (ignoring the flag once open) leaves a prompt
	// on screen after an admin withdrew it, until the member reloads. A
	// dedicated poll for this prompt was considered and rejected — it is
	// dismissible ("Not now"), so nobody is hard-blocked waiting on it, and
	// 30s of extra traffic for a dismissible surface buys little.
	//
	// `accountGateUp` is re-checked here too, not just inside `eligible`:
	// the two queries can land in either order. With `useRoleTagSnapshot()`
	// returning `null` (D12, server read failed) and `getMyProjectStatus`
	// resolving BEFORE `getMyDefault`, `accountGateUp` still reads `false`
	// at open time — there is no live account data yet for it to open on —
	// so this prompt opens, and only afterwards does `myTags` land with an
	// empty set and flip `accountGateUp` true. Without this term the two
	// would render at once, breaking the "Never fires while the account
	// gate is up" promise at the top of this file.
	if (!open || !isEnforcementLive(flagFromPayload, myTags) || accountGateUp) {
		return null;
	}

	const diverges =
		projectTags.length > 0 &&
		!sameTags(projectTags, defaultTags) &&
		defaultTags.length > 0;

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!next) {
					setOpen(false);
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Confirm your role on this project</DialogTitle>
					<DialogDescription>
						Fabric routes work, context and mentions by role.
						Confirm what you do here so the right things reach you.
					</DialogDescription>
				</DialogHeader>

				{diverges && (
					<p className="text-muted-foreground text-sm">
						An administrator set your role on this project to{" "}
						{labelList(projectTags)}. Your account default is{" "}
						{labelList(defaultTags)}.
					</p>
				)}

				{conflicted && (
					<p role="alert" className="text-highlight text-sm">
						Your role on this project changed while this was open.
						Review the updated roles below and confirm again.
					</p>
				)}

				<FunctionTagSelect
					aria-label="Your role on this project"
					value={value}
					onChange={setValue}
					disabled={confirm.isPending}
				/>

				{confirm.isError && !conflicted && (
					<p role="alert" className="text-destructive text-sm">
						Couldn't confirm your role. Please try again.
					</p>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => setOpen(false)}
						disabled={confirm.isPending}
					>
						Not now
					</Button>
					<Button
						type="button"
						onClick={() => confirm.mutate()}
						loading={confirm.isPending}
						disabled={value.length === 0}
					>
						{confirm.isError && !conflicted
							? "Try again"
							: "Confirm"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Human-readable, comma-separated tag labels — never raw enum values. */
function labelList(tags: readonly string[]): string {
	return tags
		.map(
			(t) =>
				FUNCTION_TAG_LABELS[t as keyof typeof FUNCTION_TAG_LABELS] ?? t,
		)
		.join(", ");
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
	const left = new Set(a);
	const right = new Set(b);
	if (left.size !== right.size) {
		return false;
	}
	for (const tag of left) {
		if (!right.has(tag)) {
			return false;
		}
	}
	return true;
}
