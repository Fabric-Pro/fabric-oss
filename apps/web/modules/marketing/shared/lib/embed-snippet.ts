/**
 * Normalize a free-form width to the SAME invariant the embed page enforces
 * (`resolveReleaseWidgetParams`): either `"100%"` or a clamped integer 280..640.
 * `publicWidgetConfig` is stored unvalidated, so a saved width like
 * `640" onload="x` or `100%;}</style>` must never reach the style attribute raw.
 * `parseInt` stops at the first non-digit, so any payload collapses to a bare
 * integer (then clamped) or falls back to `"100%"` — guaranteeing only `"100%"`
 * or `"<int>px"` can be emitted. Returns the css value (style attr) + the query
 * value (URL) separately so both are normalized identically.
 */
function normalizeSnippetWidth(w?: string): { css: string; query: string } {
	if (!w || w === "100%") {
		return { css: "100%", query: "100%" };
	}
	const n = Number.parseInt(w, 10);
	if (!Number.isFinite(n)) {
		return { css: "100%", query: "100%" };
	}
	const clamped = Math.min(640, Math.max(280, n));
	return { css: `${clamped}px`, query: String(clamped) };
}

/**
 * Build the copy-paste iframe snippet for the per-project release-notes widget.
 * Only the access token plus the whitelisted theming params provided by the
 * caller are emitted; absent options are omitted from the query string.
 * `URLSearchParams` URL-encodes values (e.g. an accent `#` becomes `%23`).
 *
 * @param baseUrl Trusted origin only (e.g. getBaseUrl()) — NEVER an end-user-supplied value; it is interpolated raw into the iframe src.
 */
export function buildReleaseWidgetSnippet(
	baseUrl: string,
	opts: {
		token: string;
		theme?: string;
		accent?: string;
		font?: string;
		radius?: number;
		width?: string;
		density?: string;
	},
): string {
	const origin = baseUrl.replace(/\/$/, "");
	// Normalize width up-front so BOTH the query string and the style attribute use
	// the same sanitized value — a raw `opts.width` could otherwise break out of the
	// style attribute (it is interpolated, not URL-encoded, into the markup).
	const width = normalizeSnippetWidth(opts.width);
	const query = new URLSearchParams({ t: opts.token });
	if (opts.theme) {
		query.set("theme", opts.theme);
	}
	if (opts.accent) {
		query.set("accent", opts.accent);
	}
	if (opts.font) {
		query.set("font", opts.font);
	}
	if (opts.radius != null) {
		query.set("radius", String(opts.radius));
	}
	if (opts.width) {
		query.set("width", width.query);
	}
	if (opts.density) {
		query.set("density", opts.density);
	}
	// Honor the chosen width as the iframe's max-width: a clamped pixel value gets a
	// "px" suffix; "100%" (or an unset width) lets the iframe fill its container.
	// Without this the iframe stayed capped at a hardcoded 480px, so picking a
	// wider width (e.g. 640) had no visible effect. `width.css` is guaranteed to be
	// "100%" or "<int>px" — no payload can reach the style attribute.
	return `<iframe src="${origin}/embed/release-notes?${query.toString()}" width="100%" height="560" style="border:0;max-width:${width.css}" title="Release notes" loading="lazy"></iframe>`;
}
