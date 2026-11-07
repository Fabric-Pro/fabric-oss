import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFabricMcpServer } from "../../../../packages/sdk-mcp/src/index";

const requestId = "11111111-1111-4111-8111-111111111111";
const make = () => ({
	listDeliverySources: vi.fn().mockResolvedValue({ version: 1 }),
	testDeliverySource: vi.fn().mockResolvedValue({ version: 1 }),
	configureDeliverySource: vi.fn().mockResolvedValue({ version: 1 }),
	pauseDeliverySource: vi.fn().mockResolvedValue({ version: 1 }),
	resumeDeliverySource: vi.fn().mockResolvedValue({ version: 1 }),
	disconnectDeliverySource: vi.fn().mockResolvedValue({ version: 1 }),
	startDeliverySourceCapture: vi.fn().mockResolvedValue({ version: 1 }),
	getDeliverySourceCapture: vi.fn().mockResolvedValue({ version: 1 }),
	cancelDeliverySourceCapture: vi.fn().mockResolvedValue({ version: 1 }),
	listDeliverySourceObservations: vi.fn().mockResolvedValue({ version: 1 }),
	getDeliverySourceEvidence: vi.fn().mockResolvedValue({ version: 1 }),
});
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
	await close?.();
	close = undefined;
});
async function setup(complete = true) {
	const methods = make();
	const server = createFabricMcpServer({
		fabric: {
			integrations: { list: async () => [] },
			projects: {
				list: async () => [],
				get: async () => ({}),
				listFeatures: async () => [],
				...(complete
					? methods
					: { listDeliverySources: methods.listDeliverySources }),
			},
		},
	});
	const client = new Client({
		name: "example-private-source-client",
		version: "1.0.0",
	});
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	await client.connect(b);
	close = async () => {
		await client.close();
		await server.close();
	};
	return { client, methods };
}
describe("SDK MCP private capture parity", () => {
	it("exposes all eleven source operations only when the SDK can execute them", async () => {
		const { client } = await setup();
		const names = (await client.listTools()).tools.filter((t) =>
			t.name.startsWith("fabric_delivery_source_"),
		);
		expect(names).toHaveLength(11);
		expect(
			names.find((t) => t.name.endsWith("_capture"))?._meta,
		).toMatchObject({ "fabric/confirm": true });
	});
	it("does not advertise a partial unsupported SDK surface", async () => {
		const { client } = await setup(false);
		expect(
			(await client.listTools()).tools.some((t) =>
				t.name.startsWith("fabric_delivery_source_"),
			),
		).toBe(false);
	});
	it("dispatches every operation through the SDK without authority overrides", async () => {
		const { client, methods } = await setup();
		const base = { projectId: "example-project" };
		const watch = { ...base, watchId: "example-watch" };
		const mutation = { ...watch, requestId, expectedVersion: 3 };
		const selection = {
			...base,
			integrationId: "example-connection",
			channelId: "CEXAMPLE01",
		};
		const inputs = {
			list: base,
			inspect: selection,
			configure: { ...selection, requestId },
			pause: mutation,
			resume: mutation,
			disconnect: mutation,
			capture: {
				...mutation,
				mode: "BACKFILL",
				window: {
					start: "2026-10-05T00:00:00.000Z",
					end: "2026-10-07T00:00:00.000Z",
				},
			},
			status: watch,
			cancel: { ...watch, requestId },
			observations: { ...watch, limit: 20 },
			evidence: { ...watch, observationId: "example-observation" },
		};
		for (const [op, args] of Object.entries(inputs)) {
			const result = await client.callTool({
				name: `fabric_delivery_source_${op}`,
				arguments: args,
			});
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toEqual({ version: 1 });
		}
		for (const method of Object.values(methods)) {
			expect(method).toHaveBeenCalledTimes(1);
		}
		expect(methods.startDeliverySourceCapture).toHaveBeenCalledWith(
			"example-project",
			"example-watch",
			{
				requestId,
				expectedVersion: 3,
				mode: "BACKFILL",
				window: inputs.capture.window,
			},
		);
	});
	it("refuses injected tenant, actor and model fields before calling the SDK", async () => {
		const { client, methods } = await setup();
		for (const extra of [
			{ organizationId: "other-org" },
			{ userId: "other-user" },
			{ model: "example-untrusted" },
		]) {
			const r = await client.callTool({
				name: "fabric_delivery_source_capture",
				arguments: {
					projectId: "example-project",
					watchId: "example-watch",
					requestId,
					expectedVersion: 1,
					mode: "RECENT",
					...extra,
				},
			});
			expect(r.isError).toBe(true);
		}
		expect(methods.startDeliverySourceCapture).not.toHaveBeenCalled();
	});
	it("retains coded server refusals without leaking dependency messages", async () => {
		const { client, methods } = await setup();
		methods.getDeliverySourceEvidence.mockRejectedValue(
			Object.assign(new Error("example-private-token"), {
				code: "INSUFFICIENT_SCOPE",
			}),
		);
		const r = await client.callTool({
			name: "fabric_delivery_source_evidence",
			arguments: {
				projectId: "example-project",
				watchId: "example-watch",
				observationId: "example-observation",
			},
		});
		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("INSUFFICIENT_SCOPE");
		expect(JSON.stringify(r)).not.toContain("example-private-token");
	});
});
