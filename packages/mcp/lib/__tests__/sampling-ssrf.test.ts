/**
 * Sampling uses the raw MCP SDK because it must advertise sampling support.
 * Its transport still has the same configured-server boundary as the shared
 * client factory: pre-connect DNS refusal plus a guarded fetch on every SDK
 * request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	connect: vi.fn(),
	transports: [] as Array<{
		kind: "http" | "sse";
		options: Record<string, unknown>;
	}>,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		connect = state.connect;
		close = vi.fn();
		listTools = vi.fn(async () => ({ tools: [] }));
		callTool = vi.fn();
		setRequestHandler = vi.fn();
	},
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: class {
		constructor(_url: URL, options: Record<string, unknown>) {
			state.transports.push({ kind: "sse", options });
		}
	},
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class {
		constructor(_url: URL, options: Record<string, unknown>) {
			state.transports.push({ kind: "http", options });
		}
	},
}));

const lookupMock = vi.fn();
vi.mock("node:dns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns")>();
	return {
		...actual,
		lookup: (...args: unknown[]) => lookupMock(...args),
	};
});

import { createSamplingMcpClient } from "../sampling";
import { getMcpServerBlockedReason } from "../server-url-guard";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOWED = process.env.MCP_SERVER_ALLOWED_HOSTS;

function setEnv(key: string, value: string | undefined) {
	if (value === undefined) {
		delete (process.env as Record<string, string | undefined>)[key];
	} else {
		(process.env as Record<string, string | undefined>)[key] = value;
	}
}

function resolveTo(address: string) {
	lookupMock.mockImplementation(
		(
			_hostname: string,
			_options: unknown,
			callback: (
				error: Error | null,
				addresses: { address: string; family: number }[],
			) => void,
		) => callback(null, [{ address, family: 4 }]),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	state.transports.length = 0;
	state.connect.mockResolvedValue(undefined);
	setEnv("NODE_ENV", "production");
	setEnv("MCP_SERVER_ALLOWED_HOSTS", undefined);
	resolveTo("93.184.216.34");
});

afterEach(() => {
	setEnv("NODE_ENV", ORIGINAL_NODE_ENV);
	setEnv("MCP_SERVER_ALLOWED_HOSTS", ORIGINAL_ALLOWED);
});

describe("createSamplingMcpClient outbound guard", () => {
	it.each([
		"http://127.0.0.1:7233/mcp",
		"http://169.254.169.254/latest/meta-data/",
	])(
		"refuses %s before constructing or connecting a transport",
		async (serverUrl) => {
			await expect(
				createSamplingMcpClient({ serverUrl, transport: "HTTP" }),
			).rejects.toThrow(/MCP_SERVER_ALLOWED_HOSTS/);
			expect(state.transports).toHaveLength(0);
			expect(state.connect).not.toHaveBeenCalled();
		},
	);

	it("refuses a hostname that resolves to a private address before connecting", async () => {
		resolveTo("10.20.30.40");
		await expect(
			createSamplingMcpClient({
				serverUrl: "https://mcp.internal.example/mcp",
				transport: "HTTP",
			}),
		).rejects.toThrow(/Private network access.*MCP_SERVER_ALLOWED_HOSTS/s);
		expect(state.transports).toHaveLength(0);
		expect(state.connect).not.toHaveBeenCalled();
	});

	it.each(["HTTP", "SSE"] as const)(
		"hands the %s transport a fetch that refuses DNS rebinding",
		async (transport) => {
			await createSamplingMcpClient({
				serverUrl: "https://mcp.example.com/mcp",
				transport,
			});

			expect(state.transports).toHaveLength(1);
			const transportFetch = state.transports[0]?.options.fetch as
				| typeof fetch
				| undefined;
			expect(transportFetch).toBeTypeOf("function");

			resolveTo("10.20.30.40");
			let caught: unknown;
			try {
				await transportFetch?.("https://mcp.example.com/mcp", {
					method: "POST",
				});
			} catch (error) {
				caught = error;
			}
			expect(getMcpServerBlockedReason(caught)).toMatch(
				/Blocked outbound connection.*MCP_SERVER_ALLOWED_HOSTS/s,
			);
		},
	);
});
