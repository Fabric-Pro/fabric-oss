/**
 * Technical-graph builder. Pure + deterministic (unit-testable): given the set
 * of analysable source files, produce MODULE + FILE nodes and CONTAINS / IMPORTS
 * / DEPENDS_ON edges.
 *
 * Scale strategy: file-level graphs explode on a large monorepo, so modules are
 * grouped at a directory depth chosen to keep the module count bounded
 * (`maxModules`). FILE nodes are still emitted (children of their module) for
 * drill-down + per-file description, but the canvas renders modules by default.
 *
 * Memory strategy: the produced graph stores only compact aggregates (per-module
 * counts) and compact per-file metadata (hash, ≤1500-char preview, metrics, raw
 * import specifiers) — never full file content. The streaming entry point
 * (`buildTechnicalGraphStreaming`) therefore reads ONE file's content at a time,
 * extracts that compact contribution, and releases the content before reading
 * the next file, so peak memory scales with the GRAPH size (bounded by
 * `maxModules` + the file count + the preview cap), not with total source size.
 * `buildTechnicalGraph(FileRecord[])` is a thin in-memory wrapper over the
 * streaming core so existing callers/tests keep byte-identical behaviour.
 */
import type { GraphNodeMetrics } from "../types";
import { hashContent } from "./hash";
import {
	extractImports,
	extractNamespace,
	resolveImport,
	resolveNamespaceImport,
} from "./imports";
import { countLoc, detectLanguage, normalizePath } from "./languages";

export interface FileRecord {
	/** repo-relative posix path */
	path: string;
	/** file content, already secret-redacted */
	content: string;
	/** optional pre-detected language; detected from extension if omitted */
	language?: string | null;
}

interface BuiltNode {
	key: string;
	kind: "MODULE" | "FILE";
	label: string;
	filePath: string | null;
	language: string | null;
	parentKey: string | null;
	contentHash: string | null;
	/** Capped, redacted content snippet (FILE nodes) — context for on-demand AI describe + chat. */
	contentPreview: string | null;
	/** Non-AI structural summary; immediate value + fallback before/without AI description. */
	structuralDescription: string;
	metrics: GraphNodeMetrics;
}

/** Max characters of file content stored as a preview snippet. */
const CONTENT_PREVIEW_CHARS = 1500;

/**
 * Take the leading `CONTENT_PREVIEW_CHARS` of a file's content as a STANDALONE
 * string. `String.prototype.slice` returns a V8 "SlicedString" that keeps a
 * reference to the ENTIRE parent string, so a naive `content.slice(0, N)` would
 * pin every large source file (up to 256 KiB each) in memory via its tiny
 * preview — silently re-coupling peak memory to total source size and defeating
 * the streaming design. Rebuilding the substring from its UTF-16 code units
 * (`split("").join("")`) forces a fresh, detached copy so the full content can be
 * garbage-collected once we move to the next file. Unlike a Buffer round-trip,
 * this preserves the EXACT code units (a surrogate pair split at the preview
 * boundary is kept verbatim), so the value is byte-identical to the plain slice.
 */
function detachedPreview(content: string): string {
	return content.slice(0, CONTENT_PREVIEW_CHARS).split("").join("");
}

interface BuiltEdge {
	source: string;
	target: string;
	kind: "CONTAINS" | "IMPORTS" | "DEPENDS_ON";
	weight: number;
}

export interface BuiltTechnicalGraph {
	nodes: BuiltNode[];
	edges: BuiltEdge[];
	moduleDepth: number;
	/**
	 * The `path → contentHash` manifest for every file that contributed a node.
	 * Built for free during the single content pass so the caller can run
	 * incremental change detection without re-reading/re-hashing source.
	 */
	manifest: Record<string, string>;
}

const DEFAULT_MAX_MODULES = 120;

const ROOT_MODULE = "(root)";

function moduleKeyFor(filePath: string, depth: number): string {
	const segs = filePath.split("/");
	const dirSegs = segs.slice(0, -1);
	if (dirSegs.length === 0) {
		return ROOT_MODULE;
	}
	return dirSegs.slice(0, depth).join("/");
}

