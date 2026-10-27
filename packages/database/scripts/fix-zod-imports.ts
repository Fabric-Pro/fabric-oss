/**
 * Preserve scalar Decimal validation and JSON defaults in generated Zod schemas.
 * The prisma-zod-generator's Decimal validators require
 * importing Prisma from the generated client. This creates bundler issues with
 * Next.js Turbopack.
 * Instead of adding the Prisma import, we replace Prisma.Decimal usage with
 * string/number validators (Prisma accepts scalar decimal values).
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
	/z\.custom<InstanceType<typeof Prisma\.Decimal>>\(\(\w+\) => Prisma\.Decimal\.isDecimal\(\w+\),\s*\{[\s\S]*?\}\)/g,
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

// Preserve the existing JSON-string defaults for empty JSON fields. Generator
// 3.x emits parsed arrays/objects; changing omitted-input results belongs in a
// separate API contract change, rather than a dependency upgrade.
content = content.replace(
	/(z\.unknown\(\)[^\n]*\.default\()(\[\]|\{\})(\))/g,
	(_match, head, value, tail) => `${head}${JSON.stringify(value)}${tail}`,
);

// Decimal repairs leave no Prisma references, so drop the generator's import.
const prismaImport =
	/import \{ Prisma \} from ['"]\.\.\/generated\/(?:client|browser)['"];\r?\n/g;
if (prismaImport.test(content)) {
	content = content.replace(prismaImport, "");
	console.log("Removed unused Prisma import from zod/index.ts");
}

writeFileSync(ZOD_FILE, content);
console.log("Fixed Decimal handling in zod/index.ts");
