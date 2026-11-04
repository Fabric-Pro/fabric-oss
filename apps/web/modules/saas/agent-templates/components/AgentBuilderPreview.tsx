"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { PlayIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Response } from "../../../../components/ai-elements/response";

/** A bounded instruction test, explicitly separate from a durable saved-agent run. */
export function AgentBuilderPreview({
	organizationId,
	instructions,
	expectedOutput,
	savedAgentHref,
}: {
	organizationId: string;
	instructions: string;
	expectedOutput: string;
	savedAgentHref?: string;
}) {
	const id = useId();
	const [message, setMessage] = useState("");
	const preview = useMutation({
		mutationFn: async (draft: {
			instructions: string;
			message: string;
		}) => {
			const result = await orpcClient.agents.previewDraft({
				organizationId,
				systemPrompt: draft.instructions,
				userMessage: draft.message,
				capabilityIds: [],
				mcpConfigIds: [],
				maxIterations: 1,
			});
			if (!result.success) {
				throw new Error("Preview did not complete.");
			}
			return {
				response: result.response,
				instructions: draft.instructions,
			};
		},
		retry: false,
		throwOnError: false,
	});
	const earlierDraft =
		preview.data && preview.data.instructions !== instructions;
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
				<div className="space-y-2">
					<h2 className="font-semibold">Try your instructions</h2>
					<p className="text-sm text-muted-foreground">
						Test unsaved instructions with your configured AI
						provider. This single response excludes tools,
						knowledge, skills, and goal loops.
					</p>
					{savedAgentHref ? (
						<Link
							href={savedAgentHref}
							target="_blank"
							rel="noopener noreferrer"
							className="text-sm underline underline-offset-4"
						>
							Run the saved agent with its context and tools
							(opens a new tab)
						</Link>
					) : (
						<p className="text-sm text-muted-foreground">
							Save your agent to test its full configuration in a
							durable run.
						</p>
					)}
				</div>
				{expectedOutput.trim() && (
					<div className="space-y-1 text-sm">
						<h3 className="font-medium">What to check</h3>
						<p className="whitespace-pre-wrap break-words text-muted-foreground">
							{expectedOutput}
						</p>
					</div>
				)}
				{preview.isPending && (
					<output className="block text-sm text-muted-foreground">
						Testing instructions…
					</output>
				)}
				{preview.isError && (
					<Alert variant="error">
						<AlertTitle>Preview could not complete</AlertTitle>
						<AlertDescription>
							Your draft is preserved. Check your AI connection or
							try again.
						</AlertDescription>
					</Alert>
				)}
				{preview.data && !preview.isPending && !preview.isError && (
					<section aria-label="Preview result" className="space-y-3">
						<h3 className="font-medium">
							{earlierDraft
								? "Result from earlier instructions"
								: "Preview result"}
						</h3>
						{earlierDraft && (
							<output className="block text-sm text-muted-foreground">
								Your instructions changed. Run another test to
								check the current draft.
							</output>
						)}
						<Response>
							{preview.data.response ||
								"The provider returned an empty response."}
						</Response>
					</section>
				)}
			</div>
			<form
				className="shrink-0 space-y-2 border-t border-border bg-card p-3"
				onSubmit={(event) => {
					event.preventDefault();
					if (
						!message.trim() ||
						!instructions.trim() ||
						preview.isPending
					) {
						return;
					}
					preview.mutate({ instructions, message: message.trim() });
				}}
			>
				<Label htmlFor={`${id}-message`}>Test message</Label>
				<Textarea
					id={`${id}-message`}
					value={message}
					onChange={(event) => setMessage(event.target.value)}
					placeholder="Give your agent a sample task…"
					rows={3}
					maxLength={40_000}
				/>
				<Button
					type="submit"
					size="sm"
					loading={preview.isPending}
					disabled={
						!message.trim() ||
						!instructions.trim() ||
						preview.isPending
					}
				>
					<PlayIcon className="size-4" /> Test instructions
				</Button>
			</form>
		</div>
	);
}
