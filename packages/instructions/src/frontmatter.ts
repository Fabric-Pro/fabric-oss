export type ParsedFrontmatter = {
	name: string | null;
	description: string | null;
	fields: Record<string, string>;
	body: string;
};

const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
// The value starts at its first non-space character. `:\s*(.*)$` let `\s*`
// and `.*` split a long whitespace run every possible way whenever `.` then
// met a lone `\r` or U+2028, which is quadratic in the line's length (CodeQL
// js/polynomial-redos); `\S` gives the run a single split and captures the
// same value (none when the line ends at the colon).
const TOP_LEVEL_KEY = /^([A-Za-z0-9_-]+):\s*(\S.*)?$/;

function unquote(value: string): string {
	const trimmed = value.trim();
	const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
	const isSingleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");
	if (isDoubleQuoted) {
		// A YAML double-quoted scalar escapes the two characters that would
		// otherwise end it or start an escape: `\"` and `\\`. Decode exactly
		// those two so a writer that quotes correctly round-trips, and leave
		// every other backslash sequence as it is so files that never
		// escaped anything still read exactly as before.
		return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
	}
	if (isSingleQuoted) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
	const match = BLOCK.exec(text);
	if (!match) {
		return { name: null, description: null, fields: {}, body: text };
	}
	const fields: Record<string, string> = {};
	const lines = match[1].split(/\r?\n/);
	let key: string | null = null;
	let buf: string[] = [];
	const flush = () => {
		if (key !== null) {
			fields[key] = buf.join("\n").trim();
		}
		key = null;
		buf = [];
	};
	for (const raw of lines) {
		const isIndented = raw.startsWith(" ") || raw.startsWith("\t");
		const top = isIndented ? null : TOP_LEVEL_KEY.exec(raw);
		if (top) {
			flush();
			key = top[1];
			const rest = top[2] ?? "";
			if (rest.length > 0) {
				buf.push(unquote(rest));
			}
		} else if (key !== null) {
			buf.push(raw.trim());
		}
	}
	flush();
	// A single blank line conventionally separates the frontmatter block from
	// the body; drop it so the body starts at its first real content line.
	const body = text.slice(match[0].length).replace(/^\r?\n/, "");
	return {
		name: fields.name ?? null,
		description: fields.description ?? null,
		fields,
		body,
	};
}
