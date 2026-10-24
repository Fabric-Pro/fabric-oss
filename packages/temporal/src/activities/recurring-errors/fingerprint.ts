/**
 * Stable identities for recurring problems. PURE — no I/O, no clock.
 *
 * A recurring error is one failure logged many times with different request
 * ids, timestamps and values each time. Its fingerprint must be the same for
 * every occurrence and for every scan, or a rescan would file the same problem
 * again; and it must differ between genuinely different failures, or two bugs
 * would collapse into one proposal.
 */
import { createHash } from "node:crypto";
import type { RawErrorGroup } from "@repo/ai/lib/log-context";

/** How much of a normalized message identifies it. */
const MAX_NORMALIZED_CHARS = 300;
const MAX_MERGED_SAMPLES = 3;
const MAX_MERGED_COMPONENTS = 5;

/**
 * Ordered: each pattern runs on the output of the one before, so a URL is
 * masked whole before its digits could be, and a timestamp before its numbers.
 */
const MASKS: Array<[RegExp, string]> = [
	[/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>"],
	[/\?[^\s"'<>]*/g, "<query>"],
	[
		/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?/gi,
		"<ts>",
	],
	[
		/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
		"<id>",
	],
	[/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>"],
	// A quote that opens after a non-word character, so an apostrophe inside
	// a word ("can't") does not start one.
	[/(^|[^\w])"[^"\n]*"/g, '$1"<v>"'],
	[/(^|[^\w])'[^'\n]*'/g, "$1'<v>'"],
	[/\b0x[0-9a-f]+\b/gi, "<hex>"],
	// Long hex runs (hashes, object ids) — only when they contain a digit, so
	// an ordinary long word is left alone.
	[/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "<hex>"],
	[/\b\d+(?:\.\d+)?\b/g, "<n>"],
];

/**
 * Reduce an error message to what every occurrence of the same failure shares:
 * URLs, query strings, timestamps, GUIDs, e-mail addresses, quoted values, hex
 * ids and numbers are masked, whitespace is collapsed and case is folded.
 */
export function normalizeErrorMessage(message: string): string {
	let text = message;
	for (const [pattern, replacement] of MASKS) {
		text = text.replace(pattern, replacement);
	}
	return text
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
		.slice(0, MAX_NORMALIZED_CHARS);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * Fingerprint of an error group. The platform key is normalized here too, so
 * two groups the platform split only by a varying value (a trace keyed on a
 * message whose id the platform did not mask) share one fingerprint.
 *
 * The emitting component is deliberately NOT part of it: the same failure
 * surfacing in two services is one problem with two components, not two bugs.
 */
export function fingerprintErrorGroup(
	group: Pick<RawErrorGroup, "kind" | "key">,
): string {
	return sha256(`${group.kind}:${normalizeErrorMessage(group.key)}`);
}

export type FingerprintedErrorGroup = RawErrorGroup & { fingerprint: string };

function union(a: string[], b: string[], cap: number): string[] {
	return Array.from(new Set([...a, ...b])).slice(0, cap);
}

/**
 * Fingerprint every group and merge those that share a fingerprint: counts
 * add, the time range widens, and samples and components are united (capped).
 * Distinct users cannot be added without double counting, so the larger
 * figure is kept as a lower bound. Most frequent first.
 */
export function mergeErrorGroups(
	groups: RawErrorGroup[],
): FingerprintedErrorGroup[] {
	const byFingerprint = new Map<string, FingerprintedErrorGroup>();
	for (const group of groups) {
		const fingerprint = fingerprintErrorGroup(group);
		const seen = byFingerprint.get(fingerprint);
		if (!seen) {
			byFingerprint.set(fingerprint, { ...group, fingerprint });
			continue;
		}
		byFingerprint.set(fingerprint, {
			...seen,
			occurrences: seen.occurrences + group.occurrences,
			firstSeen:
				group.firstSeen < seen.firstSeen
					? group.firstSeen
					: seen.firstSeen,
			lastSeen:
				group.lastSeen > seen.lastSeen ? group.lastSeen : seen.lastSeen,
			affectedUsers: Math.max(seen.affectedUsers, group.affectedUsers),
			components: union(
				seen.components,
				group.components,
				MAX_MERGED_COMPONENTS,
			),
			sampleMessages: union(
				seen.sampleMessages,
				group.sampleMessages,
				MAX_MERGED_SAMPLES,
			),
			exceptionType: seen.exceptionType ?? group.exceptionType,
		});
	}
	return Array.from(byFingerprint.values()).sort(
		(a, b) => b.occurrences - a.occurrences,
	);
}

/**
 * Group stories into clusters from pairwise "same problem" edges (connected
 * components), keeping clusters of at least `minSize`. Members are sorted, and
 * clusters are ordered largest first, so the output is stable for a given
 * input regardless of edge order.
 */
export function clusterByEdges(
	nodeIds: string[],
	edges: Array<{ storyAId: string; storyBId: string }>,
	minSize: number,
): string[][] {
	const nodes = new Set(nodeIds);
	const parent = new Map<string, string>();
	const find = (id: string): string => {
		let root = id;
		while (parent.get(root) !== root) {
			root = parent.get(root) ?? root;
		}
		parent.set(id, root);
		return root;
	};
	for (const id of nodes) {
		parent.set(id, id);
	}
	for (const edge of edges) {
		if (!nodes.has(edge.storyAId) || !nodes.has(edge.storyBId)) {
			continue;
		}
		const a = find(edge.storyAId);
		const b = find(edge.storyBId);
		if (a !== b) {
			parent.set(a < b ? b : a, a < b ? a : b);
		}
	}
	const clusters = new Map<string, string[]>();
	for (const id of nodes) {
		const root = find(id);
		clusters.set(root, [...(clusters.get(root) ?? []), id]);
	}
	return Array.from(clusters.values())
		.filter((members) => members.length >= Math.max(2, minSize))
		.map((members) => members.sort())
		.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
}

/**
 * Which existing incident signature a cluster continues, if any: the one that
 * shares the most members with it. A cluster grows as new reports arrive, so
 * matching on overlap rather than on exact membership is what lets a rescan
 * refresh the cluster it already filed instead of filing a superset.
 */
export function matchClusterToSignature<
	T extends { fingerprint: string; sourceStoryIds: string[] },
>(members: string[], signatures: T[]): T | null {
	const memberSet = new Set(members);
	let best: T | null = null;
	let bestOverlap = 0;
	for (const signature of signatures) {
		const overlap = signature.sourceStoryIds.filter((id) =>
			memberSet.has(id),
		).length;
		if (overlap > bestOverlap) {
			best = signature;
			bestOverlap = overlap;
		}
	}
	return best;
}

/** Fingerprint for a NEW cluster: anchored on its member list. */
export function fingerprintCluster(members: string[]): string {
	return sha256(`incident:${[...members].sort().join(",")}`);
}
