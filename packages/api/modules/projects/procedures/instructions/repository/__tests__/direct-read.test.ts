import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	listRepositoryTreeAtCommit: vi.fn(),
	readRepositoryFileAtCommit: vi.fn(),
}));

vi.mock("@repo/connectors", () => ({
	listRepositoryTreeAtCommit: m.listRepositoryTreeAtCommit,
	readRepositoryFileAtCommit: m.readRepositoryFileAtCommit,
}));

import { resetDirectRepositoryCaches } from "../direct-cache";
import {
	listDirectRepositoryFiles,
	readDirectRepositoryFile,
} from "../direct-read";

const SHA = "a".repeat(40);
const source = {
	organizationId: "org-1",
	integrationId: "integration-1",
	generation: 4,
	ref: "main",
	rootPath: "",
	ignoreGlobs: null,
	repository: {
		provider: "GITLAB" as const,
		token: "direct-read-test-token",
		repositoryUrl: "https://gitlab.com/example-org/instructions",
		owner: "example-org",
		repo: "instructions",
		gitlabAuth: "private-token" as const,
	},
	refreshFault: null,
};

const pin = { generation: 4, commitSha: SHA };

beforeEach(() => {
	resetDirectRepositoryCaches();
	m.readRepositoryFileAtCommit.mockImplementation(async ({ path }) =>
		path === ".fabricignore"
			? { ok: true, state: "absent" }
			: { ok: true, state: "absent" },
	);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("direct repository reads", () => {
	it("refuses malformed provider paths instead of advertising unreadable metadata", async () => {
		m.listRepositoryTreeAtCommit.mockResolvedValueOnce({
			ok: true,
			entries: [{ path: "../outside.md", type: "file" }],
			truncated: false,
		});

		await expect(
			listDirectRepositoryFiles({ source, pin }),
		).resolves.toEqual({
			files: [],
			incomplete: true,
			refusal: "invalid_tree",
			excludedCount: 0,
			excludedPaths: [],
		});
	});

	it("refuses case-colliding provider paths rather than selecting one arbitrarily", async () => {
		m.listRepositoryTreeAtCommit.mockResolvedValueOnce({
			ok: true,
			entries: [
				{ path: "AGENTS.md", type: "file" },
				{ path: "agents.md", type: "file" },
			],
			truncated: false,
		});

		await expect(
			listDirectRepositoryFiles({ source, pin }),
		).resolves.toEqual({
			files: [],
			incomplete: true,
			refusal: "invalid_tree",
			excludedCount: 0,
			excludedPaths: [],
		});
	});

	it("keeps a provider-truncated tree explicit after filtering", async () => {
		m.listRepositoryTreeAtCommit.mockResolvedValueOnce({
			ok: true,
			entries: [{ path: "linked.md", type: "file", regular: false }],
			truncated: true,
		});

		await expect(
			listDirectRepositoryFiles({ source, pin }),
		).resolves.toEqual({
			files: [],
			incomplete: true,
			refusal: null,
			excludedCount: 1,
			excludedPaths: [
				{ path: "linked.md", rule: "Non-regular Git entry" },
			],
		});
	});

	it("preserves raw pinned UTF-8 BOM and line endings without checkout conversion", async () => {
		const bytes = Buffer.from("\uFEFFline one\r\nline two\r\n", "utf8");
		m.readRepositoryFileAtCommit.mockImplementation(async ({ path }) =>
			path === ".fabricignore"
				? { ok: true, state: "absent" }
				: { ok: true, state: "found", bytes },
		);

		await expect(
			readDirectRepositoryFile({ source, pin, path: "AGENTS.md" }),
		).resolves.toEqual({
			state: "found",
			text: "\uFEFFline one\r\nline two\r\n",
			textLength: 21,
			size: bytes.length,
		});
	});
});
