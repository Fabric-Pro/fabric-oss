/**
 * Living Memory decision candidate procedures (`list`, `createFrom`,
 * `dismiss`).
 *
 * The DB helpers and the post-create pipeline are boundary-mocked; what this
 * file pins is the part that lives in the procedure: the permissions it gates
 * on (the same as the meeting candidates, plus the input-organization check),
 * the project re-check, the shape of the decision it writes (PROPOSED,
 * `sourceKind: "living_memory"`, the candidate key in `sourceMetadata`), the
 * "Create as update" link, and the errors for a stale or used candidate.
 */

import { ORPCError } from "@orpc/client";
import {
	PROJECT_ROLE_PERMISSIONS,
	Permissions as RealPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks, captured } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		hasProjectAccess: vi.fn(),
		listLivingMemoryDecisionCandidates: vi.fn(),
		countLivingMemoryFilesAwaitingDecisionScan: vi.fn(),
		listLivingMemoryLimitedFiles: vi.fn(),
		startLivingMemoryFirstSyncScan: vi.fn(),
		getLivingMemoryDecisionCandidate: vi.fn(),
		dismissLivingMemoryDecision: vi.fn(),
		getArchitectureDecision: vi.fn(),
		createDecisionFromLivingMemoryCandidate: vi.fn(),
		completeCapturedDecision: vi.fn(),
	};
	const captured: { permissions: unknown[] } = { permissions: [] };
	return { handlers, mocks, captured };
});

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	listLivingMemoryDecisionCandidates:
		mocks.listLivingMemoryDecisionCandidates,
	countLivingMemoryFilesAwaitingDecisionScan:
		mocks.countLivingMemoryFilesAwaitingDecisionScan,
	listLivingMemoryLimitedFiles: mocks.listLivingMemoryLimitedFiles,
	getLivingMemoryDecisionCandidate: mocks.getLivingMemoryDecisionCandidate,
	dismissLivingMemoryDecision: mocks.dismissLivingMemoryDecision,
	getArchitectureDecision: mocks.getArchitectureDecision,
	createDecisionFromLivingMemoryCandidate:
		mocks.createDecisionFromLivingMemoryCandidate,
	LIVING_MEMORY_DECISION_SOURCE_KIND: "living_memory",
}));

vi.mock("../../../lib/captured-decision", () => ({
	completeCapturedDecision: mocks.completeCapturedDecision,
	deriveCapturedDecisionTitle: (text: string) => `Title: ${text}`,
}));

