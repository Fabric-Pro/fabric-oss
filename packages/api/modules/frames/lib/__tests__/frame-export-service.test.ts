import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	frame: vi.fn(),
	audit: vi.fn(),
	sign: vi.fn(),
	start: vi.fn(),
	describe: vi.fn(),
	query: vi.fn(),
	cancel: vi.fn(),
	memo: undefined as any,
}));
vi.mock("@repo/database", () => ({
	canReadOrganizationFrames: m.read,
	getUserById: async () => ({ email: "user@example.com" }),
	getAccessibleFrameById: m.frame,
	recordAuditDurable: m.audit,
}));
vi.mock("@repo/storage", () => ({ getSignedUrl: m.sign }));
vi.mock("@repo/temporal/client", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: m.start,
			getHandle: () => ({
				describe: m.describe,
				query: m.query,
				cancel: m.cancel,
			}),
		},
	}),
}));

import {
	cancelFrameExport,
	downloadFrameExport,
	getFrameExport,
	startFrameExport,
} from "../frame-export-service";

const actor = { userId: "example-user", organizationId: "example-org" };
const request = {
	frameId: "example-frame",
	expectedUpdatedAt: "2026-11-01T00:00:00.000Z",
	requestId: "11111111-1111-4111-8111-111111111111",
};
beforeEach(() => {
	vi.resetAllMocks();
	m.read.mockResolvedValue(true);
	m.frame.mockResolvedValue({
		id: request.frameId,
		updatedAt: new Date(request.expectedUpdatedAt),
		document: { blocks: [] },
		projectId: null,
	});
	m.audit.mockResolvedValue(undefined);
	m.sign.mockResolvedValue("https://example.com/download");
	m.start.mockImplementation(async (_type: string, options: any) => {
		m.memo = options.memo.fabricFrameExport;
		return {};
	});
	m.describe.mockImplementation(async () => ({
		type: "exportFrameToPDF",
		memo: { fabricFrameExport: m.memo },
		status: { name: "RUNNING" },
	}));
	m.query.mockImplementation(async () => ({
		status: "completed",
		storageKey: m.memo.objectKey,
	}));
	m.cancel.mockResolvedValue(undefined);
});
it("pins a stable native admission and does not disclose storage identity or a bearer link in state", async () => {
	const first = await startFrameExport(actor, request);
	expect(first.status).toBe("pending");
	expect(m.start).toHaveBeenCalledWith(
		"exportFrameToPDF",
		expect.objectContaining({
			taskQueue: "fabric-worker",
			workflowIdReusePolicy: "REJECT_DUPLICATE",
			args: [
				expect.objectContaining({
					expectedUpdatedAt: request.expectedUpdatedAt,
					managedExport: expect.any(Object),
				}),
			],
		}),
	);
	const existing = new Error();
	existing.name = "WorkflowExecutionAlreadyStartedError";
	m.start.mockRejectedValueOnce(existing);
	const retry = await startFrameExport(actor, request);
	expect(retry.exportId).toBe(first.exportId);
	const state = await getFrameExport(actor, {
		frameId: request.frameId,
		exportId: first.exportId,
	});
	expect(state.status).toBe("completed");
	expect(state).not.toHaveProperty("storageKey");
	expect(state).not.toHaveProperty("url");
	expect(m.sign).not.toHaveBeenCalled();
});
it("refuses stale content, revoked roles and inaccessible objects before dispatch", async () => {
	await expect(
		startFrameExport(actor, {
			...request,
			expectedUpdatedAt: "2026-10-01T00:00:00Z",
		}),
	).rejects.toMatchObject({ status: 409 });
	m.read.mockResolvedValue(false);
	await expect(startFrameExport(actor, request)).rejects.toMatchObject({
		status: 404,
	});
	m.read.mockResolvedValue(true);
	m.frame.mockResolvedValue(null);
	await expect(startFrameExport(actor, request)).rejects.toMatchObject({
		status: 404,
	});
	expect(m.start).not.toHaveBeenCalled();
});
it("refuses another actor, tenant, frame and request-identity collision", async () => {
	const job = await startFrameExport(actor, request);
	const input = { frameId: request.frameId, exportId: job.exportId };
	await expect(
		getFrameExport({ ...actor, userId: "example-other-user" }, input),
	).rejects.toMatchObject({ status: 404 });
	await expect(
		getFrameExport(
			{ ...actor, organizationId: "example-other-org" },
			input,
		),
	).rejects.toMatchObject({ status: 404 });
	await expect(
		getFrameExport(actor, { ...input, frameId: "example-other-frame" }),
	).rejects.toMatchObject({ status: 404 });
	const existing = new Error();
	existing.name = "WorkflowExecutionAlreadyStartedError";
	m.start.mockRejectedValueOnce(existing);
	await expect(
		startFrameExport(actor, { ...request, orientation: "landscape" }),
	).rejects.toMatchObject({ status: 409 });
});
it("signs only an explicit current-authority and current-revision download for at most sixty seconds", async () => {
	const job = await startFrameExport(actor, request);
	const input = { frameId: request.frameId, exportId: job.exportId };
	await expect(downloadFrameExport(actor, input)).resolves.toMatchObject({
		url: "https://example.com/download",
	});
	expect(m.sign).toHaveBeenCalledWith(
		m.memo.objectKey,
		expect.objectContaining({ expiresIn: 60 }),
	);
	m.sign.mockClear();
	m.frame.mockResolvedValue({ updatedAt: new Date("2026-11-02T00:00:00Z") });
	await expect(downloadFrameExport(actor, input)).rejects.toMatchObject({
		status: 409,
	});
	expect(m.sign).not.toHaveBeenCalled();
	m.read.mockResolvedValue(false);
	await expect(downloadFrameExport(actor, input)).rejects.toMatchObject({
		status: 404,
	});
});
it("refuses expired, mismatched and non-ready exports without issuing links", async () => {
	const job = await startFrameExport(actor, request);
	const input = { frameId: request.frameId, exportId: job.exportId };
	m.query.mockResolvedValue({
		status: "completed",
		storageKey: "exports/unrelated.pdf",
	});
	await expect(downloadFrameExport(actor, input)).rejects.toMatchObject({
		status: 404,
	});
	m.query.mockResolvedValue({ status: "running" });
	await expect(downloadFrameExport(actor, input)).rejects.toMatchObject({
		status: 409,
	});
	m.memo.expiresAt = "2020-01-01T00:00:00Z";
	expect((await getFrameExport(actor, input)).status).toBe("expired");
	await expect(downloadFrameExport(actor, input)).rejects.toMatchObject({
		status: 409,
	});
	expect(m.sign).not.toHaveBeenCalled();
});
it("treats cancellation as requested until Temporal confirms and does not restart it", async () => {
	const job = await startFrameExport(actor, request);
	const input = { frameId: request.frameId, exportId: job.exportId };
	m.query.mockResolvedValue({ status: "running" });
	expect((await cancelFrameExport(actor, input)).status).toBe("running");
	expect(m.cancel).toHaveBeenCalledOnce();
	m.describe.mockResolvedValue({
		type: "exportFrameToPDF",
		memo: { fabricFrameExport: m.memo },
		status: { name: "CANCELLED" },
	});
	expect((await getFrameExport(actor, input)).status).toBe("cancelled");
	expect(m.start).toHaveBeenCalledOnce();
});
it("fails closed when audit or native admission fails and never returns raw provider errors", async () => {
	m.audit.mockRejectedValueOnce(new Error("Audit unavailable"));
	await expect(startFrameExport(actor, request)).rejects.toThrow(
		"Audit unavailable",
	);
	expect(m.start).not.toHaveBeenCalled();
	m.start.mockRejectedValueOnce(
		new Error("example provider credential=hidden"),
	);
	await expect(startFrameExport(actor, request)).rejects.toMatchObject({
		status: 503,
		message: expect.not.stringContaining("credential"),
	});
});

it("normalizes uppercase UUIDs before generating native and storage identity", async () => {
	const job = await startFrameExport(actor, {
		...request,
		requestId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
	});
	expect(job.exportId).toMatch(/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa$/);
	expect(m.memo.objectKey).toMatch(
		/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\.pdf$/,
	);
	const existing = new Error();
	existing.name = "WorkflowExecutionAlreadyStartedError";
	m.start.mockRejectedValueOnce(existing);
	expect(
		(
			await startFrameExport(actor, {
				...request,
				requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			})
		).exportId,
	).toBe(job.exportId);
});
it("shows pending while the first native task has not registered the state query", async () => {
	const job = await startFrameExport(actor, request);
	const error = new Error();
	error.name = "QueryNotRegisteredError";
	m.query.mockRejectedValueOnce(error);
	expect(
		(
			await getFrameExport(actor, {
				frameId: request.frameId,
				exportId: job.exportId,
			})
		).status,
	).toBe("pending");
});
