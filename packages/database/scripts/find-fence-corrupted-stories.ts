/**
 * Finds feature specs whose fenced code blocks may hold text the AI-diff
 * accept path concatenated instead of replacing.
 *
 * The defect: accepting an AI edit inside a ``` fence saved the deleted value
 * joined onto its replacement (`const timeout = 30` edited to `90` saved as
 * `3090`). The diff delete marker is a ProseMirror mark, code blocks forbade
 * marks, so the marker was dropped on parse and nothing was left to strip on
 * accept. Fixed for new saves; rows written before the fix still hold the
 * joined text.
 *
 * WHAT THIS DOES AND DOES NOT DO. It cannot prove corruption: `3090` is a
 * perfectly legal number, and the original value is not recoverable from the
 * current row alone. What it does is narrow the search. It reports stories that
 * are *reachable* by the defect (a fence, plus an AI edit in the window) and,
 * where a FeatureVersion snapshot exists either side of an edit, flags fences
 * where a token grew by having another token appended to it — the shape the bug
 * leaves behind.
 *
 * Read-only. It writes nothing.
 *
 * Local:    pnpm tsx packages/database/scripts/find-fence-corrupted-stories.ts
 * Staging:  DATABASE_URL='<staging-url>' pnpm tsx packages/database/scripts/find-fence-corrupted-stories.ts
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client";

/**
 * The mark-dropping behaviour is present in the diff/accept path from the
 * commit that introduced it. Anything edited before this date cannot have been
 * corrupted by THIS defect, so the window bounds the review set.
 */
const DEFECT_INTRODUCED = new Date("2026-06-15T00:00:00Z");

/** Fenced blocks, capturing the body. */
const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g;

/** A word of 5+ chars immediately repeated. Case-insensitive; see doubledWords. */
const DOUBLED_WORD_RE = /(\w{5,}?)\1+/gi;

/** One character repeated (`XXXXXXXX`) is placeholder text, not damage. */
const SINGLE_CHAR_RUN_RE = /^(.)\1*$/;
/** Markdown list markers, which legitimately carry wide indentation. */
const LIST_ITEM_RE = /^([-*+]|\d+[.)])\s/;

/** A run of spaces mid-line, where a newline used to be. */
const WELD_RUN_RE = /\S {3,}\S/;

/** Tokens that end a statement in the languages these fences hold. */
const STATEMENT_TOKENS = ["-->", ";", "{"];

/** How many stories' version snapshots to fetch per round trip. */
const STORY_CHUNK = 25;

export function fenceBodies(markdown: string | null | undefined): string[] {
	if (!markdown) {
		return [];
	}
	const out: string[] = [];
	FENCE_RE.lastIndex = 0;
	let m = FENCE_RE.exec(markdown);
	while (m !== null) {
		out.push(m[1]);
		m = FENCE_RE.exec(markdown);
	}
	return out;
}

/**
 * Did a token in `before` become a strict prefix of a longer token in `after`,
 * at the same position? That is the concatenation signature: `30` -> `3090`,
 * `3` -> `37`, `B` -> `BC`. Compared token-wise so ordinary rewrites, which
 * change whole lines, do not trip it.
 *
 * Trailing punctuation is stripped before comparing, because the joined value
 * lands INSIDE it: `const timeout = 30;` becomes `3090;`, and a raw prefix test
 * against `30;` misses that entirely. That miss would have hidden the very case
 * the defect was reported for.
 */
export function concatenationSuspects(
	before: string,
	after: string,
): Array<{ from: string; to: string }> {
	// Drop trailing punctuation so `30;` and `3090;` compare as `30` and `3090`.
	const core = (t: string) => t.replace(/[^\p{L}\p{N}_]+$/u, "");
	const b = before.split(/(\s+)/);
	const a = after.split(/(\s+)/);
	const hits: Array<{ from: string; to: string }> = [];
	const limit = Math.min(b.length, a.length);
	for (let i = 0; i < limit; i += 1) {
		const from = b[i];
		const to = a[i];
		if (!from || !to || from === to || from.trim().length === 0) {
			continue;
		}
		const fromCore = core(from);
		const toCore = core(to);
		if (
			fromCore.length > 0 &&
			toCore.startsWith(fromCore) &&
			toCore.length > fromCore.length
		) {
			hits.push({ from, to });
		}
	}
	return hits;
}

