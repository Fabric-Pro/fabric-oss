/**
 * Tests for `listVersionsProcedure`.
 *
 * The contract this pins is authorship reaching the client: `getDocumentVersions`
 * resolves each version's `author` ({ kind, name }), and the procedure must hand
 * that through untouched. Narrowing the payload back down to the raw `changedBy`
 * would silently break version history — the client cannot resolve an opaque user
 * id (or the agent sentinel) on its own.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/projects/procedures/versions/__tests__/list-versions.test.ts
 */

import type { DocumentVersionAuthor } from "@repo/utils/document-version-author";
import { AI_REFRESH_AUTHOR_ID } from "@repo/utils/document-version-author";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getDocumentById: vi.fn(),
	getDocumentVersions: vi.fn(),
	hasProjectAccess: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		resolveOrganizationId: (orgId: unknown) => orgId ?? undefined,
		Permissions: { DOCUMENT_READ: "document:read" },
	};
});

import {
	getDocumentById,
	getDocumentVersions,
	hasProjectAccess,
} from "@repo/database";
import { listVersionsProcedure } from "../list-versions";

const handler = (
	listVersionsProcedure as unknown as {
		handler: (opts: {
			input: {
				projectId: string;
				documentId: string;
				organizationId: string | null;
			};
			context: unknown;
		}) => Promise<{
			versions: { author: DocumentVersionAuthor | null }[];
		}>;
	}
).handler;
const ctx = {
	user: { id: "u1", name: "U", email: "u@example.com" },
	session: {},
};
const input = {
	projectId: "p1",
	documentId: "doc-1",
	organizationId: "org1",
};

const version = (overrides: Record<string, unknown> = {}) => ({
	id: "ver-1",
	version: 1,
	content: "content",
	changeDescription: null,
	changedBy: "user-1",
	createdAt: new Date("2026-07-01T00:00:00Z"),
	author: { kind: "HUMAN", name: "Ada Lovelace" },
	...overrides,
});

/** Stub the query layer's page of already-author-resolved versions. */
const givenVersions = (versions: Record<string, unknown>[]) => {
	vi.mocked(getDocumentVersions).mockResolvedValue({
		versions,
		total: versions.length,
		hasMore: false,
	} as never);
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(hasProjectAccess).mockResolvedValue(true as never);
	vi.mocked(getDocumentById).mockResolvedValue({
		id: "doc-1",
		projectId: "p1",
	} as never);
	givenVersions([version()]);
});

describe("listVersionsProcedure", () => {
	it("is gated on DOCUMENT_READ", () => {
		expect(
			(listVersionsProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("document:read");
	});

	it("carries a human author through to the client", async () => {
		const res = await handler({ input, context: ctx });

		expect(res.versions[0].author).toEqual({
			kind: "HUMAN",
			name: "Ada Lovelace",
		});
	});

	it("carries the AI refresh agent's identity through to the client", async () => {
		givenVersions([
			version({
				changedBy: AI_REFRESH_AUTHOR_ID,
				author: { kind: "AI_AGENT", name: "Fabric Refresh Agent" },
			}),
		]);

		const res = await handler({ input, context: ctx });

		expect(res.versions[0].author).toEqual({
			kind: "AI_AGENT",
			name: "Fabric Refresh Agent",
		});
	});

	it("carries a null author (legacy row) through without crashing", async () => {
		givenVersions([version({ changedBy: null, author: null })]);

		const res = await handler({ input, context: ctx });

		expect(res.versions[0].author).toBeNull();
	});

	it("does not drop the author when the page mixes author kinds", async () => {
		givenVersions([
			version({ id: "v3", author: { kind: "HUMAN", name: "Ada" } }),
			version({
				id: "v2",
				changedBy: AI_REFRESH_AUTHOR_ID,
				author: { kind: "AI_AGENT", name: "Fabric Refresh Agent" },
			}),
			version({ id: "v1", changedBy: null, author: null }),
		]);

		const res = await handler({ input, context: ctx });

		expect(res.versions.map((v) => v.author)).toEqual([
			{ kind: "HUMAN", name: "Ada" },
			{ kind: "AI_AGENT", name: "Fabric Refresh Agent" },
			null,
		]);
	});

	it("rejects a caller without project access", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValue(false as never);

		await expect(handler({ input, context: ctx })).rejects.toThrow(
			/access to this project/i,
		);
		expect(getDocumentVersions).not.toHaveBeenCalled();
	});

	it("rejects a document that belongs to a different project", async () => {
		vi.mocked(getDocumentById).mockResolvedValue({
			id: "doc-1",
			projectId: "other-project",
		} as never);

		await expect(handler({ input, context: ctx })).rejects.toThrow(
			/not found/i,
		);
		expect(getDocumentVersions).not.toHaveBeenCalled();
	});
});
