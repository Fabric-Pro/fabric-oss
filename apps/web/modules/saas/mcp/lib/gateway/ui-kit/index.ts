/**
 * The Fabric UI kit for MCP Apps (`io.modelcontextprotocol/ui`, spec 2026-01-26):
 * Shared design system and A2UI v0.9.1 surface renderer used across Fabric MCP
 * servers (`/mcp` portal gateway and `@fabricorg/sdk-mcp`).
 */

import { createHash } from "node:crypto";
import A2UI from "./a2ui-core.generated.js";
import { KIT_CSS, KIT_SCRIPT, KIT_VERSION } from "./kit.generated.js";

export { A2UI, KIT_CSS, KIT_SCRIPT, KIT_VERSION };

/**
 * Official Fabric 3-arc brand mark encoded as an inline SVG data URI
 * in Fabric's warm bright-orange primary accent (`#bc3e0b`).
 * Requires zero external network requests (`img-src data:` CSP-safe).
 */
export const FABRIC_MARK_DATA_URI =
	"data:image/svg+xml," +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 220">' +
			'<path fill="#bc3e0b" d="M115.14,219.89h-21v-87.3c.028-21.221,17.239-38.41,38.46-38.41h7v21h-7c-9.634.011-17.443,7.816-17.46,17.45v87.26Z"/>' +
			'<path fill="#bc3e0b" d="M83,181.48h-20.93v-53.08c.044-36.62,29.72-66.296,66.34-66.34h26.59v20.94h-26.59c-25.068.017-45.388,20.332-45.41,45.4v53.08Z"/>' +
			'<path fill="#bc3e0b" d="M50.9,143.07h-20.9v-18.86c.061-52.039,42.231-94.209,94.27-94.27h46.09v21h-46.14c-40.456.044-73.248,32.814-73.32,73.27v18.86Z"/>' +
			"</svg>",
	);

export interface KitAccent {
	light?: string;
	dark?: string;
	tintLight?: string;
	tintDark?: string;
	inkLight?: string;
	inkDark?: string;
}

export const FABRIC_BRAND: {
	accent: Required<KitAccent>;
	display: string;
	mark: string;
} = {
	accent: {
		light: "#bc3e0b",
		dark: "#ff8547",
		tintLight: "#fdf0ea",
		tintDark: "#381c11",
		inkLight: "#9a3006",
		inkDark: "#ffb088",
	},
	display: '"Poppins", "Inter", ui-sans-serif, system-ui, sans-serif',
	mark: FABRIC_MARK_DATA_URI,
};

const esc = (s: unknown): string =>
	String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

const cssValue = (s: unknown): string =>
	String(s ?? "").replace(/[;{}<>\\]/g, "");

/** Synchronous SHA-256 base64 CSP source expression (`'sha256-...'`). */
export function cspHashSync(text: string): string {
	const digest = createHash("sha256").update(text).digest("base64");
	return `'sha256-${digest}'`;
}

/** Async SHA-256 base64 CSP source expression (`'sha256-...'`). */
export async function cspHash(text: string): Promise<string> {
	return cspHashSync(text);
}

/** The page's own CSP (on top of the host's): its one script by hash; styles, fonts and images from the site only. */
export function kitCsp(scriptHash: string, domains: string[] = []): string {
	const ds = domains.join(" ");
	return [
		"default-src 'none'",
		`script-src ${scriptHash}`,
		`style-src 'unsafe-inline' ${ds}`.trim(),
		`img-src data: ${ds}`.trim(),
		`font-src data: ${ds}`.trim(),
		"connect-src 'none'",
		"frame-src 'none'",
		"object-src 'none'",
		"form-action 'none'",
		"base-uri 'none'",
	].join("; ");
}

