/**
 * Post-generate script to fix Decimal handling in generated Zod schemas
 * The prisma-zod-generator uses z.instanceof(Prisma.Decimal,..) which requires
 * importing Prisma from the generated client. This creates bundler issues with
 * Next.js Turbopack.
 * Instead of adding the Prisma import, we replace Prisma.Decimal usage with
 * z.string which is sufficient for validation (Prisma accepts string decimals).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ZOD_FILE = join(__dirname, "../prisma/zod/index.ts");

let content = readFileSync(ZOD_FILE, "utf-8");

const decimalReplacement =
	'z.union([z.string().regex(/^-?\\d+(\\.\\d+)?$/, { message: "Must be a valid decimal string" }), z.number()])';

const decimalPatterns = [
	/z\.instanceof\(Prisma\.Decimal,\s*\{[\s\S]*?\}\)/g,
	/z\.instanceof\(Prisma\.Decimal,\s*\{[\s\S]*?\}\)\.nullish\(\)/g,
];

let totalReplacements = 0;
for (const pattern of decimalPatterns) {
	const matches = content.match(pattern);
	if (!matches?.length) {
		continue;
	}
	totalReplacements += matches.length;
	content = content.replace(pattern, (match) => {
		return match.endsWith(".nullish()")
			? `${decimalReplacement}.nullish()`
			: decimalReplacement;
	});
}

if (totalReplacements > 0) {
	console.log(
		`Replaced ${totalReplacements} Prisma.Decimal usages with scalar-safe validators`,
	);
}

// prisma-zod-generator emits BigInt column defaults as string literals (e.g.
// `.default("0")`), but z.bigint.default expects a bigint. Wrap with BigInt
// rather than emitting a `0n` literal so the file stays compatible with the
// repo's ES6 tsconfig target (BigInt literals require ES2020+). Matches
// columns like `usedTokens BigInt @default(0)` on AiUsageLimitCounter.
const bigintDefaultPattern = /(z\.bigint\(\)[^\n]*\.default\()"(-?\d+)"(\))/g;
const bigintMatches = content.match(bigintDefaultPattern);
if (bigintMatches?.length) {
	content = content.replace(bigintDefaultPattern, (_m, head, num, tail) => {
		return `${head}BigInt(${num})${tail}`;
	});
	console.log(
		`Coerced ${bigintMatches.length} BigInt default literals to bigint`,
	);
}

// Remove any existing Prisma import if present (no longer needed)
if (content.includes("import { Prisma } from '../generated/client';")) {
	content = content.replace(
		"import { Prisma } from '../generated/client';\n",
		"",
	);
	console.log("Removed unused Prisma import from zod/index.ts");
}

writeFileSync(ZOD_FILE, content);
console.log("Fixed Decimal handling in zod/index.ts");
