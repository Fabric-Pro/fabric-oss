"use client";

import { Input } from "@ui/components/input";
import { useRef, useState } from "react";
import { RecentNotes } from "./RecentNotes";

/** The API's limit on an entry's description, which a timer's note becomes. */
const NOTE_MAX_LENGTH = 10_000;

/**
 * The timer's note, saved when it loses focus or on Enter, with the caller's
 * recent notes on the timer's project. A recent note fills the field like
 * typing does, so it is saved the same way and stays editable until then.
 */
export function TimerNote({
	id,
	initial,
	placeholder,
	onCommit,
	projectId,
	notesDisabled,
}: {
	id: string;
	initial: string;
	placeholder: string;
	onCommit: (description: string) => void;
	projectId: string;
	notesDisabled: boolean;
}) {
	const [value, setValue] = useState(initial);
	const inputRef = useRef<HTMLInputElement>(null);
	const commit = () => {
		const trimmed = value.trim();
		if (trimmed !== initial.trim()) {
			onCommit(trimmed);
		}
	};
	return (
		<>
			<Input
				ref={inputRef}
				id={id}
				value={value}
				placeholder={placeholder}
				maxLength={NOTE_MAX_LENGTH}
				onChange={(event) => setValue(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit();
					}
				}}
			/>
			<RecentNotes
				projectId={projectId}
				onPick={(note) => {
					setValue(note);
					inputRef.current?.focus();
				}}
				disabled={notesDisabled}
				className="col-start-2"
			/>
		</>
	);
}
