/**
 * Keeping the project's rules in step with Fabric, as files in the project.
 *
 * Claude Code reads `.claude/rules/**.md` of the project folder, recursively;
 * a plugin cannot ship rules. So the rules of the instructions are written
 * into `.claude/rules/fabric-<id>/` (the plugin's name), and nothing outside
 * that folder is ever created, changed or removed.
 *
 * The folder carries a marker, `.fabric-managed.json`, mapping each file this
 * module wrote to the sha256 of what it wrote. That is what makes a refresh
 * safe on a folder people also work in:
 *
 *   - a file whose bytes still match the marker is Fabric's: it is rewritten
 *     when the rule changed, and deleted when the rule is gone;
 *   - a file that differs from the marker was edited by the person: it is
 *     kept, reported, and from then on no longer managed;
 *   - a file the marker does not know is the person's own: it is never
 *     overwritten (unless it already holds exactly the wanted bytes);
 *   - a rule whose destination the project's own git tracks is the project's
 *     own file: it is skipped.
 *
 * Every path goes through the same guarded writer as the rest of this CLI
 * (`safe-write.ts`): no symlinked component, nothing resolving outside the
 * root, atomic writes, sha-guarded deletes. Rule bytes, frontmatter included,
 * are written exactly as the instructions hold them.
 */
import { createHash } from "node:crypto";
import { rmdir } from "node:fs/promises";
import path from "node:path";
import { checkRelativePath } from "../instructions/paths.js";
import {
	assertWritableTarget,
	deleteFileSafely,
	readFileSafely,
	writeFileSafely,
} from "../instructions/safe-write.js";
import { pluginNameFor } from "./layout.js";
import { capRules, type ProjectRule } from "./rules.js";

const MARKER_NAME = ".fabric-managed.json";
const MARKER_VERSION = 1;
const MAX_MARKER_BYTES = 256 * 1024;
const MAX_RULE_READ_BYTES = 2 * 1024 * 1024;

/** The folder of a project's rules, relative to the project root. */
export function rulesFolderFor(projectId: string): string {
	return `.claude/rules/${pluginNameFor(projectId)}`;
}

type KeptReason = "edited" | "not-managed" | "unsafe";
type SkippedReason = "tracked" | "unsafe-path";

export interface RulesSyncResult {
	written: string[];
	removed: string[];
	unchanged: number;
	/** Files left as they are, with the reason. */
	kept: Array<{ path: string; reason: KeptReason }>;
	skipped: Array<{ path: string; reason: SkippedReason }>;
	/** Rules beyond the caps. */
	omitted: number;
	/** The deadline passed before every rule was handled. */
	timedOut: boolean;
	/** Why nothing was done at all (the folder cannot be used). */
	refused: string | null;
}

const sha256 = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

type Managed = Record<string, string>;

async function readMarker(root: string, folder: string): Promise<Managed> {
	try {
		const read = await readFileSafely(root, `${folder}/${MARKER_NAME}`, {
			maxBytes: MAX_MARKER_BYTES,
		});
		if (read === null) {
			return {};
		}
		const parsed: unknown = JSON.parse(
			new TextDecoder().decode(read.bytes),
		);
		const files = (parsed as { files?: unknown } | null)?.files;
		if (
			(parsed as { version?: unknown } | null)?.version !==
				MARKER_VERSION ||
			typeof files !== "object" ||
			files === null ||
			Array.isArray(files)
		) {
			return {};
		}
		const managed: Managed = {};
		for (const [file, hash] of Object.entries(files)) {
			if (
				typeof hash === "string" &&
				/^[0-9a-f]{64}$/.test(hash) &&
				checkRelativePath(file).ok
			) {
				managed[file] = hash;
			}
		}
		return managed;
	} catch {
		// A marker that cannot be read manages nothing: every file is the
		// person's until proven otherwise.
		return {};
	}
}

async function writeMarker(
	root: string,
	folder: string,
	managed: Managed,
): Promise<void> {
	const sorted = Object.fromEntries(
		Object.entries(managed).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		),
	);
	await writeFileSafely({
		root,
		relativePath: `${folder}/${MARKER_NAME}`,
		bytes: new TextEncoder().encode(
			`${JSON.stringify({ version: MARKER_VERSION, files: sorted }, null, 2)}\n`,
		),
		mode: 0o644,
	});
}

/** Delete the marker (when it is there) and the folders it leaves empty. */
async function removeMarker(root: string, folder: string): Promise<void> {
	const relative = `${folder}/${MARKER_NAME}`;
	const current = await readFileSafely(root, relative, {
		maxBytes: MAX_MARKER_BYTES,
	});
	if (current !== null) {
		await deleteFileSafely(root, relative, sha256(current.bytes));
	}
	await pruneEmpty(root, folder, MARKER_NAME);
}

/** Remove now-empty folders below `folder`, deepest first; the folder itself too when empty. */
async function pruneEmpty(
	root: string,
	folder: string,
	file: string,
): Promise<void> {
	const parts = file.split("/").slice(0, -1);
	for (let depth = parts.length; depth >= 0; depth--) {
		const relative = [folder, ...parts.slice(0, depth)].join("/");
		try {
			await rmdir(path.join(root, relative));
		} catch {
			return;
		}
	}
}

/**
 * Bring `.claude/rules/fabric-<id>/` to exactly `rules`.
 *
 * `root` must be an already-canonical project folder (`resolveExistingRoot`).
 * `tracked` holds the paths, relative to the rules folder, that the project's
 * own git tracks. Never throws for a file it cannot handle: that file is
 * reported and the rest continue.
 */
