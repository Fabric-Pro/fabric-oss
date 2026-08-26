import "server-only";
import {
	listPublicNewsletterArchive,
	type NewsletterContent,
	newsletterContentSchema,
	resolveProjectByEmbedToken,
} from "@repo/database";
import { logger } from "@repo/logs";

/** A release-note row with `content` validated to the canonical, typed shape. */
export type PublicReleaseNote = {
	id: string;
	status: string;
	createdAt: Date;
	content: NewsletterContent;
};

/** Latest N releases the per-project embed widget renders. Mirrors the public
 * /release-notes archive (SENT/PARTIAL only — enforced by the query). */
const EMBED_RELEASE_LIMIT = 5;

/**
 * A SENT/PARTIAL row's `content` is a raw Prisma `Json` value with NO runtime
 * validation — a malformed row (e.g. non-string headline, or highlights holding
 * `[null]`) would crash the unauthenticated embed render. Validate centrally
 * against the canonical schema (the same one that produces/persists content) and
 * return the row with the PARSED, typed content so callers never touch the raw
 * Json; a row that fails validation yields `null` (filtered from the list).
 * Mirrors `public-release-notes.ts`'s `toRenderableNote`.
 */
function toRenderableNote(send: {
	id: string;
	status: string;
	createdAt: Date;
	content: unknown;
}): PublicReleaseNote | null {
	const parsed = newsletterContentSchema.safeParse(send.content);
	if (!parsed.success) {
		return null;
	}
	return {
		id: send.id,
		status: send.status,
		createdAt: send.createdAt,
		content: parsed.data,
	};
}

/**
 * Server-only data helper for the per-project embed widget (`/embed/release-notes`).
 * Resolves the opaque embed `token` to a project server-side (NEVER from client
 * input — the token IS the tenant bound) and returns its latest validated release
 * sends together with the widget's presentation config.
 *
 *  - Unknown/empty token → `null` (the embed page renders nothing / 404). The
 *    archive query is NOT run.
 *  - Widget disabled → `{ enabled: false, sends: [] }` plus the stored
 *    presentation (the page can still honor theme/accent for a graceful
 *    "widget off" state). The archive query is NOT run.
 *  - Enabled → up to `EMBED_RELEASE_LIMIT` SENT/PARTIAL sends (status filtering is
 *    done by `listPublicNewsletterArchive`), each validated against
 *    `newsletterContentSchema`; malformed rows are dropped. No internal columns
 *    leak — the query already projects a public-safe shape. A DB failure (or all
 *    rows malformed) degrades to `{ enabled: true, sends: [] }` rather than
 *    throwing into the unauthenticated iframe — mirrors `public-release-notes.ts`.
 *
 * NOTE: an ENABLED widget with zero renderable sends is a VALID state
 * (`{ enabled: true, sends: [] }`), not an error/404 — the embed page (Task 10)
 * must render an empty-state for it. Only an unknown token yields `null`.
 */
export async function getEmbedReleaseNotes(token: string): Promise<{
	enabled: boolean;
	sends: PublicReleaseNote[];
	theme: string | null;
	accent: string | null;
	config: Record<string, unknown> | null;
} | null> {
	// Do NOT wrap the resolve in try/catch: an unknown token must stay `null`, and
	// a resolve failure is a hard misconfiguration we should not silently mask.
	const proj = await resolveProjectByEmbedToken(token);
	if (!proj) {
		return null;
	}
	// The write side stores config as `z.record(z.string(), z.unknown()).nullable()`,
	// so the resolved Json column is a record-or-null; surface that typed shape.
	const config = (proj.config ?? null) as Record<string, unknown> | null;
	if (!proj.publicWidgetEnabled) {
		return {
			enabled: false,
			sends: [],
			theme: proj.theme,
			accent: proj.accent,
			config,
		};
	}
	// Degrade a DB blip to an empty (but enabled) feed: a thrown error here would
	// 500 the unauthenticated embed iframe. Mirrors public-release-notes.ts.
	let rows: Awaited<ReturnType<typeof listPublicNewsletterArchive>>;
	try {
		rows = await listPublicNewsletterArchive(proj.projectId, {
			limit: EMBED_RELEASE_LIMIT,
			offset: 0,
		});
	} catch (err) {
		logger.error(
			"embed release-notes archive query failed; serving empty",
			err,
		);
		rows = [];
	}
	const sends = rows
		.map(toRenderableNote)
		.filter((n): n is PublicReleaseNote => n !== null);
	return {
		enabled: true,
		sends,
		theme: proj.theme,
		accent: proj.accent,
		config,
	};
}
