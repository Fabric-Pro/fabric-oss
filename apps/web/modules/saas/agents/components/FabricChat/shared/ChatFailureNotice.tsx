"use client";

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
		<div className="space-y-2">
			{content && content !== error && content !== `Error: ${error}` && (
				<Response>{content}</Response>
			)}
			<p role="alert" className="text-sm text-destructive">
				{error}
			</p>
		</div>
	);
}