export async function syncProjectRules(input: {
	root: string;
	projectId: string;
	rules: readonly ProjectRule[];
	tracked?: ReadonlySet<string>;
	/** `Date.now()` value after which no further file is touched. */
	deadline?: number;
}): Promise<RulesSyncResult> {
	const folder = rulesFolderFor(input.projectId);
	const { kept: wanted, omitted } = capRules(input.rules);
	const result: RulesSyncResult = {
		written: [],
		removed: [],
		unchanged: 0,
		kept: [],
		skipped: [],
		omitted,
		timedOut: false,
		refused: null,
	};
	const folderCheck = await assertWritableTarget(
		input.root,
		`${folder}/${MARKER_NAME}`,
	);
	if (!folderCheck.ok) {
		result.refused = `${folder} cannot be used (${folderCheck.reason}: ${folderCheck.detail})`;
		return result;
	}

	const previous = await readMarker(input.root, folder);
	const next: Managed = {};
	const expired = () =>
		input.deadline !== undefined && Date.now() > input.deadline;

	const handled = new Set<string>();
	for (const rule of wanted) {
		const relative = rule.path;
		if (!checkRelativePath(relative).ok || relative === MARKER_NAME) {
			result.skipped.push({ path: relative, reason: "unsafe-path" });
			continue;
		}
		handled.add(relative);
		if (input.tracked?.has(relative)) {
			result.skipped.push({ path: relative, reason: "tracked" });
			continue;
		}
		if (expired()) {
			result.timedOut = true;
			if (previous[relative] !== undefined) {
				next[relative] = previous[relative];
			}
			continue;
		}
		const target = `${folder}/${relative}`;
		const wantedHash = sha256(rule.bytes);
		try {
			const check = await assertWritableTarget(input.root, target);
			if (!check.ok) {
				result.kept.push({ path: relative, reason: "unsafe" });
				continue;
			}
			const existing = await readFileSafely(input.root, target, {
				maxBytes: MAX_RULE_READ_BYTES,
			}).catch(() => "unreadable" as const);
			if (existing === "unreadable") {
				result.kept.push({ path: relative, reason: "unsafe" });
				continue;
			}
			if (existing === null) {
				await writeFileSafely({
					root: input.root,
					relativePath: target,
					bytes: rule.bytes,
					mode: 0o644,
				});
				result.written.push(relative);
				next[relative] = wantedHash;
				continue;
			}
			const currentHash = sha256(existing.bytes);
			if (currentHash === wantedHash) {
				result.unchanged++;
				next[relative] = wantedHash;
			} else if (previous[relative] === currentHash) {
				await writeFileSafely({
					root: input.root,
					relativePath: target,
					bytes: rule.bytes,
					mode: 0o644,
				});
				result.written.push(relative);
				next[relative] = wantedHash;
			} else {
				result.kept.push({
					path: relative,
					reason:
						previous[relative] === undefined
							? "not-managed"
							: "edited",
				});
			}
		} catch {
			result.kept.push({ path: relative, reason: "unsafe" });
		}
	}

	for (const [relative, hash] of Object.entries(previous)) {
		if (handled.has(relative)) {
			continue;
		}
		if (expired()) {
			result.timedOut = true;
			next[relative] = hash;
			continue;
		}
		try {
			const outcome = await deleteFileSafely(
				input.root,
				`${folder}/${relative}`,
				hash,
			);
			if (outcome === "modified") {
				result.kept.push({ path: relative, reason: "edited" });
			} else {
				if (outcome === "deleted") {
					result.removed.push(relative);
				}
				await pruneEmpty(input.root, folder, relative);
			}
		} catch {
			result.kept.push({ path: relative, reason: "unsafe" });
		}
	}

	const changed =
		JSON.stringify(Object.entries(next).sort()) !==
		JSON.stringify(Object.entries(previous).sort());
	try {
		if (Object.keys(next).length > 0) {
			if (changed) {
				await writeMarker(input.root, folder, next);
			}
		} else if (Object.keys(previous).length > 0) {
			await removeMarker(input.root, folder);
		}
	} catch {
		result.refused = `${folder}/${MARKER_NAME} could not be updated`;
	}
	return result;
}

/** The lines the sync tells the person, empty when nothing happened worth saying. */
export function rulesSyncLines(result: RulesSyncResult): string[] {
	const lines: string[] = [];
	if (result.refused !== null) {
		lines.push(`rules not synced: ${result.refused}.`);
	}
	if (result.written.length > 0 || result.removed.length > 0) {
		lines.push(
			`rules: ${result.written.length} written, ${result.removed.length} removed.`,
		);
	}
	for (const entry of result.kept) {
		lines.push(
			entry.reason === "edited"
				? `rules: kept ${entry.path}, which you edited; it is no longer updated from Fabric.`
				: entry.reason === "not-managed"
					? `rules: kept ${entry.path}, which is your own file at that path.`
					: `rules: left ${entry.path} alone because it could not be written safely.`,
		);
	}
	for (const entry of result.skipped) {
		lines.push(
			entry.reason === "tracked"
				? `rules: skipped ${entry.path}, which this project's own git tracks.`
				: `rules: skipped ${entry.path}: not a path Fabric will write.`,
		);
	}
	if (result.omitted > 0) {
		lines.push(
			`rules: ${result.omitted} more rule files were not delivered automatically (limit: 64 files or 256 KiB). Load fabric-instruction-access to find their original paths and read mapped local copies or available text through the project's Fabric MCP tools.`,
		);
	}
	if (result.timedOut) {
		lines.push(
			"rules: ran out of time; the rest follow at the next session.",
		);
	}
	return lines;
}
