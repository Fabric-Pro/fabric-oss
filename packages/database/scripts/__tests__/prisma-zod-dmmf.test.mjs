import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const source = readFileSync(
	join(
		dirname(require.resolve("prisma-zod-generator/package.json")),
		"lib/prisma-generator.js",
	),
	"utf8",
);
const expression = source.match(
	/const prismaClientDmmf = ([\s\S]*?);\s*\/\/ Load and process configuration/,
)?.[1];
assert.ok(expression, "review the Zod DMMF patch after upgrading");

function resolveDmmf(options, getDMMF) {
	return runInNewContext(`(async () => (${expression}))()`, {
		options,
		internals_1: { getDMMF },
		prismaClientGeneratorConfig: { previewFeatures: [] },
	});
}

test("Zod reuses Prisma's supplied DMMF without starting another engine", async () => {
	const dmmf = { datamodel: { models: [] } };
	const result = await resolveDmmf({ dmmf }, () => {
		throw new Error("redundant DMMF generation");
	});
	assert.equal(result, dmmf);
});

test("Zod retains generation fallback when no DMMF is supplied", async () => {
	const dmmf = { datamodel: { models: [] } };
	let calls = 0;
	const result = await resolveDmmf(
		{ datamodel: "model Example {}" },
		(args) => {
			calls++;
			assert.equal(args.datamodel, "model Example {}");
			return dmmf;
		},
	);
	assert.equal(calls, 1);
	assert.equal(result, dmmf);
});
