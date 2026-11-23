/** How many characters a recent note's button shows before it is shortened. */
export const RECENT_NOTE_LABEL_LENGTH = 24;

const ELLIPSIS = "…";

/** A note as a button shows it: whitespace collapsed, as HTML renders it. */
function displayText(note: string): string {
	return note.trim().replace(/\s+/g, " ");
}

/** Characters, not UTF-16 units, so an emoji is never cut in half. */
function charactersOf(text: string): string[] {
	return Array.from(text);
}

/** The start and the end a shortened label keeps, around its ellipsis. */
interface ShortLabel {
	head: string;
	tail: string;
}

/**
 * A long note keeps its start and its end: "Requirements…management". A note
 * that fits is not shortened.
 */
function shorten(text: string, maxLength: number): ShortLabel | null {
	const characters = charactersOf(text);
	if (characters.length <= maxLength) {
		return null;
	}
	const headLength = Math.ceil((maxLength - 1) / 2);
	const tailStart = characters.length - (maxLength - 1 - headLength);
	const head = characters.slice(0, headLength).join("").trimEnd();
	const tail = characters.slice(tailStart).join("");
	// The end starts on a whole word where it can: "meetings", not "ct meetings".
	const startsMidWord = tail[0] !== " " && characters[tailStart - 1] !== " ";
	const firstSpace = tail.indexOf(" ");
	const wholeWordTail =
		startsMidWord && firstSpace >= 0 ? tail.slice(firstSpace) : tail;
	return { head, tail: wholeWordTail.trimStart() };
}

/**
 * Whether a shortened label could as well stand for another note: "Review…team"
 * reads as both "Review with the product team" and "Review with the design
 * team".
 */
function couldBe(label: ShortLabel, other: string): boolean {
	return other.startsWith(label.head) && other.endsWith(label.tail);
}

/** How many leading characters two texts share. */
function sharedStartLength(a: string[], b: string[]): number {
	let length = 0;
	while (length < a.length && length < b.length && a[length] === b[length]) {
		length++;
	}
	return length;
}

/** The part of a note where it differs from the others, between ellipses. */
function aroundDifference(
	text: string,
	others: readonly string[],
	maxLength: number,
): string {
	const characters = charactersOf(text);
	if (characters.length <= maxLength) {
		return text;
	}
	const differsAt = Math.max(
		0,
		...others.map((other) =>
			sharedStartLength(characters, charactersOf(other)),
		),
	);
	// Start on the word where the note differs.
	const wordStart =
		differsAt > 0 ? characters.lastIndexOf(" ", differsAt - 1) + 1 : 0;
	const width = maxLength - 2;
	const start = Math.max(
		0,
		// A single word longer than the label still shows where it differs.
		differsAt - width + 1,
		Math.min(wordStart, characters.length - width),
	);
	const end = Math.min(characters.length, start + width);
	const middle = characters.slice(start, end).join("").trim();
	return `${start > 0 ? ELLIPSIS : ""}${middle}${end < characters.length ? ELLIPSIS : ""}`;
}

/**
 * A short label for each note that still tells it apart from the others.
 * A shortened label that could stand for another note shows where the note
 * differs instead. Labels are for display only; a pick uses the full note.
 */
export function recentNoteLabels(
	notes: readonly string[],
	maxLength = RECENT_NOTE_LABEL_LENGTH,
): string[] {
	const texts = notes.map(displayText);
	return texts.map((text, index) => {
		const label = shorten(text, maxLength);
		if (!label) {
			return text;
		}
		const others = texts.filter((_, other) => other !== index);
		return others.some((other) => couldBe(label, other))
			? aroundDifference(text, others, maxLength)
			: `${label.head}${ELLIPSIS}${label.tail}`;
	});
}
