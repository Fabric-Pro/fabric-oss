import { getBaseUrl } from "@repo/utils";
import type { MetadataRoute } from "next";

const baseUrl = getBaseUrl();

export default function robots(): MetadataRoute.Robots {
	return {
		rules: [
			{
				userAgent: "*",
				allow: "/",
				disallow: ["/app/", "/api/", "/auth/"],
			},
			{
				userAgent: "Googlebot",
				allow: "/",
				disallow: ["/app/", "/api/", "/auth/"],
			},
		],
		sitemap: `${baseUrl}/sitemap.xml`,
		host: baseUrl,
	};
}
