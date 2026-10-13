/**
 * Which download a project or company context gets, shared by the server
 * procedures that sign the download and the context list that labels it.
 *
 *   - Class A — an uploaded file: the original object is signed as it was
 *     uploaded, under its original filename.
 *   - Class B — pulled or written text: a Markdown file is built from the
 *     extracted `content`.
 *   - Class C — code: a plain-text file is built the same way.
 *
 * Client-safe on purpose: the list once kept its own copy of the Class A set,
 * and when the server added `API_SPEC` the copy did not follow, so an uploaded
 * OpenAPI file was offered as "extracted text" in Markdown, PDF or Word and its
 * PDF item printed the raw JSON. One function on both sides cannot drift.
 */

export type ContextDownloadClass = "A" | "B" | "C";

/**
 * Classify a context by its `type` string. The input is structural so callers
 * need no Prisma enum.
 */
export function classifyContext(ctx: { type: string }): ContextDownloadClass {
	switch (ctx.type) {
		// Class A — binary / original-file downloads served via signed URL.
		case "FILE":
		case "IMAGE":
		case "DOCUMENT":
		case "SPREADSHEET":
		// An API spec is an uploaded file that happens to be indexed by endpoint.
		// Without this it falls to the defensive `default` and downloads as
		// synthesized Markdown — so uploading `petstore.yaml` and pressing
		// Download would stop returning `petstore.yaml`, purely as a side effect
		// of the type changing at ingestion.
		case "API_SPEC":
			return "A";

		// Class B — synthesized Markdown (pulled text + free-text planning).
		case "TEXT":
		case "TECH_STACK":
		case "FEATURES":
		case "GOALS":
		case "DESCRIPTION":
		case "LINK":
		case "INTEGRATION":
		case "MEETING_TRANSCRIPT":
			return "B";

		// Class C — code-specific synthesized text.
		case "CODE_FILE":
		case "CODE_FILE_SUMMARY":
			return "C";

		default:
			// Defensive default: unknown future types ship as Class B Markdown.
			return "B";
	}
}
