/**
 * What may be written into a command line: one rule for the arguments this CLI
 * hands to a coding tool and for the lines it prints for a person to paste.
 *
 * A deployment's address comes from `new URL(...).origin`, which lets a host
 * carry `$ ( ) ; & ` ' " ! ~ , { }`. None of that is safe in a shell, and no
 * quoting reads the same in bash, PowerShell and cmd. So a word is either made
 * only of the characters below, or it is not written into a command at all: the
 * caller says, in a fixed sentence that does not repeat the address, that there
 * is no line to run.
 */

/** Letters, digits and the punctuation of a name, a flag or a URL, and nothing a shell reads. */
const SAFE_ARGUMENT = /^[A-Za-z0-9._:/=@+-]+$/;

/**
 * An origin a session hook may carry unquoted: a scheme, a plain host or a
 * bracketed IPv6 address, and a port. A hook is run by a shell at every session
 * start, so what it carries is stricter than what is printed.
 */
const PLAIN_ORIGIN =
	/^https?:\/\/(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** What stands in for a command that cannot be printed, inside a sentence that expects one. */
export const NO_COMMAND =
	"<no command: the deployment address cannot be written into one>";

/** Said instead of `Run: <line>` when no line can be printed. */
export const NO_LINE_FOR_ADDRESS =
	"This deployment's address cannot be written into a command, so there is no line to run for it.";

export function isSafeArgument(value: string): boolean {
	return SAFE_ARGUMENT.test(value);
}

/** The words as one line to paste, or `null` when any of them is not plain. */
export function pasteableLine(words: readonly string[]): string | null {
	return words.every(isSafeArgument) ? words.join(" ") : null;
}

export function isPlainOrigin(origin: string): boolean {
	return PLAIN_ORIGIN.test(origin);
}
