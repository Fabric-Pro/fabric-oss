#!/usr/bin/env node
/**
 * Renders the docs screenshots in `mocks/` to `apps/web/public/images/docs/`.
 *
 *   node tooling/docs-screenshots/render.mjs            # all of them
 *   node tooling/docs-screenshots/render.mjs pr-review  # one mock
 *
 * Why mocks instead of a real capture: `apps/web/content/docs` is published to
 * the public docs site, and a screenshot of a running Fabric carries a real
 * organization, project and repository in it. These pages reproduce the
 * component with synthetic data, on the SAME design tokens — each mock copies
 * the `:root` block from `tooling/tailwind/theme.css` verbatim and mirrors the
 * component's own class structure — so the image matches the product without
 * publishing anybody's data.
 *
 * Fonts are fetched once into `.fonts/` (gitignored) so the type metrics match
 * the app's `next/font` Inter and JetBrains Mono rather than a host fallback.
 * The render FAILS if Inter did not load; a silent fallback would ship a
 * screenshot that looks subtly unlike the product.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// Playwright belongs to `apps/web`, and pnpm does not hoist it to the root, so a
// bare `import "@playwright/test"` here fails whichever directory you run from.
// Resolved against that package rather than vendored a second copy: this script
// renders five images, it should not own a dependency. `require` rather than
// `import` because the entry is CommonJS, whose named exports an ESM import does
// not reliably expose.
const webRequire = createRequire(path.join(repoRoot, "apps/web/package.json"));
const { chromium } = webRequire("@playwright/test");
const mocksDir = path.join(here, "mocks");
const fontsDir = path.join(here, ".fonts");
const outDir = path.join(repoRoot, "apps/web/public/images/docs/qa");

/**
 * Which element of which mock becomes which image. Explicit rather than derived
 * from the DOM: the filename is referenced from an .mdx page, so it is part of
 * the published contract and should not change because a mock was reordered.
 */
const SHOTS = {
	"pr-review": [
		["#shot-panel", "pr-review-panel.png"],
		["#shot-sheet", "pr-review-diff.png"],
	],
	"qa-strategy-depth": [["#shot-depth", "qa-strategy-depth.png"]],
	"qa-surfaces": [
		["#shot-cases", "qa-cases-segment.png"],
		["#shot-findings", "qa-ci-findings.png"],
	],
	"qa-gates": [
		["#shot-coverage", "qa-coverage-gate.png"],
		["#shot-testfirst", "qa-test-first-tab.png"],
		["#shot-transition", "qa-test-first-transition.png"],
		["#shot-runtests", "qa-run-tests-dialog.png"],
		["#shot-revise", "qa-revise-cases.png"],
		["#shot-covers-ac", "qa-covers-ac.png"],
		["#shot-testfirst-evidence", "qa-test-first-evidence.png"],
	],
};

const GOOGLE_FONTS_CSS =
	"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600" +
	"&family=JetBrains+Mono:wght@400&display=swap";
// Google serves woff2 only to a browser-like UA; anything else gets ttf.
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Downloads the webfonts once and writes a CSS file with local `url(...)`s. */
async function ensureFonts() {
	const localCss = path.join(fontsDir, "fonts.css");
	if (existsSync(localCss)) {
		return localCss;
	}
	mkdirSync(fontsDir, { recursive: true });
	const res = await fetch(GOOGLE_FONTS_CSS, {
		headers: { "User-Agent": BROWSER_UA },
	});
	if (!res.ok) {
		throw new Error(`Could not fetch the font CSS (HTTP ${res.status})`);
	}
	let css = await res.text();
	const urls = [...new Set(css.match(/https:\/\/[^)]*\.woff2/g) ?? [])];
	if (urls.length === 0) {
		throw new Error("Font CSS carried no woff2 sources");
	}
	for (const url of urls) {
		const name = `${createHash("md5").update(url).digest("hex").slice(0, 10)}.woff2`;
		const file = path.join(fontsDir, name);
		if (!existsSync(file)) {
			const font = await fetch(url, {
				headers: { "User-Agent": BROWSER_UA },
			});
			writeFileSync(file, Buffer.from(await font.arrayBuffer()));
		}
		css = css.split(url).join(name);
	}
	writeFileSync(localCss, css, "utf-8");
	return localCss;
}

const only = process.argv[2];
const names = Object.keys(SHOTS).filter((n) => !only || n === only);
if (names.length === 0) {
	throw new Error(
		`Unknown mock "${only}". Known: ${Object.keys(SHOTS).join(", ")}`,
	);
}
for (const name of names) {
	if (!existsSync(path.join(mocksDir, `${name}.html`))) {
		throw new Error(`mocks/${name}.html is missing`);
	}
}
// A mock nobody renders is a mock that silently rots.
for (const file of readdirSync(mocksDir)) {
	const stem = file.replace(/\.html$/, "");
	if (file.endsWith(".html") && !(stem in SHOTS)) {
		throw new Error(
			`mocks/${file} has no entry in SHOTS — add one or delete it`,
		);
	}
}

await ensureFonts();
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
	// Set DOCS_SHOT_CHROME when Playwright's own browser revision is not
	// installed but another Chromium is (common on a dev machine).
	executablePath: process.env.DOCS_SHOT_CHROME,
});
const page = await browser.newPage({
	viewport: { width: 1240, height: 900 },
	// The docs site renders these on high-DPI displays.
	deviceScaleFactor: 2,
});

for (const name of names) {
	await page.goto(pathToFileURL(path.join(mocksDir, `${name}.html`)).href);
	await page.waitForLoadState("load");
	await page.evaluate(() => document.fonts.ready);
	if (!(await page.evaluate(() => document.fonts.check("500 14px Inter")))) {
		throw new Error(
			`${name}: Inter did not load — the shot would use a fallback face`,
		);
	}
	for (const [selector, file] of SHOTS[name]) {
		const el = await page.$(selector);
		if (!el) {
			throw new Error(`${name}: no element matches ${selector}`);
		}
		await el.screenshot({ path: path.join(outDir, file) });
		console.log(`wrote images/docs/qa/${file}`);
	}
}

await browser.close();

// Keeps the "tokens copied verbatim" claim in each mock honest: if the theme's
// light-mode palette moves, the mocks are stale and the images must be re-cut.
const theme = readFileSync(
	path.join(repoRoot, "tooling/tailwind/theme.css"),
	"utf-8",
);
const drifted = [];
for (const name of names) {
	const mock = readFileSync(path.join(mocksDir, `${name}.html`), "utf-8");
	for (const [, token, value] of mock.matchAll(
		/--(background|foreground|primary|border|muted|card|highlight|destructive|secondary):\s*(#[0-9a-f]{6})/gi,
	)) {
		if (!theme.includes(`--${token}: ${value}`)) {
			drifted.push(`${name}: --${token}: ${value}`);
		}
	}
}
if (drifted.length > 0) {
	console.warn(
		`\nWARNING: these mock tokens no longer match theme.css — the images may be off-palette:\n  ${drifted.join("\n  ")}`,
	);
}
