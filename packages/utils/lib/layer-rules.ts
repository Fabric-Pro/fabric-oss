/**
 * Architectural layer rules, checked rather than judged.
 *
 * NOT FOR REVIEWING SOMEBODY ELSE'S REPOSITORY. Both rules below encode THIS
 * repository's layout: `owningPackage` hardcodes `packages/` and `apps/`, and the
 * direction rule asserts a convention about what those two directories mean. The
 * pull-request review lens used to call this against a customer project's import
 * graph, which produced findings whose only real content was those assumptions —
 * the declarations came from this server's own filesystem, and an unread package
 * read as "declares nothing" rather than as "cannot check". It reports cycles
 * only now. Applying this module to a repository whose layout has not been
 * established re-creates that bug.
 *
 * The review lens that reports these must never ask a model whether an import is
 * allowed — "does this module import that one" is exactly the question a model
 * answers confidently and wrongly, and a wrong architecture finding costs somebody
 * an afternoon looking for a violation that is not there. So every rule here is
 * decidable from facts THIS repository already states.
 *
 * That constraint is also why there is no hand-written allow-list of package pairs.
 * A manifest somebody maintains by hand goes stale the first time it is
 * inconvenient, and then the checker is reporting the manifest's opinion rather
 * than the repository's. Both rules below are derived instead:
 *
 *  1. **Undeclared dependency.** A workspace package may only import another one it
 *     names in its own `package.json`. The declaration already exists and is
 *     already load-bearing (pnpm enforces resolution from it), so this rule cannot
 *     drift from reality — it reads the same file the installer does.
 *
 *  2. **A library may not import an application.** `packages/*` are consumed by
 *     `apps/*`, never the reverse. This one is a direction, not a list, so it needs
 *     no maintenance either.
 *
 * Anything needing a genuine judgement call — "the QA surface should not reach into
 * scan internals" — is deliberately absent until somebody records it as data. The
 * lens reporting a rule it cannot prove is the failure being avoided.
 */

/** One import that breaks a rule, in the terms a reader has to act on. */
export interface LayerViolation {
	/** The importing file, as the diff names it. */
	from: string;
	/** The imported file. */
	to: string;
	/** Which rule it broke — `undeclared-dependency` | `library-imports-app`. */
	rule: "undeclared-dependency" | "library-imports-app";
	/** One sentence a reader can act on without opening this file. */
	detail: string;
}

/**
 * Which workspace package owns a path, by its directory prefix.
 *
 * Returns null for anything outside `packages/` and `apps/` — the repo root's own
 * tooling and config belong to no package and are governed by neither rule.
 */
export function owningPackage(filePath: string): string | null {
	const match = filePath.match(/^(packages|apps)\/([^/]+)\//);
	return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Import edges that break a derived rule.
 *
 * `declaredDependencies` maps a workspace directory (`packages/api`) to the set of
 * workspace directories it declares. The caller builds it from the `package.json`
 * files, because reading those belongs to whoever has filesystem access — this
 * function stays pure so it can be tested exhaustively.
 *
 * An edge inside one package is never a violation: how a package arranges itself is
 * its own business, and the cycle check already covers the shape of that.
 */
export function findLayerViolations(input: {
	edges: Array<{ from: string; to: string }>;
	declaredDependencies: Map<string, Set<string>>;
}): LayerViolation[] {
	const violations: LayerViolation[] = [];
	const seen = new Set<string>();

	for (const edge of input.edges) {
		const fromPkg = owningPackage(edge.from);
		const toPkg = owningPackage(edge.to);
		if (!fromPkg || !toPkg || fromPkg === toPkg) {
			continue;
		}

		// One finding per package pair per rule, not per file: twenty files in the
		// same package importing the same offending package is one architectural
		// fact, and reporting it twenty times buries everything else.
		const rule =
			fromPkg.startsWith("packages/") && toPkg.startsWith("apps/")
				? "library-imports-app"
				: !input.declaredDependencies.get(fromPkg)?.has(toPkg)
					? "undeclared-dependency"
					: null;
		if (!rule) {
			continue;
		}
		const key = `${fromPkg}->${toPkg}:${rule}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		violations.push({
			from: edge.from,
			to: edge.to,
			rule,
			detail:
				rule === "library-imports-app"
					? `${fromPkg} is a library and imports ${toPkg}, an application. Applications consume packages, never the reverse — this makes ${fromPkg} unusable in any other app and is usually a type or helper that belongs in a package.`
					: `${fromPkg} imports ${toPkg} without declaring it in its package.json. It resolves today only because pnpm hoisted it, so it will break the first time the dependency tree shifts. Add it as a dependency, or move the shared code somewhere both already depend on.`,
		});
	}

	// Stable order so a re-run does not reshuffle the finding list.
	return violations.sort((a, b) =>
		`${a.rule}${a.from}${a.to}`.localeCompare(`${b.rule}${b.from}${b.to}`),
	);
}
