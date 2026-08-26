import { permanentRedirect } from "next/navigation";

/**
 * Fabric no longer hosts its own contact experience — contact intent belongs to
 * TechFabric. A 308 (not a 307) because this is a permanent move of a
 * previously-indexed page: search engines should transfer link equity to the
 * destination and stop re-crawling this path. The route is also dropped from
 * `sitemap.ts` for the same reason.
 */
export default function ContactPage(): never {
	permanentRedirect("https://techfabric.com/contact");
}
