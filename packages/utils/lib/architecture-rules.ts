/**
 * Design-pattern compliance, checked rather than judged.
 *
 * "Compliance" presupposes a record of which patterns a codebase requires, and
 * for somebody else's repository no such record exists — which is why the
 * architecture lens shipped with cycles only, and why `layer-rules.ts` is
 * quarantined: its rules encoded THIS repository's layout and produced findings
 * whose only real content was that assumption.
 *
 * The record is now the project's own. A team declares the imports its
 * architecture forbids, and this checks the import graph against what they
 * declared. Two properties follow, and both are the point:
 *
 *  - **No model decides anything.** An import either matches a forbidden pair or
 *    it does not. That keeps this lens inside the constraint its own file states
 *    — prose may word a violation this code proved, never decide one exists —
 *    and it is why "does this module import that one", the question a model
 *    answers confidently and wrongly, is never asked.
 *  - **Nothing is assumed about the repository.** No `packages/`, no `apps/`, no
 *    inference from folder names. A project that declares nothing gets no
 *    findings, which is the honest answer rather than a guess dressed as one.
 *
 * The trade is that a rule nobody writes is a rule nobody enforces. That is
 * deliberate: a checker reporting a convention it invented costs more trust than
 * the findings are worth.
 */

/**
 * What a rule asserts about an import.
 *
 * `forbidden` is the original: `from` must not import `to`. `required` is its
 * mirror and the reason design-pattern compliance can be checked at all without
 * inferring anything — "every route file imports the auth guard" is a pattern a
 * team can state, and a graph can settle. Both stay decidable: no model is
 * asked, and a project that declares neither gets no findings.
 */
export type ArchitectureRuleKind = "forbidden" | "required";

/** One rule a project declared, about imports between two path patterns. */
export interface ArchitectureRule {
	/** `forbidden`: `from` must not import `to`. `required`: it must. */
	kind: ArchitectureRuleKind;
	/** Glob matched against the importing file's repo-relative path. */
	from: string;
	/** Glob matched against the imported file's repo-relative path. */
	to: string;
	/** Why, in the team's own words. Shown on the finding. */
	reason: string;
}

/**
 * One breach of a declared rule.
 *
 * `toPath` is the import that broke a `forbidden` rule. For a `required` rule
 * there is no such import — that is the finding — so it is null.
 */
export interface ArchitectureViolation {
	rule: ArchitectureRule;
	fromPath: string;
	toPath: string | null;
}

/**
 * Compile one glob segment to a regular expression.
 *
 * Deliberately tiny: `**` crosses directory separators, `*` does not, `?` is one
 * character, and everything else is literal. No brace expansion, no negation, no
 * extglob.
 *
 * A bigger glob dialect would be a bigger surface for a rule to mean something
 * its author did not intend, and a rule that quietly matches the wrong files
 * produces exactly the confidently-wrong finding this whole lens exists to
 * avoid.
 */
