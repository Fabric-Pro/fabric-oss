/**
 * Read-only check of the feature duplicate matcher's Scope weighting against
 * the pairs people have reviewed. FOCUS_SECTION_WEIGHT and
 * FOCUS_CANDIDATE_MARGIN were tuned on the verifier's own verdicts; this
 * measures them against human decisions once enough exist.
 *
 * A reviewed feature pair is labelled by what the reviewer did with its flag:
 * the pair merged into one another is a duplicate, DISMISSED is not. Flags a
 * merge resolved only because they touched the merged item are left out.
 * Vectors are read as they are now, not as they were at review time. Only pairs whose two
 * features share a section with cached vectors from the same embedding model
 * are scored. For each weight it prints how well the weighted score separates
 * the two labels (ROC AUC; 0.5 is chance, 1 is perfect), and for the shipped
 * weight and margin how many of each label would be candidates.
 *
 * Writes nothing.
 *
 * Run against staging:
 *   DATABASE_URL='<staging-url>' pnpm tsx packages/database/scripts/evaluate-duplicate-focus-weight.ts [projectId]
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client";
import {
	CANDIDATE_COSINE_THRESHOLD,
	calibratedFocusScore,
	cosineSimilarity,
	effectiveCandidateThreshold,
	isProximatePair,
} from "../prisma/queries/projects/duplicate-detection";
import {
	choosePairFocusKind,
	FOCUS_SECTION_WEIGHT,
	PAIR_FOCUS_KINDS,
	type PairFocusKind,
	weightedFocusSimilarity,
} from "../prisma/queries/projects/duplicate-focus";

/** Below this many labelled pairs of either kind, the numbers are reported but
 * not worth acting on. */
const MIN_PAIRS_PER_LABEL = 20;

const WEIGHTS = [0, 0.25, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1];

type ScoredPair = {
	duplicate: boolean;
	focus: number;
	document: number;
	threshold: number;
};

/** Share of (duplicate, not-duplicate) pairs the score orders correctly,
 * ties counting half. */
function rocAuc(pairs: ScoredPair[], score: (p: ScoredPair) => number) {
	const positives = pairs.filter((p) => p.duplicate).map(score);
	const negatives = pairs.filter((p) => !p.duplicate).map(score);
	if (positives.length === 0 || negatives.length === 0) {
		return Number.NaN;
	}
	let wins = 0;
	for (const p of positives) {
		for (const n of negatives) {
			wins += p > n ? 1 : p === n ? 0.5 : 0;
		}
	}
	return wins / (positives.length * negatives.length);
}

function asVector(value: unknown): number[] | null {
	return Array.isArray(value) && value.every((v) => typeof v === "number")
		? value
		: null;
}

