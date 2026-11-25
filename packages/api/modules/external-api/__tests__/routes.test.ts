import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	verifyKey: vi.fn(),
	ownerPermission: vi.fn(),
	execute: vi.fn(),
	upload: vi.fn(),
	validateFile: vi.fn(),
	agent: vi.fn(),
	agents: vi.fn(),
	execution: vi.fn(),
	spec: vi.fn(),
	stream: vi.fn(),
	eventStream: vi.fn(),
	authorizeStream: vi.fn(),
}));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	verifyOrganizationApiKey: mocks.verifyKey,
	canExecuteOrganizationAgents: mocks.ownerPermission,
}));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://app.example.com" }));
vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: vi.fn(),
}));
vi.mock("../middleware/api-rate-limit", () => ({
	externalApiRateLimit: () => (_: unknown, next: () => Promise<void>) =>
		next(),
}));
vi.mock("../middleware/usage-logger", () => ({
	usageLogger: () => (_: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../procedures/execute-agent", () => ({ executeAgent: mocks.execute }));
vi.mock("../procedures/get-agent", () => ({ getExposedAgent: mocks.agent }));
vi.mock("../procedures/list-agents", () => ({
	listExposedAgents: mocks.agents,
}));
vi.mock("../procedures/get-execution", () => ({
	getExecution: mocks.execution,
	authorizeAgentExecutionStream: mocks.authorizeStream,
}));
vi.mock("../procedures/stream-execution", () => ({
	createExecutionStreamHandler: () => mocks.stream,
}));
vi.mock("../lib/execution-stream", () => ({
	createExecutionEventStream: mocks.eventStream,
}));
vi.mock("../procedures/openapi-docs", () => ({
	generateOpenApiSpec: mocks.spec,
}));
vi.mock("../procedures/upload-file", () => ({
	handleFileUpload: mocks.upload,
	validateFileIdAccess: mocks.validateFile,
}));

import { createExternalApiRoutes } from "../routes";

const app = createExternalApiRoutes();
const auth = { Authorization: "Bearer org_example_fixture" };
const key = {
	id: "example-key",
	createdByUserId: "example-user",
	organizationId: "example-org",
	scopes: ["agents:read", "agents:execute"],
};
const context = {
	keyType: "organization",
	keyId: key.id,
	keyPrefix: "org_example",
	userId: key.createdByUserId,
	organizationId: key.organizationId,
	scopes: key.scopes,
};
const instanceId = "example-instance";
const executionId = "example-execution";
const executePath = `/agents/${instanceId}/execute`;
const input = { message: "Example" };

beforeEach(() => {
	vi.resetAllMocks();
	mocks.verifyKey.mockResolvedValue(key);
	mocks.ownerPermission.mockResolvedValue(true);
});

function post(body: unknown, headers?: Record<string, string>) {
	return app.request(executePath, {
		method: "POST",
		headers: { ...auth, "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}
async function expectJson(response: Response, status: number, body: unknown) {
	expect(response.status).toBe(status);
	expect(await response.json()).toEqual(body);
}

it("authenticates before dispatching", async () => {
	const response = await app.request("/agents");
	expect(response.status).toBe(401);
	expect(mocks.agents).not.toHaveBeenCalled();
});

it("allows a cross-origin preflight with the idempotency header", async () => {
	const response = await app.request(executePath, {
		method: "OPTIONS",
		headers: {
			Origin: "https://example.com",
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers": "Idempotency-Key",
		},
	});
	expect(response.status).toBe(204);
	expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
		"Idempotency-Key",
	);
	expect(mocks.verifyKey).not.toHaveBeenCalled();
});

it("refuses a key that lacks execute scope even if its creator has permission", async () => {
	mocks.verifyKey.mockResolvedValue({ ...key, scopes: ["agents:read"] });
	await expectJson(await post({ input }), 403, {
		error: "Missing required scope: agents:execute",
	});
	expect(mocks.ownerPermission).not.toHaveBeenCalled();
	expect(mocks.execute).not.toHaveBeenCalled();
});

it.each(["agents:execute", "*"])(
	"refuses a key with %s when the creator lacks permission",
	async (scope) => {
		mocks.verifyKey.mockResolvedValue({ ...key, scopes: [scope] });
		mocks.ownerPermission.mockResolvedValue(false);
		await expectJson(await post({ input }), 403, {
			error: "The key's owner no longer holds the access required for agents:execute in this organization",
		});
		expect(mocks.ownerPermission).toHaveBeenCalledExactlyOnceWith(
			key.createdByUserId,
			key.organizationId,
		);
		expect(mocks.execute).not.toHaveBeenCalled();
	},
);

it("rejects malformed JSON before starting an execution", async () => {
	const response = await app.request(executePath, {
		method: "POST",
		headers: auth,
		body: "{",
	});
	await expectJson(response, 400, { error: "Invalid JSON body" });
	expect(mocks.execute).not.toHaveBeenCalled();
});

it.each([null, {}, { input: null }, { input: "text" }, { input: [] }])(
	"rejects an execution without an input object (%j)",
	async (body) => {
		await expectJson(await post(body), 400, {
			error: "Request body must include an 'input' object",
		});
		expect(mocks.execute).not.toHaveBeenCalled();
	},
);

it.each([null, { mimeType: "image/png" }, { fileId: "example-file" }])(
	"rejects incomplete image references (%j)",
	async (image) => {
		await expectJson(await post({ input, images: [image] }), 400, {
			error: "Each image must have fileId and mimeType",
		});
		expect(mocks.validateFile).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
	},
);

const image = { fileId: "example-file", mimeType: "image/png" };

it("rejects more than five images before looking up access", async () => {
	await expectJson(await post({ input, images: Array(6).fill(image) }), 400, {
		error: "Too many images: maximum 5 per request",
	});
	expect(mocks.validateFile).not.toHaveBeenCalled();
	expect(mocks.execute).not.toHaveBeenCalled();
});

it("does not execute with an image outside the caller's access", async () => {
	mocks.validateFile.mockResolvedValue({
		valid: false,
		error: "File not found",
	});
	await expectJson(await post({ input, images: [image] }), 403, {
		error: "File not found",
	});
	expect(mocks.validateFile).toHaveBeenCalledExactlyOnceWith(
		image.fileId,
		context,
	);
	expect(mocks.execute).not.toHaveBeenCalled();
});

it("requires a stream scope before starting a streaming execution", async () => {
	await expectJson(await post({ input, stream: true }), 403, {
		error: "Missing required scope: agents:stream",
	});
	expect(mocks.execute).not.toHaveBeenCalled();
});

it("rejects conflicting idempotency keys before starting an execution", async () => {
	const response = await post(
		{ input, idempotencyKey: "body-key" },
		{ "Idempotency-Key": "header-key" },
	);
	await expectJson(response, 400, {
		error: {
			code: "INVALID_EXECUTION_REQUEST",
			message: "Invalid or conflicting request keys",
		},
	});
	expect(mocks.execute).not.toHaveBeenCalled();
});

const receipt = {
	executionId,
	deploymentId: "example-deployment",
	workflowId: "example-workflow",
	workflowExecutionId: "example-channel",
};

it("passes the verified image, actor and idempotency header to execution", async () => {
	mocks.validateFile.mockResolvedValue({
		valid: true,
		storagePath: "example/image.png",
	});
	mocks.execute.mockResolvedValue({ status: 202, data: receipt });
	const response = await post(
		{ input, images: [image], priority: "HIGH" },
		{ "Idempotency-Key": "example-request" },
	);
	await expectJson(response, 202, receipt);
	expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(
		instanceId,
		{
			input,
			priority: "HIGH",
			idempotencyKey: "example-request",
			stream: undefined,
			imageRefs: [
				{
					storagePath: "example/image.png",
					mimeType: "image/png",
					name: "image",
					accessUserId: key.createdByUserId,
				},
			],
		},
		context,
	);
});

it("preserves execution error status and code", async () => {
	const error = {
		code: "IDEMPOTENCY_CONFLICT",
		message: "Conflicting request",
	};
	mocks.execute.mockResolvedValue({ status: 409, error });
	await expectJson(await post({ input }), 409, { error });
});

it("authorizes the execution stream against the public receipt ID", async () => {
	const scopes = ["*"];
	mocks.verifyKey.mockResolvedValue({ ...key, scopes });
	mocks.execute.mockResolvedValue({ status: 202, data: receipt });
	const events = new ReadableStream();
	mocks.eventStream.mockReturnValue(events);
	mocks.authorizeStream.mockReturnValue(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode("data: example\n\n"),
				);
				controller.close();
			},
		}),
	);
	const response = await post({ input, stream: true });
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toBe("text/event-stream");
	expect(response.headers.get("X-Execution-Id")).toBe(executionId);
	expect(await response.text()).toBe("data: example\n\n");
	expect(mocks.eventStream).toHaveBeenCalledWith(
		receipt.workflowExecutionId,
		receipt.workflowId,
	);
	expect(mocks.authorizeStream).toHaveBeenCalledWith(events, executionId, {
		...context,
		scopes,
	});
});

it.each([
	{ path: "/agents", delegate: mocks.agents, args: [], data: [] },
	{
		path: `/agents/${instanceId}`,
		delegate: mocks.agent,
		args: [instanceId],
		data: { id: instanceId },
	},
	{
		path: `/executions/${executionId}`,
		delegate: mocks.execution,
		args: [executionId],
		data: { id: executionId },
	},
	{
		path: "/docs/openapi.json",
		delegate: mocks.spec,
		args: [],
		data: { openapi: "3.1.0" },
	},
])(
	"passes authenticated context to GET $path",
	async ({ path, delegate, args, data }) => {
		delegate.mockResolvedValue(data);
		await expectJson(await app.request(path, { headers: auth }), 200, data);
		expect(delegate).toHaveBeenCalledExactlyOnceWith(...args, context);
	},
);

it.each([
	{
		path: `/agents/${instanceId}`,
		delegate: mocks.agent,
		error: "Agent not found",
	},
	{
		path: `/executions/${executionId}`,
		delegate: mocks.execution,
		error: "Execution not found",
	},
])(
	"returns 404 for a missing resource at $path",
	async ({ path, delegate, error }) => {
		delegate.mockResolvedValue(null);
		await expectJson(await app.request(path, { headers: auth }), 404, {
			error,
		});
	},
);

it("only dispatches the execution stream route to keys with its scope", async () => {
	const path = `/executions/${executionId}/stream`;
	await expectJson(await app.request(path, { headers: auth }), 403, {
		error: "Missing required scope: agents:stream",
	});
	expect(mocks.stream).not.toHaveBeenCalled();
	mocks.verifyKey.mockResolvedValue({ ...key, scopes: ["agents:stream"] });
	mocks.stream.mockReturnValue(new Response("example stream"));
	expect(await (await app.request(path, { headers: auth })).text()).toBe(
		"example stream",
	);
	expect(mocks.stream).toHaveBeenCalledOnce();
});

it("rejects a non-multipart upload and a multipart upload without a file", async () => {
	const upload = (body: string | FormData) =>
		app.request("/agents/files", { method: "POST", headers: auth, body });
	await expectJson(await upload("invalid"), 400, {
		error: "Invalid multipart/form-data body",
	});
	await expectJson(await upload(new FormData()), 400, {
		error: "No file provided",
	});
	expect(mocks.upload).not.toHaveBeenCalled();
});

it.each([true, false])(
	"serializes the upload result (uploaded: %s)",
	async (uploaded) => {
		const data = {
			fileId: "example-file",
			name: "example.png",
			size: 7,
			mimeType: "image/png",
		};
		mocks.upload.mockResolvedValue(
			uploaded
				? { data, status: 200 }
				: { error: "File type not allowed", status: 415 },
		);
		const form = new FormData();
		form.set(
			"file",
			new File(["example"], "example.png", { type: "image/png" }),
		);
		const response = await app.request("/agents/files", {
			method: "POST",
			headers: auth,
			body: form,
		});
		await expectJson(
			response,
			uploaded ? 200 : 415,
			uploaded ? data : { error: "File type not allowed" },
		);
		expect(mocks.upload).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ name: "example.png", type: "image/png" }),
			context,
		);
	},
);
