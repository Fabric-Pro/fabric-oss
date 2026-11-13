"use client";

import { Input } from "@ui/components/input";

/**
 * A branch name field that offers the repository's real branches as
 * suggestions (a native `datalist`, so the browser's own accessible list,
 * with keyboard and screen-reader support) while still taking any typed
 * name: a listing can be truncated, and a branch may be created after it.
 */
export function RepositoryBranchInput({
	id,
	value,
	onChange,
	branches,
	invalid,
	describedBy,
	disabled,
}: {
	id: string;
	value: string;
	onChange: (next: string) => void;
	branches: readonly string[];
	invalid?: boolean;
	describedBy?: string;
	disabled?: boolean;
}) {
	const listId = `${id}-suggestions`;
	return (
		<>
			<Input
				id={id}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				list={branches.length > 0 ? listId : undefined}
				autoComplete="off"
				spellCheck={false}
				disabled={disabled}
				aria-invalid={invalid ? true : undefined}
				aria-describedby={describedBy}
			/>
			{branches.length > 0 ? (
				<datalist id={listId} data-testid={listId}>
					{branches.map((name) => (
						<option key={name} value={name} />
					))}
				</datalist>
			) : null}
		</>
	);
}
