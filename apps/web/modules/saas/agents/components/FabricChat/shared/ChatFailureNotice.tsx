"use client";

import { AlertCircle } from "lucide-react";
import { Response } from "../../../../../../components/ai-elements/response";

/** Keep the partial answer readable while explaining why the turn stopped. */
export function ChatFailureNotice({
	content,
	error,
}: {
	content?: string;
	error: string;
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
				<p className="min-w-0 break-words">{error}</p>
			</div>
		</div>
	);
}
