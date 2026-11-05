/**
 * Choosing the icon an MCP server lists for itself in the initialize
 * handshake (`serverInfo.icons`, MCP 2025-06-18), and deciding whether to
 * store it as the server's `MCPServer.iconUrl`.
 *
 * Pure: no I/O. The write, with its ownership and permission checks, is in
 * `apps/web/app/api/mcp/test-connection/record-server-icon.ts`.
 */

/** An entry of `serverInfo.icons`, as the MCP SDK parses it. */
export type McpServerIconEntry = {
	src: string;
	mimeType?: string;
	sizes?: string[];
	/** The background the icon is designed for, per the MCP spec. */
	theme?: "light" | "dark";
};

/** A `data:image/` icon larger than this is refused rather than stored. */
export const MAX_DATA_IMAGE_ICON_LENGTH = 32 * 1024;

/** The smallest raster icon worth storing for a 40px (2x: 80px) tile. */
const MIN_RASTER_ICON_SIZE = 64;

const DATA_IMAGE_PATTERN =
	/^data:image\/(?:png|jpeg|webp|gif|svg\+xml)(?:;[a-z0-9=._-]+)*,/i;

/**
 * Only `https:` URLs, and small `data:image/` URLs of a common image type.
 * Everything else (`http:`, `javascript:`, `file:`, `blob:`, a relative path,
 * `data:text/html`) is refused, so nothing the server names can run or
 * downgrade the page.
 */
export function isAcceptableIconSrc(src: unknown): src is string {
	if (typeof src !== "string" || src.length === 0) {
		return false;
	}
	if (src.toLowerCase().startsWith("data:")) {
		return (
			src.length <= MAX_DATA_IMAGE_ICON_LENGTH &&
			DATA_IMAGE_PATTERN.test(src)
		);
	}
	try {
		return new URL(src).protocol === "https:";
	} catch {
		return false;
	}
}

function isSvg(icon: McpServerIconEntry): boolean {
	const mime = icon.mimeType?.toLowerCase();
	if (mime) {
		return mime === "image/svg+xml";
	}
	const src = icon.src.toLowerCase();
	if (src.startsWith("data:")) {
		return src.startsWith("data:image/svg+xml");
	}
	try {
		return new URL(src).pathname.endsWith(".svg");
	} catch {
		return false;
	}
}

/** The largest square edge in `sizes` ("128x128", "256x256"); 0 when unknown or "any". */
function largestEdge(icon: McpServerIconEntry): number {
	let largest = 0;
	for (const size of icon.sizes ?? []) {
		const match = /^(\d+)x(\d+)$/i.exec(size.trim());
		if (match) {
			largest = Math.max(
				largest,
				Math.min(Number(match[1]), Number(match[2])),
			);
		}
	}
	return largest;
}

/**
 * Fabric draws every MCP server icon on a white tile, in both color themes
 * (`McpServerIcon`), so an icon made for a light background comes first, and
 * one made for a dark background (often a white mark) only when nothing else
 * is listed.
 */
function themeRank(icon: McpServerIconEntry): number {
	if (icon.theme === undefined) {
		return 0;
	}
	if (icon.theme === "light") {
		return 1;
	}
	return 2;
}

/**
 * The one icon to store, or null when the server lists none Fabric accepts.
 *
 * Order, by the background it suits the white tile:
 * 1. a theme-neutral SVG;
 * 2. an SVG for a light background;
 * 3. the largest PNG/raster of at least 64px, theme-neutral or light first;
 * 4. an SVG for a dark background, then the largest such raster.
 */
