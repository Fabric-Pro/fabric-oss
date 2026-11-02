/**
 * Regression lock for the Labels removal.
 *
 * `UserStory.labels` survives in the database as system-owned state for the
 * GitLab label↔status sync pipeline, but it must never cross a user- or
 * agent-facing boundary. The strip is a one-token destructure, so without a
 * test any refactor can silently re-expose the field — and the sync tests
 * mock `getStoryById`, so they would not notice.
 */
import { describe, expect, it } from "vitest";
import {
	stripInternalStoryFields,
	stripInternalStoryFieldsFromMany,
	stripRemoteCodingRunSummary,
} from "../strip-internal-story-fields";

const storyRow = {
	id: "story-1",
	identifier: "F-001",
	title: "A feature",
	statusId: "status-1",
	priority: "P2_MEDIUM" as const,
	// Sync-owned: GitLab status label, an internal provenance marker, and a
	// legacy value a user typed before the picker was removed.
	labels: ["workflow::in-review", "supersedes:F-042", "legacy-label"],
	tags: [{ id: "tag-1", value: "checkout", createdById: "user-1" }],
};

describe("stripInternalStoryFields", () => {
	it("removes labels from the payload", () => {
		const result = stripInternalStoryFields(storyRow);
		expect(result).not.toHaveProperty("labels");
	});

	it("preserves tags — they are the user-facing classification primitive", () => {
		const result = stripInternalStoryFields(storyRow);
		expect(result.tags).toEqual([
			{ id: "tag-1", value: "checkout", createdById: "user-1" },
		]);
	});

	it("preserves every other field verbatim", () => {
		const result = stripInternalStoryFields(storyRow);
		const { labels: _dropped, ...expected } = storyRow;
		expect(result).toEqual(expected);
	});

	it("does not mutate the input row — sync reads the same object", () => {
		const row = { ...storyRow, labels: [...storyRow.labels] };
		stripInternalStoryFields(row);
		expect(row.labels).toEqual([
			"workflow::in-review",
			"supersedes:F-042",
			"legacy-label",
		]);
	});

	it("accepts a row with no labels field and returns it unchanged", () => {
		// The constraint is `object`, not `{ labels?: unknown }` — the latter is
		// a weak type, and TS would reject this call outright ("has no properties
		// in common"). This file is not type-checked (tsconfig excludes tests),
		// so the compile-time half of that contract is pinned by a probe in
		// review, not here; this asserts the runtime half.
		const { labels: _omit, ...withoutLabels } = storyRow;
		expect(() => stripInternalStoryFields(withoutLabels)).not.toThrow();
		expect(stripInternalStoryFields(withoutLabels)).toEqual(withoutLabels);
	});

	it("tolerates an empty labels array", () => {
		const result = stripInternalStoryFields({ ...storyRow, labels: [] });
		expect(result).not.toHaveProperty("labels");
	});
});

describe("stripInternalStoryFieldsFromMany", () => {
	it("strips labels from every element", () => {
		const result = stripInternalStoryFieldsFromMany([
			storyRow,
			{ ...storyRow, id: "story-2", labels: ["blocked"] },
		]);
		expect(result).toHaveLength(2);
		for (const story of result) {
			expect(story).not.toHaveProperty("labels");
		}
	});

	it("returns an empty array unchanged", () => {
		expect(stripInternalStoryFieldsFromMany([])).toEqual([]);
	});
});

it("keeps registered runtime bindings out of shared story and task summaries", () => {
	const run = {
		id: "example-run",
		status: "RUNNING",
		externalUrl: "https://private.example.com",
		providerSessionId: "example-native-session",
		providerMetadata: {
			executionTarget: {
				connectionId: "example-connection",
				url: "https://private.example.com",
			},
		},
		pullRequestUrl: "https://github.com/example-org/example-repo/pull/1",
	};
	const story = { codingRuns: [run], tasks: [{ codingRuns: [run] }] };
	const result = stripInternalStoryFields(story);
	expect(JSON.stringify(result)).not.toContain("private.example.com");
	expect(JSON.stringify(result)).not.toContain("example-native-session");
	expect(result.codingRuns[0].pullRequestUrl).toBe(run.pullRequestUrl);
	expect(story.codingRuns[0].providerSessionId).toBe(
		"example-native-session",
	);
});

describe("shared coding run summaries", () => {
	it("preserves legacy links when no registered execution target is present", () => {
		const legacy = {
			externalUrl: "https://legacy.example.com/session/example",
			providerMetadata: null,
		};
		expect(stripRemoteCodingRunSummary(legacy)).toBe(legacy);
	});
	it("removes runtime text, bindings and events before a registered run enters a shared feed or AI context", () => {
		const run = {
			status: "RUNNING",
			pullRequestUrl:
				"https://github.com/example-org/example-repo/pull/1",
			externalUrl: "https://private.example.com/session/example-native",
			externalStatus: "Private runtime detail",
			workingDirectory: "/example/private-checkout",
			events: [{ text: "Private runtime detail" }],
			providerMetadata: {
				executionTarget: {
					connectionId: "example-connection",
					profileId: "example-profile",
				},
			},
		};
		const summary = stripRemoteCodingRunSummary(run);
		expect(summary.status).toBe("RUNNING");
		expect(summary.pullRequestUrl).toBe(run.pullRequestUrl);
		expect(JSON.stringify(summary)).not.toMatch(
			/private\.example|Private runtime|private-checkout|example-profile|example-connection/,
		);
		expect(run.externalUrl).toContain("private.example.com");
	});

	it("strips executionTarget from providerMetadata even when connectionId is absent", () => {
		const run = {
			status: "RUNNING",
			externalUrl: "https://agents.example.com/?session=1",
			providerMetadata: {
				executionRuntime: "fabric-agent-server",
				llmConnection: "codex",
				executionTarget: {
					url: "http://127.0.0.1:9100",
					profileId: "fabric-user-1",
				},
			},
		};
		const summary = stripRemoteCodingRunSummary(run);
		expect(summary.providerMetadata).toEqual({
			executionRuntime: "fabric-agent-server",
			llmConnection: "codex",
		});
		expect(JSON.stringify(summary)).not.toContain("127.0.0.1:9100");
		expect(JSON.stringify(summary)).not.toContain("fabric-user-1");
	});
});
