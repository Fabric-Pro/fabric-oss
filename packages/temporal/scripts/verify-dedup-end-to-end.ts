/**
 * End-to-end verification of the AI Update duplicate-creation guard against
 * the local Postgres database via the real applyBacklogChanges activity.
 *
 * Why this exists: unit tests prove the structural gap is closed; this script
 * proves the same fix works against the actual DB write path with the real
 * createStoryFromProposal (classifier + plain createStory). No LLM keys are
 * required — the classifier returns its SAFE_FALLBACK when no provider is
 * configured, which is fine for this test.
 *
 * Lives in packages/temporal/scripts/ because the activity transitively
 * imports @repo/ai which is only fully resolvable from inside the temporal
 * package's node_modules hoist.
 *
 * Run:
 *   npx dotenv -c -e .env.local -- pnpm --filter @repo/temporal exec tsx scripts/verify-dedup-end-to-end.ts
 */
// The activity calls @temporalio/activity::heartbeat() at the top of every
// per-change iteration. That function reads the current Temporal Activity
// context from AsyncLocalStorage — outside a Temporal worker it throws
// "Activity context not initialized". Provide a minimal fake context with a
// no-op heartbeatFn so the activity runs unmodified end-to-end.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@repo/database/prisma/generated/client";
import { asyncLocalStorage } from "@temporalio/activity";
import {
	applyBacklogChanges,
	type ChangeProposal,
} from "../src/activities/backlog-context/analyze-context";

type ChangeItem = ChangeProposal["changes"][number];

function synthChange(
	title: string,
	type: "feature" | "bug",
	description: string,
): ChangeItem {
	return {
		action: "create",
		type,
		title: { to: title, from: null },
		description: { to: description, from: null },
		acceptanceCriteria: undefined,
		priority: { to: "P2_MEDIUM", from: null },
		size: { to: "M", from: null },
		parentEpicIdentifier: null,
		parentFeatureIdentifier: null,
		parentEpicTitle: null,
		parentFeatureTitle: null,
		existingExternalId: null,
		reasoning: "Synthetic — dedup verification",
		sourceContext: "multiple",
	};
}

