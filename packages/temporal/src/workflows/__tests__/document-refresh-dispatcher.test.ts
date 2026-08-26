/**
 * The sweep workflow's contract: one document's failure must not end the sweep.
 *
 * Repo convention (see the header of `monitoring/__tests__/incident-lifecycle.test.ts`)
 * is to mock the activity surface with `vi.fn()` and drive the workflow body as
 * a plain async helper — NOT `TestWorkflowEnvironment`, which would pull
 * Temporalite into CI. Determinism is gated separately by the replay-validation
 * matrix in .github/workflows/temporal-replay-validation.yml.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findDueMock, dispatchMock, logErrorMock } = vi.hoisted(() => ({
	findDueMock: vi.fn(),
	dispatchMock: vi.fn(),
	logErrorMock: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	log: { error: logErrorMock, info: vi.fn(), warn: vi.fn() },
	proxyActivities: () => ({
		findDueDocumentsActivity: findDueMock,
		dispatchDocumentRefreshActivity: dispatchMock,
	}),
}));

import { documentRefreshDispatcherWorkflow } from "../document-refresh-dispatcher";

function due(documentId: string) {
	return {
		documentId,
		projectId: "proj_1",
		documentTitle: "PRD",
		organizationId: null,
		userId: "user_1",
		triggeredByUserId: "user_1",
		workflowId: `document-refresh-${documentId}-1342`,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	dispatchMock.mockResolvedValue(undefined);
});

describe("documentRefreshDispatcherWorkflow", () => {
	it("dispatches every due document", async () => {
		findDueMock.mockResolvedValue({
			due: [due("doc_1"), due("doc_2"), due("doc_3")],
		});

		const result = await documentRefreshDispatcherWorkflow();

		expect(result).toEqual({ dispatched: 3 });
		expect(dispatchMock).toHaveBeenCalledTimes(3);
	});

	it("does nothing when nothing is due", async () => {
		findDueMock.mockResolvedValue({ due: [] });

		const result = await documentRefreshDispatcherWorkflow();

		expect(result).toEqual({ dispatched: 0 });
		expect(dispatchMock).not.toHaveBeenCalled();
	});

	it("continues past a failing document and reports what it did dispatch", async () => {
		findDueMock.mockResolvedValue({
			due: [due("doc_1"), due("doc_2"), due("doc_3")],
		});
		dispatchMock
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("temporal is having a day"))
			.mockResolvedValueOnce(undefined);

		const result = await documentRefreshDispatcherWorkflow();

		// One document's failure must not block the rest of the sweep.
		expect(result).toEqual({ dispatched: 2 });
		expect(dispatchMock).toHaveBeenCalledTimes(3);
		expect(logErrorMock).toHaveBeenCalledWith(
			expect.stringContaining("dispatch failed"),
			expect.objectContaining({ documentId: "doc_2" }),
		);
	});
});
