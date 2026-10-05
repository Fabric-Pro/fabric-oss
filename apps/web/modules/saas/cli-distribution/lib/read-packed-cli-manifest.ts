/**
 * Reads the manifest `pack:deployment` left in `public/cli`.
 *
 * Server only: it reads the file system. `next.config.ts` lists the file under
 * `outputFileTracingIncludes` for the discovery route, because Vercel serves
 * `public/` from its CDN and the function would otherwise not have it.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "@repo/logs";
import { type CliManifest, parseCliManifest } from "./cli-discovery";

const MANIFEST_PATH = ["public", "cli", "manifest.json"] as const;

/**
 * `null` when this build packed no CLI (a dev server nobody ran the pack step
 * for) or left a manifest this code does not understand. The second is logged,
 * because that is a build that went wrong rather than one that never packed.
 */
export async function readPackedCliManifest(
	root: string = process.cwd(),
): Promise<CliManifest | null> {
	let raw: string;
	try {
		raw = await readFile(path.join(root, ...MANIFEST_PATH), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		logger.warn("[cli-discovery] Could not read the packed CLI manifest", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = null;
	}
	const manifest = parseCliManifest(parsed);
	if (!manifest) {
		logger.warn("[cli-discovery] The packed CLI manifest is not valid");
	}
	return manifest;
}
