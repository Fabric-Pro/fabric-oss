/**
 * mermaid.js keeps one global configuration, and `mermaid.render` yields
 * mid-render. The editor's live preview renders under `securityLevel:
 * "loose"` and the Glossy export under `"strict"`; if one could call
 * `initialize` while the other is mid-render, the export could draw under
 * the editor's loose settings. Every such render shares `withMermaidLock`.
 *
 * mermaid is a stand-in here whose `render` can be parked on a gate, so a
 * test can hold one render open and see whether another slips in.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	type Config = Record<string, unknown>;
	const state = {
		config: {} as Config,
		initializeCalls: [] as Config[],
		renders: [] as Array<{ id: string; atStart: unknown; atEnd: unknown }>,
		gate: null as Promise<void> | null,
		parked: 0,
	};
	const mermaid = {
		initialize: (config: Config) => {
			state.config = { ...config };
			state.initializeCalls.push(state.config);
		},
		render: async (id: string, text: string) => {
			const atStart = state.config.securityLevel;
			if (state.gate) {
				state.parked += 1;
				await state.gate;
				state.parked -= 1;
			}
			const atEnd = state.config.securityLevel;
			state.renders.push({ id, atStart, atEnd });
			if (text.includes("FAIL")) {
				throw new Error("Parse error");
			}
			return { svg: `<svg data-security="${String(atEnd)}"></svg>` };
		},
		mermaidAPI: { getSiteConfig: () => ({ ...state.config }) },
	};
	return { state, mermaid };
});

vi.mock("mermaid", () => ({ default: fake.mermaid }));

import { renderThemedMermaidSvg } from "../markdown-to-document";
import { withMermaidLock } from "../mermaid-lock";
import { renderNativeMermaidSvg } from "../tiptap-mermaid-extension";

const theme = { themeVariables: { primaryColor: "#1e3a8a" } };

/** The configuration the editor module sets on load; every render restores it. */
let baseline: Record<string, unknown>;

beforeAll(() => {
	baseline = fake.mermaid.mermaidAPI.getSiteConfig();
});

beforeEach(() => {
	fake.state.initializeCalls.length = 0;
	fake.state.renders.length = 0;
	fake.state.gate = null;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * Start `first` and hold it mid-render, start `second`, and report how many
 * times the configuration was replaced while `first` was still rendering.
 */
async function overlap(
	first: () => Promise<string>,
	second: () => Promise<string>,
): Promise<number> {
	let open = () => {};
	fake.state.gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const firstRun = first();
	await vi.waitFor(() => expect(fake.state.parked).toBe(1));
	const initializedBefore = fake.state.initializeCalls.length;
	const secondRun = second();
	await settle();
	const initializedWhileParked =
		fake.state.initializeCalls.length - initializedBefore;
	fake.state.gate = null;
	open();
	await Promise.all([firstRun, secondRun]);
	return initializedWhileParked;
}

describe("withMermaidLock", () => {
	it("runs overlapping tasks one at a time, in call order", async () => {
		const events: string[] = [];
		let releaseFirst = () => {};
		const first = withMermaidLock(async () => {
			events.push("first:start");
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			events.push("first:end");
			return 1;
		});
		const second = withMermaidLock(async () => {
			events.push("second:start");
			return 2;
		});

		await settle();
		expect(events).toEqual(["first:start"]);

		releaseFirst();
		await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
		expect(events).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("does not stall the queue behind a task that fails", async () => {
		const failed = withMermaidLock(async () => {
			throw new Error("boom");
		});
		const next = withMermaidLock(async () => "ran");

		await expect(failed).rejects.toThrow("boom");
		await expect(next).resolves.toBe("ran");
	});
});

describe("renders that share mermaid's configuration", () => {
	it("holds a Glossy export until the editor's preview render finishes", async () => {
		const initializedWhileParked = await overlap(
			() => renderNativeMermaidSvg("pie\n  A: 1", false),
			() => renderThemedMermaidSvg("flowchart LR\nA --> B", theme),
		);

		expect(initializedWhileParked).toBe(0);
		expect(fake.state.renders).toEqual([
			{
				id: expect.stringMatching(/^mermaid-/),
				atStart: "loose",
				atEnd: "loose",
			},
			{
				id: expect.stringMatching(/^glossy-/),
				atStart: "strict",
				atEnd: "strict",
			},
		]);
		expect(fake.state.config).toEqual(baseline);
	});

	it("holds the editor's preview until a Glossy export render finishes", async () => {
		const initializedWhileParked = await overlap(
			() => renderThemedMermaidSvg("flowchart LR\nA --> B", theme),
			() => renderNativeMermaidSvg("pie\n  A: 1", true),
		);

		expect(initializedWhileParked).toBe(0);
		expect(fake.state.renders).toEqual([
			{
				id: expect.stringMatching(/^glossy-/),
				atStart: "strict",
				atEnd: "strict",
			},
			{
				id: expect.stringMatching(/^mermaid-/),
				atStart: "loose",
				atEnd: "loose",
			},
		]);
		expect(fake.state.config).toEqual(baseline);
	});

	it("restores the configuration after an editor render that fails", async () => {
		await expect(renderNativeMermaidSvg("FAIL", true)).rejects.toThrow(
			"Parse error",
		);

		expect(fake.state.initializeCalls[0]).toMatchObject({ theme: "dark" });
		expect(fake.state.config).toEqual(baseline);
	});
});
