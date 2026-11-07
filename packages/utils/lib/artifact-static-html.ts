import { sanitizeFrameHtml } from "./sanitize-frame-html";

/** Offline policy is emitted before any authored markup; sanitizer is defense in depth. */
export const ARTIFACT_STATIC_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; form-action 'none'; base-uri 'none'; sandbox";
export function sanitizeArtifactHtmlFragment(html: string): string {
	const safe = sanitizeFrameHtml(html);
	return safe
		.replace(/^[\s\S]*?<body[^>]*>/i, "")
		.replace(/<\/body>[\s\S]*$/i, "");
}
