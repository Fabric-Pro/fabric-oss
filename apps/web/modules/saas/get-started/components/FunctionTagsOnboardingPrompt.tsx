"use client";

import {
	FunctionTagSelect,
	type FunctionTagValue,
} from "@saas/shared/components/FunctionTagSelect";
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
import { toast } from "sonner";

type Props = {
	/** Permanently opt the user out of the no-tags prompt (server write via the
	 * controller's serialized chain). Rejects on failure so the modal stays open
	 * for retry. */
	onOptOut: () => Promise<void>;
	/** Return the controller to idle (session-level dismiss; the controller has
	 * already marked this session shown, so closing never reopens it). */
	onClose: () => void;
};

/**
 * Recurring no-tags prompt asking a user with no default
 * function tags to pick some. Hosted by `GetStartedController` (mode
 * `"tagsPrompt"`). Save persists the chosen defaults; "Not now" dismisses for
 * the session; "Don't ask again" permanently opts out.
 */
export function FunctionTagsOnboardingPrompt({ onOptOut, onClose }: Props) {
	const queryClient = useQueryClient();
	const { data, isSuccess } = useQuery(
		orpc.functionTags.getMyDefault.queryOptions(),
	);
	const [value, setValue] = useState<FunctionTagValue[]>([]);

	// Gate editing + Save on the read having SUCCEEDED (not `!isLoading`): in
	// React Query v5 `isLoading` flips false on a terminal error while `data`
	// is still undefined, which would let Save persist an empty set over the
	// user's real defaults.
	const ready = isSuccess;

	useEffect(() => {
		if (data?.tags) {
			setValue(data.tags as FunctionTagValue[]);
		}
	}, [data?.tags]);

	const save = useMutation({
		mutationFn: () => orpcClient.functionTags.setMyDefault({ tags: value }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey:
					orpc.functionTags.getMyDefault.queryOptions().queryKey,
			});
			onClose();
		},
		onError: (error) => {
			toast.error("Couldn't save your function tags", {
				description: error instanceof Error ? error.message : undefined,
			});
		},
	});

	const optOut = useMutation({
		mutationFn: () => onOptOut(),
		onSuccess: onClose,
		onError: (error) => {
			toast.error("Couldn't update this — please retry", {
				description: error instanceof Error ? error.message : undefined,
			});
		},
	});

	const busy = save.isPending || optOut.isPending;

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				// X / Esc / outside-click behaves like "Not now" — a plain
				// session dismiss (no server write). Ignore while a mutation is
				// in flight.
				if (!next && !busy) {
					onClose();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Set your function tags</DialogTitle>
					<DialogDescription>
						Tell your team what you do. These become your starting
						tags on new projects you join. You can change them
						anytime in settings.
					</DialogDescription>
				</DialogHeader>
				<FunctionTagSelect
					aria-label="Your default function tags"
					value={value}
					onChange={setValue}
					disabled={busy || !ready}
				/>
				<DialogFooter className="sm:justify-between">
					<Button
						type="button"
						variant="ghost"
						onClick={() => optOut.mutate()}
						loading={optOut.isPending}
						disabled={save.isPending}
					>
						Don't ask again
					</Button>
					<div className="flex gap-2">
						<Button
							type="button"
							variant="ghost"
							onClick={onClose}
							disabled={busy}
						>
							Not now
						</Button>
						<Button
							type="button"
							onClick={() => save.mutate()}
							loading={save.isPending}
							disabled={
								optOut.isPending || !ready || value.length === 0
							}
						>
							Save
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
