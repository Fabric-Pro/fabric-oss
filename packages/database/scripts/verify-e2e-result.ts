/** Verify the E2E dedup scenarios produced expected DB state. */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client";

const tag = process.argv[2];
if (!tag) {
	console.error("Usage: verify-e2e-result.ts <E2E-tag>");
	process.exit(2);
}

async function main() {
	const adapter = new PrismaPg({
		connectionString: process.env.DATABASE_URL!,
	});
	const p = new PrismaClient({ adapter });

	const project = await p.project.findFirst({
		where: { storyStatuses: { some: { isDefault: true } } },
		select: { id: true },
	});
	if (!project) {
		console.error("No project");
		process.exit(2);
	}

	const rows = await p.userStory.findMany({
		where: {
			projectId: project.id,
			OR: [
				{ title: { contains: tag } },
				{ title: { startsWith: `[BUG] ${tag}` } },
			],
		},
		select: {
			identifier: true,
			title: true,
			kind: true,
			source: true,
			createdAt: true,
		},
		orderBy: { createdAt: "asc" },
	});

	console.log(`\nFound ${rows.length} rows tagged ${tag}:`);
	for (const r of rows) {
		console.log(
			`  ${r.identifier} [${r.kind}/${r.source}] "${r.title}" — ${r.createdAt.toISOString()}`,
		);
	}

	// Expected: 2 baselines (exact + prefixed) + 2 new (in-batch first + novel) = 4 rows.
	// MUST NOT exist: dedup'd duplicates (A duplicate, B bare, C second occurrence) = 0 new rows for those titles.
	const exactCount = rows.filter(
		(r) => r.title === `${tag} Login crashes on Safari`,
	).length;
	const prefixedCount = rows.filter(
		(r) => r.title === `[BUG] ${tag} Pricing page misaligned`,
	).length;
	const prefixedBareCount = rows.filter(
		(r) => r.title === `${tag} Pricing page misaligned`,
	).length;
	const inBatchCount = rows.filter(
		(r) => r.title === `${tag} Desktop notifications`,
	).length;
	const novelCount = rows.filter(
		(r) => r.title === `${tag} Novel feature with no collision`,
	).length;

	const checks = [
		{
			name: "A. exact-title CREATE blocked → only baseline (1 row)",
			got: exactCount,
			expected: 1,
		},
		{
			name: "B. prefixed baseline kept",
			got: prefixedCount,
			expected: 1,
		},
		{
			name: "B. bare-title duplicate NOT created",
			got: prefixedBareCount,
			expected: 0,
		},
		{
			name: "C. in-batch duplicate → exactly 1 row",
			got: inBatchCount,
			expected: 1,
		},
		{
			name: "D. novel title created",
			got: novelCount,
			expected: 1,
		},
	];

	console.log("\nVerification:");
	let allPassed = true;
	for (const c of checks) {
		const ok = c.got === c.expected;
		if (!ok) {
			allPassed = false;
		}
		console.log(
			`  ${ok ? "PASS" : "FAIL"} — ${c.name} (got ${c.got}, expected ${c.expected})`,
		);
	}

	// Cleanup
	const cleanup = await p.userStory.deleteMany({
		where: {
			projectId: project.id,
			OR: [
				{ title: { contains: tag } },
				{ title: { startsWith: `[BUG] ${tag}` } },
			],
		},
	});
	console.log(`\nCleanup: deleted ${cleanup.count} test rows.`);

	await p.$disconnect();
	if (!allPassed) {
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
