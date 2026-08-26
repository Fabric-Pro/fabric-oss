"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { XIcon } from "lucide-react";
import { useState } from "react";

export interface TerminalStatusEditorProps {
	value: string[];
	onChange: (next: string[]) => void;
	onSuggest?: () => void;
	isSuggesting?: boolean;
}

/**
 * Chip editor for a project's terminal-status list (card #1360). Controlled by
 * the parent settings form; emits the deduped list on every add/remove.
 *
 * NOTE: the "Suggest with AI" button was temporarily removed (may return). The
 * onSuggest/isSuggesting props are intentionally kept on the interface so the
 * parent's suggestTerminalStatuses wiring stays live and re-adding the button is
 * a one-line revert.
 */
export function TerminalStatusEditor({
	value,
	onChange,
}: TerminalStatusEditorProps) {
	const [draft, setDraft] = useState("");

	const addStatus = () => {
		const trimmed = draft.trim();
		if (trimmed.length === 0 || value.includes(trimmed)) {
			setDraft("");
			return;
		}
		onChange([...value, trimmed]);
		setDraft("");
	};

	const removeStatus = (status: string) => {
		onChange(value.filter((s) => s !== status));
	};

	return (
		<div className="space-y-3">
			<div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
				Terminal statuses
			</div>
			<p className="text-muted-foreground text-xs">
				Tickets in these statuses are treated as closed in the connected
				PM tool. Matched case-sensitively.
			</p>

			<div
				className="flex flex-wrap gap-1.5"
				data-testid="terminal-status-chips"
			>
				{value.length === 0 ? (
					<p className="text-muted-foreground text-sm italic">
						No terminal statuses set. Add your own.
					</p>
				) : null}
				{value.map((status) => (
					<Badge key={status} variant="secondary" className="gap-1">
						{status}
						<button
							type="button"
							aria-label={`Remove ${status}`}
							onClick={() => removeStatus(status)}
							className="text-muted-foreground hover:text-foreground"
						>
							<XIcon className="size-3" />
						</button>
					</Badge>
				))}
			</div>

			<div className="flex items-center gap-2">
				<Input
					aria-label="Add a terminal status"
					placeholder="add a status…"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							addStatus();
						}
					}}
				/>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={addStatus}
				>
					Add
				</Button>
			</div>
		</div>
	);
}
