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
	readDirectRepositoryFileVersion,
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
	it("proves absence only from a complete pinned tree", async () => {
		m.listRepositoryTreeAtCommit.mockResolvedValue({
			ok: true,
			entries: [],
			truncated: false,
		});
		await expect(
			readDirectRepositoryFileVersion({
				source,
				pin,
				path: "deleted.md",
			}),
		).resolves.toEqual({ state: "absent" });
		resetDirectRepositoryCaches();
		m.listRepositoryTreeAtCommit.mockResolvedValue({
			ok: true,
			entries: [],
			truncated: true,
		});
		await expect(
			readDirectRepositoryFileVersion({
				source,
				pin,
				path: "deleted.md",
			}),
		).resolves.toEqual({ state: "unavailable" });
	});

	it.each([
		{ path: "target.md", type: "file", mode: "120000", regular: false },
		{ path: "target.md", type: "file", mode: "160000", regular: false },
		{ path: "target.md", type: "dir" },
		{ path: "target.md", type: "file" },
	])(
		"does not mistake an unsupported entry for deletion: $mode $type",
		async (entry) => {
			m.listRepositoryTreeAtCommit.mockResolvedValue({
				ok: true,
				entries: [entry],
				truncated: false,
			});
			await expect(
				readDirectRepositoryFileVersion({
					source,
					pin,
					path: "target.md",
				}),
			).resolves.toEqual({ state: "nonRegular" });
			expect(
				m.readRepositoryFileAtCommit.mock.calls.every(
					([input]) => input.path === ".fabricignore",
				),
			).toBe(true);
		},
	);

	it("does not treat a path below a gitlink as absent", async () => {
		m.listRepositoryTreeAtCommit.mockResolvedValue({
			ok: true,
			entries: [{ path: "vendor", type: "file", regular: false }],
			truncated: false,
		});
		await expect(
			readDirectRepositoryFileVersion({
				source,
				pin,
				path: "vendor/file.md",
			}),
		).resolves.toEqual({ state: "nonRegular" });
	});

	it("withholds an inconsistent body instead of turning it into a delete", async () => {
		m.listRepositoryTreeAtCommit.mockResolvedValue({
			ok: true,
			entries: [{ path: "file.md", type: "file", mode: "100644" }],
			truncated: false,
		});
		await expect(
			readDirectRepositoryFileVersion({ source, pin, path: "file.md" }),
		).resolves.toEqual({ state: "unavailable" });
	});

	it("preserves empty UTF-8 and BOM/CRLF bytes in a full version", async () => {
		m.listRepositoryTreeAtCommit.mockResolvedValue({
			ok: true,
			entries: [{ path: "file.md", type: "file", mode: "100644" }],
			truncated: false,
		});
		for (const text of ["", "\uFEFFfirst\r\nsecond\r\n"]) {
			resetDirectRepositoryCaches();
			m.readRepositoryFileAtCommit.mockImplementation(async ({ path }) =>
				path === ".fabricignore"
					? { ok: true, state: "absent" }
					: {
							ok: true,
							state: "found",
							bytes: new TextEncoder().encode(text),
						},
			);
			await expect(
				readDirectRepositoryFileVersion({
					source,
					pin,
					path: "file.md",
				}),
			).resolves.toMatchObject({ state: "found", text });
		}
	});

	it("uses prepared batch ignore rules while preserving exclusions and the inline cap", async () => {
		m.readRepositoryFileAtCommit.mockResolvedValue({
			ok: true,
			state: "found",
			bytes: new TextEncoder().encode("example"),
		});
		const ignore = { globs: ["hidden/**"], layer: "project" as const };
		await expect(
			readDirectRepositoryFile({
				source,
				pin,
				path: "AGENTS.md",
				ignore,
			}),
		).resolves.toMatchObject({ state: "found", text: "example" });
		expect(m.readRepositoryFileAtCommit).toHaveBeenCalledWith(
			expect.objectContaining({ path: "AGENTS.md", maxBytes: 262_144 }),
		);
		expect(
			m.readRepositoryFileAtCommit.mock.calls.some(
				([read]) => read.path === ".fabricignore",
			),
		).toBe(false);
		await expect(
			readDirectRepositoryFile({
				source,
				pin,
				path: "hidden/file.md",
				ignore,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			readDirectRepositoryFile({ source, pin, path: ".env", ignore }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

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

	it("lists a 5,253-file tree completely", async () => {
		m.listRepositoryTreeAtCommit.mockResolvedValueOnce({
			ok: true,
			entries: Array.from({ length: 5_253 }, (_, i) => ({
				path: `docs/file-${i}.md`,
				type: "file",
			})),
			truncated: false,
		});

		const listed = await listDirectRepositoryFiles({ source, pin });

		expect(listed.incomplete).toBe(false);
		expect(listed.files).toHaveLength(5_253);
	});

	it("still flags a tree beyond the connector's own entry cap as incomplete", async () => {
		m.listRepositoryTreeAtCommit.mockResolvedValueOnce({
			ok: true,
			entries: Array.from({ length: 20_001 }, (_, i) => ({
				path: `docs/file-${i}.md`,
				type: "file",
			})),
			truncated: false,
		});

		const listed = await listDirectRepositoryFiles({ source, pin });

		expect(listed.incomplete).toBe(true);
		expect(listed.files).toHaveLength(20_000);
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
