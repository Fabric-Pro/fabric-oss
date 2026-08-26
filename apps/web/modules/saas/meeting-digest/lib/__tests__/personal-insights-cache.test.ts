import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CACHE_VERSION,
	dropInsights,
	entryId,
	purgeProject,
	purgeUser,
	readInsights,
	storageKey,
	writeInsights,
} from "../personal-insights-cache";

const USER = "user-1";
const PROJECT = "proj-1";
const JOIN = "https://teams.microsoft.com/l/meetup-join/abc";
const START = "2026-08-01T10:00:00.000Z";
const VALUE = {
	summary: "We agreed to ship on Friday.",
	actionItems: [{ text: "Send the deck", tentativeOwnerName: "Sam" }],
};

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("storageKey", () => {
	it("scopes by user and project", () => {
		expect(storageKey(USER, PROJECT)).toBe(
			"meeting-digest-personal-insights:user-1:proj-1",
		);
	});

	it("gives different users different keys", () => {
		expect(storageKey("a", PROJECT)).not.toBe(storageKey("b", PROJECT));
	});
});

describe("entryId", () => {
	it("is stable for the same inputs", () => {
		expect(entryId(JOIN, START)).toBe(entryId(JOIN, START));
	});

	it("differs when the occurrence differs", () => {
		expect(entryId(JOIN, START)).not.toBe(
			entryId(JOIN, "2026-08-08T10:00:00.000Z"),
		);
	});

	it("differs when the meeting differs", () => {
		expect(entryId(JOIN, START)).not.toBe(entryId(`${JOIN}x`, START));
	});

	it("never contains the join URL in cleartext", () => {
		expect(entryId(JOIN, START)).not.toContain("meetup-join");
	});
});

describe("round trip", () => {
	it("returns null on a cold cache", () => {
		expect(readInsights(USER, PROJECT, JOIN, START)).toBeNull();
	});

	it("reads back what it wrote", () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		expect(readInsights(USER, PROJECT, JOIN, START)).toEqual(VALUE);
	});

	it("does not leak across users", () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		expect(readInsights("other-user", PROJECT, JOIN, START)).toBeNull();
	});

	it("does not leak across projects", () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		expect(readInsights(USER, "other-proj", JOIN, START)).toBeNull();
	});

	it("never stores the join URL anywhere in the blob", () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		expect(localStorage.getItem(storageKey(USER, PROJECT))).not.toContain(
			"meetup-join",
		);
	});
});

describe("invalidation", () => {
	it("ignores a blob written by a different cache version", () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		const raw = JSON.parse(
			localStorage.getItem(storageKey(USER, PROJECT)) as string,
		);
		raw.v = CACHE_VERSION + 1;
		localStorage.setItem(storageKey(USER, PROJECT), JSON.stringify(raw));

		expect(readInsights(USER, PROJECT, JOIN, START)).toBeNull();
	});

	it("ignores an entry older than the TTL", () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		const key = storageKey(USER, PROJECT);
		const raw = JSON.parse(localStorage.getItem(key) as string);
		raw.entries[entryId(JOIN, START)].cachedAt =
			Date.now() - 8 * 24 * 60 * 60 * 1000;
		localStorage.setItem(key, JSON.stringify(raw));

		expect(readInsights(USER, PROJECT, JOIN, START)).toBeNull();
	});

	it("keeps an entry inside the TTL", () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		const key = storageKey(USER, PROJECT);
		const raw = JSON.parse(localStorage.getItem(key) as string);
		raw.entries[entryId(JOIN, START)].cachedAt =
			Date.now() - 6 * 24 * 60 * 60 * 1000;
		localStorage.setItem(key, JSON.stringify(raw));

		expect(readInsights(USER, PROJECT, JOIN, START)).toEqual(VALUE);
	});

	it("tolerates a corrupt blob", () => {
		localStorage.setItem(storageKey(USER, PROJECT), "{not json");
		expect(() => readInsights(USER, PROJECT, JOIN, START)).not.toThrow();
		expect(readInsights(USER, PROJECT, JOIN, START)).toBeNull();
	});
});

