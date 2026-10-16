"use client";

import type {
	ConversationListItem,
	ConversationVisibility,
} from "@saas/agents/lib/conversation-list";
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
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { useRef, useState } from "react";

const OPTIONS: ReadonlyArray<{
	value: ConversationVisibility;
	label: string;
	description: string;
}> = [
	{
		value: "PRIVATE",
		label: "Private",
		description: "Only you can open this conversation.",
	},
	{
		value: "ORGANIZATION",
		label: "Shared with your organization",
		description:
			"Everyone in your organization can read it. They cannot change it; they can carry on from it in a chat of their own.",
	},
];

/**
 * Who can read a conversation. Only the owner opens this. Sharing asks first,
 * because a conversation's transcript can hold what the agent read from the
 * owner's own connected servers, and everyone in the organization sees it as it
 * is.
 */
export function ConversationVisibilityDialog({
	conversation,
	onOpenChange,
	onConfirm,
}: {
	/** The conversation being changed; the dialog is closed while this is null. */
	conversation: ConversationListItem | null;
	onOpenChange: (open: boolean) => void;
	onConfirm: (
		conversation: ConversationListItem,
		visibility: ConversationVisibility,
	) => Promise<unknown>;
}) {
	// The dialog fades out after it is closed, when there is no conversation
	// any more: it keeps showing the last one until it has gone.
	const last = useRef(conversation);
	if (conversation) {
		last.current = conversation;
	}
	const shown = conversation ?? last.current;

	return (
		<Dialog open={conversation !== null} onOpenChange={onOpenChange}>
			<DialogContent>
				{shown ? (
					<VisibilityForm
						key={shown.id}
						conversation={shown}
						onCancel={() => onOpenChange(false)}
						onConfirm={onConfirm}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/**
 * The question for one conversation. Keyed on the conversation, so the choice
 * starts from what that conversation is now and never carries over from the
 * last one that was opened.
 */
function VisibilityForm({
	conversation,
	onCancel,
	onConfirm,
}: {
	conversation: ConversationListItem;
	onCancel: () => void;
	onConfirm: (
		conversation: ConversationListItem,
		visibility: ConversationVisibility,
	) => Promise<unknown>;
}) {
	const [choice, setChoice] = useState<ConversationVisibility>(
		conversation.visibility,
	);
	const [saving, setSaving] = useState(false);
	const title = conversation.title?.trim() || "Untitled conversation";

	return (
		<>
			<DialogHeader>
				<DialogTitle>Who can read this conversation?</DialogTitle>
				<DialogDescription>{title}</DialogDescription>
			</DialogHeader>

			<RadioGroup
				value={choice}
				onValueChange={(value) =>
					setChoice(value as ConversationVisibility)
				}
				aria-label="Who can read this conversation"
			>
				{OPTIONS.map((option) => (
					<div key={option.value} className="flex items-start gap-3">
						<RadioGroupItem
							value={option.value}
							id={`conversation-visibility-${option.value}`}
							className="mt-1"
						/>
						<Label
							htmlFor={`conversation-visibility-${option.value}`}
							className="grid gap-0.5 font-normal"
						>
							<span className="font-medium text-foreground">
								{option.label}
							</span>
							<span className="text-sm text-muted-foreground">
								{option.description}
							</span>
						</Label>
					</div>
				))}
			</RadioGroup>

			{choice === "ORGANIZATION" ? (
				<Alert variant="warning">
					<AlertTitle>Check what this conversation shows</AlertTitle>
					<AlertDescription>
						The transcript can include results the agent read from
						your own connected servers. Anyone you share it with
						sees them. Reading it does not give them access to those
						servers.
					</AlertDescription>
				</Alert>
			) : null}

			<DialogFooter>
				<Button type="button" variant="outline" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					type="button"
					disabled={conversation.visibility === choice || saving}
					onClick={async () => {
						setSaving(true);
						try {
							await onConfirm(conversation, choice);
						} finally {
							setSaving(false);
						}
					}}
				>
					{choice === "ORGANIZATION" ? "Share" : "Make private"}
				</Button>
			</DialogFooter>
		</>
	);
}
