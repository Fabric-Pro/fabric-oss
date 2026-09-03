import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Is the given module the script being run, rather than something imported?
 *
 * Seed scripts guard their top-level invocation with this so importing one —
 * which the retirement-skip tests do — does not seed a database and then call
 * `process.exit()` on the importer.
 *
 * The caller passes its own `import.meta.url`. Reading it inside this module
 * would resolve to *this* file and the guard would never match.
 *
 * pathToFileURL rather than a `file://` template: on Windows `process.argv[1]`
 * is a backslash drive path while `import.meta.url` is a `file:///C:/…` URL, and
 * the naive comparison never matches — see `scripts/apply-rls-direct.ts`, where
 * exactly that mismatch silently no-op'd the script. The realpath fallback
 * covers the other way to get a false negative: a symlinked checkout, where the
 * loader resolves the module URL and the shell's argument differently. A seed
 * that silently does nothing is the worst outcome available here, so the cheap
 * second comparison is worth its lines.
 */
export function isDirectRun(moduleUrl: string): boolean {
	const entry = process.argv[1];
	if (!entry) {
		return false;
	}
	if (moduleUrl === pathToFileURL(entry).href) {
		return true;
	}
	try {
		return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
	} catch {
		return false;
	}
}