// #2137 — a stale blob or expired entry must not merely read as a miss: it
// has to leave the disk. The TTL exists to bound how long a personal summary
// sits in localStorage, and a "miss" that keeps the bytes forever defeats it.
// Deletion is deferred to a microtask because reads run during render.
describe("sweep on read (#2137)", () => {
	const flushMicrotasks = () =>
		new Promise<void>((resolve) => queueMicrotask(resolve));

	it("deletes a blob written by a different cache version", async () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		const key = storageKey(USER, PROJECT);
		const raw = JSON.parse(localStorage.getItem(key) as string);
		raw.v = CACHE_VERSION + 1;
		localStorage.setItem(key, JSON.stringify(raw));

		expect(readInsights(USER, PROJECT, JOIN, START)).toBeNull();
		await flushMicrotasks();
		expect(localStorage.getItem(key)).toBeNull();
	});

	it("deletes a corrupt blob", async () => {
		const key = storageKey(USER, PROJECT);
		localStorage.setItem(key, "{not json");

		expect(readInsights(USER, PROJECT, JOIN, START)).toBeNull();
		await flushMicrotasks();
		expect(localStorage.getItem(key)).toBeNull();
	});

	it("prunes an expired entry but keeps fresh siblings", async () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		const freshJoin = "https://teams.microsoft.com/l/meetup-join/def";
		writeInsights(USER, PROJECT, freshJoin, START, VALUE);

		const key = storageKey(USER, PROJECT);
		const raw = JSON.parse(localStorage.getItem(key) as string);
		raw.entries[entryId(JOIN, START)].cachedAt =
			Date.now() - 8 * 24 * 60 * 60 * 1000;
		localStorage.setItem(key, JSON.stringify(raw));

		expect(readInsights(USER, PROJECT, JOIN, START)).toBeNull();
		await flushMicrotasks();

		const after = JSON.parse(localStorage.getItem(key) as string);
		expect(after.entries[entryId(JOIN, START)]).toBeUndefined();
		expect(after.entries[entryId(freshJoin, START)]).toBeDefined();
	});
});

// A meeting can be cached while personal, then become a shared, linked
// project row. `readInsights` is never called for it again once that
// happens (`cacheActive` in `PersonalMeetingSheet` guards that), so nothing
// on the read path would otherwise ever prune the stale entry — it would sit
// on disk past its TTL until the LRU cap evicts it or the user purges.
describe("dropInsights", () => {
	const flushMicrotasks = () =>
		new Promise<void>((resolve) => queueMicrotask(resolve));

	it("removes the entry, deferred to a microtask", async () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		const key = storageKey(USER, PROJECT);

		dropInsights(USER, PROJECT, JOIN, START);
		// Deferred, same as the TTL prune: still present synchronously.
		const stillThere = JSON.parse(localStorage.getItem(key) as string);
		expect(stillThere.entries[entryId(JOIN, START)]).toBeDefined();

		await flushMicrotasks();
		const after = JSON.parse(localStorage.getItem(key) as string);
		expect(after.entries[entryId(JOIN, START)]).toBeUndefined();
	});

	it("leaves a sibling entry in the same blob untouched", async () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		const otherJoin = "https://teams.microsoft.com/l/meetup-join/def";
		writeInsights(USER, PROJECT, otherJoin, START, VALUE);

		dropInsights(USER, PROJECT, JOIN, START);
		await flushMicrotasks();

		const key = storageKey(USER, PROJECT);
		const after = JSON.parse(localStorage.getItem(key) as string);
		expect(after.entries[entryId(JOIN, START)]).toBeUndefined();
		expect(after.entries[entryId(otherJoin, START)]).toBeDefined();
	});

	it("is a no-op when there is nothing to delete", async () => {
		expect(() => dropInsights(USER, PROJECT, JOIN, START)).not.toThrow();
		await flushMicrotasks();
		expect(localStorage.getItem(storageKey(USER, PROJECT))).toBeNull();
	});

	it("does nothing for an unidentified caller", async () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		dropInsights("", PROJECT, JOIN, START);
		await flushMicrotasks();
		expect(readInsights(USER, PROJECT, JOIN, START)).toEqual(VALUE);
	});
});