/**
 * Lines inside a fence that look like several statements welded onto one.
 *
 * This is the signature that actually survives in a live row. When the accept
 * path dropped the delete marker it also lost the newline between the deleted
 * text and its replacement, so a block that was many lines becomes one very
 * long line with runs of spaces where the newlines were.
 *
 * Two conditions must both hold, because either alone is noisy:
 *
 *  - a run of 3+ spaces mid-line (the collapsed newline), and
 *  - the same statement-boundary token twice (`-->`, `;` or `{`), meaning the
 *    line really does carry more than one statement.
 *
 * Requiring both keeps out the things that legitimately contain wide gaps:
 * aligned assignments, ASCII tables, and indented markdown list items (those
 * are skipped outright).
 *
 * Known false positive: a hand-written one-liner that genuinely holds two
 * statements and some alignment. Rare, and the caller reviews by hand anyway.
 */
export function weldedLines(fenceBody: string): string[] {
	const out: string[] = [];
	for (const raw of fenceBody.split("\n")) {
		const line = raw.trim();
		if (LIST_ITEM_RE.test(line) || !WELD_RUN_RE.test(line)) {
			continue;
		}
		const multiStatement = STATEMENT_TOKENS.some(
			(token) => line.split(token).length - 1 >= 2,
		);
		if (multiStatement) {
			out.push(line);
		}
	}
	return out;
}

/**
 * A word immediately repeated with no separator: `switchesswitches`,
 * `trivytrivy`, `attachmentsAttachments`.
 *
 * This is the shape the defect leaves in ORDINARY PROSE, where there is no
 * newline to collapse and no statement punctuation to weld — so neither of the
 * detectors above can see it. Running the audit against production found three
 * damaged specs; the snapshot diff caught one and the welded-line check caught
 * none, because the damage was word-level with the line structure intact.
 *
 * Matching is CASE-INSENSITIVE on purpose, which costs false positives:
 * `firecrawlCrawlActivity` reads as `crawl`+`Crawl` and is an ordinary
 * identifier. Case-sensitive matching would drop those, but it would also drop
 * `attachmentsAttachments`, which IS real damage — the replacement text was
 * capitalised because it began a clause. Since one real hit and one false hit
 * are the same shape, no regex separates them; the caller reads the
 * surrounding text, which `contextFor` supplies.
 */
export function doubledWords(text: string | null | undefined): string[] {
	if (!text) {
		return [];
	}
	return [
		...new Set(
			[...text.matchAll(DOUBLED_WORD_RE)]
				.map((m) => m[0])
				// A run of one character (`XXXXXXXX`) is placeholder text, not damage.
				.filter((hit) => !SINGLE_CHAR_RUN_RE.test(hit)),
		),
	];
}

