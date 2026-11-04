import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	resolveExecutionChatMediaAccess: vi.fn(),
	getSignedUrl: vi.fn(),
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { chatDocuments: "example-chat-documents" } },
	},
}));
vi.mock("@repo/database", () => ({
	db: { agentDeploymentExecution: { findFirst: mocks.findFirst } },
	getAgentTemplateInstanceForRead: async () => ({
		instance: {},
		projectId: "example-project",
	}),
	getProjectAccessContext: async () => ({ organizationId: "example-org" }),
	isProjectSoftDeleted: async () => false,
	readAgentExecutionAdmission: () => null,
	resolveExecutionChatMediaAccess: mocks.resolveExecutionChatMediaAccess,
}));
vi.mock("@repo/storage", () => ({ getSignedUrl: mocks.getSignedUrl }));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => {
		throw new Error("Offline");
	},
}));

import { getExecution } from "../get-execution";

const path = "example-org/generated-images/1794200000000-abc123xy.png";
const context = {
	userId: "example-owner",
	organizationId: "example-org",
	scopes: ["agents:read"],
} as never;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findFirst.mockResolvedValue({
		id: "execution-example",
		userId: "example-owner",
		organizationId: "example-org",
		deployment: {
			instanceId: "example-instance",
			userId: "example-owner",
			organizationId: "example-org",
		},
		status: "COMPLETED",
		priority: 5,
		input: {},
		output: {
			artifacts: [
				{
					id: "artifact-example",
					name: "example.png",
					mimeType: "image/png",
					storagePath: path,
				},
			],
		},
		error: null,
		queuedAt: new Date(),
		startedAt: new Date(),
		completedAt: new Date(),
		duration: 1,
		inputTokens: 0,
		outputTokens: 0,
		totalCost: null,
		steps: [],
	});
	mocks.getSignedUrl.mockResolvedValue("https://storage.example/signed");
});

describe("getExecution artifact media access", () => {
	it("does not sign an influenceable artifact path when live access denies it", async () => {
		mocks.resolveExecutionChatMediaAccess.mockResolvedValueOnce("deny");

		const result = await getExecution("execution-example", context);

		expect(result?.artifacts).toEqual([]);
		expect(mocks.resolveExecutionChatMediaAccess).toHaveBeenCalledWith({
			storageKey: path,
			userId: "example-owner",
			organizationId: "example-org",
			execution: {
				userId: "example-owner",
				organizationId: "example-org",
				startedAt: expect.any(Date),
				completedAt: expect.any(Date),
			},
		});
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
	});

	it("signs the artifact only after an allow decision", async () => {
		mocks.resolveExecutionChatMediaAccess.mockResolvedValueOnce("allow");

		const result = await getExecution("execution-example", context);

		expect(result?.artifacts).toEqual([
			expect.objectContaining({ url: "https://storage.example/signed" }),
		]);
		expect(mocks.getSignedUrl).toHaveBeenCalledWith(path, {
			bucket: "example-chat-documents",
			expiresIn: 3600,
		});
	});
});
