/**
 * Scans every project for UserStory rows whose titles collide pair-wise.
 * Two stories are considered a "duplicate pair" when their normalized titles
 * match exactly, where normalization is:
 *   - lowercase
 *   - trim
 *   - strip a leading "[BUG] " prefix (the pre-#1041 convention)
 *
 * Reports each colliding pair with timestamps so you can see whether the
 * duplicate was created BEFORE or AFTER PR #1041 (squash-merged 2026-05-19).
 *
 * Run against local: pnpm tsx packages/database/scripts/find-duplicate-stories.ts
 * Run against staging: DATABASE_URL='<staging-url>' pnpm tsx packages/database/scripts/find-duplicate-stories.ts
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client";

// PR #1041 squash commit: 2026-05-19. Duplicates created at/after this date
// could plausibly be triggered by the [BUG]-prefix-drop vector. Earlier ones
// are purely the pre-existing dedup gap.
const PR_1041_MERGE_DATE = new Date("2026-05-19T00:00:00Z");

function normalizeTitle(t: string): string {
	return t
		.toLowerCase()
		.trim()
		.replace(/^\[bug\]\s+/i, "")
		.trim();
}

async function main() {
	const adapter = new PrismaPg({
		connectionString: process.env.DATABASE_URL!,
	});
	const p = new PrismaClient({ adapter });

	const projects = await p.project.findMany({
		select: {
			id: true,
			name: true,
			organization: { select: { slug: true, name: true } },
		},
	});

	const allCollisions: Array<{
		projectId: string;
		projectName: string;
		orgSlug: string | null;
		normalizedTitle: string;
		members: Array<{
			id: string;
			identifier: string;
			title: string;
			kind: string;
			source: string;
			createdAt: Date;
		}>;
	}> = [];

	for (const project of projects) {
		const stories = await p.userStory.findMany({
			where: { projectId: project.id },
			select: {
				id: true,
				identifier: true,
				title: true,
				kind: true,
				source: true,
				createdAt: true,
			},
		});

		const byKey = new Map<string, typeof stories>();
		for (const s of stories) {
			const key = normalizeTitle(s.title);
			if (!key) {
				continue;
			}
			const arr = byKey.get(key) ?? [];
			arr.push(s);
			byKey.set(key, arr);
		}

		for (const [key, members] of byKey) {
			if (members.length < 2) {
				continue;
			}
			allCollisions.push({
				projectId: project.id,
				projectName: project.name,
				orgSlug: project.organization?.slug ?? null,
				normalizedTitle: key,
				members: members.sort(
					(a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
				),
			});
		}
	}

	console.log(
		`\nScanned ${projects.length} projects. Found ${allCollisions.length} collision groups.\n`,
	);

	if (allCollisions.length === 0) {
		await p.$disconnect();
		return;
	}

	// Bucket by likely origin so the report leads with the most informative cases.
	const aiUpdateInvolved: typeof allCollisions = [];
	const allManual: typeof allCollisions = [];
	const mixed: typeof allCollisions = [];
	const post1041: typeof allCollisions = [];

	for (const c of allCollisions) {
		const sources = new Set(c.members.map((m) => m.source));
		const anyAiUpdate = sources.has("AI_UPDATE");
		const anyApprovedProposal = sources.has("APPROVED_PROPOSAL");
		const aiInvolved = anyAiUpdate || anyApprovedProposal;
		const allAi =
			c.members.every((m) => m.source === "AI_UPDATE") ||
			c.members.every((m) => m.source === "APPROVED_PROPOSAL");
		const anyPost1041 = c.members.some(
			(m) => m.createdAt >= PR_1041_MERGE_DATE,
		);

		if (anyPost1041 && aiInvolved) {
			post1041.push(c);
		}
		if (aiInvolved && !allAi) {
			mixed.push(c);
		} else if (aiInvolved) {
			aiUpdateInvolved.push(c);
		} else {
			allManual.push(c);
		}
	}

	const print = (label: string, group: typeof allCollisions) => {
		if (group.length === 0) {
			return;
		}
		console.log(`\n========== ${label} (${group.length}) ==========\n`);
		for (const c of group) {
			console.log(
				`[${c.orgSlug ?? "?"}] ${c.projectName} (${c.projectId.slice(-8)})`,
			);
			console.log(`  Normalized title: "${c.normalizedTitle}"`);
			for (const m of c.members) {
				const tag =
					m.createdAt >= PR_1041_MERGE_DATE
						? "POST-1041"
						: "pre-1041";
				console.log(
					`    ${m.identifier} [${m.kind}/${m.source}] [${tag}] "${m.title}" — ${m.createdAt.toISOString()}`,
				);
			}
		}
	};

	print(
		"POST-PR#1041 + AI-UPDATE involved (most suspicious — likely the new vector)",
		post1041,
	);
	print(
		`MIXED: AI source paired with non-AI source (LLM didn't recognize manual item)`,
		mixed,
	);
	print(
		"ALL-AI source (analyzer re-proposed the same item across runs)",
		aiUpdateInvolved,
	);
	print("ALL-MANUAL (user duplication, unrelated to AI Update)", allManual);

	console.log(
		`\nSummary: ${post1041.length} post-#1041 AI-involved, ${mixed.length} mixed, ${aiUpdateInvolved.length} all-AI, ${allManual.length} all-manual.\n`,
	);

	await p.$disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