function fileName(filePath: string): string {
	return filePath.slice(filePath.lastIndexOf("/") + 1);
}

function moduleLabel(moduleKey: string): string {
	if (moduleKey === ROOT_MODULE) {
		return "(root)";
	}
	return moduleKey.slice(moduleKey.lastIndexOf("/") + 1);
}

/** Largest directory depth whose distinct-module count still fits `maxModules`. */
function selectModuleDepthFromPaths(
	paths: string[],
	maxModules: number,
): number {
	let chosen = 1;
	for (let depth = 1; depth <= 12; depth++) {
		const keys = new Set(
			paths.map((p) => moduleKeyFor(normalizePath(p), depth)),
		);
		if (keys.size <= maxModules) {
			chosen = depth;
		} else {
			break;
		}
	}
	return chosen;
}

const SYMBOL_HINT =
	/\b(function|class|interface|enum|struct|trait|def|fn|func|type)\b/g;

function countSymbols(content: string): number {
	const matches = content.match(SYMBOL_HINT);
	return matches ? matches.length : 0;
}

export interface BuildOptions {
	maxModules?: number;
	/**
	 * Resumability for the (long) streaming parse. `seed` supplies already-parsed
	 * per-file metadata from a durable checkpoint — those files skip the expensive
	 * re-parse and are reused verbatim. `onExtracted` is awaited with each batch of
	 * NEWLY parsed files so the caller can persist them and heartbeat. The holistic
	 * assembly still runs over the COMPLETE file set either way, so the resulting
	 * graph is byte-identical whether or not a checkpoint was used.
	 */
	checkpoint?: {
		seed?: ReadonlyMap<string, FileMeta>;
		onExtracted?: (batch: FileMeta[]) => Promise<void>;
		batchSize?: number;
	};
}

/**
 * Lazily read one file's (already secret-redacted) content for the given
 * repo-relative path, or `null` if the file is missing / unreadable / over the
 * size cap (in which case it is dropped from the graph, exactly as a file the
 * collector never materialised). MUST return the SAME redacted string the
 * in-memory path would hold, since every per-file metric (hash, preview, LOC,
 * symbols, namespace, imports) is derived from it.
 */
export type ReadSource = (path: string) => string | null;

/**
 * Compact, content-FREE per-file record retained across the build. Holds only
 * bounded metadata (hash 40 chars, preview ≤1500 chars, a handful of short
 * import specifiers, a few ints) — never the full file content — so the working
 * set scales with the file count, not with total source size.
 */
export interface FileMeta {
	path: string;
	language: string;
	namespace: string | null;
	loc: number;
	symbolCount: number;
	contentHash: string;
	contentPreview: string;
	importSpecs: string[];
}

/**
 * Streaming technical-graph builder — the memory-bounded core. Reads each source
 * file's content EXACTLY ONCE via `readSource`, extracts its compact
 * contribution, and releases the content before the next read, so peak memory is
 * bounded by the graph (modules + files + previews), never by total source size.
 *
 * Produces output byte-identical to feeding the same files through
 * `buildTechnicalGraph(FileRecord[])`: same node/edge set, ordering, metrics,
 * previews, hashes, and module depth. The only behavioural contract is that the
 * surviving set (files with a detectable language AND non-null `readSource`)
 * matches what the in-memory path would have kept — `collectFiles` already drops
 * unreadable/oversized files before they reach the in-memory builder, so the
 * activity passes only paths whose content it could read.
 *
 * @param filePaths  candidate repo-relative source paths, in collection order.
 * @param readSource lazy, redacted content reader (see {@link ReadSource}).
 */
/** Yield mask — pause the streaming parse every (mask + 1) scanned files. */
const STREAM_YIELD_MASK = 0x3f;

/**
 * Hand control back to the event loop so the enclosing Temporal activity's
 * heartbeat interval can fire between bursts of synchronous parsing. Prefers
 * Node's `setImmediate`, falling back to `setTimeout` in non-Node runtimes.
 */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof setImmediate === "function") {
			setImmediate(resolve);
		} else {
			setTimeout(resolve, 0);
		}
	});
}

