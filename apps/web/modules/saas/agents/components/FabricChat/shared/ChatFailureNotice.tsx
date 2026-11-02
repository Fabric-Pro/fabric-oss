"use client";

import type { AiErrorToastAction } from "@saas/shared/components/copilot/copilot-error-toast";
import { Button } from "@ui/components/button";
import { AlertCircle } from "lucide-react";
import { DeferredResponse as Response } from "../../../../../../components/ai-elements/deferred-response";

/** Keep the partial answer readable while explaining why the turn stopped. */
export function ChatFailureNotice({
	content,
	error,
	action,
}: {
	content?: string;
	error: string;
	action?: AiErrorToastAction;
}) {
	return (
		<div className="space-y-3">
			{content && content !== error && content !== `Error: ${error}` && (
				<Response>{content}</Response>
			)}
			<div
				role="alert"
				className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-4 py-3 text-sm leading-5 text-destructive"
			>
				<AlertCircle
					className="mt-0.5 size-4 shrink-0 text-destructive"
					aria-hidden="true"
				/>
				<div className="min-w-0 space-y-3">
					<p className="break-words">{error}</p>
					{action && (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={action.onClick}
						>
							{action.label}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
