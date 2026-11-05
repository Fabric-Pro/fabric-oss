"use client";

import { Button } from "@ui/components/button";
import { WandSparklesIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";

// CopilotKit loads when someone asks to refine, not with every page holding a prompt.
const RefinePromptDialog = dynamic(
	() =>
		import("./RefinePromptDialog").then(
			(module) => module.RefinePromptDialog,
		),
	{ ssr: false },
);

export function RefineButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			className="h-7 text-xs"
			aria-label={`Refine with AI: ${label}`}
			onClick={onClick}
		>
			<WandSparklesIcon aria-hidden="true" className="mr-1 h-3 w-3" />
			Refine with AI
		</Button>
	);
}

/** "Refine with AI" for one prompt field, with its own dialog. */
export function RefinePromptButton({
	id,
	label,
	content,
	organizationId,
	onApply,
}: {
	/** Names the prompt to the assistant's session; nothing is stored under it. */
	id: string;
	label: string;
	content: string;
	organizationId: string | null;
	onApply: (content: string) => void;
}) {
	const [refining, setRefining] = useState(false);
	return (
		<>
			<RefineButton label={label} onClick={() => setRefining(true)} />
			{refining && (
				<RefinePromptDialog
					request={{ id, title: label, content }}
					organizationId={organizationId}
					onApply={onApply}
					onClose={() => setRefining(false)}
				/>
			)}
		</>
	);
}
