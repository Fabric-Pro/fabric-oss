// @vitest-environment node
/**
 * The delegation and project cards' buttons, run in the real view against a host: "Open in Fabric Desktop" sends its
 * fabricagents:// link to the host (the kit's openLink opens only web links, so it did nothing), "Delegate to Remote
 * Server" hands the task to the person's assistant (no server has a tool that dispatches it), and a button's tool call
 * shows its result or its error instead of dropping it.
 */
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { readFabricMcpAppResource as readSdkResource } from "../../../../../../../../packages/sdk-mcp/src/mcp-apps";
import { readFabricMcpAppResource as readGatewayResource } from "../mcp-apps";

// The hosted gateway and the local SDK server each carry a copy of the view; both must behave the same.
type Reader = (uri: string) => { contents: { text?: string }[] } | null;
const READERS: [string, Reader][] = [
	["hosted gateway", readGatewayResource as Reader],
	["SDK server", readSdkResource as Reader],
];

type Sent = { id?: number; method?: string; params?: Record<string, unknown> };

async function mountView(
	read: Reader,
	uri: string,
	result: Record<string, unknown>,
	answerToolCall?: (
		params: Record<string, unknown>,
	) => Record<string, unknown>,
) {
	const html = read(uri)?.contents[0]?.text ?? "";
	const sent: Sent[] = [];
	const dom = new JSDOM(html, {
		runScripts: "dangerously",
		pretendToBeVisual: true,
		beforeParse(window) {
			const host = {
				postMessage(message: Sent) {
					sent.push(message);
					const reply = (body: Record<string, unknown>) =>
						window.dispatchEvent(
							new window.MessageEvent("message", {
								data: {
									jsonrpc: "2.0",
									id: message.id,
									...body,
								},
								source: host as never,
							}),
						);
					if (message.method === "ui/initialize") {
						setTimeout(() =>
							reply({
								result: {
									protocolVersion: "2026-01-26",
									hostCapabilities: {
										openLinks: {},
										serverTools: {},
										message: { text: {} },
									},
									hostContext: {},
								},
							}),
						);
					} else if (message.method === "tools/call") {
						setTimeout(() =>
							answerToolCall
								? reply({
										result: answerToolCall(
											message.params ?? {},
										),
									})
								: reply({
										error: {
											code: -32602,
											message: "Unknown tool",
										},
									}),
						);
					} else if (message.id !== undefined) {
						setTimeout(() => reply({ result: {} }));
					}
				},
			};
			Object.defineProperty(window, "parent", { get: () => host });
		},
	});
	const { window } = dom;
	const tick = () => new Promise((r) => setTimeout(r, 20));
	await tick();
	window.dispatchEvent(
		new window.MessageEvent("message", {
			data: {
				jsonrpc: "2.0",
				method: "ui/notifications/tool-result",
				params: result,
			},
			source: window.parent as never,
		}),
	);
	await tick();
	const button = (label: string) => {
		const found = [...window.document.querySelectorAll("button")].find(
			(b) => (b.textContent ?? "").includes(label),
		);
		if (!found) {
			throw new Error(
				`no button "${label}" in: ${window.document.body.textContent}`,
			);
		}
		return found as HTMLButtonElement;
	};
	const click = async (label: string) => {
		button(label).click();
		await tick();
	};
	return {
		window,
		sent,
		click,
		text: () => window.document.body.textContent ?? "",
	};
}

// What the card showed the developer: a project-level result, no tickets and no harness listing.
const delegation = {
	structuredContent: { projectName: "Acme delivery" },
	content: [{ type: "text", text: "{}" }],
};

const tickets = {
	structuredContent: {
		title: "Tickets Assigned to You",
		tickets: [
			{
				identifier: "ACME-12",
				title: "Fix the login redirect",
				status: "In progress",
				priority: "High",
			},
		],
	},
	content: [{ type: "text", text: "{}" }],
};

describe.each(READERS)("delegation card actions (%s)", (_name, read) => {
	it("hands the card's task to the assistant instead of calling a tool no server has", async () => {
		const view = await mountView(
			read,
			"ui://fabric/agent-delegation",
			delegation,
		);
		expect(view.text()).not.toContain("Harness status unavailable");
		await view.click("Delegate to Remote Server");
		const message = view.sent.find((m) => m.method === "ui/message");
		expect(JSON.stringify(message?.params)).toContain(
			'Delegate \\"Work on Acme delivery\\" to the Remote Fabric Agents Server',
		);
		expect(view.sent.some((m) => m.method === "tools/call")).toBe(false);
	});

	it("sends the desktop link, with the task, to the host", async () => {
		const view = await mountView(
			read,
			"ui://fabric/agent-delegation",
			delegation,
		);
		await view.click("Open in Fabric Desktop");
		const url = new URL(
			String(
				view.sent.find((m) => m.method === "ui/open-link")?.params?.url,
			),
		);
		expect(url.protocol).toBe("fabricagents:");
		expect(url.searchParams.get("input")).toBe("Work on Acme delivery");
	});

	it("sends a ticket's desktop link to the host", async () => {
		const view = await mountView(
			read,
			"ui://fabric/agent-delegation",
			tickets,
		);
		await view.click("Open in Fabric Desktop");
		const url = new URL(
			String(
				view.sent.find((m) => m.method === "ui/open-link")?.params?.url,
			),
		);
		expect(url.searchParams.get("input")).toBe(
			"Implement ticket ACME-12: Fix the login redirect",
		);
	});
});

describe.each(READERS)("project card actions (%s)", (_name, read) => {
	const project = {
		structuredContent: {
			id: "p1",
			slug: "acme",
			name: "Acme",
			projectName: "Acme",
		},
		content: [{ type: "text", text: "{}" }],
	};

	it("shows why a button's tool call failed", async () => {
		const view = await mountView(
			read,
			"ui://fabric/project-dashboard",
			project,
		);
		await view.click("View Artifacts");
		expect(view.sent.some((m) => m.method === "tools/call")).toBe(true);
		expect(view.text()).toContain("Unknown tool");
	});

	it("shows what a button's tool call returned", async () => {
		const view = await mountView(
			read,
			"ui://fabric/project-dashboard",
			project,
			() => ({
				isError: true,
				content: [
					{
						type: "text",
						text: "No artifacts are shared with you in Acme.",
					},
				],
			}),
		);
		await view.click("View Artifacts");
		expect(view.text()).toContain(
			"No artifacts are shared with you in Acme.",
		);
	});
});
