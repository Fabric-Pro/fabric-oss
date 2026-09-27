import { describe, expect, it } from "vitest";
import {
	branchDestinationSchema,
	branchOperationEntrySchema,
	branchPresentationSchema,
	treeEntrySchema,
} from "../src/proposal-branch-schemas";
import {
	pullRequestContextSchema,
	pullRequestContextSchemaV2,
} from "../src/pull-request-context";

const NOREPLY = "noreply@example.com";

const shared = {
	integrationId: "int_1",
	syncId: "sync_1",
	syncGeneration: 2,
	provider: "GITHUB",
	targetRef: "main",
	rootPath: "",
	baseCommitSha: "a".repeat(40),
	repository: {
		provider: "GITHUB",
		owner: "example-org",
		repo: "example-repo",
	},
	author: { name: "Pat Example", email: NOREPLY },
	committer: { name: "Fabric", email: NOREPLY },
	message: "Update coding instructions (3 files)",
	committedAt: "2026-09-26T00:00:00Z",
} as const;

const v1 = {
	v: 1,
	...shared,
	branch: "fabric/instructions/cexample000000000000000a",
	title: "Update coding instructions (3 files)",
	body: "---\n\nOpened from Fabric project Example Project by Pat Example",
} as const;

const v2 = { v: 2, ...shared } as const;

describe("pullRequestContextSchema (member proposal branch spec §4.2)", () => {
	it("parses a v1 context as v1", () => {
		const parsed = pullRequestContextSchema.parse(v1);
		expect(parsed.v).toBe(1);
		expect(parsed).toEqual(v1);
	});

	it("parses a v2 context as v2", () => {
		const parsed = pullRequestContextSchema.parse(v2);
		expect(parsed.v).toBe(2);
		expect(parsed).toEqual(v2);
	});

	it.each([
		["branch", { branch: "fabric/instructions/members/pat-abcd/1" }],
		["title", { title: "x" }],
		["body", { body: "x" }],
	])("rejects a v2 context carrying %s", (_, extra) => {
		expect(
			pullRequestContextSchemaV2.safeParse({ ...v2, ...extra }).success,
		).toBe(false);
		expect(
			pullRequestContextSchema.safeParse({ ...v2, ...extra }).success,
		).toBe(false);
	});

	it("rejects a v2 context whose repository has another provider", () => {
		expect(
			pullRequestContextSchema.safeParse({ ...v2, provider: "GITLAB" })
				.success,
		).toBe(false);
	});

	it("rejects an unknown version", () => {
		expect(
			pullRequestContextSchema.safeParse({ ...v2, v: 3 }).success,
		).toBe(false);
	});
});

describe("branch journal and branch JSON (spec §4.1)", () => {
	const blob = { type: "blob", mode: "100644", oid: "b".repeat(40) } as const;

	it("round-trips an executable entry", () => {
		const entry = {
			type: "blob",
			mode: "100755",
			oid: "c".repeat(40),
		} as const;
		expect(treeEntrySchema.parse(entry)).toEqual(entry);
	});

	it("accepts symlink and gitlink entries and refuses a malformed mode", () => {
		expect(
			treeEntrySchema.safeParse({
				type: "symlink",
				mode: "120000",
				oid: "d".repeat(40),
			}).success,
		).toBe(true);
		expect(
			treeEntrySchema.safeParse({
				type: "gitlink",
				mode: "160000",
				oid: "e".repeat(64),
			}).success,
		).toBe(true);
		expect(
			treeEntrySchema.safeParse({ ...blob, mode: "644" }).success,
		).toBe(false);
		expect(
			treeEntrySchema.safeParse({ ...blob, type: "tree" }).success,
		).toBe(false);
	});

	it("allows a null before (an added file) and a null after (a deletion)", () => {
		const added = {
			path: "rules/a.md",
			rawPath: "docs/rules/a.md",
			before: null,
			after: blob,
			afterSha256: "f".repeat(64),
			afterSource: "snap_1",
			beforeSource: null,
		};
		expect(branchOperationEntrySchema.parse(added)).toEqual(added);
		const deleted = {
			...added,
			before: blob,
			after: null,
			afterSha256: null,
			afterSource: null,
		};
		expect(branchOperationEntrySchema.parse(deleted)).toEqual(deleted);
	});

	it("parses a destination and refuses a provider mismatch", () => {
		const destination = {
			integrationId: "int_1",
			syncId: "sync_1",
			repositoryKey: "github:example-org/example-repo",
			provider: "GITHUB",
			repository: shared.repository,
			targetRef: "main",
			rootPath: "",
		};
		expect(branchDestinationSchema.parse(destination)).toEqual(destination);
		expect(
			branchDestinationSchema.safeParse({
				...destination,
				provider: "GITLAB",
			}).success,
		).toBe(false);
	});

	it("parses a presentation", () => {
		const presentation = {
			title: "Coding instruction changes from Pat Example",
			body: "",
		};
		expect(branchPresentationSchema.parse(presentation)).toEqual(
			presentation,
		);
		expect(branchPresentationSchema.safeParse({ title: "x" }).success).toBe(
			false,
		);
	});
});
