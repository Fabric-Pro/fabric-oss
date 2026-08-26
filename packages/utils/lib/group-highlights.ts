/** Minimal structural shape of a curated highlight the email renders — kept local
 *  so @repo/mail does not depend on the @repo/database data layer. Mirrors the
 *  optional fields of NewsletterHighlight. */
export interface ReleaseHighlight {
	title: string;
	description: string;
	prUrl?: string;
	releaseTag?: string;
	repoFullName?: string;
}

export interface ReleaseGroup {
	tag: string | null;
	repoFullName: string | null;
	items: ReleaseHighlight[];
}

const TAG_FROM_URL = /\/(?:releases\/tag|releases|tags|tag)\/([^/?#]+)/;
const REPO_FROM_URL = /github\.com\/([^/]+\/[^/]+?)(?:\/|$)/;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/;

function deriveTag(h: ReleaseHighlight): string | null {
	if (h.releaseTag) {
		return h.releaseTag;
	}
	const m = h.prUrl?.match(TAG_FROM_URL);
	return m ? decodeURIComponent(m[1]) : null;
}

function deriveRepo(h: ReleaseHighlight): string | null {
	if (h.repoFullName) {
		return h.repoFullName;
	}
	const m = h.prUrl?.match(REPO_FROM_URL);
	return m ? m[1] : null;
}

function semverKey(tag: string | null): number[] | null {
	const m = tag?.match(SEMVER);
	return m
		? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)]
		: null;
}

/** Groups highlights by (repo, releaseTag) and orders groups newest-first.
 *  Distinct repos never merge even on identical tags. Order: semver groups
 *  (newest-first), then non-semver tags (stable, first-seen), then the
 *  version-less (null) group last. No item is dropped. */
export function groupHighlightsByRelease(
	highlights: ReleaseHighlight[],
): ReleaseGroup[] {
	// `highlights` originates from a Prisma `Json?` column cast to NewsletterContent
	// with no runtime validation. A malformed row (e.g. non-array `highlights`) must
	// not crash the email render or the in-app detail modal — degrade to no groups.
	if (!Array.isArray(highlights)) {
		return [];
	}
	const groups: ReleaseGroup[] = [];
	const index = new Map<string, ReleaseGroup>();
	for (const h of highlights) {
		const tag = deriveTag(h);
		const repoFullName = deriveRepo(h);
		const key = JSON.stringify([repoFullName, tag]);
		let group = index.get(key);
		if (!group) {
			group = { tag, repoFullName, items: [] };
			index.set(key, group);
			groups.push(group);
		}
		group.items.push(h);
	}
	const tierOf = (tag: string | null) =>
		semverKey(tag) ? 0 : tag !== null ? 1 : 2;
	return groups
		.map((group, i) => ({ group, i }))
		.sort((a, b) => {
			const ta = tierOf(a.group.tag);
			const tb = tierOf(b.group.tag);
			if (ta !== tb) {
				return ta - tb;
			}
			const av = semverKey(a.group.tag);
			const bv = semverKey(b.group.tag);
			if (av && bv) {
				for (let k = 0; k < 4; k++) {
					if (bv[k] !== av[k]) {
						return bv[k] - av[k];
					}
				}
			}
			return a.i - b.i;
		})
		.map((x) => x.group);
}
