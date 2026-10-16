/**
 * `<root>/.fabric/project.json` -- the folder `fabric instructions init` ran in,
 * and what it set up there.
 *
 * The memory mirror writes files and edits `.git/info/exclude`, so it must be
 * certain which folder and which repository it is working for. It never
 * guesses from the working directory: it walks up from there to the nearest
 * folder holding this marker, and works only inside that folder. A folder
 * under no such marker is refused, and so is a git work tree other than the
 * one `init` recorded, so a session started in a subfolder of an unrelated
 * checkout cannot write into that checkout or its git directory.
 */
import path from "node:path";
import { readFileSafely, writeFileSafely } from "../instructions/safe-write.js";

const MARKER_RELATIVE_PATH = ".fabric/project.json";
const MARKER_VERSION = 1;
const MAX_MARKER_BYTES = 64 * 1024;

export interface ProjectMarker {
	version: number;
	projectId: string;
	/** The git work tree's top folder when `init` ran, or `null` when there was none. */
	gitToplevel: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readMarker(root: string): Promise<ProjectMarker | null> {
	try {
		const read = await readFileSafely(root, MARKER_RELATIVE_PATH, {
			maxBytes: MAX_MARKER_BYTES,
		});
		if (read === null) {
			return null;
		}
		const parsed: unknown = JSON.parse(
			new TextDecoder().decode(read.bytes),
		);
		if (
			!isRecord(parsed) ||
			parsed.version !== MARKER_VERSION ||
			typeof parsed.projectId !== "string" ||
			!(
				parsed.gitToplevel === null ||
				typeof parsed.gitToplevel === "string"
			)
		) {
			return null;
		}
		return {
			version: MARKER_VERSION,
			projectId: parsed.projectId,
			gitToplevel: parsed.gitToplevel,
		};
	} catch {
		return null;
	}
}

export async function writeProjectMarker(
	root: string,
	marker: { projectId: string; gitToplevel: string | null },
): Promise<void> {
	const body: ProjectMarker = { version: MARKER_VERSION, ...marker };
	await writeFileSafely({
		root,
		relativePath: MARKER_RELATIVE_PATH,
		bytes: new TextEncoder().encode(`${JSON.stringify(body, null, 2)}\n`),
	});
}

/**
 * The project folder `start` is in or under: the nearest folder, going up,
 * that `init` marked. `null` when there is none.
 */
export async function findProjectRoot(
	start: string,
): Promise<{ root: string; marker: ProjectMarker } | null> {
	let current = path.resolve(start);
	for (;;) {
		const marker = await readMarker(current);
		if (marker !== null) {
			return { root: current, marker };
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

function comparable(folder: string): string {
	const resolved = path.resolve(folder);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
	return comparable(left) === comparable(right);
}

/** May the mirror use a git work tree whose top folder is `found`, given the marker and the root? */
export function gitToplevelIsTheProjects(
	marker: ProjectMarker,
	root: string,
	found: string,
): boolean {
	return marker.gitToplevel === null
		? samePath(found, root)
		: samePath(found, marker.gitToplevel);
}