/** The surrounding text for a hit, so a reader can judge it without a query. */
export function contextFor(text: string, hit: string, radius = 90): string {
	const at = text.indexOf(hit);
	if (at === -1) {
		return "";
	}
	return text
		.slice(Math.max(0, at - radius), at + hit.length + radius)
		.replace(/\s+/g, " ")
		.trim();
}
async function main() {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error("DATABASE_URL is not set");
	}
	const prisma = new PrismaClient({
		adapter: new PrismaPg({ connectionString }),
	});

	const stories = await prisma.userStory.findMany({
		// Every story touched in the window, NOT only those with a fence: the
		// word-level damage doubledWords() finds occurs in ordinary prose too, and
		// filtering on ``` here is what hid two of production's three damaged rows.
		where: { updatedAt: { gte: DEFECT_INTRODUCED } },
		select: {
			id: true,
			identifier: true,
			title: true,
			projectId: true,
			description: true,
			lastEditedSource: true,
			lastEditedAt: true,
			updatedAt: true,
		},
	});

	console.log(
		`Stories touched since ${DEFECT_INTRODUCED.toISOString().slice(0, 10)}: ${stories.length}`,
	);

	let flagged = 0;
	// Snapshots are fetched a chunk of stories at a time rather than one story at
	// a time. Per-story it is one round trip per row: unnoticeable against a local
	// Postgres, slow enough against a managed one to look hung. Chunking also
	// bounds how many descriptions are held in memory at once.
	for (let c = 0; c < stories.length; c += STORY_CHUNK) {
		const chunk = stories.slice(c, c + STORY_CHUNK);
		const chunkVersions = await prisma.featureVersion.findMany({
			where: { storyId: { in: chunk.map((s) => s.id) } },
			orderBy: [{ storyId: "asc" }, { version: "asc" }],
			select: { storyId: true, version: true, description: true },
		});
		const versionsByStory = new Map<
			string,
			Array<{ version: number; description: string | null }>
		>();
		for (const v of chunkVersions) {
			const list = versionsByStory.get(v.storyId) ?? [];
			list.push({ version: v.version, description: v.description });
			versionsByStory.set(v.storyId, list);
		}

		for (const story of chunk) {
			const versions = versionsByStory.get(story.id) ?? [];

			// Walk consecutive snapshots, then the last snapshot against the live
			// row, so an edit that has not been snapshotted yet is still compared.
			const timeline = [
				...versions.map((v) => ({
					label: `v${v.version}`,
					text: v.description,
				})),
				{ label: "current", text: story.description },
			];

			const hits: Array<{ at: string; from: string; to: string }> = [];
			for (let i = 1; i < timeline.length; i += 1) {
				const beforeFences = fenceBodies(timeline[i - 1].text);
				const afterFences = fenceBodies(timeline[i].text);
				const pairs = Math.min(beforeFences.length, afterFences.length);
				for (let f = 0; f < pairs; f += 1) {
					for (const hit of concatenationSuspects(
						beforeFences[f],
						afterFences[f],
					)) {
						hits.push({
							at: `${timeline[i - 1].label}→${timeline[i].label}`,
							...hit,
						});
					}
				}
			}

			if (hits.length > 0) {
				flagged += 1;
				console.log(
					`\n${story.identifier ?? story.id}  ${story.title}` +
						`\n  project ${story.projectId}  lastEdited ${story.lastEditedSource ?? "unknown"} ${story.lastEditedAt?.toISOString() ?? ""}`,
				);
				for (const hit of hits.slice(0, 8)) {
					console.log(`    ${hit.at}: "${hit.from}" -> "${hit.to}"`);
				}
				if (hits.length > 8) {
					console.log(`    ...and ${hits.length - 8} more`);
				}
			}
		}
	}

	// Second, independent pass, and the one that finds damage still sitting in
	// a live row. The snapshot diff above only sees a story whose history
	// happens to straddle the bad edit; a row corrupted before its first
	// snapshot, or whose snapshots were pruned, shows up here and nowhere else.
	const welded: Array<{ label: string; lines: string[] }> = [];
	for (const story of stories) {
		const lines = fenceBodies(story.description).flatMap(weldedLines);
		if (lines.length > 0) {
			welded.push({
				label: `${story.identifier ?? story.id}  ${story.title}`,
				lines,
			});
		}
	}

	if (welded.length > 0) {
		console.log(
			"\n\nWelded lines in a CURRENT row (statements run together on one line):",
		);
		for (const entry of welded) {
			console.log(`\n  ${entry.label}`);
			for (const line of entry.lines.slice(0, 3)) {
				console.log(`    ${line.slice(0, 160)}`);
			}
		}
	}

	// Third pass: word-level doubling, anywhere in the description. This is the
	// only signal that sees damage in prose, and the only one that caught the
	// majority of production's damaged rows.
	const doubled: Array<{ label: string; hits: string[]; desc: string }> = [];
	for (const story of stories) {
		const hits = doubledWords(story.description);
		if (hits.length > 0) {
			doubled.push({
				label: `${story.identifier ?? story.id}  ${story.title}`,
				hits,
				desc: story.description ?? "",
			});
		}
	}

	if (doubled.length > 0) {
		console.log("\n\nDoubled words (a word repeated with no separator).");
		console.log(
			"Read the context: an ordinary camelCase identifier looks identical.",
		);
		for (const entry of doubled) {
			console.log(`\n  ${entry.label}`);
			for (const hit of entry.hits.slice(0, 4)) {
				console.log(`    "${hit}"`);
				console.log(`      ...${contextFor(entry.desc, hit)}...`);
			}
		}
	}
	console.log(
		`\nFlagged ${flagged} of ${stories.length} by snapshot diff, ${welded.length} by welded line, ${doubled.length} by doubled word.` +
			"\nEach flag is a CANDIDATE, not a proven corruption: a token that grew by" +
			"\nappending is the bug's signature, but a human edit can look identical." +
			"\nCheck the flagged fence against its FeatureVersion history before changing anything.",
	);

	await prisma.$disconnect();
}

if (process.env.VITEST === undefined) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
