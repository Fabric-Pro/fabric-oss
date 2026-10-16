/**
 * `projects.proposalArtifact.clearFindingResponse` (Fizzy #2946): a member
 * removes an answer, by document and stable key, only while it is the answer
 * they saw, by id and version — so an answer under "No longer raised" can be
 * cleared too, and a change made meanwhile (an answer cleared and given
 * again included) is reported instead of lost.
 *
 * Access is covered in `access.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
	(await import("./proposal-artifact-harness")).databaseModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);

import { buildSectionMap } from "@repo/utils/proposal-artifact/section-hash";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { clearFindingResponseProcedure } from "../clear-finding-response";
import { getProposalAnalysisProcedure } from "../get-analysis";
import {
	auditRows,
	call,
	DOC_A,
	inputRefusal,
	inputSchema,
	mocks,
	ORG_A,
	ORG_B,
	PROJECT_A,
	PROPOSAL_BODY,
	refusal,
	resetMocks,
	resetWorld,
	USER_NAMES,
	USERS,
	usePermissionCheck,
	type WorldResponse,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const MAP = buildSectionMap(PROPOSAL_BODY);
const SCOPE = MAP.sections.find(
	(section) => section.headingText === "Scope",
) as (typeof MAP.sections)[number];
/** A key in the analysis workflow's format: key version, colon, 32 hex. */
const KEY = "k1:0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const TEXT = "Accepted: the vendor is the client's choice.";

function answer(overrides: Partial<WorldResponse> = {}): WorldResponse {
	const response: WorldResponse = {
		id: "response-1",
		organizationId: ORG_A,
		projectId: PROJECT_A,
		documentId: DOC_A,
		stableKey: KEY,
		kind: "RESPONDED",
		text: TEXT,
		findingTitle: "Vendor lock-in",
		answeredRunId: "run-1",
		sectionKey: SCOPE.key,
		sectionHash: SCOPE.proseHash,
		authorId: USERS.owner,
		version: 2,
		createdAt: new Date("2026-10-10T10:00:00.000Z"),
		updatedAt: new Date("2026-10-10T11:00:00.000Z"),
		...overrides,
	};
	world.responses.push(response);
	return response;
}

function clear(
	overrides: Record<string, unknown> = {},
	userId: string = USERS.editor,
) {
	return call(
		clearFindingResponseProcedure,
		{
			projectId: PROJECT_A,
			documentId: DOC_A,
			stableKey: KEY,
			responseId: "response-1",
			version: 2,
			...overrides,
		},
		userId,
	) as Promise<Record<string, unknown>>;
}

beforeEach(() => {
	resetWorld();
	resetMocks();
});

