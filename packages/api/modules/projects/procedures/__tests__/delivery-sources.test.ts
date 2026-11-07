import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commands = vi.hoisted(() => ({
	listDeliverySourceWatches: vi.fn(),
	inspectDeliverySource: vi.fn(),
	configureDeliverySource: vi.fn(),
	updateDeliverySourceState: vi.fn(),
	startDeliverySourceCapture: vi.fn(),
	getDeliverySourceCaptureStatus: vi.fn(),
	cancelDeliverySourceCapture: vi.fn(),
	listDeliverySourceObservations: vi.fn(),
	getDeliverySourceEvidence: vi.fn(),
}));
vi.mock("../../lib/delivery-source-commands", () => commands);
vi.mock("../../../../orpc/procedures", async () => {
	const { os } = await import("@orpc/server");
	return { tenantProtectedProcedure: os };
});

import { deliverySourcesProcedures } from "../delivery-sources";

const projectId = "example-project";
const watchId = "example-watch";
const requestId = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-01-01T00:00:00.000Z";
const rootPath = `/projects/${projectId}/delivery/private-sources`;
const watch = {
	id: watchId,
	provider: "SLACK",
	label: "Slack channel",
	state: "ACTIVE",
	version: 1,
	visibility: "ONLY_ME",
	retentionDays: 7,
	verifiedAt: timestamp,
	createdAt: timestamp,
	lastRequestId: null,
	hasMore: false,
	lastCaptureInput: null,
};
const run = {
	version: 1,
	state: "NOT_STARTED",
	requestId: null,
	coverage: null,
	captured: null,
	hasMore: false,
	message: null,
};
const cases = [
	{
		operation: "list",
		command: "listDeliverySourceWatches",
		method: "GET",
		path: rootPath,
		input: { projectId },
		output: {
			version: 1,
			availability: { state: "ENABLED", reason: null },
			watches: [watch],
			connections: [],
		},
	},
	{
		operation: "inspect",
		command: "inspectDeliverySource",
		method: "POST",
		path: `${rootPath}/inspect`,
		input: {
			projectId,
			integrationId: "example-integration",
			channelId: "C123",
		},
		output: {
			version: 1,
			provider: "SLACK",
			label: "Slack channel",
			visibility: "ONLY_ME",
			checkedAt: timestamp,
			coverage: "ROOT_MESSAGES_ONLY",
		},
	},
	{
		operation: "configure",
		command: "configureDeliverySource",
		method: "POST",
		path: rootPath,
		input: {
			projectId,
			integrationId: "example-integration",
			channelId: "C123",
			requestId,
			retentionDays: 7,
		},
		output: watch,
	},
	{
		operation: "state",
		command: "updateDeliverySourceState",
		method: "POST",
		path: `${rootPath}/${watchId}/state`,
		input: {
			projectId,
			watchId,
			requestId,
			expectedVersion: 1,
			action: "PAUSE",
		},
		output: { ...watch, state: "PAUSED" },
	},
	{
		operation: "capture",
		command: "startDeliverySourceCapture",
		method: "POST",
		path: `${rootPath}/${watchId}/capture`,
		input: {
			projectId,
			watchId,
			requestId,
			expectedVersion: 1,
			mode: "RECENT",
		},
		output: run,
	},
	{
		operation: "status",
		command: "getDeliverySourceCaptureStatus",
		method: "GET",
		path: `${rootPath}/${watchId}/capture`,
		input: { projectId, watchId },
		output: run,
	},
	{
		operation: "cancel",
		command: "cancelDeliverySourceCapture",
		method: "POST",
		path: `${rootPath}/${watchId}/capture/cancel`,
		input: { projectId, watchId, requestId },
		output: run,
	},
	{
		operation: "observations",
		command: "listDeliverySourceObservations",
		method: "GET",
		path: `${rootPath}/${watchId}/observations`,
		input: { projectId, watchId, limit: 20 },
		output: { version: 1, items: [], nextCursor: null },
	},
	{
		operation: "evidence",
		command: "getDeliverySourceEvidence",
		method: "GET",
		path: `${rootPath}/${watchId}/observations/example-observation`,
		input: { projectId, watchId, observationId: "example-observation" },
		output: {
			version: 1,
			observationId: "example-observation",
			text: "Example private evidence",
			capturedAt: timestamp,
			checkedAt: timestamp,
			coverage: "ROOT_MESSAGES_ONLY",
			visibility: "ONLY_ME",
		},
	},
] as const;

const router = { deliverySources: deliverySourcesProcedures };
const rpc = new RPCHandler(router, { plugins: [new ResponseHeadersPlugin()] });
const openApi = new OpenAPIHandler(router, {
	plugins: [new ResponseHeadersPlugin()],
});

async function respond(
	transport: "RPC" | "OpenAPI",
	entry: (typeof cases)[number],
) {
	const url = new URL(
		transport === "RPC"
			? `/deliverySources/${entry.operation}`
			: entry.path,
		"https://example.com",
	);
	if (transport === "RPC" && entry.method === "GET") {
		url.searchParams.set("data", JSON.stringify({ json: entry.input }));
	}
	const request = new Request(url, {
		method: entry.method,
		...(entry.method === "POST" && {
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				transport === "RPC" ? { json: entry.input } : entry.input,
			),
		}),
	});
	const handler = transport === "RPC" ? rpc : openApi;
	const result = await handler.handle(request, {
		context: { user: { id: "example-user" } },
	});
	expect(result.matched).toBe(true);
	if (!result.response) {
		throw new Error("Expected a matched HTTP response");
	}
	return result.response;
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe.each(["RPC", "OpenAPI"] as const)(
	"private source %s response caching",
	(transport) => {
		it.each(cases)(
			"prevents storage of $method $operation responses",
			async (entry) => {
				commands[entry.command].mockResolvedValue(entry.output);
				const response = await respond(transport, entry);
				expect(response.status).toBe(200);
				expect(response.headers.get("Cache-Control")).toBe(
					"private, no-store",
				);
				const body = await response.json();
				expect(transport === "RPC" ? body.json : body).toEqual(
					entry.output,
				);
				expect(commands[entry.command]).toHaveBeenCalledWith(
					{ userId: "example-user" },
					entry.input,
				);
			},
		);

		it.each(cases.filter((entry) => entry.method === "GET"))(
			"prevents storage of a $operation refusal without returning private content",
			async (entry) => {
				commands[entry.command].mockRejectedValue(
					new ORPCError("FORBIDDEN", {
						message: "Current source access is required.",
					}),
				);
				const response = await respond(transport, entry);
				expect(response.status).toBe(403);
				expect(response.headers.get("Cache-Control")).toBe(
					"private, no-store",
				);
				expect(await response.text()).not.toContain(
					"Example private evidence",
				);
			},
		);
	},
);
