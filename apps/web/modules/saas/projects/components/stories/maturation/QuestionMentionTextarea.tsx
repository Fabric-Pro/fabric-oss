"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Textarea } from "@ui/components/textarea";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { AssignableMember } from "./QuestionAssigneePicker";

/**
 * Matches a `@` the caret is currently sitting inside a word of. Anchored to the
 * end so it only fires on the token being typed, and requires the `@` to start a
 * word so an email address does not open the popover.
 */
const TRAILING_MENTION = /(?:^|\s)@([\w.-]*)$/;

/**
 * Everyone named in the text, resolved back to member ids. Matching on the
 * rendered display name is what keeps the stored value plain text: the answer
 * payload is a string, and turning it into a rich document to carry ids would
 * put document-formatting behaviour into a panel whose answers are prose.
 */
export function mentionedMemberIds(
	text: string,
	members: AssignableMember[],
): string[] {
	// LONGEST LABEL FIRST, and each match claims its span.
	//
	// `(?!\w)` stops `@Sam` matching inside `@Sammy`, but it does NOT stop a name
	// that is a prefix of a longer one when the longer one continues past a
	// SPACE: in `@Ann Lee`, the char after `Ann` is a space, so a member called
	// "Ann" satisfies the guard and the single token names two people. Two
	// accounts whose display names are "Ann" and "Ann Lee" is not a corner case —
	// a second test account is exactly how it happens.
	const byLongestLabel = [...members].sort(
		(a, b) => (b.name?.trim().length ?? 0) - (a.name?.trim().length ?? 0),
	);
	const found = new Set<string>();
	// `@` offsets already spoken for, so a shorter name cannot match inside a
	// longer one's token.
	const claimed: { start: number; end: number }[] = [];
	for (const member of byLongestLabel) {
		const label = member.name?.trim();
		if (!label) {
			continue;
		}
		// Escape the label — display names legitimately contain regex characters.
		const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// The `@` must start a word, so `x@Sam R.com` in an email address is not a
		// mention. The trailing guard is `(?!\w)` rather than `\b`, because a name
		// ending in punctuation ("Sam R.") has no word boundary after it and `\b`
		// would never match — while `(?!\w)` still rejects `@Sam` inside `@Sammy`.
		const pattern = new RegExp(`(?:^|\\s)@${escaped}(?!\\w)`, "gi");
		for (const match of text.matchAll(pattern)) {
			// The match may start on the preceding whitespace.
			const at = (match.index ?? 0) + match[0].indexOf("@");
			if (claimed.some((span) => at >= span.start && at < span.end)) {
				continue;
			}
			claimed.push({ start: at, end: at + label.length + 1 });
			found.add(member.id);
		}
	}
	// Caller order, not match order, so the Ask label reads the same every time.
	return members.filter((member) => found.has(member.id)).map((m) => m.id);
}

type Props = {
	value: string;
	onChange: (value: string) => void;
	members: AssignableMember[];
	onQueryChange: (query: string) => void;
	disabled?: boolean;
	placeholder?: string;
	ariaLabel?: string;
};

/**
 * The answer field, with `@` mention support (Fizzy #1751, AC-8).
 *
 * Deliberately a plain `<Textarea>` with a popover over it, NOT the rich
 * document editor. Two reasons: the answer payload is a plain string, and one of
 * the acceptance criteria is that nothing here disturbs document formatting —
 * dragging the document editor into this panel puts both at risk.
 *
 * This component only inserts the token and reports who was named. It does not
 * decide what the mention MEANS: citing somebody ("as per @Sam, ninety days") is
 * an answer, whereas asking them ("ninety days, right @Sam?") is not, and only
 * the author knows which. The panel offers both actions and lets them choose.
 */
export function QuestionMentionTextarea({
	value,
	onChange,
	members,
	onQueryChange,
	disabled = false,
	placeholder,
	ariaLabel,
}: Props) {
	const t = useTranslations("projects.stories.maturation.summaryQuestions");
	const ref = useRef<HTMLTextAreaElement>(null);
	const [open, setOpen] = useState(false);

	const handleChange = (next: string) => {
		onChange(next);
		const caret = ref.current?.selectionStart ?? next.length;
		const match = TRAILING_MENTION.exec(next.slice(0, caret));
		if (match) {
			setOpen(true);
			onQueryChange(match[1]);
		} else {
			setOpen(false);
		}
	};

	const insert = (member: AssignableMember) => {
		const label = member.name ?? member.email ?? "";
		const caret = ref.current?.selectionStart ?? value.length;
		const before = value.slice(0, caret);
		const after = value.slice(caret);
		// Replace the partial token the caret is in, keeping everything else.
		const replaced = before.replace(TRAILING_MENTION, (whole, partial) =>
			whole
				.slice(0, whole.length - partial.length - 1)
				.concat(`@${label} `),
		);
		onChange(replaced + after);
		setOpen(false);
		ref.current?.focus();
	};

	return (
		<div className="relative">
			<Textarea
				ref={ref}
				value={value}
				onChange={(e) => handleChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape" && open) {
						e.stopPropagation();
						setOpen(false);
					}
				}}
				placeholder={placeholder}
				rows={3}
				aria-label={ariaLabel}
				disabled={disabled}
			/>
			{open && members.length > 0 && (
				<ul
					className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
					aria-label={t("mentionSuggestionsLabel")}
				>
					{members.slice(0, 8).map((member) => (
						<li key={member.id}>
							<button
								type="button"
								onClick={() => insert(member)}
								className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
							>
								<Avatar className="size-5">
									{member.avatarUrl && (
										<AvatarImage
											src={member.avatarUrl}
											alt={member.name ?? ""}
										/>
									)}
									<AvatarFallback className="text-[9px]">
										{(member.name ?? member.email ?? "?")
											.slice(0, 2)
											.toUpperCase()}
									</AvatarFallback>
								</Avatar>
								<span className="truncate">
									{member.name ?? member.email}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
