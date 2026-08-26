/**
 * Seed two baseline stories the E2E dedup test will collide against.
 * Prints JSON the Playwright script consumes: { stamp, exactTitle, prefixedTitle, prefixedBareTitle, inBatchTitle, novelTitle, projectId }.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client";

async function main() {
	const adapter = new PrismaPg({
		connectionString: process.env.DATABASE_URL!,
	});
	const p = new PrismaClient({ adapter });

	const project = await p.project.findFirst({
		where: { storyStatuses: { some: { isDefault: true } } },
		select: {
			id: true,
			userId: true,
			organizationId: true,
		},
	});
	if (!project?.userId) {
		console.error("No project found");
		process.exit(2);
	}

	const status = await p.projectStoryStatus.findFirst({
		where: { projectId: project.id, isDefault: true },
		select: { id: true },
	});
	if (!status) {
		console.error("No default status");
		process.exit(2);
	}

	const stamp = Date.now();
	const tag = `E2E-${stamp}`;
	const exactTitle = `${tag} Login crashes on Safari`;
	const prefixedTitle = `[BUG] ${tag} Pricing page misaligned`;
	const prefixedBareTitle = `${tag} Pricing page misaligned`;
	const inBatchTitle = `${tag} Desktop notifications`;
	const novelTitle = `${tag} Novel feature with no collision`;

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

	await p.userStory.create({
		data: {
			projectId: project.id,
			statusId: status.id,
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
	});
	await p.userStory.create({
		data: {
			projectId: project.id,
			statusId: status.id,
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
	});

	console.log(
		JSON.stringify({
			projectId: project.id,
			userId: project.userId,
			organizationId: project.organizationId,
			tag,
			stamp,
			exactTitle,
			prefixedTitle,
			prefixedBareTitle,
			inBatchTitle,
			novelTitle,
		}),
	);
	await p.$disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