vi.mock("../../../lib/living-memory-decision-scan-workflow", () => ({
	startLivingMemoryFirstSyncScan: mocks.startLivingMemoryFirstSyncScan,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = [
		"list",
		"scanFirstSync",
		"createFrom",
		"dismiss",
	];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: {
			ARCHITECTURE_DECISION_READ: "architecture_decision:read",
			ARCHITECTURE_DECISION_CREATE: "architecture_decision:create",
		},
		requireProjectPermission: (permission: unknown) => {
			captured.permissions.push(["project", permission]);
			return (c: unknown) => c;
		},
		requireInputOrgPermission: (permission: unknown) => {
			captured.permissions.push(["inputOrg", permission]);
			return (c: unknown) => c;
		},
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../living-memory-decisions");

const HASH = "a".repeat(64);
const EXTRACTED_AT = new Date("2026-11-04T10:00:00.000Z");

const context = {
	user: { id: "user-1", email: "reviewer@example.com", name: "Reviewer" },
	session: { id: "sess-1" },
};

const candidate = {
	extractionId: "ext-1",
	contextId: "ctx-1",
	contentHash: HASH,
	sourcePath: "docs/architecture.md",
	extractedAt: EXTRACTED_AT,
	decisionIndex: 2,
	text: "We use Postgres for all persistence.",
	rationale: "One operational store.",
};

const createInput = {
	projectId: "p-1",
	organizationId: "org-1",
	extractionId: "ext-1",
	decisionIndex: 2,
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getLivingMemoryDecisionCandidate.mockResolvedValue({
		status: "found",
		candidate,
	});
	mocks.createDecisionFromLivingMemoryCandidate.mockResolvedValue({
		status: "created",
		decision: { id: "dec-new", identifier: "ADR-007" },
	});
	mocks.completeCapturedDecision.mockImplementation(async (decision) => ({
		...decision,
		tagged: true,
	}));
});

describe("Living Memory candidate procedures — authorization", () => {
	it("gates like the meeting candidates: READ to list, CREATE to scan, create and dismiss", () => {
		expect(captured.permissions).toEqual([
			["inputOrg", "architecture_decision:read"],
			["project", "architecture_decision:read"],
			["inputOrg", "architecture_decision:create"],
			["project", "architecture_decision:create"],
			["inputOrg", "architecture_decision:create"],
			["project", "architecture_decision:create"],
			["inputOrg", "architecture_decision:create"],
			["project", "architecture_decision:create"],
		]);
		const create = RealPermissions.ARCHITECTURE_DECISION_CREATE;
		expect(PROJECT_ROLE_PERMISSIONS.VIEWER).not.toContain(create);
		expect(PROJECT_ROLE_PERMISSIONS.COMMENTER).not.toContain(create);
	});

	it.each(["list", "scanFirstSync", "createFrom", "dismiss"])(
		"%s refuses a caller without access to the project",
		async (key) => {
			mocks.hasProjectAccess.mockResolvedValue(false);

			await expect(
				handlers[key]?.({ input: createInput, context }),
			).rejects.toBeInstanceOf(ORPCError);
			expect(
				mocks.createDecisionFromLivingMemoryCandidate,
			).not.toHaveBeenCalled();
			expect(mocks.dismissLivingMemoryDecision).not.toHaveBeenCalled();
			expect(mocks.startLivingMemoryFirstSyncScan).not.toHaveBeenCalled();
		},
	);
});

describe("scanFirstSync", () => {
	const scanInput = { projectId: "p-1", organizationId: "org-1" };

	it("starts the project's scan, naming the member who asked, and says how many files it covers", async () => {
		mocks.countLivingMemoryFilesAwaitingDecisionScan.mockResolvedValue(3);
		mocks.startLivingMemoryFirstSyncScan.mockResolvedValue(true);

		await expect(
			handlers.scanFirstSync?.({ input: scanInput, context }),
		).resolves.toEqual({ fileCount: 3, alreadyRunning: false });
		expect(
			mocks.countLivingMemoryFilesAwaitingDecisionScan,
		).toHaveBeenCalledWith(scanInput);
		expect(mocks.startLivingMemoryFirstSyncScan).toHaveBeenCalledWith({
			...scanInput,
			requestedByUserId: "user-1",
		});
	});

	it("answers rather than fails when a scan is already open", async () => {
		mocks.countLivingMemoryFilesAwaitingDecisionScan.mockResolvedValue(3);
		mocks.startLivingMemoryFirstSyncScan.mockResolvedValue(false);

		await expect(
			handlers.scanFirstSync?.({ input: scanInput, context }),
		).resolves.toEqual({ fileCount: 3, alreadyRunning: true });
	});

	it("starts nothing when no file is waiting", async () => {
		mocks.countLivingMemoryFilesAwaitingDecisionScan.mockResolvedValue(0);

		await expect(
			handlers.scanFirstSync?.({ input: scanInput, context }),
		).resolves.toEqual({ fileCount: 0, alreadyRunning: false });
		expect(mocks.startLivingMemoryFirstSyncScan).not.toHaveBeenCalled();
	});
});

describe("list", () => {
	it("returns the project's candidates, unread file count and partly read files for the resolved organization", async () => {
		const limitedFiles = [
			{ sourcePath: "docs/huge.md", truncated: true, capped: false },
		];
		mocks.listLivingMemoryDecisionCandidates.mockResolvedValue([candidate]);
		mocks.countLivingMemoryFilesAwaitingDecisionScan.mockResolvedValue(2);
		mocks.listLivingMemoryLimitedFiles.mockResolvedValue(limitedFiles);

		await expect(
			handlers.list?.({
				input: { projectId: "p-1", organizationId: "org-1" },
				context,
			}),
		).resolves.toEqual({
			candidates: [candidate],
			filesNotScanned: 2,
			limitedFiles,
		});
		const scope = { projectId: "p-1", organizationId: "org-1" };
		expect(mocks.listLivingMemoryDecisionCandidates).toHaveBeenCalledWith(
			scope,
		);
		expect(mocks.listLivingMemoryLimitedFiles).toHaveBeenCalledWith(scope);
	});
});

describe("createFrom", () => {
	it("writes a PROPOSED decision carrying the candidate key, then completes it", async () => {
		const result = await handlers.createFrom?.({
			input: createInput,
			context,
		});

		expect(
			mocks.createDecisionFromLivingMemoryCandidate,
		).toHaveBeenCalledWith(
			candidate,
			expect.objectContaining({
				projectId: "p-1",
				createdById: "user-1",
				title: `Title: ${candidate.text}`,
				decision: candidate.text,
				rationale: "One operational store.",
				status: "PROPOSED",
				decisionDate: EXTRACTED_AT,
				relatedDecisionIds: [],
				sourceKind: "living_memory",
				sourceMetadata: {
					contextId: "ctx-1",
					contentHash: HASH,
					sourcePath: "docs/architecture.md",
					index: 2,
					originalText: candidate.text,
				},
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
		expect(mocks.completeCapturedDecision).toHaveBeenCalledWith(
			{ id: "dec-new", identifier: "ADR-007" },
			{ projectId: "p-1", user: context.user, organizationId: "org-1" },
		);
		expect(result).toEqual({
			decision: { id: "dec-new", identifier: "ADR-007", tagged: true },
		});
	});

	it("carries the work item the lookup re-read into the decision's source", async () => {
		const workItem = { id: "story-12", identifier: "F-012" };
		mocks.getLivingMemoryDecisionCandidate.mockResolvedValue({
			status: "found",
			candidate: { ...candidate, workItem },
		});

		await handlers.createFrom?.({ input: createInput, context });

		const written =
			mocks.createDecisionFromLivingMemoryCandidate.mock.calls[0]?.[1];
		expect(written.sourceMetadata).toEqual({
			contextId: "ctx-1",
			contentHash: HASH,
			sourcePath: "docs/architecture.md",
			index: 2,
			originalText: candidate.text,
			workItem,
		});
	});

	it("creates as an update: links the existing decision without changing it", async () => {
		mocks.getArchitectureDecision.mockResolvedValue({
			id: "dec-old",
			identifier: "ADR-003",
		});

		await handlers.createFrom?.({
			input: { ...createInput, updatesDecisionId: "dec-old" },
			context,
		});

		expect(mocks.getArchitectureDecision).toHaveBeenCalledWith({
			id: "dec-old",
			projectId: "p-1",
		});
		const written =
			mocks.createDecisionFromLivingMemoryCandidate.mock.calls[0]?.[1];
		expect(written.status).toBe("PROPOSED");
		expect(written.relatedDecisionIds).toEqual(["dec-old"]);
		expect(written.sourceMetadata.supersedes).toBe("dec-old");
		expect(written.contextProblem).toContain("ADR-003");
		expect(written).not.toHaveProperty("supersededById");
	});

	it("answers NOT_FOUND when the decision to update is not this project's", async () => {
		mocks.getArchitectureDecision.mockResolvedValue(null);

		await expect(
			handlers.createFrom?.({
				input: { ...createInput, updatesDecisionId: "dec-elsewhere" },
				context,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			mocks.createDecisionFromLivingMemoryCandidate,
		).not.toHaveBeenCalled();
	});

	it("answers CONFLICT, not a duplicate, when a concurrent request converted the candidate first", async () => {
		mocks.createDecisionFromLivingMemoryCandidate.mockResolvedValue({
			status: "converted",
		});

		await expect(
			handlers.createFrom?.({ input: createInput, context }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: "A decision was already created from this suggestion",
		});
		expect(mocks.completeCapturedDecision).not.toHaveBeenCalled();
	});

	it.each([
		["not_found", "NOT_FOUND"],
		["stale", "CONFLICT"],
		["converted", "CONFLICT"],
	])("refuses a %s candidate with %s", async (status, code) => {
		mocks.getLivingMemoryDecisionCandidate.mockResolvedValue({ status });

		await expect(
			handlers.createFrom?.({ input: createInput, context }),
		).rejects.toMatchObject({ code });
		expect(
			mocks.createDecisionFromLivingMemoryCandidate,
		).not.toHaveBeenCalled();
	});
});

describe("dismiss", () => {
	it("records the dismissal scoped to the project and organization", async () => {
		mocks.dismissLivingMemoryDecision.mockResolvedValue(true);

		await expect(
			handlers.dismiss?.({ input: createInput, context }),
		).resolves.toEqual({ success: true });
		expect(mocks.dismissLivingMemoryDecision).toHaveBeenCalledWith({
			projectId: "p-1",
			organizationId: "org-1",
			extractionId: "ext-1",
			decisionIndex: 2,
		});
	});

	it("answers NOT_FOUND for a candidate outside the project", async () => {
		mocks.dismissLivingMemoryDecision.mockResolvedValue(false);

		await expect(
			handlers.dismiss?.({ input: createInput, context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
