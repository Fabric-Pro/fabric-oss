"use client";

import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import {
	FunctionTagSelect,
	type FunctionTagValue,
} from "@saas/shared/components/FunctionTagSelect";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useEffect, useState } from "react";
import { toast } from "sonner";

// Order-independent equality for two tag sets. A user can reselect the same
// tags in a different order, which must still count as "unchanged" so Save
// doesn't round-trip an identical set.
function sameTagSet(a: FunctionTagValue[], b: FunctionTagValue[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	const bSet = new Set(b);
	return a.every((tag) => bSet.has(tag));
}

export function DefaultFunctionTagsForm() {
	const queryClient = useQueryClient();
	// `getMyDefault` takes no input — matches the no-input procedure calling
	// convention used elsewhere in this codebase (e.g. `orpc.projects.listGuest`).
	const { data, isSuccess } = useQuery(
		orpc.functionTags.getMyDefault.queryOptions(),
	);
	const [value, setValue] = useState<FunctionTagValue[]>([]);

	// Seed local edit state from the loaded value once it arrives.
	useEffect(() => {
		if (data?.tags) {
			setValue(data.tags as FunctionTagValue[]);
		}
	}, [data?.tags]);

	const save = useMutation({
		mutationFn: () => orpcClient.functionTags.setMyDefault({ tags: value }),
		onSuccess: () => {
			toast.success("Default function tags updated");
			queryClient.invalidateQueries({
				queryKey: orpc.functionTags.getMyDefault.queryKey(),
			});
		},
		onError: (error) => {
			toast.error("Failed to save function tags", {
				description: error instanceof Error ? error.message : undefined,
			});
		},
	});

	// Disable edits + Save until the user's current defaults have loaded
	// SUCCESSFULLY, so a Save fired during a slow/cold initial load — or after
	// a failed read — can never persist the empty starting `value` over their
	// real defaults. Gated on `isSuccess` rather than `!isLoading`: in React
	// Query v5, `isLoading` is `isPending && isFetching`, so it goes back to
	// `false` once the query terminally ERRORS even though `data` never
	// arrived — `!isLoading` would incorrectly re-enable the picker and Save
	// on a failed read. Save is further gated on the selection actually
	// differing from what's saved (dirty-check).
	const savedTags = (data?.tags ?? []) as FunctionTagValue[];
	const isDirty = !sameTagSet(value, savedTags);
	const controlsDisabled = !isSuccess || save.isPending;

	// With enforcement on a role is mandatory, so this form must not let
	// someone clear their tags and be blocked by the gate on the next render
	// (Fizzy #2264). `enforcementEnabled` is a LIVE re-read of the same flag
	// via this form's own `getMyDefault` query, mirroring
	// `FunctionTagsRequiredGate`'s `shouldEnforce` — the payload-frozen flag
	// alone would leave this form refusing to clear tags until a full page
	// reload, long after an admin turned enforcement off and the gate itself
	// stood down. No bound to quote here: this form sets no `refetchInterval`,
	// and the gate's 30s poll has already switched itself off for exactly the
	// user who visits this form (`shouldEnforce` is false once tags exist, so
	// `killSwitchRefetchInterval` returns false). The value refreshes on the
	// query's ordinary triggers — remount, window focus, invalidation.
	// `?? true` keeps the floor up until a read says otherwise, the same
	// direction `shouldEnforce` takes.
	const roleRequired =
		useFeatureFlag("ROLE_TAG_ENFORCEMENT") &&
		(data?.enforcementEnabled ?? true);
	// Gated on `isSuccess` too: before the load resolves, `value` is still
	// its empty initial state, which is indistinguishable from "the user
	// cleared their tags" unless we also know a real read landed — without
	// it, every visitor sees the note flash for a frame while the flag is
	// on, tagged or not. Save is already disabled during that window via
	// `controlsDisabled`, so this only guards the note's visibility.
	const wouldClearRequiredTags =
		roleRequired && isSuccess && value.length === 0;

	return (
		<SettingsItem title="Function tags">
			<p className="mb-3 text-sm text-muted-foreground">
				Applied to new projects you join — they become your starting
				tags there. Changing this doesn't retag projects you've already
				joined.
			</p>
			<FunctionTagSelect
				id="default-function-tags"
				aria-label="Your default function tags"
				value={value}
				onChange={setValue}
				disabled={controlsDisabled}
			/>
			{wouldClearRequiredTags && (
				<p className="text-muted-foreground text-sm">
					At least one role is required.
				</p>
			)}
			<div className="mt-4 flex justify-end">
				<Button
					type="button"
					loading={save.isPending}
					disabled={
						controlsDisabled || !isDirty || wouldClearRequiredTags
					}
					onClick={() => save.mutate()}
				>
					Save
				</Button>
			</div>
		</SettingsItem>
	);
}
