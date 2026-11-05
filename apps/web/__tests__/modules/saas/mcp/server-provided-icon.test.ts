import {
	decideServerIconWrite,
	isAcceptableIconSrc,
	isServerProvidedIconUrl,
	MAX_DATA_IMAGE_ICON_LENGTH,
	type McpServerIconEntry,
	selectServerProvidedIcon,
} from "@saas/mcp/lib/server-provided-icon";
import { describe, expect, it } from "vitest";

const svg = (src: string, theme?: "light" | "dark"): McpServerIconEntry => ({
	src,
	mimeType: "image/svg+xml",
	sizes: ["any"],
	...(theme ? { theme } : {}),
});
const png = (
	src: string,
	edge: number,
	theme?: "light" | "dark",
): McpServerIconEntry => ({
	src,
	mimeType: "image/png",
	sizes: [`${edge}x${edge}`],
	...(theme ? { theme } : {}),
});

describe("selectServerProvidedIcon", () => {
	it("prefers a theme-neutral SVG over everything else", () => {
		expect(
			selectServerProvidedIcon([
				png("https://example.com/icon-512.png", 512),
				svg("https://example.com/on-light.svg", "light"),
				svg("https://example.com/mark.svg"),
			]),
		).toBe("https://example.com/mark.svg");
	});

	it("picks the light-background SVG for the white tile when the server lists light and dark variants", () => {
		// The shape a Heddle site sends: SVG + PNGs, each for light and dark.
		const icons = [
			svg("https://example.com/brand/mark-on-dark.svg", "dark"),
			png("https://example.com/brand/on-dark-1024.png", 1024, "dark"),
			svg("https://example.com/brand/mark-on-light.svg", "light"),
			png("https://example.com/brand/on-light-1024.png", 1024, "light"),
			png("https://example.com/brand/on-light-128.png", 128, "light"),
		];
		expect(selectServerProvidedIcon(icons)).toBe(
			"https://example.com/brand/mark-on-light.svg",
		);
	});

	it("falls back to the largest raster of at least 64px when there is no usable SVG", () => {
		expect(
			selectServerProvidedIcon([
				png("https://example.com/icon-48.png", 48),
				png("https://example.com/icon-128.png", 128),
				png("https://example.com/icon-256.png", 256, "light"),
				png("https://example.com/icon-1024-dark.png", 1024, "dark"),
			]),
		).toBe("https://example.com/icon-256.png");
	});

	it("ignores rasters smaller than 64px or without a size", () => {
		expect(
			selectServerProvidedIcon([
				png("https://example.com/icon-32.png", 32),
				{ src: "https://example.com/icon.png", mimeType: "image/png" },
			]),
		).toBeNull();
	});

	it("uses a dark-background icon only when nothing else is listed", () => {
		expect(
			selectServerProvidedIcon([
				png("https://example.com/on-dark-512.png", 512, "dark"),
				svg("https://example.com/on-dark.svg", "dark"),
			]),
		).toBe("https://example.com/on-dark.svg");
		expect(
			selectServerProvidedIcon([
				png("https://example.com/on-dark-512.png", 512, "dark"),
			]),
		).toBe("https://example.com/on-dark-512.png");
	});

	it("skips unacceptable sources and takes the next acceptable icon", () => {
		expect(
			selectServerProvidedIcon([
				svg("http://example.com/mark.svg"),
				svg("javascript:alert(1)"),
				svg("https://example.com/mark.svg"),
			]),
		).toBe("https://example.com/mark.svg");
	});

	it("returns null for no icons or a malformed list", () => {
		expect(selectServerProvidedIcon(undefined)).toBeNull();
		expect(selectServerProvidedIcon([])).toBeNull();
		expect(
			selectServerProvidedIcon([
				null as unknown as McpServerIconEntry,
				{ src: 42 } as unknown as McpServerIconEntry,
			]),
		).toBeNull();
	});
});

