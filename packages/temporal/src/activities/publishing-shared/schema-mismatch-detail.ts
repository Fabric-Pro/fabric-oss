const MAX_ISSUES = 10;

interface Issue {
	path?: unknown;
	message?: unknown;
}

function findIssues(error: unknown): Issue[] | null {
	let current = error;
	for (let depth = 0; depth < 5 && current; depth++) {
		if (typeof current !== "object") {
			return null;
		}
		const bag = current as { issues?: unknown; cause?: unknown };
		if (Array.isArray(bag.issues)) {
			return bag.issues as Issue[];
		}
		current = bag.cause;
	}
	return null;
}

/**
 * Which fields a model's answer got wrong, from the Zod issues a
 * `NoObjectGeneratedError` carries in its cause chain, as ` [path: message;
 * …]`; empty when there are none. The AI SDK's own message says only "did not
 * match schema", which left a failure on the ChatGPT plan undiagnosable from
 * the run log (Fizzy #2770). Paths and Zod messages only: never the answer.
 */
export function schemaMismatchDetail(error: unknown): string {
	const issues = findIssues(error);
	if (!issues || issues.length === 0) {
		return "";
	}
	const listed = issues.slice(0, MAX_ISSUES).map((issue) => {
		const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
		return `${path || "(root)"}: ${String(issue.message ?? "invalid")}`;
	});
	const more =
		issues.length > MAX_ISSUES
			? `; +${issues.length - MAX_ISSUES} more`
			: "";
	return ` [${listed.join("; ")}${more}]`;
}