async function main() {
	const projectId = process.argv[2];
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error("DATABASE_URL is not set");
	}
	const adapter = new PrismaPg({ connectionString });
	const p = new PrismaClient({ adapter });
	try {
		const links = await p.storyDuplicateLink.findMany({
			where: {
				status: { in: ["RESOLVED", "DISMISSED"] },
				...(projectId ? { projectId } : {}),
				storyA: { kind: "FEATURE" },
				storyB: { kind: "FEATURE" },
			},
			select: {
				storyAId: true,
				storyBId: true,
				status: true,
				storyA: {
					select: { createdAt: true, mergedIntoStoryId: true },
				},
				storyB: {
					select: { createdAt: true, mergedIntoStoryId: true },
				},
			},
		});
		// A merge resolves every flag touching the merged item, including
		// flags against third items nobody judged; only the pair actually
		// merged is a reviewed duplicate.
		const reviewed = links.filter(
			(l) =>
				l.status === "DISMISSED" ||
				l.storyA.mergedIntoStoryId === l.storyBId ||
				l.storyB.mergedIntoStoryId === l.storyAId,
		);
		const collateral = links.length - reviewed.length;
		const storyIds = Array.from(
			new Set(reviewed.flatMap((l) => [l.storyAId, l.storyBId])),
		);
		const [documents, sections] = await Promise.all([
			p.storyDuplicateEmbedding.findMany({
				where: { storyId: { in: storyIds } },
				select: { storyId: true, model: true, embedding: true },
			}),
			p.storyDuplicateFocusEmbedding.findMany({
				where: { storyId: { in: storyIds } },
				select: {
					storyId: true,
					kind: true,
					model: true,
					embedding: true,
				},
			}),
		]);
		const documentById = new Map(documents.map((d) => [d.storyId, d]));
		const sectionsById = new Map<
			string,
			Partial<Record<PairFocusKind, { model: string; vector: number[] }>>
		>();
		for (const s of sections) {
			const vector = asVector(s.embedding);
			const kind = PAIR_FOCUS_KINDS.find((k) => k === s.kind);
			if (vector && kind) {
				sectionsById.set(s.storyId, {
					...sectionsById.get(s.storyId),
					[kind]: { model: s.model, vector },
				});
			}
		}

		const scored: ScoredPair[] = [];
		let skipped = 0;
		for (const link of reviewed) {
			const docA = documentById.get(link.storyAId);
			const docB = documentById.get(link.storyBId);
			const vectorA = asVector(docA?.embedding);
			const vectorB = asVector(docB?.embedding);
			const sectionsA = sectionsById.get(link.storyAId);
			const sectionsB = sectionsById.get(link.storyBId);
			const kind = choosePairFocusKind(sectionsA, sectionsB);
			const focusA = kind ? sectionsA?.[kind] : undefined;
			const focusB = kind ? sectionsB?.[kind] : undefined;
			if (
				!docA ||
				!docB ||
				!vectorA ||
				!vectorB ||
				!focusA ||
				!focusB ||
				new Set([docA.model, docB.model, focusA.model, focusB.model])
					.size !== 1
			) {
				skipped += 1;
				continue;
			}
			scored.push({
				duplicate: link.status === "RESOLVED",
				focus: cosineSimilarity(focusA.vector, focusB.vector),
				document: cosineSimilarity(vectorA, vectorB),
				threshold: effectiveCandidateThreshold(
					isProximatePair(
						link.storyA.createdAt,
						link.storyB.createdAt,
					),
				),
			});
		}

		const duplicates = scored.filter((s) => s.duplicate).length;
		const distinct = scored.length - duplicates;
		console.log(
			`Reviewed feature pairs: ${reviewed.length} (plus ${collateral} resolved only because a merge touched them); scored: ${scored.length} (${duplicates} merged, ${distinct} dismissed); skipped (no shared section or mixed models): ${skipped}`,
		);
		console.log("\nROC AUC by section weight (0 = whole document only):");
		for (const weight of WEIGHTS) {
			const auc = rocAuc(scored, (s) =>
				weightedFocusSimilarity(s.focus, s.document, weight),
			);
			const marker = weight === FOCUS_SECTION_WEIGHT ? "  ← shipped" : "";
			const shown = Number.isNaN(auc) ? "n/a" : auc.toFixed(3);
			console.log(`  ${weight.toFixed(2)}  ${shown}${marker}`);
		}

		const candidate = (s: ScoredPair) =>
			calibratedFocusScore(
				weightedFocusSimilarity(s.focus, s.document),
				s.threshold,
			) >= s.threshold;
		const byDocument = (s: ScoredPair) => s.document >= s.threshold;
		const count = (duplicate: boolean, rule: (s: ScoredPair) => boolean) =>
			scored.filter((s) => s.duplicate === duplicate && rule(s)).length;
		console.log(
			`\nCandidates at threshold ${CANDIDATE_COSINE_THRESHOLD} (shipped weight and margin vs whole document):`,
		);
		console.log(
			`  merged:    ${count(true, candidate)}/${duplicates} vs ${count(true, byDocument)}/${duplicates}`,
		);
		console.log(
			`  dismissed: ${count(false, candidate)}/${distinct} vs ${count(false, byDocument)}/${distinct}`,
		);
		if (
			duplicates < MIN_PAIRS_PER_LABEL ||
			distinct < MIN_PAIRS_PER_LABEL
		) {
			console.log(
				`\nFewer than ${MIN_PAIRS_PER_LABEL} pairs of each label: too few to retune on.`,
			);
		}
	} finally {
		await p.$disconnect();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
