// @vitest-environment node
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";

it("renders Streamdown on the server without Shiki language, theme or WASM assets", async () => {
	// Use Node's real loader, not jsdom or a mocked highlighter. CSS is
	// handled by Next in production; only that loader behavior is substituted.
	let blockedLoads = 0;
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (
				/^@shikijs\/(langs|themes)(\/|$)/.test(specifier) ||
				/^(shiki\/wasm|@shikijs\/engine-oniguruma\/wasm-inlined)$/.test(
					specifier,
				)
			) {
				blockedLoads++;
				throw new Error(`SSR attempted excluded asset: ${specifier}`);
			}
			return next(specifier, context);
		},
		load(url, context, next) {
			if (url.endsWith(".css")) {
				return {
					format: "module",
					source: "export default {};",
					shortCircuit: true,
				};
			}
			return next(url, context);
		},
	});

	try {
		const require = createRequire(
			path.resolve(__dirname, "../package.json"),
		);
		const { createElement } = require("react") as typeof import("react");
		const { renderToString } =
			require("react-dom/server") as typeof import("react-dom/server");
		// Streamdown's ESM entry is the one Next bundles. Its CJS entry has
		// different interop with react-markdown under Node's native loader.
		const entry = path.join(
			path.dirname(require.resolve("streamdown")),
			"index.js",
		);
		const { Streamdown } = require(entry) as typeof import("streamdown");
		const markdown = [
			"# Example",
			"",
			"Paragraph",
			"",
			"~~~typescript",
			"const answer: number = 42;",
			"~~~",
			"",
			"~~~unknown-language",
			"hello",
			"~~~",
		].join("\n");
		const html = renderToString(createElement(Streamdown, {}, markdown));
		// Also catch an eager dynamic import queued during module evaluation.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(html).toContain("Example");
		expect(html).toContain("Paragraph");
		expect(html).toContain("data-code-block");
		expect(html).toContain("typescript");
		expect(html).toContain("unknown-language");
		expect(blockedLoads).toBe(0);
	} finally {
		hooks.deregister();
	}
});