describe("isAcceptableIconSrc", () => {
	it.each([
		"https://example.com/icon.svg",
		"data:image/png;base64,iVBORw0KGgo=",
		"data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E",
	])("accepts %s", (src) => {
		expect(isAcceptableIconSrc(src)).toBe(true);
	});

	it.each([
		"http://example.com/icon.svg",
		"javascript:alert(1)",
		"JAVASCRIPT:alert(1)",
		"data:text/html;base64,PHNjcmlwdD4=",
		"data:image/x-icon;base64,AAAA",
		"file:///etc/passwd",
		"blob:https://example.com/0000",
		"/icon.svg",
		"",
	])("refuses %s", (src) => {
		expect(isAcceptableIconSrc(src)).toBe(false);
	});

	it("refuses a data:image URL over the size cap", () => {
		const prefix = "data:image/png;base64,";
		const atCap =
			prefix + "A".repeat(MAX_DATA_IMAGE_ICON_LENGTH - prefix.length);
		expect(isAcceptableIconSrc(atCap)).toBe(true);
		expect(isAcceptableIconSrc(`${atCap}A`)).toBe(false);
	});
});

describe("isServerProvidedIconUrl and decideServerIconWrite", () => {
	const icons = [svg("https://example.com/brand/mark.svg")];

	it("stores the chosen icon when none is stored", () => {
		expect(
			decideServerIconWrite({
				storedIconUrl: null,
				serverUrl: "https://example.com/mcp",
				websiteUrl: undefined,
				icons,
			}),
		).toBe("https://example.com/brand/mark.svg");
	});

	it("is a no-op when the stored icon is already the chosen one", () => {
		expect(
			decideServerIconWrite({
				storedIconUrl: "https://example.com/brand/mark.svg",
				serverUrl: "https://example.com/mcp",
				websiteUrl: undefined,
				icons,
			}),
		).toBeNull();
	});

	it("is a no-op when the server lists nothing acceptable", () => {
		expect(
			decideServerIconWrite({
				storedIconUrl: null,
				serverUrl: "https://example.com/mcp",
				websiteUrl: undefined,
				icons: [svg("http://example.com/mark.svg")],
			}),
		).toBeNull();
	});

	it("refreshes an icon on the server's own origin", () => {
		expect(
			decideServerIconWrite({
				storedIconUrl: "https://example.com/old-icon.png",
				serverUrl: "https://example.com/mcp",
				websiteUrl: undefined,
				icons,
			}),
		).toBe("https://example.com/brand/mark.svg");
	});

	it("refreshes a stored data:image icon", () => {
		expect(
			decideServerIconWrite({
				storedIconUrl: "data:image/png;base64,AAAA",
				serverUrl: "https://example.com/mcp",
				websiteUrl: undefined,
				icons,
			}),
		).toBe("https://example.com/brand/mark.svg");
	});

	it("refreshes an icon on the serverInfo.websiteUrl origin when MCP runs on its own host", () => {
		const companyIcons = [svg("https://example.com/brand/mark-v2.svg")];
		expect(
			isServerProvidedIconUrl({
				storedIconUrl: "https://example.com/brand/mark.svg",
				serverUrl: "https://mcp.example.com/mcp",
				websiteUrl: "https://example.com",
				icons: companyIcons,
			}),
		).toBe(true);
		expect(
			decideServerIconWrite({
				storedIconUrl: "https://example.com/brand/mark.svg",
				serverUrl: "https://mcp.example.com/mcp",
				websiteUrl: "https://example.com",
				icons: companyIcons,
			}),
		).toBe("https://example.com/brand/mark-v2.svg");
	});

	it("treats a stored icon the server lists now as its own, from any origin", () => {
		expect(
			isServerProvidedIconUrl({
				storedIconUrl: "https://cdn.example.net/icon-128.png",
				serverUrl: "https://example.com/mcp",
				websiteUrl: undefined,
				icons: [
					svg("https://example.com/brand/mark.svg"),
					png("https://cdn.example.net/icon-128.png", 128),
				],
			}),
		).toBe(true);
	});

	it("never overwrites an icon from another origin", () => {
		expect(
			decideServerIconWrite({
				storedIconUrl: "https://icons.example.org/custom.png",
				serverUrl: "https://mcp.example.com/mcp",
				websiteUrl: "https://example.com",
				icons: [svg("https://example.com/brand/mark.svg")],
			}),
		).toBeNull();
	});
});