export async function buildTechnicalGraphStreaming(
	filePaths: string[],
	readSource: ReadSource,
	options: BuildOptions = {},
): Promise<BuiltTechnicalGraph> {
	const maxModules = options.maxModules ?? DEFAULT_MAX_MODULES;

	// ── Pass A: the ONLY content-reading pass. Read one file at a time, derive
	// its compact contribution, then drop the content reference. Files with no
	// detectable language or no readable content are skipped — matching the
	// in-memory builder's `.filter(language !== null)` and `collectFiles`'
	// read-failure `continue`. Order is preserved so all downstream Map/array
	// iteration (and thus node/edge ordering) is identical to the array path.
	const seed = options.checkpoint?.seed;
	const onExtracted = options.checkpoint?.onExtracted;
	const batchSize = Math.max(1, options.checkpoint?.batchSize ?? 256);

	const metas: FileMeta[] = [];
	const manifest: Record<string, string> = {};
	let scanned = 0;
	// Newly-parsed files awaiting a durable checkpoint flush (resumability).
	let pending: FileMeta[] = [];
	for (const rawPath of filePaths) {
		// Punctuate the parse so the enclosing activity keeps heartbeating. Reading
		// + parsing thousands of files is otherwise one long synchronous block that
		// starves `withHeartbeat`'s timer and can trip the activity's heartbeat
		// timeout on a very large repo. Yielding every few dozen files is
		// output-neutral (same files, same order) and costs only sub-millisecond
		// pauses spread across the run.
		if ((scanned++ & STREAM_YIELD_MASK) === 0) {
			await yieldToEventLoop();
		}
		const path = normalizePath(rawPath);
		// Resume: a checkpointed extraction for this exact path (captured at the
		// same commit) is byte-identical to re-parsing the file, so reuse it and
		// skip the expensive read + parse. Order is preserved — we still walk
		// `filePaths` in collection order, slotting the cached meta in place — so
		// the assembled graph is identical to a from-scratch run.
		const cached = seed?.get(path);
		if (cached !== undefined) {
			metas.push(cached);
			manifest[path] = cached.contentHash;
			continue;
		}
		const language = detectLanguage(path);
		if (language === null) {
			continue;
		}
		const content = readSource(rawPath);
		if (content === null) {
			continue;
		}
		const contentHash = hashContent(content);
		const meta: FileMeta = {
			path,
			language,
			namespace: extractNamespace(content, language),
			loc: countLoc(content),
			symbolCount: countSymbols(content),
			contentHash,
			contentPreview: detachedPreview(content),
			importSpecs: extractImports(content, language),
		};
		metas.push(meta);
		manifest[path] = contentHash;
		// Stream the freshly-parsed file out for durable checkpointing so a
		// mid-parse worker death only loses the in-flight batch — the retry reloads
		// the rest as `seed`. `content` goes out of scope at the end of this
		// iteration, released before the next read (only one file ever live).
		if (onExtracted) {
			pending.push(meta);
			if (pending.length >= batchSize) {
				await onExtracted(pending);
				pending = [];
			}
		}
	}
	if (onExtracted && pending.length > 0) {
		await onExtracted(pending);
	}

	return assembleGraph(metas, manifest, maxModules);
}

/**
 * Build the nodes + edges from the compact per-file metadata. Pure + content-free
 * — every step below mirrors `buildTechnicalGraph`'s aggregation/emission exactly,
 * just sourced from `FileMeta` (precomputed) instead of re-reading content.
 */
