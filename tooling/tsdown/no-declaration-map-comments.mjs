// With `dts: { sourcemap: false }`, tsdown 0.23 drops the declaration maps but
// still ends each `.d.ts`/`.d.cts` with `//# sourceMappingURL=<file>.map`,
// pointing at a file that is never published. tsup emitted no such comment.
//
// The comment comes from two builds, so it takes two fixes:
// - the ESM build emits `.js` and `.d.ts` together, so source maps stay on and
//   a plugin strips the comment from the declaration chunks only;
// - the separate CJS declaration build (`.d.cts`) only emits declarations, so
//   source maps are turned off for it.
//
// Spread into a package's tsdown config next to `dts: { sourcemap: false }`.
// It is shared through a relative import, so turbo.json lists this directory
// as a build input.

export function noDeclarationMapComments() {
	return {
		plugins: [
			{
				name: "fabric-strip-declaration-map-comments",
				generateBundle(_options, bundle) {
					for (const chunk of Object.values(bundle)) {
						if (
							chunk.type !== "chunk" ||
							!/\.d\.[cm]?ts$/.test(chunk.fileName)
						) {
							continue;
						}
						chunk.code = chunk.code.replace(
							/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm,
							"",
						);
					}
				},
			},
		],
		outputOptions: (options, _format, { cjsDts }) => ({
			...options,
			sourcemap: cjsDts ? false : options.sourcemap,
		}),
	};
}
