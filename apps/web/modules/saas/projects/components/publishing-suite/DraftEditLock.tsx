"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useEffect, useRef, useState } from "react";
import type { PostType } from "./topic-shared";

/**
 * Who else is in this draft, and a way to take it anyway.
 *
 * `PublishingTopicWorkingDraft` is unique on `(topicId, postType)`: one draft
 * per content type for the WHOLE topic rather than one per author. Two people
 * editing is therefore a real collision, and until now the only signal was a
 * CONFLICT toast on save — after the words were typed.
 *
 * ADVISORY throughout. Nothing here blocks an edit or a save: the claim is
 * reported so the second person can decide, and `saveBody`'s compare-and-set
 * stays the thing that actually protects the text. Take-over is always
 * offered, and it is non-destructive because every prior body is reachable
 * through the draft version list — which is why the lock was sequenced after
 * opening that read path rather than before it.
 */
export function useDraftEditLock({
	projectId,
	topicId,
	organizationId,
	postType,
	canEdit,
	hasDraft,
	isDirty,
}: {
	projectId: string;
	topicId: string;
	organizationId: string | null;
	postType: PostType;
	canEdit: boolean;
	/** No draft, nothing to claim. */
	hasDraft: boolean;
	/**
	 * The reader has typed something that is not yet saved.
	 *
	 * The claim is driven from THIS rather than from a keystroke handler on
	 * each panel's textarea: those live at different depths in seven different
	 * components, and half of them are inside a sub-component with no access to
	 * this hook. Every panel already tracks whether its body is dirty, so the
	 * one fact the lock needs is the one fact they all have.
	 */
	isDirty: boolean;
}) {
	const [heldBy, setHeldBy] = useState<{
		id: string;
		name: string | null;
	} | null>(null);
	const claimedRef = useRef(false);

	const claim = useMutation(
		orpc.projects.publishingSuite.claimDraftLock.mutationOptions({
			onSuccess: (result: {
				status: string;
				heldBy: { id: string; name: string | null } | null;
			}) => {
				setHeldBy(result.status === "held" ? result.heldBy : null);
			},
			// Silent on failure, deliberately. An advisory lock that toasts
			// when it cannot be taken is worse than no lock: it interrupts the
			// edit it exists to protect, over something the reader cannot act
			// on and does not need to.
			onError: () => undefined,
		}),
	);

	/**
	 * Claim once the draft actually goes dirty, not on mount.
	 *
	 * Opening a topic to read it is not editing it, and claiming on mount would
	 * mean every reader who clicked a tab held the draft for ten minutes.
	 */
	const claimMutate = claim.mutate;
	useEffect(() => {
		if (!isDirty || !canEdit || !hasDraft || claimedRef.current) {
			return;
		}
		claimedRef.current = true;
		claimMutate({ projectId, topicId, organizationId, postType });
	}, [
		isDirty,
		canEdit,
		hasDraft,
		claimMutate,
		projectId,
		topicId,
		organizationId,
		postType,
	]);

	const takeOver = () => {
		claim.mutate({
			projectId,
			topicId,
			organizationId,
			postType,
			takeOver: true,
		});
	};

	const release = useMutation(
		orpc.projects.publishingSuite.releaseDraftLock.mutationOptions({
			onError: () => undefined,
		}),
	);

	// Give it back on the way out, so the next person does not wait out a
	// ten-minute expiry for a tab somebody closed.
	useEffect(() => {
		return () => {
			if (claimedRef.current) {
				release.mutate({
					projectId,
					topicId,
					organizationId,
					postType,
				});
			}
		};
	}, [release.mutate, projectId, topicId, organizationId, postType]);

	return { heldBy, takeOver };
}

export function DraftLockBanner({
	heldBy,
	onTakeOver,
}: {
	heldBy: { id: string; name: string | null } | null;
	onTakeOver: () => void;
}) {
	if (!heldBy) {
		return null;
	}
	return (
		<div
			className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-highlight/40 bg-highlight/10 px-3 py-2"
			data-testid="draft-edit-lock"
		>
			<p className="min-w-0 flex-1 text-xs leading-relaxed" role="status">
				{`${heldBy.name ?? "Someone"} is editing this draft. You can still edit and save — every earlier version stays in the history either way.`}
			</p>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={onTakeOver}
			>
				Take over
			</Button>
		</div>
	);
}
