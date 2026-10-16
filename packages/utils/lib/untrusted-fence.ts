/**
 * Quoting text that somebody else wrote inside a prompt, so a model reads it as
 * data. The text goes between an opening and a closing tag that name it
 * untrusted. A tag of the same name inside the text, opening or closing, is
 * neutralised first, so the text cannot end its block early or forge one of its
 * own. The instructions that tell the model what the fence means stay outside
 * it, in code, where the text cannot reach them.
 *
 * One definition for everything that fences: a page's question to the model, and
 * the transcript a reader carries over from a session someone else shared.
 */

export function fenceUntrusted(
	tag: string,
	attributes: Record<string, string>,
	content: string,
): string {
	const neutralised = content.replace(
		new RegExp(`<(/?)${tag}`, "gi"),
		`&lt;$1${tag}`,
	);
	const described = Object.entries(attributes)
		.map(([name, value]) => ` ${name}="${value}"`)
		.join("");
	return `<${tag}${described} trust="untrusted">\n${neutralised}\n</${tag}>`;
}
