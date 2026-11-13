"use client";

import { Button } from "@ui/components/button";
import { useState } from "react";
import {
	reviewSummaryLine,
	summarizeReviewImages,
} from "../lib/newsletter-review-images";
import { NewsletterReviewDialog } from "./NewsletterReviewDialog";
import { NewsletterReviewHighlight } from "./NewsletterReviewHighlight";
import {
	type PendingNewsletterSend,
	readReviewContent,
} from "./newsletter-review-content";

export interface NewsletterApproveRequest {
	sendId: string;
	removed: number[];
	/** Only sent from the review dialog, the one place highlights reorder. */
	highlightOrder?: number[];
}

/**
 * The "Awaiting review" block of the newsletter settings. A send that takes
 * images gets a compact row whose Review opens the review dialog; any other
 * send keeps the inline checklist.
 */
export function NewsletterPendingReviews({
	sends,
	projectId,
	organizationId,
	reviewInFlight,
	onApprove,
	onReject,
	onRefetch,
}: {
	sends: PendingNewsletterSend[];
	projectId: string;
	organizationId: string | null;
	reviewInFlight: boolean;
	onApprove: (request: NewsletterApproveRequest) => void;
	onReject: (sendId: string) => void;
	onRefetch: () => void;
}) {
	// Per-send set of highlight indexes the reviewer has marked for removal
	// before approving — keyed by send id so switching between multiple
	// pending drafts (rare, but possible after a missed review window)
	// doesn't clobber an in-progress edit on another draft. The checkbox UI
	// is inverted for display: a highlight is checked (selected) by default,
	// and unchecking it is what adds its index here — so the set still stores
	// the *removed* indexes sent up as `removedHighlightIndexes`.
	const [removedBySend, setRemovedBySend] = useState<
		Record<string, Set<number>>
	>({});
	// Per-send reviewer order, as indexes into the frozen highlights; absent
	// until the reviewer drags, which means the natural order.
	const [orderBySend, setOrderBySend] = useState<Record<string, number[]>>(
		{},
	);
	const [reviewingSendId, setReviewingSendId] = useState<string | null>(null);

	if (sends.length === 0) {
		return null;
	}

	const toggleFor = (sendId: string) => (i: number) =>
		setRemovedBySend((prev) => {
			const next = new Set(prev[sendId] ?? []);
			if (next.has(i)) {
				next.delete(i);
			} else {
				next.add(i);
			}
			return { ...prev, [sendId]: next };
		});
	const orderFor = (send: PendingNewsletterSend) =>
		orderBySend[send.id] ??
		Array.from(
			{
				length:
					readReviewContent(send.content)?.highlights?.length ?? 0,
			},
			(_, i) => i,
		);
	// Only a send still awaiting a decision is reviewable; once a refetch
	// shows it decided (here or elsewhere), the dialog closes by itself.
	const reviewing =
		sends.find(
			(p) =>
				p.id === reviewingSendId &&
				p.status === "PENDING_APPROVAL" &&
				p.screenshotsEnabled === true,
		) ?? null;
	const forReviewing = (act: (send: PendingNewsletterSend) => void) => {
		if (reviewing) {
			act(reviewing);
		}
	};

	return (
		<div className="mt-5 mb-6 space-y-4">
			<p className="font-medium text-foreground" role="status">
				Awaiting review
			</p>
			{sends.map((p) => {
				const content = readReviewContent(p.content);
				const removed = removedBySend[p.id] ?? new Set<number>();
				const toggle = toggleFor(p.id);
				return (
					<div
						key={p.id}
						className="rounded-lg border border-border p-4"
					>
						<p className="font-medium text-foreground">
							{content?.headline ?? "Release notes"}
						</p>
						{content?.intro ? (
							<p className="mt-1 text-sm text-muted-foreground">
								{content.intro}
							</p>
						) : null}
						{p.status === "APPROVED" ? (
							// In-flight / recovery: an approved send that
							// is delivering (or was stranded by a start
							// failure). Offer an idempotent re-kick.
							<div className="mt-3 flex items-center gap-3">
								<span className="text-sm text-muted-foreground">
									Sending…
								</span>
								<Button
									size="sm"
									variant="outline"
									disabled={reviewInFlight}
									onClick={() =>
										onApprove({ sendId: p.id, removed: [] })
									}
								>
									Retry send
								</Button>
							</div>
						) : p.screenshotsEnabled === true ? (
							<div className="mt-3 flex flex-wrap items-center justify-between gap-3">
								<p className="text-muted-foreground text-xs">
									{reviewSummaryLine(
										(content?.highlights?.length ?? 0) -
											removed.size,
										summarizeReviewImages(p.images, removed)
											.included,
									)}
								</p>
								<div className="flex gap-2">
									<Button
										size="sm"
										variant="primary"
										disabled={reviewInFlight}
										onClick={() => {
											onRefetch();
											setReviewingSendId(p.id);
										}}
									>
										Review
									</Button>
									<Button
										size="sm"
										variant="outline"
										disabled={reviewInFlight}
										onClick={() => onReject(p.id)}
									>
										Reject
									</Button>
								</div>
							</div>
						) : (
							<>
								<p className="mt-3 text-muted-foreground text-xs">
									Unchecking an item leaves it out of this
									issue only — nothing is deleted.
								</p>
								<ul className="mt-2 space-y-2">
									{(content?.highlights ?? []).map((h, i) => (
										<NewsletterReviewHighlight
											key={`${p.id}-${i}`}
											title={h.title}
											description={h.description}
											excluded={removed.has(i)}
											onToggle={() => toggle(i)}
										/>
									))}
								</ul>
								<div className="mt-4 flex gap-2">
									<Button
										size="sm"
										variant="primary"
										disabled={reviewInFlight}
										onClick={() =>
											onApprove({
												sendId: p.id,
												removed: Array.from(removed),
											})
										}
									>
										Approve &amp; send
									</Button>
									<Button
										size="sm"
										variant="outline"
										disabled={reviewInFlight}
										onClick={() => onReject(p.id)}
									>
										Reject
									</Button>
								</div>
							</>
						)}
					</div>
				);
			})}
			<NewsletterReviewDialog
				send={reviewing}
				projectId={projectId}
				organizationId={organizationId}
				removed={
					(reviewing && removedBySend[reviewing.id]) ??
					new Set<number>()
				}
				order={reviewing ? orderFor(reviewing) : []}
				reviewInFlight={reviewInFlight}
				onToggle={(i) => forReviewing((send) => toggleFor(send.id)(i))}
				onOrderChange={(order) =>
					forReviewing((send) =>
						setOrderBySend((prev) => ({
							...prev,
							[send.id]: order,
						})),
					)
				}
				onApprove={() =>
					forReviewing((send) =>
						onApprove({
							sendId: send.id,
							removed: Array.from(removedBySend[send.id] ?? []),
							highlightOrder: orderFor(send),
						}),
					)
				}
				onReject={() => forReviewing((send) => onReject(send.id))}
				onRefetch={onRefetch}
				onOpenChange={(open) => {
					if (!open) {
						setReviewingSendId(null);
					}
				}}
			/>
		</div>
	);
}
