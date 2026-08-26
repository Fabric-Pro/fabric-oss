"use client";

import {
	FunctionTagSelect,
	type FunctionTagValue,
} from "@saas/shared/components/FunctionTagSelect";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { useRoleTagSnapshot } from "@saas/shared/components/RoleTagSnapshotProvider";
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
import { useEffect, useState } from "react";

/** How often an OPEN gate re-checks whether enforcement was withdrawn. */
const KILL_SWITCH_POLL_MS = 30_000;

/**
 * Blocking role/function-tag gate (Fizzy #2264, AC1-AC5).
 *
 * A user with no default function tags cannot use the app until they set one.
 * There is no dismissal path: no close button, no Escape, no outside click,
 * no "not now". The only exit is a successful save.
 *
 * This deliberately supersedes `FunctionTagsOnboardingPrompt`, which is the
 * dismissible version of the same prompt. Exactly one of them renders:
 * `GetStartedController` stands the old one down whenever this flag is on.
 */
export function FunctionTagsRequiredGate() {
	const queryClient = useQueryClient();
	const flagFromPayload = useFeatureFlag("ROLE_TAG_ENFORCEMENT");
	const snapshot = useRoleTagSnapshot();
	const [value, setValue] = useState<FunctionTagValue[]>([]);

	const queryKey = orpc.functionTags.getMyDefault.queryOptions().queryKey;

	// Mounted unconditionally: this query is what DECIDES the gate, so it
	// cannot be conditional on the gate. Only the aggressive interval below
	// is conditional.
	//
	// `enabled: flagFromPayload` — with the flag off, `shouldEnforce` short-
	// circuits before it ever reads `data`, so firing this request is pure
	// waste. `RoleTagSnapshotProvider`'s server-side counterpart already
	// skips this same read when the flag is off (Task 3); this mirrors it on
	// the client, and matches the Global Constraint that nothing changes
	// until an admin turns the flag on.
	const { data, isPending } = useQuery({
		...orpc.functionTags.getMyDefault.queryOptions(),
		enabled: flagFromPayload,
		refetchInterval: killSwitchRefetchInterval(flagFromPayload, snapshot),
	});

	const enforcing = shouldEnforce(flagFromPayload, snapshot, data);

	// Seed the picker only from a read that actually returned. `data` may be
	// retained from an earlier success across a failed refetch, which is
	// exactly what we want to seed from.
	useEffect(() => {
		if (data?.tags) {
			setValue(data.tags as FunctionTagValue[]);
		}
	}, [data?.tags]);

	const save = useMutation({
		mutationFn: () => orpcClient.functionTags.setMyDefault({ tags: value }),
		onSuccess: (result) => {
			// Write the response into the cache BEFORE invalidating.
			// Invalidation only schedules a refetch; if that refetch fails,
			// the retained empty `tags` would keep this modal open forever
			// after a save that already succeeded — the exact "permanently
			// locked out" outcome AC5 forbids, reached through success.
			//
			// Spread the cached value forward and overwrite only `tags`, with
			// NO explicit generic on `setQueryData`: `queryKey` is a
			// `DataTag`-typed key (`@orpc/tanstack-query`), so TypeScript
			// infers the real `getMyDefault` output type here, not a
			// hand-rolled local shape. `setMyDefault` returns only `{ tags }`;
			// spreading `old` forward (rather than rebuilding the object
			// field-by-field under an explicit generic) means a field added
			// to `get-my-default.ts`'s output tomorrow survives a save today
			// instead of being silently blanked with `tsc` still green.
			queryClient.setQueryData(queryKey, (old) =>
				old
					? { ...old, tags: result.tags }
					: { tags: result.tags, enforcementEnabled: true },
			);
			queryClient.invalidateQueries({ queryKey });
			// The account default just changed, and every project's
			// `defaultTags` was copied from it (spec §5.8, guard 1). Without
			// this, a project prompt opening next would pre-fill from a stale
			// response — for a user who was tagless a moment ago, that means
			// pre-filling EMPTY, and a Confirm would persist an empty,
			// confirmed tag set. The member is then never prompted again and
			// holds no role.
			//
			// `key()` (partial, prefix-matched) and NOT `queryKey({ input })`:
			// the user may have several projects cached and all of them went
			// stale at once.
			queryClient.invalidateQueries({
				queryKey: orpc.functionTags.getMyProjectStatus.key(),
			});
		},
		onError: (error) => {
			// Log the real detail; never render a raw server error string
			// into this modal. This repo is public — a server error message
			// can carry something (an identifier, an internal detail) that
			// has no business in UI copy.
			console.error("Failed to save function tags", error);
		},
	});

	// `data === undefined` means no read has ever returned. The gate may
	// still be open (from the payload snapshot), but we must not let Save
	// write a selection that was never seeded from real tags.
	const tagsLoaded = data !== undefined;

	if (!enforcing) {
		return null;
	}

	return (
		<Dialog open>
			<DialogContent
				hideCloseButton
				onEscapeKeyDown={(e) => e.preventDefault()}
				onPointerDownOutside={(e) => e.preventDefault()}
				onInteractOutside={(e) => e.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>Set your function tags</DialogTitle>
					<DialogDescription>
						Tell your team what you do. Fabric uses this to route
						work and context to the right people. Pick at least one
						to continue — you can change it anytime in settings.
					</DialogDescription>
				</DialogHeader>
				<FunctionTagSelect
					aria-label="Your default function tags"
					value={value}
					onChange={setValue}
					disabled={save.isPending || !tagsLoaded}
				/>
				{!tagsLoaded && (
					<p className="text-muted-foreground text-sm">
						{isPending
							? "Loading your current tags…"
							: "Couldn't load your current tags — retrying."}
					</p>
				)}
				{save.isError && (
					<p role="alert" className="text-destructive text-sm">
						Couldn't save your function tags. Please try again.
					</p>
				)}
				<DialogFooter data-testid="function-tags-gate-footer">
					<Button
						type="button"
						onClick={() => save.mutate()}
						loading={save.isPending}
						disabled={!tagsLoaded || value.length === 0}
					>
						{save.isError ? "Try again" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type Snapshot = { tags: string[]; enforcementEnabled: boolean };

/**
 * The `refetchInterval` callback for the kill-switch poll: 30s while the gate
 * would be up, `false` otherwise.
 *
 * Built as a named factory rather than an inline arrow so a test can invoke
 * the exact callback the component passes. A live fake-timer test is not an
 * option here: React Query v5 only runs interval fetches while its focus
 * manager reports focused, so under Vitest fake timers such a test hangs or
 * passes vacuously (see
 * `__tests__/modules/saas/projects/newsletter-approval-chat-channels.test.tsx:499`,
 * which needs real timers plus `focusManager.setFocused(true)`).
 */
export function killSwitchRefetchInterval(
	flagFromPayload: boolean,
	snapshot: boolean | null,
) {
	return (query: { state: { data: Snapshot | undefined } }) =>
		shouldEnforce(flagFromPayload, snapshot, query.state.data)
			? KILL_SWITCH_POLL_MS
			: (false as const);
}

/**
 * Whether role-tag enforcement is LIVE — the flag as the app currently
 * believes it, across both delivery channels.
 *
 * `flagFromPayload` rides the frozen RSC payload (fixed until a page reload);
 * `data.enforcementEnabled` is the polled kill switch that can only ever turn
 * enforcement OFF. Suppressing a surface on the payload flag alone would leave
 * it dark for the rest of the session after an admin turned enforcement off
 * mid-session.
 *
 * `?? true` matches `shouldEnforce`'s direction: a missing field must only
 * ever KEEP enforcement on, never turn it off early. The failure worth
 * engineering against is a user stuck behind a surface we already withdrew,
 * not one who escapes it for thirty seconds.
 *
 * Three callers — this gate (via `shouldEnforce`), `GetStartedController`'s
 * legacy-prompt suppression, and `ProjectRoleConfirmationPrompt`. One
 * definition, so they cannot drift into disagreeing about whether enforcement
 * is on.
 */
export function isEnforcementLive(
	flagFromPayload: boolean,
	data: Snapshot | undefined,
): boolean {
	return flagFromPayload && (data?.enforcementEnabled ?? true);
}

/**
 * Whether the gate should be up.
 *
 * Exported and called by BOTH this component and `GetStartedController`, so
 * the two surfaces cannot disagree about who is being blocked. The controller
 * uses it to suppress the welcome auto-launch; keying that off
 * `eligibleForFunctionTagsPrompt` instead would be wrong, because that field
 * is gated on a DIFFERENT flag (`FABRIC_FEATURE_FUNCTION_TAGS`).
 *
 * Two rules, in order:
 *   1. a read that has returned wins: `data.tags.length === 0`
 *   2. otherwise the server snapshot: `snapshot === false`
 *
 * `null` snapshot (server read failed) does NOT open the gate — see
 * `RoleTagSnapshotProvider`.
 *
 * The flag is ANDed from two sources and the poll can only ever turn the gate
 * OFF (`?? true` keeps it up until a read says otherwise). The failure worth
 * engineering against is a user stuck behind a gate we already withdrew, not
 * one who escapes it for thirty seconds.
 *
 * Reads `data` and never `isSuccess`: this app sets `retry: false`, so one
 * failed poll flips `status` to "error" while retaining `data`, and reading
 * `isSuccess` would drop the gate on a single network blip.
 */
export function shouldEnforce(
	flagFromPayload: boolean,
	snapshot: boolean | null,
	data: Snapshot | undefined,
): boolean {
	if (!isEnforcementLive(flagFromPayload, data)) {
		return false;
	}
	return data !== undefined ? data.tags.length === 0 : snapshot === false;
}