async function assembleGraph(
	files: FileMeta[],
	manifest: Record<string, string>,
	maxModules: number,
): Promise<BuiltTechnicalGraph> {
	const fileKeys = new Set(files.map((f) => f.path));
	const depth = selectModuleDepthFromPaths(
		files.map((f) => f.path),
		maxModules,
	);

	const nodes: BuiltNode[] = [];
	const edges: BuiltEdge[] = [];

	// Aggregates per module.
	interface ModuleAgg {
		fileCount: number;
		loc: number;
		symbolCount: number;
		languages: Map<string, number>;
	}
	const modules = new Map<string, ModuleAgg>();
	// file -> module key, for mapping import edges to module dependencies.
	const fileToModule = new Map<string, string>();
	// dependentCount: how many files import a given file.
	const dependentCount = new Map<string, number>();
	// Aggregated module dependency weights.
	const moduleDeps = new Map<string, number>(); // "src|>dst" -> weight
	// declared namespace/package -> module(s) that declare it (C#, Java, …).
	const namespaceToModules = new Map<string, Set<string>>();

	// Assembly re-walks the COMPLETE file set several times (module aggregation,
	// import-edge resolution, file-node emission). On a large repo (thousands of
	// files) that synchronous work can run longer than the enclosing activity's
	// heartbeat timeout, starving the auto-heartbeat timer until it trips. So —
	// exactly as Pass A does for the read/parse loop — punctuate the heavy passes
	// with a brief yield so the heartbeat can fire mid-assembly. A single shared
	// counter keeps the cadence at one short pause per (mask + 1) processed items.
	// Output-neutral: the same nodes/edges are produced in the same order; the
	// yield only releases the event loop between iterations.
	let assembled = 0;
	for (const file of files) {
		if ((assembled++ & STREAM_YIELD_MASK) === 0) {
			await yieldToEventLoop();
		}
		const moduleKey = moduleKeyFor(file.path, depth);
		fileToModule.set(file.path, moduleKey);
		const namespace = file.namespace;
		if (namespace) {
			let set = namespaceToModules.get(namespace);
			if (!set) {
				set = new Set();
				namespaceToModules.set(namespace, set);
			}
			set.add(moduleKey);
		}
		let agg = modules.get(moduleKey);
		if (!agg) {
			agg = {
				fileCount: 0,
				loc: 0,
				symbolCount: 0,
				languages: new Map(),
			};
			modules.set(moduleKey, agg);
		}
		const loc = file.loc;
		const symbolCount = file.symbolCount;
		agg.fileCount++;
		agg.loc += loc;
		agg.symbolCount += symbolCount;
		if (file.language) {
			agg.languages.set(
				file.language,
				(agg.languages.get(file.language) ?? 0) + 1,
			);
		}
	}

	// Import edges (file -> file) + module dependency aggregation.
	const seenFileEdge = new Set<string>();
	const importCounts = new Map<string, number>();
	for (const file of files) {
		// Keep the heartbeat alive through edge resolution (the heaviest pass).
		if ((assembled++ & STREAM_YIELD_MASK) === 0) {
			await yieldToEventLoop();
		}
		const specs = file.importSpecs;
		importCounts.set(file.path, specs.length);
		const fromModule = fileToModule.get(file.path);
		for (const spec of specs) {
			const target = resolveImport(spec, file.path, fileKeys);
			if (!target || target === file.path) {
				// Namespace/package import (C#, Java, …): resolve to module
				// dependency edge(s) since there's no concrete file to link.
				if (!target && fromModule) {
					const targetModules = resolveNamespaceImport(
						spec,
						namespaceToModules,
					);
					if (targetModules) {
						for (const toModule of targetModules) {
							if (toModule !== fromModule) {
								const depKey = `${fromModule}|>${toModule}`;
								moduleDeps.set(
									depKey,
									(moduleDeps.get(depKey) ?? 0) + 1,
								);
							}
						}
					}
				}
				continue;
			}
			const edgeKey = `${file.path}|>${target}`;
			if (!seenFileEdge.has(edgeKey)) {
				seenFileEdge.add(edgeKey);
				edges.push({
					source: file.path,
					target,
					kind: "IMPORTS",
					weight: 1,
				});
				dependentCount.set(
					target,
					(dependentCount.get(target) ?? 0) + 1,
				);
			}
			const toModule = fileToModule.get(target);
			if (fromModule && toModule && fromModule !== toModule) {
				const depKey = `${fromModule}|>${toModule}`;
				moduleDeps.set(depKey, (moduleDeps.get(depKey) ?? 0) + 1);
			}
		}
	}

	// Emit MODULE nodes.
	for (const [moduleKey, agg] of modules) {
		const primaryLanguage =
			[...agg.languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
			null;
		const label = moduleLabel(moduleKey);
		nodes.push({
			key: moduleKey,
			kind: "MODULE",
			label,
			filePath: moduleKey === ROOT_MODULE ? null : moduleKey,
			language: primaryLanguage,
			parentKey: null,
			contentHash: null,
			contentPreview: null,
			structuralDescription: `Module "${label}" — ${agg.fileCount} file${
				agg.fileCount === 1 ? "" : "s"
			}, ~${agg.loc} LOC${primaryLanguage ? `, primarily ${primaryLanguage}` : ""}.`,
			metrics: {
				fileCount: agg.fileCount,
				loc: agg.loc,
				symbolCount: agg.symbolCount,
			},
		});
	}

	// Emit FILE nodes (children of their module).
	for (const file of files) {
		// Keep the heartbeat alive through file-node emission too.
		if ((assembled++ & STREAM_YIELD_MASK) === 0) {
			await yieldToEventLoop();
		}
		const moduleKey = fileToModule.get(file.path) ?? ROOT_MODULE;
		const fileLoc = file.loc;
		const fileSymbols = file.symbolCount;
		const fileImports = importCounts.get(file.path) ?? 0;
		const fileDependents = dependentCount.get(file.path) ?? 0;
		nodes.push({
			key: file.path,
			kind: "FILE",
			label: fileName(file.path),
			filePath: file.path,
			language: file.language ?? null,
			parentKey: moduleKey,
			contentHash: file.contentHash,
			contentPreview: file.contentPreview,
			structuralDescription: `${file.language ?? "Source"} file — ${fileLoc} LOC, ${fileSymbols} symbol${
				fileSymbols === 1 ? "" : "s"
			}, ${fileImports} import${fileImports === 1 ? "" : "s"}, used by ${fileDependents} file${
				fileDependents === 1 ? "" : "s"
			}.`,
			metrics: {
				loc: fileLoc,
				symbolCount: fileSymbols,
				importCount: fileImports,
				dependentCount: fileDependents,
			},
		});
		// CONTAINS edge module -> file.
		edges.push({
			source: moduleKey,
			target: file.path,
			kind: "CONTAINS",
			weight: 1,
		});
	}

	// Emit aggregated module DEPENDS_ON edges.
	for (const [depKey, weight] of moduleDeps) {
		const [source, target] = depKey.split("|>");
		edges.push({ source, target, kind: "DEPENDS_ON", weight });
	}

	return { nodes, edges, moduleDepth: depth, manifest };
}

/**
 * In-memory technical-graph builder. Thin wrapper over the streaming core:
 * filters to files with a detectable language (preserving order) and serves
 * their already-redacted content from memory. Output is byte-identical to the
 * streaming path. Retained for existing callers/tests that already hold a fully
 * materialised `FileRecord[]`; the memory-bounded analysis path uses
 * `buildTechnicalGraphStreaming` directly to avoid holding all content at once.
 */
export function buildTechnicalGraph(
	rawFiles: FileRecord[],
	options: BuildOptions = {},
): Promise<BuiltTechnicalGraph> {
	// Serve content from the in-memory records. The streaming core re-derives the
	// language filter itself (detectLanguage on the path), so the only mapping
	// needed here is path -> content. A file whose provided `language` is null but
	// whose path IS detectable would, in the old code, have been kept (it used
	// `f.language ?? detectLanguage(path)`); serving by path preserves that.
	const contentByPath = new Map<string, string>();
	const paths: string[] = [];
	for (const f of rawFiles) {
		const path = normalizePath(f.path);
		// Last-writer-wins on duplicate paths, matching the array builder where a
		// later FileRecord's content is what the final FILE-node pass would read.
		contentByPath.set(path, f.content);
		paths.push(f.path);
	}
	return buildTechnicalGraphStreaming(
		paths,
		(p) => contentByPath.get(normalizePath(p)) ?? null,
		options,
	);
}
