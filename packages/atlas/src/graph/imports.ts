/**
 * Dependency (import) extraction + resolution. Own, multi-language implementation
 * (the existing code-indexing symbol extractor captures NO relationships, so
 * there was nothing to reuse). Produces the edges that make this a graph.
 *
 * Approach: extract raw import specifiers per language, then resolve them to
 * repo-relative file keys. Relative specifiers resolve precisely; bare/aliased
 * specifiers fall back to a suffix match against the known file set (catches
 * monorepo path aliases like `@saas/...` without parsing every tsconfig).
 */
import { normalizePath } from "./languages";

const CODE_EXTENSIONS = [
	"ts",
	"tsx",
	"mts",
	"cts",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"py",
	"go",
	"rs",
	"java",
	"kt",
	"rb",
	"php",
	"cs",
	"c",
	"h",
	"cpp",
	"cc",
	"hpp",
	"swift",
	"scala",
	"vue",
	"svelte",
];

const TS_JS = [
	/\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
	/\bimport\s*['"]([^'"]+)['"]/g,
	/\bexport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
	/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
	/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const PY = [/^\s*from\s+([.\w]+)\s+import\b/gm, /^\s*import\s+([.\w]+)/gm];

const GO = [/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm];
// Go grouped imports: import ( "a" \n "b" ) — capture each quoted line.
const GO_GROUP = /import\s*\(([\s\S]*?)\)/g;
const GO_GROUP_LINE = /"([^"]+)"/g;

const JAVA = [/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm];
const RUBY = [/\brequire(?:_relative)?\s*\(?\s*['"]([^'"]+)['"]/g];
const PHP = [
	/^\s*use\s+([\w\\]+)\s*;/gm,
	/\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g,
];
const CSHARP = [/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm];
const C_CPP = [/^\s*#\s*include\s+["<]([^">]+)[">]/gm];

function collect(content: string, patterns: RegExp[]): string[] {
	const out: string[] = [];
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		let m: RegExpExecArray | null = pattern.exec(content);
		while (m !== null) {
			if (m[1]) {
				out.push(m[1]);
			}
			m = pattern.exec(content);
		}
	}
	return out;
}

/** Extract raw import specifiers from a file's content for its language. */
export function extractImports(
	content: string,
	language: string | null,
): string[] {
	switch (language) {
		case "TypeScript":
		case "JavaScript":
		case "Vue":
		case "Svelte":
			return collect(content, TS_JS);
		case "Python":
			return collect(content, PY);
		case "Go": {
			const specs = collect(content, GO);
			GO_GROUP.lastIndex = 0;
			let g: RegExpExecArray | null = GO_GROUP.exec(content);
			while (g !== null) {
				specs.push(...collect(g[1], [GO_GROUP_LINE]));
				g = GO_GROUP.exec(content);
			}
			return specs;
		}
		case "Java":
		case "Kotlin":
		case "Scala":
			return collect(content, JAVA);
		case "Ruby":
			return collect(content, RUBY);
		case "PHP":
			return collect(content, PHP);
		case "C#":
			return collect(content, CSHARP);
		case "C":
		case "C++":
			return collect(content, C_CPP);
		default:
			return [];
	}
}

function isRelativeSpec(spec: string): boolean {
	return (
		spec.startsWith("./") ||
		spec.startsWith("../") ||
		spec === "." ||
		spec === ".."
	);
}

function dirname(filePath: string): string {
	const i = filePath.lastIndexOf("/");
	return i === -1 ? "" : filePath.slice(0, i);
}

function normalizeJoin(base: string, rel: string): string {
	const parts = (base ? `${base}/${rel}` : rel).split("/");
	const stack: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") {
			continue;
		}
		if (part === "..") {
			stack.pop();
		} else {
			stack.push(part);
		}
	}
	return stack.join("/");
}

/** Candidate concrete file keys for a path that may omit its extension / be a dir. */
function candidatesFor(basePath: string): string[] {
	const candidates = [basePath];
	for (const ext of CODE_EXTENSIONS) {
		candidates.push(`${basePath}.${ext}`);
		candidates.push(`${basePath}/index.${ext}`);
		candidates.push(`${basePath}/__init__.${ext}`); // python packages
	}
	return candidates;
}

/**
 * The analysable file keys, indexed for {@link resolveImport}. Build it once
 * per graph: a bare specifier then costs one map lookup per candidate instead
 * of a scan of every key. Most imports in a large repo are external packages
 * that match nothing, so the scan ran to the end every time — on an 8.7k-file
 * monorepo that was tens of minutes of synchronous work on the worker's event
 * loop, long enough to starve its database connections.
 */
export interface FileKeyIndex {
	keys: ReadonlySet<string>;
	/** Each key's "/"-aligned suffixes of up to MAX_INDEXED_SUFFIX_SEGMENTS
	 * segments, the key itself included when it is that short, mapped to the
	 * first key in iteration order that ends with it. */
	bySuffix: ReadonlyMap<string, string>;
}

