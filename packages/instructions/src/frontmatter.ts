export type ParsedFrontmatter = {
	name: string | null;
	description: string | null;
	fields: Record<string, string>;
	body: string;
};

const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const TOP_LEVEL_KEY = /^([A-Za-z0-9_-]+):\s*(.*)$/;

function unquote(value: string): string {
	const trimmed = value.trim();
	const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
	const isSingleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");
	if (isDoubleQuoted || isSingleQuoted) {
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
