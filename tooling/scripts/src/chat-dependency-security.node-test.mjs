import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const webRequire = createRequire(join(root, "apps/web/package.json"));
const streamdownRequire = createRequire(webRequire.resolve("streamdown"));
const remarkMathRequire = createRequire(
	streamdownRequire.resolve("remark-math"),
);
const katexConsumers = [
	["streamdown", streamdownRequire],
	["rehype-katex", createRequire(streamdownRequire.resolve("rehype-katex"))],
	["mermaid", createRequire(streamdownRequire.resolve("mermaid"))],
	[
		"micromark-extension-math",
		createRequire(remarkMathRequire.resolve("micromark-extension-math")),
	],
	[
		"@copilotkit/react-core",
		createRequire(webRequire.resolve("@copilotkit/react-core")),
	],
];

for (const [name, consumer] of katexConsumers) {
	test(`${name} resolves the reviewed KaTeX release and ignores inherited trust`, () => {
		const katex = consumer("katex");
		assert.equal(katex.version, "0.18.2");
		const expression = String.raw`\href{javascript:alert(1)}{x}`;
		assert.doesNotMatch(
			katex.renderToString(expression, Object.create({ trust: true })),
			/<a href=/,
		);
		assert.match(
			katex.renderToString(expression, { trust: true }),
			/<a href=/,
		);
	});
}

test("Streamdown's KaTeX stylesheet covers generated HTML classes and ships its fonts", () => {
	const katex = streamdownRequire("katex");
	const cssPath = streamdownRequire.resolve("katex/dist/katex.min.css");
	const css = readFileSync(cssPath, "utf8");
	const html = katex.renderToString(
		String.raw`\frac{x^2}{\sqrt{y}}+\sum_{i=1}^{n}i`,
		{ output: "html" },
	);
	for (const className of [
		"katex-base",
		"katex-strut",
		"mathnormal",
		"vlist",
	]) {
		assert.ok(html.includes(className), `Missing rendered ${className}`);
		assert.ok(
			css.includes(`.${className}`),
			`Missing style for ${className}`,
		);
	}
	const fonts = [...css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)];
	assert.ok(fonts.length > 0, "KaTeX must ship WOFF2 font references");
	for (const [, font] of fonts) {
		assert.ok(
			existsSync(join(dirname(cssPath), font)),
			`Missing KaTeX font ${font}`,
		);
	}
});

test("chat-related transitive security floors cover every lockfile copy", () => {
	// Use the existing Changesets parser's YAML dependency.
	const changesetsRequire = createRequire(
		join(
			root,
			"node_modules/.pnpm/@changesets+parse@1.0.0/node_modules/@changesets/parse/package.json",
		),
	);
	const yaml = changesetsRequire("yaml");
	const lockfile = yaml.parse(
		readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
	);
	for (const [name, reviewed] of [
		["qs", "6.16.1"],
		["fast-copy", "3.1.0"],
		["@fastify/busboy", "3.2.2"],
		["katex", "0.18.2"],
	]) {
		const copies = Object.keys(lockfile.packages).filter((key) =>
			key.startsWith(`${name}@`),
		);
		assert.ok(copies.length > 0, `Missing ${name} from lockfile`);
		assert.deepEqual(copies, [`${name}@${reviewed}`]);
	}
});
