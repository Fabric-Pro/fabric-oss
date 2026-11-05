import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
	SKILL_IMPORT_MAX_BYTES,
	type SkillImportCandidate,
	type SkillImportPreview,
	skillImportSourceSchema,
} from "@repo/ai/skill-authoring-contracts";
import { SkillError } from "@repo/ai/skill-contracts";
import { parseDocument } from "yaml";
import { type Entry, fromBuffer, type ZipFile } from "yauzl";
import type { z } from "zod";

const MAX_FILES = 128;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_MARKDOWN = 128 * 1024;
const digest = (data: Buffer) =>
	createHash("sha256").update(data).digest("hex");
export interface SkillPackageEntry {
	path: string;
	data: Buffer;
}
export interface ParsedSkillPackage {
	preview: SkillImportPreview;
	entries: SkillPackageEntry[];
}
function refused(message: string): never {
	throw new SkillError("BAD_REQUEST", message);
}
export function safeSkillPackagePath(path: string) {
	if (
		!path ||
		path.length > 512 ||
		path.includes("\\") ||
		[...path].some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) ||
		path.startsWith("/") ||
		/^[A-Za-z]:/.test(path) ||
		path
			.split("/")
			.some(
				(x, i, a) =>
					x === "." || x === ".." || (!x && i < a.length - 1),
			) ||
		path.split("/").length > 16
	) {
		refused("The skill package contains an unsafe file path.");
	}
	return path;
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let i = 0; i < 8; i++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return c >>> 0;
});
function crc32(bytes: Buffer) {
	let crc = 0xffffffff;
	for (const b of bytes) {
		crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 255];
	}
	return (crc ^ 0xffffffff) >>> 0;
}
/** Read metadata first so a repository imports skill directories, not unrelated files. */
async function unzip(
	bytes: Buffer,
	repository = false,
): Promise<SkillPackageEntry[]> {
	const zip = await new Promise<ZipFile>((resolve, reject) =>
		fromBuffer(
			bytes,
			{
				lazyEntries: true,
				autoClose: false,
				validateEntrySizes: true,
				strictFileNames: true,
			},
			(error, archive) => {
				if (error || !archive) {
					reject(
						new SkillError(
							"BAD_REQUEST",
							"This is not a valid ZIP skill bundle.",
						),
					);
				} else {
					resolve(archive);
				}
			},
		),
	);
	try {
		if (zip.entryCount > 1024) {
			refused(
				"This archive has too many entries. Upload a smaller skill bundle.",
			);
		}
		const metadata = await new Promise<Entry[]>((resolve, reject) => {
			const rows: Entry[] = [];
			const seen = new Set<string>();
			zip.on("error", reject);
			zip.on("end", () => resolve(rows));
			zip.on("entry", (entry: Entry) => {
				try {
					const path = safeSkillPackagePath(entry.fileName);
					const normalized = path.replace(/\/$/, "").toLowerCase();
					if (seen.has(normalized)) {
						refused(
							"The skill package contains duplicate file paths.",
						);
					}
					seen.add(normalized);
					rows.push(entry);
					zip.readEntry();
				} catch (error) {
					reject(error);
				}
			});
			zip.readEntry();
		});
		// Include even a symlink SKILL.md as a root so it is rejected rather than followed.
		const roots = metadata
			.filter((e) => posix.basename(e.fileName) === "SKILL.md")
			.map((e) => posix.dirname(e.fileName));
		const selected = repository
			? metadata.filter((e) =>
					roots.some(
						(folder) =>
							folder === "." ||
							e.fileName.startsWith(`${folder}/`),
					),
				)
			: metadata;
		const files: SkillPackageEntry[] = [];
		let total = 0;
		for (const entry of selected) {
			const path = entry.fileName;
			if (
				entry.isEncrypted() ||
				![0, 8].includes(entry.compressionMethod) ||
				((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
			) {
				refused(
					"Encrypted files, symbolic links and unsupported ZIP compression inside a skill are not accepted. Upload a regular-file skill bundle.",
				);
			}
			if (path.endsWith("/")) {
				continue;
			}
			if (
				path
					.split("/")
					.some(
						(p) =>
							[".git", ".aws", ".ssh"].includes(
								p.toLowerCase(),
							) || /^\.env(?:\.|$)/i.test(p),
					) ||
				/^(?:id_rsa|id_ed25519|credentials)$/i.test(
					posix.basename(path),
				)
			) {
				refused(
					"Remove credential files from the skill package before importing it.",
				);
			}
			if (
				files.length >= (repository ? 512 : MAX_FILES) ||
				!Number.isSafeInteger(entry.uncompressedSize) ||
				entry.uncompressedSize < 0 ||
				entry.uncompressedSize > MAX_FILE ||
				total + entry.uncompressedSize > MAX_TOTAL
			) {
				refused(
					"This bundle exceeds the import limits: 128 files per skill, 2 MiB per file and 20 MiB expanded. Upload one smaller skill bundle.",
				);
			}
			if (
				entry.uncompressedSize > 1024 * 1024 &&
				entry.uncompressedSize > Math.max(1, entry.compressedSize) * 200
			) {
				refused(
					"The archive expands beyond the supported compression ratio.",
				);
			}
			const data = await new Promise<Buffer>((resolve, reject) =>
				zip.openReadStream(entry, (error, stream) => {
					if (error || !stream) {
						reject(error);
						return;
					}
					const chunks: Buffer[] = [];
					let size = 0;
					stream.on("error", reject);
					stream.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > MAX_FILE || total + size > MAX_TOTAL) {
							stream.destroy();
							reject(
								new SkillError(
									"BAD_REQUEST",
									"The expanded skill archive exceeds its limits.",
								),
							);
							return;
						}
						chunks.push(chunk);
					});
					stream.on("end", () => resolve(Buffer.concat(chunks)));
				}),
			);
			if (
				data.length !== entry.uncompressedSize ||
				crc32(data) !== entry.crc32 >>> 0
			) {
				refused("The skill archive contains a corrupt file.");
			}
			total += data.length;
			files.push({ path, data });
		}
		return files;
	} catch (error) {
		if (error instanceof SkillError) {
			throw error;
		}
		throw new SkillError(
			"BAD_REQUEST",
			"The skill archive is invalid or corrupt.",
		);
	} finally {
		zip.close();
	}
}
export function skillPackageContentType(path: string) {
	const ext = posix.extname(path).toLowerCase();
	return (
		(
			{
				".md": "text/markdown",
				".txt": "text/plain",
				".json": "application/json",
				".yaml": "application/yaml",
				".yml": "application/yaml",
				".js": "application/javascript",
				".ts": "application/typescript",
				".py": "text/x-python",
				".sh": "text/x-shellscript",
				".html": "text/html",
				".css": "text/css",
				".svg": "image/svg+xml",
				".png": "image/png",
				".jpg": "image/jpeg",
				".jpeg": "image/jpeg",
				".webp": "image/webp",
				".pdf": "application/pdf",
				".csv": "text/csv",
			} as Record<string, string>
		)[ext] ?? "application/octet-stream"
	);
}
function parseSkill(
	entry: SkillPackageEntry,
	entries: SkillPackageEntry[],
): SkillImportCandidate {
	if (entry.data.length > MAX_MARKDOWN) {
		refused("SKILL.md must be smaller than 128 KiB.");
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(entry.data);
	} catch {
		refused("SKILL.md must contain valid UTF-8 text.");
	}
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match || Buffer.byteLength(match[1]) > 16384) {
		refused(
			"SKILL.md needs YAML frontmatter with name and description. You can create a skill from scratch to convert a plain document.",
		);
	}
	let metadata: Record<string, unknown>;
	try {
		const doc = parseDocument(match[1], { uniqueKeys: true });
		if (doc.errors.length || doc.warnings.length) {
			throw Error();
		}
		const value = doc.toJS({ maxAliasCount: 0 });
		if (!value || Array.isArray(value) || typeof value !== "object") {
			throw Error();
		}
		metadata = value;
	} catch {
		refused(
			"The SKILL.md frontmatter must be a simple valid YAML mapping without aliases or custom tags.",
		);
	}
	if (
		typeof metadata.name !== "string" ||
		!metadata.name.trim() ||
		metadata.name.length > 200 ||
		typeof metadata.description !== "string" ||
		!metadata.description.trim() ||
		metadata.description.length > 4000
	) {
		refused(
			"SKILL.md needs a name (up to 200 characters) and description (up to 4,000 characters).",
		);
	}
	const content = text.slice(match[0].length).trim();
	if (!content) {
		refused("SKILL.md needs instructions after its frontmatter.");
	}
	const slug = metadata.name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 100)
		.replace(/-$/, "");
	if (!slug) {
		refused("The imported skill needs a name that can form a URL slug.");
	}
	const folder = posix.dirname(entry.path);
	const prefix = folder === "." ? "" : `${folder}/`;
	const nested = entries.filter(
		(x) =>
			x.path.startsWith(prefix) &&
			x.path !== entry.path &&
			!entries.some(
				(other) =>
					other.path !== entry.path &&
					posix.basename(other.path) === "SKILL.md" &&
					posix.dirname(other.path) !== folder &&
					posix.dirname(other.path).startsWith(prefix) &&
					x.path.startsWith(`${posix.dirname(other.path)}/`),
			),
	);
	if (nested.length > MAX_FILES) {
		refused(
			"This skill exceeds the 128-file limit. Upload a smaller selected skill bundle.",
		);
	}
	const files = nested.map((x) => ({
		path: safeSkillPackagePath(x.path.slice(prefix.length)),
		contentType: skillPackageContentType(x.path),
		sizeBytes: x.data.length,
		sha256: digest(x.data),
	}));
	const warnings = [
		"Importing stores files; it does not execute scripts or grant access to tools, credentials, documents or data.",
	];
	if (
		Object.keys(metadata).some(
			(x) => !["name", "description", "metadata"].includes(x),
		)
	) {
		warnings.push(
			"Custom permissions, dependencies and runtime hooks in frontmatter are not applied. Review the instructions and files before publication.",
		);
	}
	if (files.some((x) => /\.(?:sh|py|js|ts|ps1|exe|bat)$/i.test(x.path))) {
		warnings.push(
			"This bundle contains code files. Review them before making the skill available to your organization.",
		);
	}
	return {
		key: entry.path,
		draft: {
			name: metadata.name.trim(),
			slug,
			description: metadata.description.trim(),
			content,
			tags: [],
		},
		files,
		warnings,
	};
}
async function boundedResponse(
	response: Response,
	limit: number,
): Promise<Buffer> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) {
		await response.body?.cancel();
		refused(
			"The repository archive is too large. Download and upload one smaller skill bundle.",
		);
	}
	const reader = response.body?.getReader();
	if (!reader) {
		refused("The repository returned no content.");
	}
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) {
				break;
			}
			size += next.value.byteLength;
			if (size > limit) {
				await reader.cancel();
				refused(
					"The repository archive is too large. Download and upload one smaller skill bundle.",
				);
			}
			chunks.push(Buffer.from(next.value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}
export async function readSkillPackage(
	raw: z.infer<typeof skillImportSourceSchema>,
	fetcher: typeof fetch = fetch,
): Promise<ParsedSkillPackage> {
	const source = skillImportSourceSchema.parse(raw);
	let bytes: Buffer;
	let entries: SkillPackageEntry[];
	let provenance: SkillImportPreview["source"];
	if (source.kind === "file") {
		if (
			!/\.(?:md|zip|skill)$/i.test(source.fileName) ||
			source.fileName.includes("/") ||
			source.fileName.includes("\\")
		) {
			refused(
				"Upload SKILL.md, a Markdown skill, .zip or .skill bundle.",
			);
		}
		if (source.base64.length % 4 !== 0) {
			refused("The uploaded file encoding is invalid.");
		}
		bytes = Buffer.from(source.base64, "base64");
		if (bytes.toString("base64") !== source.base64) {
			refused("The uploaded file encoding is invalid.");
		}
		if (!bytes.length || bytes.length > SKILL_IMPORT_MAX_BYTES) {
			refused("Skill packages must be no larger than 8 MiB.");
		}
		entries = /\.md$/i.test(source.fileName)
			? [{ path: "SKILL.md", data: bytes }]
			: await unzip(bytes);
		provenance = {
			kind: "file",
			fileName: source.fileName,
			sha256: digest(bytes),
		};
	} else {
		const url = new URL(source.url);
		const parts = url.pathname
			.replace(/\/$/, "")
			.replace(/\.git$/, "")
			.split("/")
			.filter(Boolean);
		if (
			url.protocol !== "https:" ||
			url.hostname !== "github.com" ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			parts.length !== 2 ||
			parts.some(
				(p) => !/^[-A-Za-z0-9_.]+$/.test(p) || [".", ".."].includes(p),
			)
		) {
			refused(
				"Use a public HTTPS GitHub repository URL without credentials, query parameters or a subfolder.",
			);
		}
		if (
			source.ref &&
			(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,149}$/.test(source.ref) ||
				source.ref.split("/").some((p) => p === "." || p === ".."))
		) {
			refused("Use a valid branch, tag or commit reference.");
		}
		const repo = parts.join("/");
		const options = {
			redirect: "error" as const,
			signal: AbortSignal.timeout(20000),
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "Fabric-Skill-Importer",
			},
		};
		let commit: string;
		try {
			const response = await fetcher(
				`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(source.ref ?? "HEAD")}`,
				options,
			);
			if (!response.ok) {
				throw Error();
			}
			const body = JSON.parse(
				(await boundedResponse(response, 256 * 1024)).toString("utf8"),
			);
			if (
				typeof body.sha !== "string" ||
				!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(body.sha)
			) {
				throw Error();
			}
			commit = body.sha;
		} catch (error) {
			if (error instanceof SkillError) {
				throw error;
			}
			throw new SkillError(
				"SERVICE_UNAVAILABLE",
				"The public repository could not be read. Check the URL and reference, or upload a skill bundle. Private repository authentication is not available in this import flow.",
			);
		}
		try {
			const response = await fetcher(
				`https://codeload.github.com/${repo}/zip/${commit}`,
				options,
			);
			if (!response.ok) {
				throw Error();
			}
			bytes = await boundedResponse(response, SKILL_IMPORT_MAX_BYTES);
		} catch (error) {
			if (error instanceof SkillError) {
				throw error;
			}
			throw new SkillError(
				"SERVICE_UNAVAILABLE",
				"The repository archive could not be downloaded. Try uploading the selected skill bundle.",
			);
		}
		entries = await unzip(bytes, true);
		provenance = {
			kind: "github",
			repository: `https://github.com/${repo}`,
			commit,
			sha256: digest(bytes),
		};
	}
	const definitions = entries.filter(
		(e) => posix.basename(e.path) === "SKILL.md",
	);
	if (!definitions.length) {
		refused("No SKILL.md was found in this package.");
	}
	if (definitions.length > 30) {
		refused("This package has too many skills. Import a smaller bundle.");
	}
	const candidates: SkillImportCandidate[] = [];
	const warnings: string[] =
		source.kind === "github"
			? [
					"Only files within skill folders are imported. Unrelated repository files and links are excluded; links within a skill are never followed.",
				]
			: [];
	for (const definition of definitions) {
		try {
			candidates.push(parseSkill(definition, entries));
		} catch (error) {
			if (source.kind !== "github" || !(error instanceof SkillError)) {
				throw error;
			}
			warnings.push(`Skipped ${definition.path}: ${error.message}`);
		}
	}
	if (!candidates.length) {
		refused(
			warnings.at(-1) ?? "No importable skill was found in this package.",
		);
	}
	return { preview: { source: provenance, candidates, warnings }, entries };
}
