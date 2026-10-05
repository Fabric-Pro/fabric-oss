/**
 * What a project id or an organization slug may look like.
 *
 * Both end up where a stray character does harm: in the command line a
 * session hook runs, in a URL, and in a line an agent reads. They come from
 * the person's own `--project` and `--org`, and from the deployment's
 * resolver, whose answer is not trusted any further than that. One rule,
 * checked at every boundary: the option parser, the resolver's answer, and the
 * hook command's builder.
 */

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isIdentifier(value: string): boolean {
	return IDENTIFIER.test(value);
}