describe("clearFindingResponse", () => {
	it("clears an answer under no longer raised, which the next read no longer lists", async () => {
		answer();
		const before = (await call(
			getProposalAnalysisProcedure,
			{ projectId: PROJECT_A, documentId: DOC_A },
			USERS.editor,
		)) as { noLongerRaised: unknown[] };
		expect(before.noLongerRaised).toHaveLength(1);

		expect(await clear()).toEqual({ outcome: "cleared", stableKey: KEY });

		expect(mocks.clearFindingResponse).toHaveBeenCalledWith({
			organizationId: ORG_A,
			documentId: DOC_A,
			stableKey: KEY,
			responseId: "response-1",
			version: 2,
		});
		const after = (await call(
			getProposalAnalysisProcedure,
			{ projectId: PROJECT_A, documentId: DOC_A },
			USERS.editor,
		)) as { noLongerRaised: unknown[] };
		expect(after.noLongerRaised).toEqual([]);
	});

	it("answers stale VERSION_CHANGED with the saved answer and its author, and keeps it", async () => {
		answer({ version: 3 });

		expect(await clear()).toEqual({
			outcome: "stale",
			reason: "VERSION_CHANGED",
			current: {
				id: "response-1",
				kind: "RESPONDED",
				text: TEXT,
				version: 3,
				author: { id: USERS.owner, name: USER_NAMES[USERS.owner] },
				updatedAt: new Date("2026-10-10T11:00:00.000Z"),
			},
		});
		expect(world.responses).toHaveLength(1);
		expect(auditRows()).toEqual([]);
	});

	it("answers stale for an answer cleared and given again at the version the member saw, and keeps the new one", async () => {
		answer({ id: "response-2", version: 2 });

		expect(await clear({ responseId: "response-1" })).toMatchObject({
			outcome: "stale",
			reason: "VERSION_CHANGED",
			current: { id: "response-2", version: 2 },
		});
		expect(world.responses).toHaveLength(1);
		expect(auditRows()).toEqual([]);
	});

	it("answers NOT_FOUND when there is no answer for the key", async () => {
		expect(await refusal(clear())).toMatchObject({
			code: "NOT_FOUND",
			message: "Answer not found",
		});
		expect(auditRows()).toEqual([]);
	});

	it("never reaches another organization's answer stored under the same document and key", async () => {
		answer({ organizationId: ORG_B });

		expect((await refusal(clear())).code).toBe("NOT_FOUND");
		expect(world.responses).toHaveLength(1);
	});

	it("records the key, kind and version, never the text or the finding title", async () => {
		answer();

		await clear();

		const rows = auditRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "project.document_analysis.cleared",
			category: "project",
			outcome: "success",
			organizationId: ORG_A,
			projectId: PROJECT_A,
			resource: { type: "project_document", id: DOC_A, name: null },
		});
		expect(rows[0].metadata).toEqual({
			stableKey: KEY,
			kind: "RESPONDED",
			version: 2,
		});
		const serialized = JSON.stringify(rows[0]);
		expect(serialized).not.toContain(TEXT);
		expect(serialized).not.toContain("Vendor lock-in");
	});

	it("needs a stable key, the answer's id and a positive version", () => {
		const schema = inputSchema(clearFindingResponseProcedure);
		const base = { projectId: PROJECT_A, documentId: DOC_A };
		const seen = { responseId: "response-1", version: 1 };

		expect(schema.safeParse({ ...base, ...seen }).success).toBe(false);
		expect(
			schema.safeParse({ ...base, stableKey: KEY, version: 1 }).success,
		).toBe(false);
		expect(
			schema.safeParse({ ...base, stableKey: KEY, responseId: "" })
				.success,
		).toBe(false);
		expect(
			schema.safeParse({ ...base, ...seen, stableKey: KEY, version: 0 })
				.success,
		).toBe(false);
		expect(
			schema.safeParse({ ...base, ...seen, stableKey: KEY }).success,
		).toBe(true);
	});

	it("accepts a stable key of any key version, so an answer under an older one can be cleared", () => {
		const schema = inputSchema(clearFindingResponseProcedure);
		const base = {
			projectId: PROJECT_A,
			documentId: DOC_A,
			responseId: "response-1",
			version: 1,
		};

		for (const stableKey of [KEY, KEY.replace(/^k1:/, "k2:")]) {
			expect(schema.safeParse({ ...base, stableKey }).success).toBe(true);
		}
	});

	it("refuses a key not in the stable-key format as BAD_REQUEST before the answer is read", async () => {
		answer();
		const hex = KEY.slice("k1:".length);

		for (const stableKey of [
			"",
			`RISK|${SCOPE.key}|vendor-lock-in`,
			hex,
			`k0:${hex}`,
			`K1:${hex}`,
			`k1:${hex.toUpperCase()}`,
			`k1:${hex.slice(1)}`,
			`k1:${hex}0`,
			`k1:${hex}\n`,
			` ${KEY}`,
			`k1:${"a".repeat(1000)}`,
		]) {
			const result = await inputRefusal(clear({ stableKey }));

			expect(result.code).toBe("BAD_REQUEST");
			expect(result.issues).toEqual([
				expect.objectContaining({ path: ["stableKey"] }),
			]);
		}
		expect(mocks.clearFindingResponse).not.toHaveBeenCalled();
		expect(world.responses).toHaveLength(1);
		expect(auditRows()).toEqual([]);
	});
});
