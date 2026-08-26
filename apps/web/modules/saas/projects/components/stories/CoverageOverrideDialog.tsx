"use client";

/**
 * Records why a feature is being marked Done below its project's coverage
 * target.
 *
 * The gate in `updateStory` refuses the move and offers two ways forward: add
 * cases for the uncovered criteria, or say why you are shipping without them.
 * Only the first was reachable from the product — the second existed for API
 * callers alone, which made a documented escape hatch a dead end in the UI and
 * the gate absolute in practice.
 *
 * Opens on the refusal rather than ahead of it: a feature that meets its target
 * never sees this, and the API only records an override when one was actually
 * needed, so asking for a reason up front would manufacture records of
 * decisions nobody had to make.
 */

import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Textarea } from "@ui/components/textarea";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

/** Mirrors the `data` block the coverage refusal carries. */
export interface CoverageBlockDetail {
	percent: number;
	target: number;
	coveredCriteria: number;
	totalCriteria: number;
}

/** The API caps the stored reason; the field stops typing at the same length. */
const MAX_REASON_LENGTH = 500;

export function CoverageOverrideDialog({
	detail,
	onOpenChange,
	onConfirm,
	isPending,
}: {
	/** The refusal being answered, or null when nothing is blocked. */
	detail: CoverageBlockDetail | null;
	onOpenChange: (open: boolean) => void;
	onConfirm: (reason: string) => void;
	isPending: boolean;
}) {
	const [reason, setReason] = useState("");

	// A fresh refusal starts with an empty field — carrying the previous
	// reason over would let one justification be reused without being reread.
	useEffect(() => {
		if (detail) {
			setReason("");
		}
	}, [detail]);

	const trimmed = reason.trim();

	return (
		<Dialog open={detail !== null} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Coverage is below the target</DialogTitle>
					<DialogDescription>
						Add cases for the uncovered criteria, or record why this
						feature is shipping without them.
					</DialogDescription>
				</DialogHeader>

				{detail && (
					<Alert variant="warning">
						<TriangleAlertIcon aria-hidden="true" />
						<AlertTitle>
							{detail.percent}% covered, and this project asks for{" "}
							{detail.target}%
						</AlertTitle>
						<AlertDescription>
							{detail.coveredCriteria} of {detail.totalCriteria}{" "}
							acceptance criteria have a test case behind them.
						</AlertDescription>
					</Alert>
				)}

				<div className="space-y-1.5">
					<label
						className="font-medium text-sm"
						htmlFor="coverage-override-reason"
					>
						Reason for shipping under the target
					</label>
					<Textarea
						id="coverage-override-reason"
						value={reason}
						maxLength={MAX_REASON_LENGTH}
						rows={3}
						disabled={isPending}
						placeholder="What makes this safe to ship without the missing coverage?"
						onChange={(event) => setReason(event.target.value)}
					/>
					<p className="text-muted-foreground text-xs">
						Kept on the feature with your name and the date, so the
						decision stays visible afterwards.
					</p>
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						disabled={isPending}
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						disabled={trimmed.length === 0 || isPending}
						onClick={() => onConfirm(trimmed)}
					>
						{isPending ? "Marking done…" : "Mark done anyway"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
