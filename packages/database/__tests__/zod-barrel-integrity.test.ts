import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// CI's regeneration/diff guard requires the repository's generation pipeline.
// These checks also catch unrepaired Decimal validators and defaults locally.
describe("generated zod barrel", () => {
	const barrel = readFileSync(
		join(__dirname, "../prisma/zod/index.ts"),
		"utf8",
	);

	it("contains no unpatched Prisma.Decimal references", () => {
		expect(barrel).not.toContain("Prisma.Decimal");
	});

	it("the staged-content guard rejects both generator Decimal forms", () => {
		const hook = readFileSync(
			join(__dirname, "../../../.githooks/pre-commit"),
			"utf8",
		);
		const pattern = hook.match(/grep -q '([^']*Prisma[^']*)'/)?.[1];
		if (!pattern) {
			throw new Error(
				"The staged-content guard has no Prisma Decimal pattern",
			);
		}
		for (const raw of [
			"z.instanceof(Prisma.Decimal, {})",
			"z.custom<InstanceType<typeof Prisma.Decimal>>((v) => Prisma.Decimal.isDecimal(v), {})",
		]) {
			expect(
				spawnSync("grep", ["-q", pattern], { input: raw }).status,
			).toBe(0);
		}
	});

	it("imports cleanly", async () => {
		const mod = await import("../prisma/zod/index.js");
		expect(Object.keys(mod).length).toBeGreaterThan(0);
	});

	it("keeps decimal fields compatible with scalar API values", async () => {
		const { AiCreditAccountSchema, AgentDeploymentMetricsSchema } =
			await import("../prisma/zod/index.js");
		const decimal = AiCreditAccountSchema.shape.usedCreditUsd;
		expect(decimal.parse("12.50")).toBe("12.50");
		expect(decimal.parse(12.5)).toBe(12.5);
		expect(decimal.safeParse("invalid").success).toBe(false);
		expect(
			AgentDeploymentMetricsSchema.shape.totalCost.parse(null),
		).toBeNull();
	});

	it("preserves existing JSON defaults when input is omitted", async () => {
		const { AiChatSchema, DocumentChunkSchema } = await import(
			"../prisma/zod/index.js"
		);
		expect(AiChatSchema.shape.messages.parse(undefined)).toBe("[]");
		expect(DocumentChunkSchema.shape.metadata.parse(undefined)).toBe("{}");
		expect(AiChatSchema.shape.messages.parse([{ role: "user" }])).toEqual([
			{ role: "user" },
		]);
	});
});