describe("LRU cap", () => {
	it("keeps at most 100 entries, dropping the oldest", () => {
		for (let i = 0; i < 105; i++) {
			writeInsights(USER, PROJECT, `${JOIN}/${i}`, START, {
				summary: `s${i}`,
				actionItems: [],
			});
		}

		const blob = JSON.parse(
			localStorage.getItem(storageKey(USER, PROJECT)) as string,
		);
		expect(Object.keys(blob.entries)).toHaveLength(100);
		expect(readInsights(USER, PROJECT, `${JOIN}/0`, START)).toBeNull();
		expect(
			readInsights(USER, PROJECT, `${JOIN}/104`, START),
		).not.toBeNull();
	});
});

describe("purgeProject", () => {
	it("removes every entry for that user and project", () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		purgeProject(USER, PROJECT);
		expect(readInsights(USER, PROJECT, JOIN, START)).toBeNull();
		expect(localStorage.getItem(storageKey(USER, PROJECT))).toBeNull();
	});

	it("leaves another project untouched", () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		writeInsights(USER, "proj-2", JOIN, START, VALUE);
		purgeProject(USER, PROJECT);
		expect(readInsights(USER, "proj-2", JOIN, START)).toEqual(VALUE);
	});
});

describe("purgeUser", () => {
	it("removes every project blob for that user", () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		writeInsights(USER, "proj-2", JOIN, START, VALUE);
		purgeUser(USER);
		expect(readInsights(USER, PROJECT, JOIN, START)).toBeNull();
		expect(readInsights(USER, "proj-2", JOIN, START)).toBeNull();
	});

	it("leaves another user untouched", () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		writeInsights("user-2", PROJECT, JOIN, START, VALUE);
		purgeUser(USER);
		expect(readInsights("user-2", PROJECT, JOIN, START)).toEqual(VALUE);
	});

	it("does not touch unrelated localStorage keys", () => {
		localStorage.setItem("unrelated", "keep me");
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		purgeUser(USER);
		expect(localStorage.getItem("unrelated")).toBe("keep me");
	});
});

describe("hostile blob shapes", () => {
	// `typeof null === "object"`, so a null `entries` sailed past the original
	// shape check and crashed on property access — during render.
	it("survives entries === null", () => {
		localStorage.setItem(
			storageKey(USER, PROJECT),
			JSON.stringify({ v: CACHE_VERSION, entries: null }),
		);
		expect(() => readInsights(USER, PROJECT, JOIN, START)).not.toThrow();
		expect(readInsights(USER, PROJECT, JOIN, START)).toBeNull();
	});

	it("survives entries being an array", () => {
		localStorage.setItem(
			storageKey(USER, PROJECT),
			JSON.stringify({ v: CACHE_VERSION, entries: [] }),
		);
		expect(readInsights(USER, PROJECT, JOIN, START)).toBeNull();
	});

	it("survives a JSON scalar", () => {
		localStorage.setItem(storageKey(USER, PROJECT), '"just a string"');
		expect(readInsights(USER, PROJECT, JOIN, START)).toBeNull();
	});
});

describe("unknown user is never cached", () => {
	// The whole point of user-scoping is that localStorage outlives a session.
	// An empty userId (session not yet loaded) would put every such person in
	// one shared bucket, which is precisely the leak the scoping prevents.
	it("writes nothing when the userId is empty", () => {
		writeInsights("", PROJECT, JOIN, START, VALUE);
		expect(localStorage.getItem(storageKey("", PROJECT))).toBeNull();
	});

	it("reads nothing when the userId is empty", () => {
		expect(readInsights("", PROJECT, JOIN, START)).toBeNull();
	});

	it("cannot be used to read another user's entry", () => {
		writeInsights(USER, PROJECT, JOIN, START, VALUE);
		expect(readInsights("", PROJECT, JOIN, START)).toBeNull();
	});
});
