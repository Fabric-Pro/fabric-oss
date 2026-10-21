/**
 * A person's editor save that ends a stalled Proposal run stops the run's
 * generation child (Fizzy #2946), best effort:
 *  - only a child is cancelled: a child id as it is, a single dispatch's id
 *    by the child id the dispatch gives it;
 *  - a batch or setup parent, a resume and an id naming another document are
 *    never cancelled, since they run other documents too;
 *  - `cancel()`, never `terminate()`;
 *  - a workflow that is already gone is silent, any other failure is logged,
 *    and nothing is thrown.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getHandle: vi.fn(),
	cancel: vi.fn(),
	terminate: vi.fn(),
	getTemporalClient: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { cancelStalledGenerationRun } from "../cancel-stalled-generation-run";

const DOC = "doc1";
const DISPATCH = `project-document-generation-${DOC}-0123456789abcdef`;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.cancel.mockResolvedValue(undefined);
	mocks.getHandle.mockImplementation(() => ({
		cancel: mocks.cancel,
		terminate: mocks.terminate,
	}));
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { getHandle: mocks.getHandle },
	});
});

describe("cancelStalledGenerationRun", () => {
	it("cancels a single dispatch's generation child, not the dispatch", async () => {
		await cancelStalledGenerationRun({
			documentId: DOC,
			workflowId: DISPATCH,
		});

		expect(mocks.getHandle).toHaveBeenCalledTimes(1);
		expect(mocks.getHandle).toHaveBeenCalledWith(
			`${DISPATCH}-child-${DOC}`,
		);
		expect(mocks.cancel).toHaveBeenCalledTimes(1);
		expect(mocks.terminate).not.toHaveBeenCalled();
	});

	it.each([
		["a dispatch's child", `${DISPATCH}-child-${DOC}`],
		[
			"a batch's child",
			`batch-document-generation-proj1-1700000000000-child-${DOC}`,
		],
		[
			"a resumed batch's child",
			`batch-document-generation-proj1-1700000000000-resume-2-child-${DOC}`,
		],
		["a setup's child", `existing-setup-proj1-1700000000000-doc-${DOC}`],
	])("cancels %s as it is", async (_label, workflowId) => {
		await cancelStalledGenerationRun({ documentId: DOC, workflowId });

		expect(mocks.getHandle).toHaveBeenCalledTimes(1);
		expect(mocks.getHandle).toHaveBeenCalledWith(workflowId);
		expect(mocks.cancel).toHaveBeenCalledTimes(1);
		expect(mocks.terminate).not.toHaveBeenCalled();
	});

	it.each([
		["a batch parent", "batch-document-generation-proj1-1700000000000"],
		["a setup parent", "existing-setup-proj1-1700000000000"],
		["a scheduled resume", "existing-setup-proj1-1700000000000-resume-1"],
		[
			"a Run now resume",
			"batch-document-generation-proj1-1700000000000-resume-1-api",
		],
		[
			"another document's dispatch",
			"project-document-generation-doc2-0123456789abcdef",
		],
		["another document's child", `${DISPATCH}-child-doc2`],
		[
			"another document's setup child",
			"existing-setup-proj1-1700000000000-doc-doc2",
		],
		["a longer id under the dispatch prefix", `${DISPATCH}-resume-1`],
		["the bare dispatch prefix", `project-document-generation-${DOC}-`],
	])("never touches %s", async (_label, workflowId) => {
		await cancelStalledGenerationRun({ documentId: DOC, workflowId });

		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
		expect(mocks.getHandle).not.toHaveBeenCalled();
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(mocks.terminate).not.toHaveBeenCalled();
	});

	it("stays silent when the child is already gone", async () => {
		const notFound = new Error("workflow execution already completed");
		notFound.name = "WorkflowNotFoundError";
		mocks.cancel.mockRejectedValue(notFound);

		await expect(
			cancelStalledGenerationRun({
				documentId: DOC,
				workflowId: DISPATCH,
			}),
		).resolves.toBeUndefined();

		expect(mocks.cancel).toHaveBeenCalledTimes(1);
		expect(mocks.warn).not.toHaveBeenCalled();
		expect(mocks.terminate).not.toHaveBeenCalled();
	});

	it("logs any other failure with ids only and never throws", async () => {
		const unavailable = new Error("14 UNAVAILABLE: connection refused");
		unavailable.name = "ServiceError";
		mocks.cancel.mockRejectedValue(unavailable);

		await expect(
			cancelStalledGenerationRun({
				documentId: DOC,
				workflowId: DISPATCH,
			}),
		).resolves.toBeUndefined();

		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(mocks.warn).toHaveBeenCalledWith(expect.any(String), {
			documentId: DOC,
			workflowId: DISPATCH,
			childWorkflowId: `${DISPATCH}-child-${DOC}`,
			error: "ServiceError",
		});
		expect(mocks.terminate).not.toHaveBeenCalled();
	});

	it("never throws when Temporal cannot be reached at all", async () => {
		mocks.getTemporalClient.mockRejectedValue(new Error("no address"));

		await expect(
			cancelStalledGenerationRun({
				documentId: DOC,
				workflowId: DISPATCH,
			}),
		).resolves.toBeUndefined();

		expect(mocks.warn).toHaveBeenCalledTimes(1);
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
});