export function selectServerProvidedIcon(
	icons: readonly McpServerIconEntry[] | null | undefined,
): string | null {
	if (!Array.isArray(icons)) {
		return null;
	}
	const usable = icons.filter(
		(icon): icon is McpServerIconEntry =>
			!!icon &&
			typeof icon === "object" &&
			isAcceptableIconSrc(icon.src) &&
			(icon.theme === undefined ||
				icon.theme === "light" ||
				icon.theme === "dark"),
	);

	const svgFor = (rank: number) =>
		usable.find((icon) => isSvg(icon) && themeRank(icon) === rank);
	const rasterFor = (ranks: number[]) =>
		usable
			.filter(
				(icon) =>
					!isSvg(icon) &&
					ranks.includes(themeRank(icon)) &&
					largestEdge(icon) >= MIN_RASTER_ICON_SIZE,
			)
			.sort(
				(a, b) =>
					largestEdge(b) - largestEdge(a) ||
					themeRank(a) - themeRank(b),
			)[0];

	const chosen =
		svgFor(0) ??
		svgFor(1) ??
		rasterFor([0, 1]) ??
		svgFor(2) ??
		rasterFor([2]);
	return chosen?.src ?? null;
}

function originOf(url: string | null | undefined): string | null {
	if (!url) {
		return null;
	}
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:"
			? parsed.origin
			: null;
	} catch {
		return null;
	}
}

/**
 * Whether a stored `iconUrl` came from the server itself, so a later
 * handshake may replace it. True when any of these holds:
 * - it is a `data:image/` URL;
 * - it shares the origin of the server's URL;
 * - it shares the origin of `serverInfo.websiteUrl` from the same handshake
 *   (a site that serves its MCP on its own host, such as mcp.example.com,
 *   lists its icons on the company origin, example.com);
 * - it is one of the icon `src`s the server lists now.
 *
 * ASSUMPTION: no person can set `MCPServer.iconUrl` today. Neither the
 * registry create nor update procedure accepts it (a test in
 * `packages/api/modules/mcp/procedures/__tests__/registry-icon-url-not-user-settable.test.ts`
 * fails if one starts to), and system and catalog icons are never written
 * here. The `data:image/` rule depends on that. If people can upload or
 * enter an icon later, store a marker of who set it alongside, so that a
 * reconnect never overwrites a person's choice.
 */
export function isServerProvidedIconUrl(params: {
	storedIconUrl: string;
	serverUrl: string | null | undefined;
	websiteUrl: string | null | undefined;
	icons: readonly McpServerIconEntry[] | null | undefined;
}): boolean {
	const { storedIconUrl, serverUrl, websiteUrl, icons } = params;
	if (storedIconUrl.toLowerCase().startsWith("data:image/")) {
		return true;
	}
	if (
		Array.isArray(icons) &&
		icons.some((icon) => icon?.src === storedIconUrl)
	) {
		return true;
	}
	const storedOrigin = originOf(storedIconUrl);
	if (!storedOrigin) {
		return false;
	}
	return (
		storedOrigin === originOf(serverUrl) ||
		storedOrigin === originOf(websiteUrl)
	);
}

/**
 * The `iconUrl` to write after a handshake, or null to leave it alone:
 * - nothing acceptable listed: leave it;
 * - nothing stored: store the chosen icon;
 * - stored icon came from the server (`isServerProvidedIconUrl`): refresh it;
 * - stored icon is from anywhere else: never overwrite it;
 * - unchanged: no write.
 */
export function decideServerIconWrite(params: {
	storedIconUrl: string | null | undefined;
	serverUrl: string | null | undefined;
	websiteUrl: string | null | undefined;
	icons: readonly McpServerIconEntry[] | null | undefined;
}): string | null {
	const chosen = selectServerProvidedIcon(params.icons);
	if (!chosen) {
		return null;
	}
	const stored = params.storedIconUrl?.trim() || null;
	if (stored === chosen) {
		return null;
	}
	if (!stored) {
		return chosen;
	}
	return isServerProvidedIconUrl({
		storedIconUrl: stored,
		serverUrl: params.serverUrl,
		websiteUrl: params.websiteUrl,
		icons: params.icons,
	})
		? chosen
		: null;
}
