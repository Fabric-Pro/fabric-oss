/**
 * Computes uppercase avatar initials from a display name.
 *
 * For multiple words, uses the first letter of the first and last word.
 * For single-word names, uses up to the first two characters.
 */
export function getAvatarInitials(name?: string | null, fallback = ""): string {
	if (!name) {
		return fallback;
	}

	const trimmed = name.trim();
	if (!trimmed) {
		return fallback;
	}

	// For email inputs, extract the local part and tokenize on standard separators (. _ - +)
	let workingName = trimmed;
	if (trimmed.includes("@")) {
		const localPart = trimmed
			.split("@")[0]
			.replace(/[._\-+]+/g, " ")
			.trim();
		if (localPart) {
			workingName = localPart;
		}
	}

	const words = workingName.split(/\s+/).filter(Boolean);

	if (words.length === 1) {
		const codePoints = Array.from(words[0]);
		// Strip punctuation characters so symbols are not emitted as initials
		const alphanumericChars = codePoints.filter((c) =>
			/\p{L}|\p{N}/u.test(c),
		);
		const candidateChars =
			alphanumericChars.length > 0 ? alphanumericChars : codePoints;
		return candidateChars.slice(0, 2).join("").toUpperCase();
	}

	// Extract code points to preserve surrogate pairs and astral symbols
	const firstWordChars = Array.from(words[0]);
	const lastWordChars = Array.from(words[words.length - 1]);

	const firstInitial = firstWordChars[0];
	const lastInitial = lastWordChars[0];

	return `${firstInitial}${lastInitial}`.toUpperCase();
}
