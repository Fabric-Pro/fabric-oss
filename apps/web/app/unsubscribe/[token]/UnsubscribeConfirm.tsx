"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import { useState } from "react";

/**
 * Public unsubscribe confirmation.
 *
 * Calls the RAW oRPC client (`orpcClient.newsletter.unsubscribe`) directly in an
 * async click handler with local state — deliberately NOT the tanstack
 * `mutationOptions()` hook. This page renders outside the (saas) layout; while
 * the root layout does provide a QueryClientProvider, the raw client keeps this
 * public page independent of that provider entirely. Unsubscribing on confirm
 * (not on GET) also prevents email-scanner prefetches from silently
 * unsubscribing recipients.
 */
export function UnsubscribeConfirm({ token }: { token: string }) {
	const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
		"idle",
	);

	const handleUnsubscribe = async () => {
		setStatus("loading");
		try {
			await orpcClient.newsletter.unsubscribe({ token });
			setStatus("done");
		} catch {
			setStatus("error");
		}
	};

	if (status === "done") {
		return (
			<div className="space-y-2">
				<h1 className="text-xl font-semibold text-foreground">
					Unsubscribed
				</h1>
				<p className="text-sm text-muted-foreground">
					You've been unsubscribed. You won't receive further updates.
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<h1 className="text-xl font-semibold text-foreground">
				Unsubscribe
			</h1>
			<p className="text-sm text-muted-foreground">
				Stop receiving release-notes updates for this project?
			</p>
			{status === "error" && (
				<p className="text-sm text-destructive">
					Something went wrong. Please try again.
				</p>
			)}
			<Button
				onClick={handleUnsubscribe}
				loading={status === "loading"}
				autoLoading={false}
			>
				Confirm unsubscribe
			</Button>
		</div>
	);
}