async function main() {
	const adapter = new PrismaPg({
		connectionString: process.env.DATABASE_URL!,
	});
	const p = new PrismaClient({ adapter });

	const project = await p.project.findFirst({
		where: { storyStatuses: { some: { isDefault: true } } },
		select: {
			id: true,
			name: true,
			organizationId: true,
			userId: true,
		},
	});
	if (!project?.userId) {
		console.error(
			"No project with userId + default status found — run pnpm dev once and create one.",
		);
		await p.$disconnect();
		process.exit(2);
	}

	const stamp = Date.now();
	const tag = `INT-${stamp}`;
	const exactTitle = `${tag} Login crashes on Safari`;
	const prefixedTitle = `[BUG] ${tag} Pricing page misaligned`;
	const prefixedBareTitle = `${tag} Pricing page misaligned`;
	const inBatchTitle = `${tag} Desktop notifications for AI activity`;
	const novelTitle = `${tag} Novel feature with no collision`;

	console.log(`\nProject: "${project.name}" (${project.id})`);
	console.log(
		`Tenant: user=${project.userId} org=${project.organizationId ?? "personal"}`,
	);
	console.log(`Marker: ${tag}\n`);

	const baselineStatus = await p.projectStoryStatus.findFirst({
		where: { projectId: project.id, isDefault: true },
		select: { id: true },
	});
	if (!baselineStatus) {
		console.error("Project has no default story status; bailing.");
		await p.$disconnect();
		process.exit(2);
	}

	async function nextIdent(kind: "FEATURE" | "BUG") {
		const prefix = kind === "BUG" ? "B" : "F";
		const all = await p.userStory.findMany({
			where: {
				projectId: project!.id,
				identifier: { startsWith: `${prefix}-` },
			},
			select: { identifier: true },
		});
		const max = all
			.map((r) => Number.parseInt(r.identifier.split("-")[1] ?? "0", 10))
			.reduce((a, b) => Math.max(a, b), 0);
		return `${prefix}-${String(max + 1).padStart(3, "0")}`;
	}

	// --- Seed baselines ---------------------------------------------------------
	const baselineA = await p.userStory.create({
		data: {
			projectId: project.id,
			statusId: baselineStatus.id,
			identifier: await nextIdent("FEATURE"),
			title: exactTitle,
			kind: "FEATURE",
			priority: "P2_MEDIUM",
			order: 999000,
			roadmapOrder: 999000,
			createdById: project.userId,
			source: "MANUAL",
			draftingStage: "PLACEHOLDER",
			labels: [],
		},
		select: { id: true, identifier: true, title: true },
	});
	const baselineB = await p.userStory.create({
		data: {
			projectId: project.id,
			statusId: baselineStatus.id,
			identifier: await nextIdent("BUG"),
			title: prefixedTitle,
			kind: "BUG",
			priority: "P2_MEDIUM",
			order: 999001,
			roadmapOrder: 999001,
			createdById: project.userId,
			source: "MANUAL",
			draftingStage: "PLACEHOLDER",
			labels: ["bug"],
		},
		select: { id: true, identifier: true, title: true },
	});
	console.log(
		`Baseline A (FEATURE): ${baselineA.identifier} "${baselineA.title}"`,
	);
	console.log(
		`Baseline B (BUG [prefixed]): ${baselineB.identifier} "${baselineB.title}"\n`,
	);

	// --- Run the real activity --------------------------------------------------
	console.log("Calling applyBacklogChanges with 5 synthetic proposals…\n");
	// Context.heartbeat() (the public method called by the standalone
	// `heartbeat()` helper) delegates to .heartbeatFn internally, so we
	// need both fields on the fake context to satisfy either call path.
	const fakeActivityContext = {
		heartbeat: (..._args: unknown[]) => {
			/* no-op outside Temporal worker */
		},
		heartbeatFn: (..._args: unknown[]) => {
			/* no-op outside Temporal worker */
		},
	} as unknown as Parameters<typeof asyncLocalStorage.run>[0];
	const result = await asyncLocalStorage.run(fakeActivityContext, () =>
		applyBacklogChanges({
			projectId: project.id,
			userId: project.userId,
			organizationId: project.organizationId ?? undefined,
			approvedChanges: [
				// A: exact title collision with baseline A → DEDUPE expected
				synthChange(
					exactTitle,
					"feature",
					"Scenario A — proposed by LLM, same title as baseline A",
				),
				// B: prefix-stripped collision with baseline B → DEDUPE expected
				synthChange(
					prefixedBareTitle,
					"bug",
					"Scenario B — bare title vs [BUG]-prefixed baseline B",
				),
				// C: same change twice in one batch → 1 create, 1 dedupe
				synthChange(
					inBatchTitle,
					"feature",
					"Scenario C — first occurrence",
				),
				synthChange(
					inBatchTitle,
					"feature",
					"Scenario C — duplicate occurrence in same batch",
				),
				// D: novel title → MUST be created (regression guard)
				synthChange(
					novelTitle,
					"feature",
					"Scenario D — novel title, must create",
				),
			],
		}),
	);

	console.log("Activity result:");
	console.log(`  appliedCount: ${result.appliedCount}`);
	console.log(`  createdItems: ${result.createdItems.length}`);
	for (const ci of result.createdItems) {
		console.log(`    + ${ci.identifier} "${ci.title}"`);
	}
	console.log(`  errors: ${result.errors.length}`);
	for (const e of result.errors) {
		console.log(`    ! ${e.change.title.to}: ${e.error}`);
	}
	console.log();

	// --- Verify DB state --------------------------------------------------------
	const countOf = async (title: string) =>
		await p.userStory.count({
			where: { projectId: project!.id, title },
		});

	const exactCount = await countOf(exactTitle);
	const prefixedCount = await countOf(prefixedTitle);
	const prefixedBareCount = await countOf(prefixedBareTitle);
	const inBatchCount = await countOf(inBatchTitle);
	const novelCount = await countOf(novelTitle);

	type Check = {
		name: string;
		got: number;
		expected: number;
		mustExceed?: number;
	};
	const checks: Check[] = [
		{
			name: "A. exact-title CREATE blocked → only baseline A exists",
			got: exactCount,
			expected: 1,
		},
		{
			name: "B. [BUG]-prefix variant: prefixed baseline kept",
			got: prefixedCount,
			expected: 1,
		},
		{
			name: "B. [BUG]-prefix variant: bare-title duplicate NOT created",
			got: prefixedBareCount,
			expected: 0,
		},
		{
			name: "C. in-batch duplicate: exactly one row",
			got: inBatchCount,
			expected: 1,
		},
		{
			name: "D. novel title: created successfully",
			got: novelCount,
			expected: 1,
		},
	];

	console.log("Verification:");
	let allPassed = true;
	for (const c of checks) {
		const ok = c.got === c.expected;
		if (!ok) {
			allPassed = false;
		}
		console.log(
			`  ${ok ? "✓ PASS" : "✗ FAIL"} — ${c.name} (got ${c.got}, expected ${c.expected})`,
		);
	}

	// --- Cleanup ----------------------------------------------------------------
	const cleanup = await p.userStory.deleteMany({
		where: {
			projectId: project.id,
			title: { contains: tag },
		},
	});
	console.log(`\nCleanup: deleted ${cleanup.count} rows tagged ${tag}.\n`);

	await p.$disconnect();
	if (!allPassed) {
		console.error("INTEGRATION TEST FAILED — see ✗ entries above.\n");
		process.exit(1);
	}
	console.log("INTEGRATION TEST PASSED — dedup guard verified end-to-end.\n");
}

main().catch(async (e) => {
	console.error(e);
	process.exit(1);
});
