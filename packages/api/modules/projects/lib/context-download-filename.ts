/**
 * Pure helper to compute a deterministic, filesystem-safe filename for a
 * project context download. See spec §4.3 and §13.1 in
 * `docs/specs/2026-04-15-download-project-context-files/spec.md`.
 *
 * No I/O, no database access — safe to unit test in isolation and to reuse
 * from both the single-file and batch download procedures.
 */

/** Maximum slug stem length before the extension is appended. */
const MAX_STEM_LENGTH = 80;

/** Empty-title fallback stem, per spec §4.3 rule 5. */
const FALLBACK_STEM = "context";

/**
 * Narrow mapping from common IANA mime types to file extensions, used as a
 * Class A fallback when `originalFilename` does not carry an extension. The
 * ultimate fallback is `.bin`.
 */
const MIME_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
	"application/pdf": "pdf",
	"application/msword": "doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		"docx",
	"application/vnd.ms-excel": "xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.ms-powerpoint": "ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		"pptx",
	"application/json": "json",
	"application/zip": "zip",
	"text/plain": "txt",
	"text/markdown": "md",
	"text/csv": "csv",
	"text/html": "html",
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/svg+xml": "svg",
	"image/webp": "webp",
};

export type ContextDownloadClass = "A" | "B" | "C";

export interface ContextDownloadFilenameArgs {
	title: string | null;
	class: ContextDownloadClass;
	originalFilename?: string | null;
	mimeType?: string | null;
	integration?: string | null;
}

/**
 * Normalize a free-text title to a filesystem-safe slug per spec §4.3:
 * lowercase, non-`[a-z0-9]` → single hyphen, trim, collapse repeated hyphens,
 * empty fallback to `"context"`, then truncate to 80 characters.
 */
function slugifyTitle(title: string | null): string {
	const source = (title ?? "").toLowerCase();
	// Replace any run of non-[a-z0-9] with a single hyphen.
	let slug = source.replace(/[^a-z0-9]+/g, "-");
	// Collapse repeated hyphens (paranoia — the regex above already does this,
	// but keep the rule explicit for readability and future-proofing).
	slug = slug.replace(/-+/g, "-");
	// Trim leading / trailing hyphens.
	slug = slug.replace(/^-+|-+$/g, "");
	if (slug.length === 0) {
		slug = FALLBACK_STEM;
	}
	if (slug.length > MAX_STEM_LENGTH) {
		slug = slug.slice(0, MAX_STEM_LENGTH);
	}
	return slug;
}

/** Extract a lowercase extension (without the leading dot) from a filename. */
function extensionFromFilename(
	filename: string | null | undefined,
): string | null {
	if (!filename) {
		return null;
	}
	const dot = filename.lastIndexOf(".");
	if (dot === -1 || dot === filename.length - 1) {
		return null;
	}
	const ext = filename.slice(dot + 1).toLowerCase();
	// Defensive: only allow simple alnum extensions to avoid path oddities.
	if (!/^[a-z0-9]+$/.test(ext)) {
		return null;
	}
	return ext;
}

/** Resolve a Class A extension using originalFilename → mimeType → `bin`. */
function resolveClassAExtension(
	originalFilename: string | null | undefined,
	mimeType: string | null | undefined,
): string {
	const fromFilename = extensionFromFilename(originalFilename);
	if (fromFilename) {
		return fromFilename;
	}
	if (mimeType) {
		const mapped = MIME_TYPE_EXTENSIONS[mimeType.toLowerCase()];
		if (mapped) {
			return mapped;
		}
	}
	return "bin";
}

/**
 * Build the download filename for a single project context. Pure function —
 * deterministic given its inputs.
 */
export function contextDownloadFilename(
	args: ContextDownloadFilenameArgs,
): string {
	const stem = slugifyTitle(args.title);

	switch (args.class) {
		case "A": {
			// Preserve the original uploaded filename when available (spec §4.4 —
			// Class A entries in the ZIP mirror the source object exactly). Strip
			// any path separators and leading dots/underscores for safety against
			// traversal-like names (e.g. `../etc/passwd`).
			const original = args.originalFilename?.trim();
			if (original) {
				const safe = original
					.replace(/[\\/]+/g, "_")
					.replace(/^[._]+/, "");
				if (safe.length > 0) {
					return safe;
				}
			}
			const ext = resolveClassAExtension(
				args.originalFilename,
				args.mimeType,
			);
			return `${stem}.${ext}`;
		}
		case "B": {
			return `${stem}.md`;
		}
		case "C": {
			const integration = args.integration?.trim();
			if (integration) {
				const integrationSlug = slugifyTitle(integration);
				return `${stem}-${integrationSlug}.txt`;
			}
			return `${stem}.txt`;
		}
	}
}
