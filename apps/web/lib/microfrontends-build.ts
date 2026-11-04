import fs from "node:fs";
import path from "node:path";

/** The Vercel project that is the default application of fabric.pro's Microfrontends group. */
const MICROFRONTENDS_DEFAULT_PROJECT = "fabric-prod";

type BuildContext = {
	env: Record<string, string | undefined>;
	/** Directory the build runs in: apps/web for `next build`. */
	cwd: string;
	readFile?: (file: string) => string;
};

/**
 * Whether this build is fabric-prod's, the only project in fabric.pro's
 * Microfrontends group. A fabric-prod build that misses the group still deploys
 * and still serves the portal, so nothing errors: fabric.pro just loses the
 * marketing site on `/` and every other marketing path.
 *
 * - Vercel's own builders set VERCEL_PROJECT_NAME.
 * - A prebuilt deploy (`vercel pull`, then `vercel build` on a machine, which is
 *   how the production release pipeline deploys) does not, but `vercel pull`
 *   writes the linked project's name to `.vercel/project.json`, at the
 *   repository root or in apps/web.
 *
 * Project environment variables can't stand in: fabric-prod's are sensitive,
 * and `vercel pull` writes a sensitive value as the literal "[SENSITIVE]". That
 * is how release v1.16.38 shipped without routing on 4 Nov 2026.
 *
 * `next dev` never joins the group, even inside a checkout linked to
 * fabric-prod; local runs stay exactly as before.
 */
export function isMicrofrontendsBuild({
	env,
	cwd,
	readFile = (f) => fs.readFileSync(f, "utf8"),
}: BuildContext): boolean {
	if (env.VERCEL_PROJECT_NAME) {
		return env.VERCEL_PROJECT_NAME === MICROFRONTENDS_DEFAULT_PROJECT;
	}
	if (env.NODE_ENV === "development") {
		return false;
	}
	for (const dir of [cwd, path.resolve(cwd, "../..")]) {
		let raw: string;
		try {
			raw = readFile(path.join(dir, ".vercel", "project.json"));
		} catch {
			continue;
		}
		try {
			return (
				(JSON.parse(raw) as { projectName?: unknown }).projectName ===
				MICROFRONTENDS_DEFAULT_PROJECT
			);
		} catch {
			return false;
		}
	}
	return false;
}
