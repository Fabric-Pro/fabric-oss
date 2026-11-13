import path from "node:path";
import { expandBareHome } from "./git-helpers.mjs";

const COMPOUND =
	/^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|select|function)(?:\s|$)/;

/**
 * Scan only simple shell lists, retaining operators and literal quoting. This
 * intentionally differs from the gate's segmenter: changing its heuristics
 * would change which commands are gated. Heredoc bodies are consumed at the
 * next newline, in redirection order, before scanning any more shell text.
 *
 * @param {string} command
 * @returns {{text: string, before: string[]}[] | null}
 */
function scanSegments(command) {
	const segments = [];
	let text = "";
	let before = [];
	const heredocs = [];
	const endSegment = (operator) => {
		if (text.trim()) {
			segments.push({ text: text.trim(), before });
			before = [];
		}
		text = "";
		if (operator) {
			before.push(operator);
		}
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		// A comment can hide a list operator or a heredoc marker. Do not
		// infer a cwd from commands containing an unquoted comment word.
		if (ch === "#" && (i === 0 || /[\s;&|<>]/.test(command[i - 1]))) {
			return null;
		}
		if (ch === "\\" && command[i + 1] === "\n") {
			i++;
			continue;
		}
		// Other bare escapes can conceal quote/group boundaries. Leave those
		// commands to the existing fallback rather than interpreting them.
		if (ch === "\\") {
			return null;
		}
		if (ch === "'" || ch === '"') {
			const start = i;
			const quote = ch;
			for (i++; i < command.length; i++) {
				if (quote === '"' && command[i] === "\\") {
					i++;
				} else if (command[i] === quote) {
					break;
				}
			}
			if (i >= command.length) {
				return null;
			}
			text += command.slice(start, i + 1);
			continue;
		}
		if (/[(){}`]/.test(ch)) {
			return null;
		}
		if (command.startsWith("<<", i)) {
			// Require the complete delimiter word. Unsupported quoting or
			// expansion falls back rather than guessing where a body ends.
			const match = command
				.slice(i)
				.match(
					/^<<(-?)[ \t]*(?:'([^'\r\n]+)'|"([^"\\\r\n]+)"|([A-Za-z0-9_./:-]+))(?=[ \t\r\n;&|<>]|$)/,
				);
			if (!match) {
				return null;
			}
			heredocs.push({
				delimiter: match[2] ?? match[3] ?? match[4],
				tabs: match[1] === "-",
			});
			text += match[0];
			i += match[0].length - 1;
			continue;
		}
		if (ch === "\n") {
			endSegment("\n");
			for (const { delimiter, tabs } of heredocs) {
				let bodyEnd = i;
				let cursor = i + 1;
				while (cursor < command.length) {
					let end = command.indexOf("\n", cursor);
					if (end < 0) {
						end = command.length;
					}
					const line = command.slice(cursor, end).replace(/\r$/, "");
					if (
						(tabs ? line.replace(/^\t+/, "") : line) === delimiter
					) {
						bodyEnd = end;
						break;
					}
					cursor = end + 1;
				}
				if (bodyEnd === i) {
					return null;
				}
				i = bodyEnd;
			}
			heredocs.length = 0;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&") {
			// An ampersand in a redirection is not a shell-list operator.
			if (
				ch === "&" &&
				(/[<>]/.test(command[i - 1] ?? "") || command[i + 1] === ">")
			) {
				text += ch;
				continue;
			}
			const operator = command
				.slice(i)
				.match(/^(?:&&|\|\||\|&|[;|&])/)[0];
			endSegment(operator);
			i += operator.length - 1;
			continue;
		}
		text += ch;
	}
	if (heredocs.length) {
		return null;
	}
	endSegment();
	if (segments.some(({ text }) => COMPOUND.test(text))) {
		return null;
	}
	return segments;
}

/**
 * Candidate cwd for the PR invocation only. The caller supplies its existing
 * gating predicates for individual segments; this does not decide whether to
 * gate a command. Ambiguous shell forms return null, preserving the caller's
 * leading-cd, payload-cwd and project-dir fallbacks. Without a payload cwd,
 * leave resolution to those existing candidates.
 *
 * @param {string} command
 * @param {string | undefined} payloadCwd
 * @param {(segment: string) => boolean} isPrInvocation
 * @returns {string | null}
 */
export function prCommandCwd(command, payloadCwd, isPrInvocation) {
	if (!payloadCwd) {
		return null;
	}
	const segments = scanSegments(command) ?? [];
	const invocations = segments.flatMap((segment, index) =>
		isPrInvocation(segment.text) ? [index] : [],
	);
	if (invocations.length !== 1) {
		return null;
	}
	const index = invocations[0];
	const pr = segments[index];
	if (pr.before.length !== 1 || pr.before[0] !== "&&") {
		return null;
	}
	const cd = segments[index - 1];
	if (
		cd?.before.some(
			(operator) => !["\n", ";", "&&", "&"].includes(operator),
		)
	) {
		return null;
	}
	// Whole single-quoted words are literal. Double-quoted words exclude
	// expansion/escape/history syntax; bare paths allow only stable characters.
	const target = (cd?.text ?? "").match(
		/^cd[ \t]+(?:'([^']*)'|"([^$`\\!"\n]*)"|((?:~(?:\/[A-Za-z0-9_./:-]*)?|[A-Za-z0-9_./:-]+)))[ \t]*$/,
	);
	if (!target) {
		return null;
	}
	const dir = target[1] ?? target[2] ?? expandBareHome(target[3]);
	if (path.isAbsolute(dir)) {
		return dir;
	}
	// Earlier commands may have changed cwd. Only a first-segment relative
	// cd can be resolved against the payload without following shell state.
	if (index !== 1) {
		return null;
	}
	return path.resolve(payloadCwd, dir);
}
