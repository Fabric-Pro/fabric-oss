import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	validateMiddlewareConfig,
	validateMiddlewareOnFlaggedPaths,
	validateRouting,
} from "@vercel/microfrontends/next/testing";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/config", () => ({
	config: {
		auth: { cookiePrefix: "fabric" },
		i18n: { enabled: false, defaultLocale: "en", locales: { en: {} } },
		ui: { marketing: { enabled: true }, saas: { enabled: true } },
	},
}));
vi.mock("@i18n/routing", () => ({
	routing: { locales: ["en"], defaultLocale: "en", localePrefix: "never" },
}));
/* The locale middleware records the zone header it was handed, for the header test. */
const seen: { zone: string | null } = { zone: null };
vi.mock("next-intl/middleware", () => ({
	default: () => (req: Request) => {
		seen.zone = req.headers.get("x-vercel-mfe-zone");
		return new Response("served by this app");
	},
}));
vi.mock("better-auth/cookies", () => ({ getSessionCookie: () => null }));

const CONFIG = join(__dirname, "..", "..", "microfrontends.json");

describe("microfrontends routing (fabric.pro)", () => {
	it("lets the proxy see every path the marketing flag can route", async () => {
		const { config } = await import("../../proxy");
		expect(() => validateMiddlewareConfig(config, CONFIG)).not.toThrow();
	});

	it("routes the marketing paths to fabric-web, only behind the flag", () => {
		const flag = "marketing-on-fabric-web";
		expect(() =>
			validateRouting(CONFIG, {
				"fabric-web": [
					"/",
					"/blog",
					"/blog/example-post",
					"/compare/cursor-alternatives",
					"/partners",
					"/legal/terms",
					"/fabric-web-assets/_next/static/chunks/main.js",
					"/ingest/e",
				].map((path) => ({ path, flag })),
				"fabric-prod": [
					"/app",
					"/app/example-org",
					"/auth/login",
					"/api/rpc/projects",
					"/mcp",
					"/en/docs",
					"/en/docs/core-concepts/rag",
					"/changelog",
					"/mcp-registry",
					"/share/example",
				],
			}),
		).not.toThrow();
	});

	it("sends every flagged path to fabric-web when the flag is on", async () => {
		// withMicrofrontends sets MFE_CONFIG at build time; here it is the same JSON.
		process.env.MFE_CONFIG = JSON.stringify(
			JSON.parse(readFileSync(CONFIG, "utf8")),
		);
		process.env.MARKETING_ON_FABRIC_WEB = "true";
		// Also set by withMicrofrontends: which app of the group this build is.
		process.env.NEXT_PUBLIC_MFE_CURRENT_APPLICATION = "fabric-prod";
		try {
			vi.resetModules();
			const { default: proxy } = await import("../../proxy");
			await expect(
				validateMiddlewareOnFlaggedPaths(CONFIG, proxy as never),
			).resolves.not.toThrow();
		} finally {
			delete process.env.MFE_CONFIG;
			delete process.env.MARKETING_ON_FABRIC_WEB;
			delete process.env.NEXT_PUBLIC_MFE_CURRENT_APPLICATION;
		}
	});

	async function zoneFor(
		path: string,
		flag: string | undefined,
		withConfig = true,
	) {
		if (withConfig) {
			process.env.MFE_CONFIG = JSON.stringify(
				JSON.parse(readFileSync(CONFIG, "utf8")),
			);
			process.env.NEXT_PUBLIC_MFE_CURRENT_APPLICATION = "fabric-prod";
		}
		if (flag !== undefined) {
			process.env.MARKETING_ON_FABRIC_WEB = flag;
		}
		try {
			vi.resetModules();
			const { default: proxy } = await import("../../proxy");
			const res = await proxy(
				new NextRequest(`https://fabric.pro${path}`),
			);
			return res.headers.get("x-middleware-request-x-vercel-mfe-zone");
		} finally {
			delete process.env.MFE_CONFIG;
			delete process.env.NEXT_PUBLIC_MFE_CURRENT_APPLICATION;
			delete process.env.MARKETING_ON_FABRIC_WEB;
		}
	}

	it("routes a marketing page to fabric-web only when the flag is on", async () => {
		expect(await zoneFor("/partners", "true")).toBe("fabric-web");
		expect(await zoneFor("/partners", "false")).toBeNull();
		expect(await zoneFor("/partners", undefined)).toBeNull();
	});

	it("never routes anything without the Microfrontends build config", async () => {
		expect(await zoneFor("/partners", "true", false)).toBeNull();
	});

	it("keeps the asset prefix unflagged and every marketing path behind the flag", () => {
		const config = JSON.parse(readFileSync(CONFIG, "utf8"));
		const groups = config.applications["fabric-web"].routing;
		const assets = groups.find(
			(g: { group: string }) => g.group === "marketing-assets",
		);
		const marketing = groups.find(
			(g: { group: string }) => g.group === "marketing",
		);
		expect(assets.flag).toBeUndefined();
		expect(assets.paths).toEqual(["/fabric-web-assets/:path*"]);
		expect(marketing.flag).toBe("marketing-on-fabric-web");
		expect(marketing.paths).toContain("/");
		expect(config.applications["fabric-prod"].routing).toBeUndefined();
	});

	async function respond(
		path: string,
		flag: string | undefined,
		headers: Record<string, string> = {},
	) {
		process.env.MFE_CONFIG = JSON.stringify(
			JSON.parse(readFileSync(CONFIG, "utf8")),
		);
		process.env.NEXT_PUBLIC_MFE_CURRENT_APPLICATION = "fabric-prod";
		if (flag !== undefined) {
			process.env.MARKETING_ON_FABRIC_WEB = flag;
		}
		try {
			vi.resetModules();
			const { default: proxy } = await import("../../proxy");
			return await proxy(
				new NextRequest(`https://fabric.pro${path}`, { headers }),
			);
		} finally {
			delete process.env.MFE_CONFIG;
			delete process.env.NEXT_PUBLIC_MFE_CURRENT_APPLICATION;
			delete process.env.MARKETING_ON_FABRIC_WEB;
		}
	}

	it("moves the app's old /en/blog addresses to /blog only with the flag on", async () => {
		const on = await respond("/en/blog/example-post?ref=x", "true");
		expect(on.status).toBe(307);
		expect(on.headers.get("location")).toBe(
			"https://fabric.pro/blog/example-post?ref=x",
		);
		const off = await respond("/en/blog/example-post", "false");
		expect(off.status).not.toBe(307);
	});

	it("never passes on a zone header a client sent", async () => {
		const res = await respond("/en/docs", "false", {
			"x-vercel-mfe-zone": "fabric-web",
		});
		expect(
			res.headers.get("x-middleware-request-x-vercel-mfe-zone"),
		).toBeNull();
		expect(
			res.headers.get("x-middleware-override-headers") ?? "",
		).not.toContain("x-vercel-mfe-zone");
	});

	it("drops a client zone header before the locale middleware sees it", async () => {
		seen.zone = "unset";
		await respond("/pricing", "false", {
			"x-vercel-mfe-zone": "fabric-web",
		});
		expect(seen.zone).toBeNull();
	});

	it("leaves /docs-sitemap.xml to the route, outside the locale middleware", async () => {
		const { config } = await import("../../proxy");
		const main = new RegExp(`^${config.matcher[0]}$`);
		expect(main.test("/docs-sitemap.xml")).toBe(false);
		expect(main.test("/en/docs/features/libraries")).toBe(true);
	});
});
