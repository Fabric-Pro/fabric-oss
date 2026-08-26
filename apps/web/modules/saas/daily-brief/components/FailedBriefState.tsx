"use client";

/**
 * FailedBriefState — shown when the Daily Brief workflow failed (status = FAILED).
 */

import { Button } from "@ui/components/button";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";

export interface FailedBriefStateProps {
	/** Optional error message from the workflow. */
	errorMessage?: string;
	/** Called when the user clicks Regenerate. */
	onRegenerate?: () => void;
}

export function FailedBriefState({
	errorMessage,
	onRegenerate,
}: FailedBriefStateProps) {
	return (
		<div
			role="alert"
			className="rounded-2xl border border-destructive/40 bg-destructive/5 p-12 text-center"
		>
			<div className="mx-auto flex size-12 items-center justify-center rounded-full border border-destructive/40 bg-destructive/10">
				<AlertTriangleIcon
					className="size-6 text-destructive"
					aria-hidden="true"
				/>
			</div>
			<h2 className="mt-5 font-serif text-2xl font-normal leading-tight text-foreground">
				Your brief couldn't be generated
			</h2>
			<p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
				{errorMessage ??
					"Something went wrong while pulling activity from your project sources. No data has been discarded — you can regenerate the brief and try again."}
			</p>
			{onRegenerate ? (
				<div className="mt-6">
					<Button variant="editorial" onClick={onRegenerate}>
						<RefreshCwIcon
							className="size-3.5"
							aria-hidden="true"
						/>
						Regenerate
					</Button>
				</div>
			) : null}
		</div>
	);
}