/** The site's accent and display face as CSS: the kit's only brand inputs. */
export function siteCss(
	options: { accent?: KitAccent; display?: string } = {},
): string {
	const a = options.accent ?? FABRIC_BRAND.accent;
	const display = options.display ?? FABRIC_BRAND.display;
	const light = [
		a.light && `--k-site-accent: ${cssValue(a.light)};`,
		a.tintLight && `--k-site-accent-tint: ${cssValue(a.tintLight)};`,
		a.inkLight && `--k-site-accent-ink: ${cssValue(a.inkLight)};`,
	]
		.filter(Boolean)
		.join(" ");
	const dark = [
		a.dark && `--k-site-accent: ${cssValue(a.dark)};`,
		a.tintDark && `--k-site-accent-tint: ${cssValue(a.tintDark)};`,
		a.inkDark && `--k-site-accent-ink: ${cssValue(a.inkDark)};`,
	]
		.filter(Boolean)
		.join(" ");
	return [
		display ? `:root { --k-site-display: ${cssValue(display)}; }` : "",
		light ? `:root, :root[data-theme="light"] { ${light} }` : "",
		dark
			? `:root[data-theme="dark"] { ${dark} } @media (prefers-color-scheme: dark) { :root:not([data-theme]) { ${dark} } }`
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

export interface KitPageOptions {
	uri?: string;
	title?: string;
	stylesheets?: string[];
	css?: string;
	script: string;
	domains?: string[];
	accent?: KitAccent;
	display?: string;
	buildMeta?: string;
	loading?: string;
}

/** The one inline script: the kit, then the view. */
export const pageScript = (viewScript: string): string =>
	`${KIT_SCRIPT}\n${viewScript ?? ""}`;

/**
 * The page around a view: the kit's CSS and the site's, the kit's script then the view's,
 * as one inline script under the CSP hash.
 */
export function kitDocument(
	o: KitPageOptions & { csp: string; build: string },
): string {
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		`<meta http-equiv="Content-Security-Policy" content="${esc(o.csp)}">`,
		...(o.build && o.buildMeta
			? [
					`<meta name="${esc(o.buildMeta)}" content="${String(o.build).replace(/[^A-Za-z0-9+/=_-]/g, "")}">`,
				]
			: []),
		`<meta name="ui-kit" content="${esc(KIT_VERSION)}">`,
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${esc(o.title ?? "Fabric View")}</title>`,
		...(o.stylesheets ?? []).map(
			(href) => `<link rel="stylesheet" href="${esc(href)}">`,
		),
		`<style>${KIT_CSS}\n${siteCss(o)}\n${o.css ?? ""}</style>`,
		"</head>",
		"<body>",
		`<div id="kit-app" class="k-app" data-mode="inline"${o.uri ? ` data-mcp-app-uri="${esc(o.uri)}"` : ""}>`,
		`<div id="kit-root"><div class="k-card" aria-busy="true"><span class="k-sr">${esc(o.loading ?? "Loading Fabric view.")}</span><div class="k-skel"><i></i><i></i><i></i><i></i></div></div></div>`,
		'<p id="kit-status" class="k-status" role="status" aria-live="polite"></p>',
		"</div>",
		`<script>${pageScript(o.script)}</script>`,
		"</body>",
		"</html>",
	].join("\n");
}

/** Synchronous builder for an MCP App view HTML page with SHA-256 CSP hash. */
export function kitPageSync(o: KitPageOptions): {
	html: string;
	hash: string;
	build: string;
} {
	const hash = cspHashSync(pageScript(o.script));
	const build = hash.slice("'sha256-".length, "'sha256-".length + 16);
	return {
		html: kitDocument({
			...o,
			accent: o.accent ?? FABRIC_BRAND.accent,
			display: o.display ?? FABRIC_BRAND.display,
			csp: kitCsp(hash, o.domains ?? []),
			build,
		}),
		hash,
		build,
	};
}

/** Async builder for an MCP App view HTML page with SHA-256 CSP hash. */
export async function kitPage(o: KitPageOptions): Promise<{
	html: string;
	hash: string;
	build: string;
}> {
	return kitPageSync(o);
}

export interface FabricVisualizeResult {
	title: string;
	provenance: string;
	document: unknown[];
	surfaces: Array<{ surfaceId: string; catalogId: string; components: number }>;
	errors: Array<{
		code: string;
		surfaceId: string;
		path: string;
		message: string;
	}>;
	sources: Array<{ title: string; page: string; url: string }>;
	textSummary: string;
}

/**
 * Validates an A2UI v0.9.1 document (JSONL string or JSON array of messages)
 * against the Fabric A2UI catalog (`https://agents.fabric.pro/a2ui/v0.9/fabric_catalog.json`)
 * and produces both the structured payload for `ui://fabric/visualize` and a complete
 * text fallback for non-App MCP clients.
 */
export function buildFabricVisualizePayload(args: {
	document?: unknown;
	title?: unknown;
	sources?: unknown;
}): FabricVisualizeResult {
	const doc = args.document;
	if (typeof doc !== "string" && !Array.isArray(doc)) {
		throw new Error(
			"document is required: A2UI v0.9.1 messages as JSONL (one per line) or a JSON array.",
		);
	}
	const text = typeof doc === "string" ? doc : JSON.stringify(doc);
	if (text.length > 64000) {
		throw new Error(
			`document is ${text.length} characters; the maximum is 64000. Split it into fewer, smaller surfaces.`,
		);
	}
	const messages = Array.isArray(doc) ? doc : A2UI.readMessages(doc);
	const built = A2UI.buildSurfaces(messages);
	const drawable = built.surfaces.filter(
		(s: { components: object; loop?: unknown }) =>
			Object.prototype.hasOwnProperty.call(s.components, "root") && !s.loop,
	);
	if (!drawable.length) {
		const why = built.errors.length
			? built.errors
					.slice(0, 12)
					.map(
						(e: { path?: string; message: string }) =>
							`${e.path || "/"}: ${e.message}`,
					)
					.join("; ")
			: 'no surface with a component whose id is "root"';
		throw new Error(
			`Nothing in this document would draw (VALIDATION_FAILED): ${why}. Fix it and call fabric_visualize again.`,
		);
	}
	const rawSources = Array.isArray(args.sources)
		? args.sources.slice(0, 20)
		: [];
	const sources: Array<{ title: string; page: string; url: string }> = [];
	for (const item of rawSources) {
		if (typeof item === "string" && item.startsWith("http")) {
			sources.push({ title: item, page: "Fabric Workspace", url: item });
		} else if (item && typeof item === "object") {
			const obj = item as Record<string, unknown>;
			if (typeof obj.url === "string" && obj.url.startsWith("http")) {
				sources.push({
					title: String(obj.title || obj.url),
					page: String(obj.page || "Fabric Workspace"),
					url: obj.url,
				});
			}
		}
	}
	const title =
		String(args.title ?? "")
			.trim()
			.slice(0, 120) || "Fabric Interactive View";
	const provenance = "Composed by your Fabric assistant";
	const docText = A2UI.documentText({ surfaces: drawable });
	const lines = [`# ${title}`, "", `${provenance}.`, "", docText];
	if (sources.length) {
		lines.push("", "Sources:");
		for (const s of sources) {
			lines.push(`- ${s.title}: ${s.url}`);
		}
	}
	return {
		title,
		provenance,
		document: messages,
		surfaces: drawable.map(
			(s: { surfaceId: string; catalogId: string; count: number }) => ({
				surfaceId: s.surfaceId,
				catalogId: s.catalogId,
				components: s.count,
			}),
		),
		errors: built.errors,
		sources,
		textSummary: lines.join("\n"),
	};
}
