/**
 * The MIME type and the `isText` RENDERING hint a registered file row carries,
 * decided from its extension alone.
 *
 * Moved into `@repo/instructions` so repository sync (`@repo/temporal`) types
 * its files with the same table as uploads: `packages/api` cannot be imported
 * from the Temporal worker, and two copies of this table would silently
 * disagree about what a `.mdc` is, showing up as one file of a snapshot
 * rendering as a download link while its siblings render as markdown.
 *
 * `isText` is a hint for the reader UI (markdown vs preformatted vs "this is
 * a binary file") and nothing else. It is NOT a security decision and no gate
 * may branch on it: this allowlist calls `.env`, `.pem` and `.npmrc` binary,
 * and the secret scan reading it that way is precisely how those files once
 * reached durable storage unscanned. `verifyAndScanInstructionFiles` reads
 * every object and decides text vs binary from the bytes themselves.
 *
 * Neither is this the `@repo/instructions` `classifyPath` taxonomy, which
 * drives `kind`. This decides transport and rendering; that decides meaning.
 */
const TEXT_EXTENSIONS = new Set([
	"md",
	"mdc",
	"mdx",
	"txt",
	"json",
	"jsonl",
	"yaml",
	"yml",
	"toml",
	"sh",
	"bash",
	"zsh",
	"py",
	"js",
	"mjs",
	"cjs",
	"ts",
	"ps1",
	"rb",
	"pl",
	"html",
	"css",
	"csv",
	"xml",
	"gitignore",
	"gitattributes",
	"fabricignore",
]);

const MIME: Record<string, string> = {
	md: "text/markdown",
	mdc: "text/markdown",
	mdx: "text/markdown",
	txt: "text/plain",
	json: "application/json",
	jsonl: "application/x-ndjson",
	yaml: "application/yaml",
	yml: "application/yaml",
	toml: "application/toml",
	sh: "text/x-shellscript",
	bash: "text/x-shellscript",
	zsh: "text/x-shellscript",
	py: "text/x-python",
	js: "text/javascript",
	mjs: "text/javascript",
	cjs: "text/javascript",
	ts: "text/typescript",
	ps1: "text/plain",
	html: "text/html",
	css: "text/css",
	csv: "text/csv",
	xml: "application/xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	svg: "image/svg+xml",
	pdf: "application/pdf",
};

/**
 * The extension of a POSIX-relative path, lowercased and without its dot. A
 * dotfile with no further dot (`.gitignore`) reports its own name, which is
 * how the tables above reach it.
 */
function extensionOf(path: string): string {
	const base = path.slice(path.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	return dot >= 0
		? base.slice(dot + 1).toLowerCase()
		: base.startsWith(".")
			? base.slice(1).toLowerCase()
			: "";
}

/** The `{ mimeType, isText }` pair a file row is registered with. */
export function fileTypingFor(path: string): {
	mimeType: string;
	isText: boolean;
} {
	const ext = extensionOf(path);
	return {
		mimeType: MIME[ext] ?? "application/octet-stream",
		// An extension-less file (`Makefile`, `LICENSE`) is treated as text
		// for RENDERING; the gate still decides from the bytes.
		isText: TEXT_EXTENSIONS.has(ext) || ext === "",
	};
}
