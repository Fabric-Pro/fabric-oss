import { describe, expect, it } from "vitest";
import {
	extractHeadCandidates,
	extractManifestCandidates,
	orderLogoCandidates,
} from "../extract-candidates";

const BASE = "https://www.example.com/home/";

describe("extractHeadCandidates", () => {
	it("orders the apple-touch-icon over a larger icon over og:image", () => {
		const head = extractHeadCandidates(
			`<!doctype html><html><head>
				<meta property="og:image" content="https://cdn.example.com/og.png">
				<link rel="icon" sizes="512x512" href="/icon-512.png">
				<link rel="icon" sizes="32x32" href="/icon-32.png">
				<link rel="apple-touch-icon" sizes="180x180" href="touch.png">
			</head><body></body></html>`,
			BASE,
		);
		const ordered = orderLogoCandidates({ ...head, manifestIcon: null }, 3);
		expect(ordered.map((c) => [c.source, c.url])).toEqual([
			["apple-touch-icon", "https://www.example.com/home/touch.png"],
			["icon", "https://www.example.com/icon-512.png"],
			["og:image", "https://cdn.example.com/og.png"],
		]);
	});

	it("resolves relative references against the URL the page was served from", () => {
		const head = extractHeadCandidates(
			`<head><link rel="shortcut icon" href="../img/logo.png?v=1&amp;s=2#x">
			<link rel="manifest" href="site.webmanifest"></head>`,
			"https://brand.example.com/en/about/",
		);
		expect(head.icon?.url).toBe(
			"https://brand.example.com/en/img/logo.png?v=1&s=2",
		);
		expect(head.manifestUrl).toBe(
			"https://brand.example.com/en/about/site.webmanifest",
		);
	});

	it("skips SVG and ICO icons, mask icons and vector sizes", () => {
		const head = extractHeadCandidates(
			`<head>
				<link rel="icon" href="/favicon.ico">
				<link rel="icon" type="image/svg+xml" href="/logo">
				<link rel="icon" sizes="any" href="/vector">
				<link rel="mask-icon" href="/mask.svg" color="#000000">
				<link rel="apple-touch-icon" href="/touch.SVG">
				<meta property="og:image" content="/og.svg">
			</head>`,
			BASE,
		);
		expect(head.appleTouchIcon).toBeNull();
		expect(head.icon).toBeNull();
		expect(head.ogImage).toBeNull();
	});

	it("keeps only hex theme colors and drops a value carrying CSS", () => {
		const head = extractHeadCandidates(
			`<head>
				<meta name="theme-color" content="red;background:url(x)">
				<meta name="theme-color" content="#0D9488" media="(prefers-color-scheme: light)">
				<meta name="theme-color" content="#0d9488">
				<meta name="theme-color" content="#123">
			</head>`,
			BASE,
		);
		expect(head.themeColors).toEqual(["#0d9488", "#112233"]);
	});

	it("ignores links inside comments, scripts and the body", () => {
		const head = extractHeadCandidates(
			`<head>
				<!-- <link rel="apple-touch-icon" href="/commented.png"> -->
				<script>document.write('<link rel="apple-touch-icon" href="/scripted.png">')</script>
				<link rel="icon" href="/real.png">
			</head><body><link rel="apple-touch-icon" href="/body.png"></body>`,
			BASE,
		);
		expect(head.appleTouchIcon).toBeNull();
		expect(head.icon?.url).toBe("https://www.example.com/real.png");
	});

	it("never yields a non-http reference", () => {
		const head = extractHeadCandidates(
			`<head>
				<link rel="apple-touch-icon" href="javascript:alert(1)">
				<link rel="icon" href="data:image/png;base64,AAAA">
				<link rel="manifest" href="file:///etc/passwd">
			</head>`,
			BASE,
		);
		expect(head.appleTouchIcon).toBeNull();
		expect(head.icon).toBeNull();
		expect(head.manifestUrl).toBeNull();
	});

	it("stays bounded on hostile markup", () => {
		// Unterminated tags and comments must not make the scan quadratic.
		const hostile = `<head>${"<link rel=icon href=/a.png ".repeat(20_000)}${"<!--".repeat(20_000)}`;
		const started = performance.now();
		const head = extractHeadCandidates(hostile, BASE);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(head.icon).toBeNull();
	});
});

describe("extractManifestCandidates", () => {
	const MANIFEST_URL = "https://static.example.com/app/manifest.json";

	it("takes the largest raster icon, resolved against the manifest URL", () => {
		const manifest = extractManifestCandidates(
			{
				theme_color: "#1D4ED8",
				icons: [
					{
						src: "icons/192.png",
						sizes: "192x192",
						type: "image/png",
					},
					{
						src: "icons/any.svg",
						sizes: "any",
						type: "image/svg+xml",
					},
					{
						src: "icons/1024.png",
						sizes: "1024x1024",
						purpose: "monochrome",
					},
					{
						src: "icons/512.png",
						sizes: "512x512",
						purpose: "any maskable",
					},
				],
			},
			MANIFEST_URL,
		);
		expect(manifest.icon).toEqual({
			url: "https://static.example.com/app/icons/512.png",
			source: "manifest",
			size: 512,
		});
		expect(manifest.themeColors).toEqual(["#1d4ed8"]);
	});

	it("tolerates a malformed manifest", () => {
		expect(extractManifestCandidates(null, MANIFEST_URL)).toEqual({
			icon: null,
			themeColors: [],
		});
		expect(
			extractManifestCandidates(
				{ theme_color: "blue", icons: "nope" },
				MANIFEST_URL,
			),
		).toEqual({ icon: null, themeColors: [] });
	});
});

describe("orderLogoCandidates", () => {
	it("puts manifest icons before og:image and caps the list", () => {
		const candidate = (
			url: string,
			source: "icon" | "manifest" | "og:image",
		) => ({
			url,
			source,
			size: 0,
		});
		const ordered = orderLogoCandidates(
			{
				appleTouchIcon: null,
				icon: candidate("https://www.example.com/a.png", "icon"),
				manifestIcon: candidate(
					"https://www.example.com/a.png",
					"manifest",
				),
				ogImage: candidate(
					"https://www.example.com/og.png",
					"og:image",
				),
			},
			3,
		);
		// The duplicate manifest entry collapses into the icon.
		expect(ordered.map((c) => c.source)).toEqual(["icon", "og:image"]);
		expect(
			orderLogoCandidates(
				{
					appleTouchIcon: candidate(
						"https://www.example.com/1.png",
						"icon",
					),
					icon: candidate("https://www.example.com/2.png", "icon"),
					manifestIcon: candidate(
						"https://www.example.com/3.png",
						"manifest",
					),
					ogImage: candidate(
						"https://www.example.com/4.png",
						"og:image",
					),
				},
				3,
			),
		).toHaveLength(3);
	});
});