export function globToRegExp(glob: string): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				// `**/` should also match zero directories, so `src/**/x.ts`
				// matches `src/x.ts`. Consuming the slash here is what allows it.
				if (glob[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
			continue;
		}
		if (ch === "?") {
			out += "[^/]";
			continue;
		}
		out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

/**
 * Imports that break the project's declared rules.
 *
 * `edges` is the same shape the cycle check consumes, so both run off one graph.
 * Paths are compared as given: the graph and the rules are both repo-relative,
 * and normalising here would hide a mismatch rather than surface it.
 */
export function findArchitectureViolations(input: {
	edges: Array<{ from: string; to: string }>;
	rules: ArchitectureRule[];
}): ArchitectureViolation[] {
	if (input.rules.length === 0 || input.edges.length === 0) {
		return [];
	}
	// Compiled once per rule rather than per edge: a large repository has tens of
	// thousands of edges, and recompiling a pattern for each is the difference
	// between a fast check and a timeout.
	const compiled = input.rules.map((rule) => ({
		rule,
		from: globToRegExp(rule.from),
		to: globToRegExp(rule.to),
	}));

	const violations: ArchitectureViolation[] = [];
	const seen = new Set<string>();

	const forbidden = compiled.filter((c) => c.rule.kind === "forbidden");
	const required = compiled.filter((c) => c.rule.kind === "required");

	// A required rule is answered per FILE, not per edge: the question is whether
	// a file imports anything matching the pattern, and the only way to know is to
	// have seen all of its imports. So they are collected first.
	if (required.length > 0) {
		// Every file the graph knows about, not only the ones that import
		// something. A file with no imports at all — or whose only edge is to
		// itself — imports nothing matching the pattern, which is precisely the
		// breach; keying off the import map alone made those files invisible.
		const allFiles = new Set<string>();
		const importsByFile = new Map<string, string[]>();
		for (const edge of input.edges) {
			allFiles.add(edge.from);
			allFiles.add(edge.to);
			if (edge.from === edge.to) {
				continue;
			}
			const list = importsByFile.get(edge.from);
			if (list) {
				list.push(edge.to);
			} else {
				importsByFile.set(edge.from, [edge.to]);
			}
		}
		for (const file of allFiles) {
			const imports = importsByFile.get(file) ?? [];
			for (const { rule, from, to } of required) {
				if (!from.test(file)) {
					continue;
				}
				if (imports.some((target) => to.test(target))) {
					continue;
				}
				// One finding per file per rule. Unlike a forbidden import there is
				// no offending edge to key on, so the file and the rule are the
				// identity.
				const key = `required ${file} ${rule.from} ${rule.to}`;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				violations.push({ rule, fromPath: file, toPath: null });
			}
		}
	}

	for (const edge of input.edges) {
		// A file importing itself is a parser artifact or a re-export, never the
		// architectural problem being looked for — the same exclusion the cycle
		// check makes, for the same reason.
		if (edge.from === edge.to) {
			continue;
		}
		for (const { rule, from, to } of forbidden) {
			if (!from.test(edge.from) || !to.test(edge.to)) {
				continue;
			}
			// One finding per import, even where several rules forbid it.
			// Reporting the same line three times reads as three problems.
			const key = `${edge.from}\0${edge.to}`;
			if (seen.has(key)) {
				break;
			}
			seen.add(key);
			violations.push({ rule, fromPath: edge.from, toPath: edge.to });
			break;
		}
	}
	return violations;
}

/**
 * Parse the rules a project typed, one per line.
 *
 * `src/ui/** -> src/db/** : the UI must not reach the database directly`
 * `src/routes/** => src/auth/guard.ts : every route checks the session`
 *
 * `->` forbids the import; `=>` requires it. The second is what makes
 * design-pattern compliance checkable without inferring a convention from folder
 * names: the team states the pattern, and the graph settles whether a file
 * follows it.
 *
 * Line-based rather than a JSON editor because somebody has to write these by
 * hand and read them in a diff. Blank lines and `#` comments are allowed so a
 * team can group and explain their rules.
 *
 * Every bad line is returned rather than thrown on. A settings page that rejects
 * the whole box because line 7 is malformed makes the author hunt for it; naming
 * the line is the difference between a fixable error and a frustrating one.
 */
export function parseArchitectureRules(text: string | null | undefined): {
	rules: ArchitectureRule[];
	errors: Array<{ line: number; text: string; problem: string }>;
} {
	const rules: ArchitectureRule[] = [];
	const errors: Array<{ line: number; text: string; problem: string }> = [];
	const lines = (text ?? "").split(/\r?\n/);

	lines.forEach((raw, index) => {
		const line = raw.trim();
		if (!line || line.startsWith("#")) {
			return;
		}
		// `=>` is checked first: `->` is a substring of neither, but reading them
		// in the other order would let a stray `-` inside a glob decide the kind.
		const required = line.indexOf("=>");
		const arrow = required === -1 ? line.indexOf("->") : required;
		if (arrow === -1) {
			errors.push({
				line: index + 1,
				text: line,
				problem: "missing '->' or '=>' between the two paths",
			});
			return;
		}
		const kind: ArchitectureRuleKind =
			required === -1 ? "forbidden" : "required";
		const from = line.slice(0, arrow).trim();
		const rest = line.slice(arrow + 2);
		const colon = rest.indexOf(":");
		const to = (colon === -1 ? rest : rest.slice(0, colon)).trim();
		const reason = colon === -1 ? "" : rest.slice(colon + 1).trim();

		if (!from || !to) {
			errors.push({
				line: index + 1,
				text: line,
				problem: `both sides of '${required === -1 ? "->" : "=>"}' need a path pattern`,
			});
			return;
		}
		if (!reason) {
			// Required, not optional. A violation reported without the reason its
			// author had in mind is a rule the reader has to reverse-engineer,
			// and they will assume it is wrong before they assume they are.
			errors.push({
				line: index + 1,
				text: line,
				problem:
					"add ': why' — a finding without a reason is unactionable",
			});
			return;
		}
		rules.push({ kind, from, to, reason });
	});

	return { rules, errors };
}
