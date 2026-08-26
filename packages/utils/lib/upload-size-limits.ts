export const UPLOAD_SIZE_LIMITS = {
	IMAGE: 10 * 1024 * 1024,
	SPREADSHEET: 10 * 1024 * 1024,
	DOCUMENT: 20 * 1024 * 1024,
	FILE: 20 * 1024 * 1024,
} as const;

export type UploadCategory = keyof typeof UPLOAD_SIZE_LIMITS;

export const formatSizeLimit = (bytes: number): string =>
	`${Math.round(bytes / (1024 * 1024))}MB maximum`;

// `resolveUploadCategory` used to live here — a MIME-prefix classifier that
// every upload surface shared. It was removed with Fizzy #2139: its last two
// callers moved to `resolveContextUploadCategory`, which reads the context
// surface's own allowlist, and keeping a second classifier that disagreed with
// that allowlist for `image/svg+xml` (IMAGE here, FILE there) was the shape of
// drift this repo's accept-and-validation convention exists to prevent. A
// surface that needs a category derives it from its own vocabulary.