/**
 * Deepest suffix the index holds. Indexing every suffix would size the index
 * by total path segments, which a deliberately nested repository controls;
 * capping it keeps the index linear in the file count (MAX_FILES).
 */
const MAX_INDEXED_SUFFIX_SEGMENTS = 32;

export function indexFileKeys(fileKeys: Iterable<string>): FileKeyIndex {
	const keys = new Set(fileKeys);
	const bySuffix = new Map<string, string>();
	for (const key of keys) {
		// Walk slashes from the end: suffixes of 1, 2, … segments.
		let end = key.length;
		for (let n = 0; n < MAX_INDEXED_SUFFIX_SEGMENTS; n++) {
			const slash = end > 0 ? key.lastIndexOf("/", end - 1) : -1;
			const suffix = key.slice(slash + 1);
			if (!bySuffix.has(suffix)) {
				bySuffix.set(suffix, key);
			}
			if (slash === -1) {
				break;
			}
			end = slash;
		}
	}
	return { keys, bySuffix };
}

/** The first key that equals `cand` or ends with `/cand`, for candidates of
 * up to MAX_INDEXED_SUFFIX_SEGMENTS segments; a deeper candidate matches only
 * an exact key. The caller's later candidates (alias root dropped) still run. */
function lookupSuffix(index: FileKeyIndex, cand: string): string | undefined {
	const hit = index.bySuffix.get(cand);
	if (hit !== undefined) {
		return hit;
	}
	return index.keys.has(cand) ? cand : undefined;
}

/**
 * Resolve an import specifier to a repo-relative file key, or null if it is
 * external / unresolvable. `index` covers all analysable file keys.
 */
export function resolveImport(
	spec: string,
	fromPath: string,
	index: FileKeyIndex,
): string | null {
	const from = normalizePath(fromPath);

	if (isRelativeSpec(spec)) {
		const joined = normalizeJoin(dirname(from), spec);
		for (const cand of candidatesFor(joined)) {
			if (index.keys.has(cand)) {
				return cand;
			}
		}
		return null;
	}

	// Bare / aliased specifier: best-effort suffix match against the file set.
	// Strip a leading alias marker and convert dotted module paths to slashes.
	const cleaned = spec
		.replace(/^[@~]/, "")
		.replace(/\\/g, "/")
		.replace(/\./g, "/")
		.replace(/^\/+/, "");
	if (!cleaned || cleaned.length < 3) {
		return null;
	}
	// Drop the alias root (first segment) too, since `@saas/x` → look for `/saas/x`.
	const suffixes = [cleaned, cleaned.split("/").slice(1).join("/")].filter(
		(s) => s.length >= 3,
	);
	// A key matches when it equals the candidate or ends with `/candidate`;
	// the index holds the first such key per candidate, as the scan returned.
	for (const suffix of suffixes) {
		for (const cand of candidatesFor(suffix)) {
			const key = lookupSuffix(index, cand);
			if (key !== undefined) {
				return key;
			}
		}
	}
	return null;
}

// ── Namespace/package languages (C#, Java, …) ────────────────────────────────
// These import NAMESPACES, not file paths, so path resolution can't link them.
// We map each declared namespace to its module(s) and resolve `using`/`import`
// statements to module-level dependencies.

const NAMESPACE_DECL: Partial<Record<string, RegExp>> = {
	"C#": /\bnamespace\s+([\w.]+)/,
	Java: /^\s*package\s+([\w.]+)\s*;/m,
	Kotlin: /^\s*package\s+([\w.]+)/m,
	Scala: /^\s*package\s+([\w.]+)/m,
	PHP: /^\s*namespace\s+([\w\\]+)\s*;/m,
};

/** The namespace/package a file declares, normalised to dots, or null. */
export function extractNamespace(
	content: string,
	language: string | null,
): string | null {
	if (!language) {
		return null;
	}
	const pattern = NAMESPACE_DECL[language];
	if (!pattern) {
		return null;
	}
	const m = pattern.exec(content);
	return m ? m[1].replace(/\\/g, ".") : null;
}

/**
 * Resolve a namespace/package import to the module(s) that declare it, using a
 * longest-prefix match — handles C# `using Ns` (exact) and Java-style
 * `import pkg.Class` (where the last segment is a type, not a namespace).
 */
export function resolveNamespaceImport(
	spec: string,
	namespaceToModules: Map<string, Set<string>>,
): Set<string> | null {
	const segs = spec
		.replace(/\\/g, ".")
		.replace(/^[@~]/, "")
		.split(".")
		.filter(Boolean);
	for (let n = segs.length; n >= 1; n--) {
		const prefix = segs.slice(0, n).join(".");
		const mods = namespaceToModules.get(prefix);
		if (mods && mods.size > 0) {
			return mods;
		}
	}
	return null;
}
