import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve("prisma/build/index.js"), "utf8");
// Prisma bundles this private graph walker twice (JS and TS generators).
// Exercise both installed copies so a missing dependency patch fails the test.
const walkers = [
	...source.matchAll(
		/class\{constructor\(\w+\)\{this\._dmmf=\w+\}_cache=new (\w+);typeNeedsGenericModelArg[\s\S]*?\}_cacheResultsForTree\(\w+\)\{[\s\S]*?\}\}/g,
	),
];
assert.equal(walkers.length, 2, "review the Prisma patch after upgrading");

class Cache {
	values = new Map();
	get(key) {
		return this.values.get(key);
	}
	set(key, value) {
		this.values.set(key, value);
	}
	getOrCreate(key, create) {
		if (!this.values.has(key)) {
			this.set(key, create());
		}
		return this.get(key);
	}
}

for (const [index, match] of walkers.entries()) {
	const Walker = runInNewContext(
		`Array.prototype.shift = () => { throw new Error("quadratic queue movement"); }; (${match[0]})`,
		{ [match[1]]: Cache },
	);
	const ref = (type) => ({ location: "inputObjectTypes", type });
	const fieldRef = { location: "fieldRefTypes", type: "IntFieldRefInput" };
	const input = (name, inputTypes = [], meta = undefined) => ({
		name,
		fields: [{ inputTypes }],
		meta,
	});
	const walker = (types) =>
		new Walker({ resolveInputObjectType: (r) => types.get(r.type) });

	test(`Prisma graph walker ${index}: cycles, field refs, model sources and cache`, () => {
		const types = new Map([
			["a", input("a", [ref("b"), ref("c")])],
			["b", input("b", [ref("a")])],
			["c", input("c", [fieldRef])],
			["scalar", input("scalar")],
			["model", input("model", [fieldRef], { source: "Example" })],
		]);
		const info = walker(types);
		assert.equal(info.typeNeedsGenericModelArg(types.get("a")), true);
		assert.equal(info.typeNeedsGenericModelArg(types.get("b")), true);
		assert.equal(info.typeNeedsGenericModelArg(types.get("c")), true);
		assert.equal(info.typeNeedsGenericModelArg(types.get("scalar")), false);
		assert.equal(info.typeNeedsGenericModelArg(types.get("model")), false);
		assert.equal(info.typeRefNeedsGenericModelArg(fieldRef), true);
		assert.equal(info.typeRefNeedsGenericModelArg(ref("missing")), false);
		assert.equal(info.typeNeedsGenericModelArg(types.get("a")), true);
	});

	test(`Prisma graph walker ${index}: dense cyclic schema avoids array shifts`, () => {
		const types = new Map(
			Array.from({ length: 300 }, (_, i) => [
				String(i),
				input(String(i)),
			]),
		);
		const refs = [...types.keys()].map(ref);
		for (const value of types.values()) {
			value.fields[0].inputTypes = refs;
		}
		const info = walker(types);
		for (const value of types.values()) {
			assert.equal(info.typeNeedsGenericModelArg(value), false);
		}
	});
}
