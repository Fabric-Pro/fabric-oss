/**
 * Language detection + file filtering for the analysis walk.
 *
 * Own implementation (modelled on the code-indexing walker, not imported) so
 * the Atlas feature can tune which files it considers structurally
 * meaningful independently of the search indexer.
 */

/** Max file size we read for graph building / description context. */
export const MAX_ANALYZED_FILE_BYTES = 256 * 1024; // 256 KB

const EXTENSION_LANGUAGE: Record<string, string> = {
	ts: "TypeScript",
	tsx: "TypeScript",
	mts: "TypeScript",
	cts: "TypeScript",
	js: "JavaScript",
	jsx: "JavaScript",
	mjs: "JavaScript",
	cjs: "JavaScript",
	py: "Python",
	pyi: "Python",
	go: "Go",
	rs: "Rust",
	java: "Java",
	kt: "Kotlin",
	kts: "Kotlin",
	rb: "Ruby",
	php: "PHP",
	cs: "C#",
	c: "C",
	h: "C",
	cpp: "C++",
	cc: "C++",
	hpp: "C++",
	cxx: "C++",
	swift: "Swift",
	scala: "Scala",
	sql: "SQL",
	sh: "Shell",
	bash: "Shell",
	vue: "Vue",
	svelte: "Svelte",
};

/** Directories we never descend into during analysis. */
const SKIP_DIR_SEGMENTS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	".turbo",
	".cache",
	"coverage",
	"vendor",
	"__pycache__",
	".venv",
	"venv",
	".idea",
	".vscode",
	"target", // rust/java build
	"bin",
	"obj",
	".terraform",
	"generated",
]);

const SKIP_FILE_SUFFIXES = [
	".min.js",
	".min.css",
	".map",
	".lock",
	".snap",
	".d.ts",
];

const NON_CODE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"svg",
	"ico",
	"bmp",
	"webp",
	"mp3",
	"mp4",
	"wav",
	"avi",
	"mov",
	"pdf",
	"zip",
	"tar",
	"gz",
	"rar",
	"7z",
	"exe",
	"dll",
	"so",
	"dylib",
	"woff",
	"woff2",
	"ttf",
	"eot",
	"bin",
	"wasm",
	"ipynb",
	"csv",
	"parquet",
]);

function extensionOf(filePath: string): string {
	const base = filePath.slice(filePath.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Posix-normalise a path (forward slashes, no leading "./"). */
export function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Returns true if any path segment is a directory we skip. */
export function isInSkippedDir(filePath: string): boolean {
	return normalizePath(filePath)
		.split("/")
		.some((seg) => SKIP_DIR_SEGMENTS.has(seg));
}

/** Human-readable language for a path, or null if not a recognised source file. */
export function detectLanguage(filePath: string): string | null {
	return EXTENSION_LANGUAGE[extensionOf(filePath)] ?? null;
}

/**
 * Whether a file should be treated as analysable source code (gets a FILE node
 * and participates in import edges). Non-code/binary/generated files are skipped.
 */
export function isAnalyzableSource(filePath: string): boolean {
	const normalized = normalizePath(filePath);
	if (isInSkippedDir(normalized)) {
		return false;
	}
	if (SKIP_FILE_SUFFIXES.some((s) => normalized.endsWith(s))) {
		return false;
	}
	const ext = extensionOf(normalized);
	if (!ext || NON_CODE_EXTENSIONS.has(ext)) {
		return false;
	}
	return detectLanguage(normalized) !== null;
}

/** Count of non-empty lines (a cheap LOC metric). */
export function countLoc(content: string): number {
	let loc = 0;
	for (const line of content.split("\n")) {
		if (line.trim().length > 0) {
			loc++;
		}
	}
	return loc;
}
