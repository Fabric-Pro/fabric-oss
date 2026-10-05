import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCliManifest } from "../modules/saas/cli-distribution/lib/cli-discovery";

/**
 * The environment `next.config.ts` hands the build for the CLI this deployment
 * serves, read from the manifest `pack:deployment` wrote to
 * `public/cli/manifest.json`:
 *
 *   `FABRIC_CLI_TARBALL`  where the tarball is served, origin-relative. Its
 *                         name carries the build (`fabric-<version>-<build>.tgz`),
 *                         so it is read from here and never rebuilt from the
 *                         version.
 *   `FABRIC_CLI_ORIGIN`   the address that tarball was built to sign in at;
 *                         absent when the build did not know one.
 *
 * The MCP handshake offers the one-line setup only when it knows a CLI is
 * served, and this is the one place it learns which. The pack step runs before
 * `next build` (see `turbo.json`), so the file is there when the config is
 * read; without it (a dev server nobody packed for, a build that skipped the
 * step) both variables are omitted and the handshake simply carries no offer.
 * A manifest that is not exactly what the pack step writes is treated as
 * absent rather than passed on.
 */
export function cliManifestEnv(
	appRoot: string,
):
	| { FABRIC_CLI_TARBALL: string; FABRIC_CLI_ORIGIN?: string }
	| Record<string, never> {
	let manifest: ReturnType<typeof parseCliManifest>;
	try {
		manifest = parseCliManifest(
			JSON.parse(
				readFileSync(
					path.join(appRoot, "public", "cli", "manifest.json"),
					"utf8",
				),
			),
		);
	} catch {
		return {};
	}
	if (manifest === null) {
		return {};
	}
	return {
		FABRIC_CLI_TARBALL: manifest.tarball,
		...(manifest.origin === null
			? {}
			: { FABRIC_CLI_ORIGIN: manifest.origin }),
	};
}
