/**
 * The capture loop with stand-ins for the browser and the model: a capture
 * masks the page before the picture, the step cap ends a capture that never
 * reaches its screen, and a model or browser failure becomes a reason rather
 * than an exception.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ai", () => ({
	NoObjectGeneratedError: { isInstance: () => false },
	Output: { object: (spec: unknown) => spec },
	generateText: vi.fn(),
}));

import type { z } from "zod";
import type { BrowserOperation } from "../qa-agentic-run/browser-driver";
import type { ActDecisionSchema } from "../qa-agentic-run/operation-decision";
import {
	buildCapturePrompt,
	type CaptureDecide,
	type CaptureDriver,
	runCaptureLoop,
} from "./screenshot-capture-loop";

const PNG = Buffer.from("png-bytes");
const SIGN_IN_PAGE = 'textbox "Email"\ntextbox "Password"\nbutton "Sign in"';
const ADMIN_URL = "https://app.example.com/app/example-org/settings/members";
const SETTINGS_VIEW_URL =
	"https://app.example.com/app/example-org/projects/42?tab=settings";

type CaptureTarget = { role: string; name: string } | null;

const INPUT = {
	instructions: "Capture the screen the brief names.",
	highlight: {
		title: "Saved filters",
		description: "Filters can be saved from the panel.",
	},
	brief: "The filters panel with one saved filter.",
};

function fakeDriver(over: Partial<CaptureDriver> = {}) {
	const calls: string[] = [];
	const driver: CaptureDriver = {
		snapshot: vi.fn(async () => {
			calls.push("snapshot");
			return 'button "Filters"';
		}),
		currentUrl: vi.fn(() => "https://app.example.com/projects/42"),
		perform: vi.fn(async (operation: BrowserOperation) => {
			calls.push(`perform:${operation.kind}`);
			return { ok: true, detail: `Did ${operation.kind}.` };
		}),
		mask: vi.fn(async () => {
			calls.push("mask");
		}),
		screenshot: vi.fn(async (target: CaptureTarget) => {
			calls.push(
				target ? `screenshot:${target.name}` : "screenshot:page",
			);
			return PNG;
		}),
		...over,
	};
	return { driver, calls };
}

/** A model that answers each step with the next decision in `decisions`. */
function scriptedModel(
	decisions: Array<z.infer<typeof ActDecisionSchema>>,
): CaptureDecide & { prompts: string[] } {
	const prompts: string[] = [];
	let step = 0;
	const decide: CaptureDecide = vi.fn(async (prompt: string) => {
		prompts.push(prompt);
		const value = decisions[Math.min(step, decisions.length - 1)] ?? {};
		step += 1;
		return { value, via: "object" as const, calls: 1 };
	});
	return Object.assign(decide, { prompts });
}

describe("runCaptureLoop", () => {
	it("walks to the screen, masks it, then captures the named element", async () => {
		const { driver, calls } = fakeDriver();
		const decide = scriptedModel([
			{ kind: "click", role: "button", name: "Filters" },
			{
				kind: "capture",
				role: "region",
				name: "Filters panel",
				text: "The filters panel with a saved filter",
			},
		]);

		const result = await runCaptureLoop(INPUT, driver, decide);

		expect(result).toEqual({
			ok: true,
			png: PNG,
			altText: "The filters panel with a saved filter",
			modelCalls: 2,
		});
		expect(calls).toEqual([
			"snapshot",
			"perform:click",
			"snapshot",
			"mask",
			"screenshot:Filters panel",
		]);
	});

	it("falls back to the visible page when the element cannot be captured", async () => {
		const { driver, calls } = fakeDriver({
			screenshot: vi.fn(async (target: CaptureTarget) =>
				target ? null : PNG,
			),
		});
		const decide = scriptedModel([
			{ kind: "capture", role: "region", name: "Missing" },
		]);

		const result = await runCaptureLoop(INPUT, driver, decide);

		expect(result.ok).toBe(true);
		expect(result.ok && result.altText).toBe("Saved filters");
		expect(calls).toEqual(["snapshot", "mask"]);
		expect(driver.screenshot).toHaveBeenLastCalledWith(null);
	});

	it("stops without a picture when the model gives up", async () => {
		const { driver, calls } = fakeDriver();
		const decide = scriptedModel([
			{
				kind: "give_up",
				reasoning:
					"The page asks to sign in; the panel is not reachable.",
			},
		]);

		const result = await runCaptureLoop(INPUT, driver, decide);

		expect(result).toEqual({
			ok: false,
			reason: "The screen could not be reached: The page asks to sign in; the panel is not reachable.",
			modelCalls: 1,
		});
		expect(calls).toEqual(["snapshot"]);
	});

	it("gives up with a reason once the step cap is spent", async () => {
		const { driver } = fakeDriver();
		const decide = scriptedModel([{ kind: "wait", ms: 10 }]);

		const result = await runCaptureLoop(
			{ ...INPUT, maxOperations: 3 },
			driver,
			decide,
		);

		expect(result).toEqual({
			ok: false,
			reason: "Stopped after 3 steps without reaching the screen to capture.",
			modelCalls: 4,
		});
		expect(driver.perform).toHaveBeenCalledTimes(3);
		expect(driver.mask).not.toHaveBeenCalled();
	});

	it("turns a model failure into a reason", async () => {
		const { driver } = fakeDriver();
		const decide: CaptureDecide = vi.fn(async () => {
			throw new Error("quota exceeded");
		});

		const result = await runCaptureLoop(INPUT, driver, decide);

		expect(result).toEqual({
			ok: false,
			reason: "The model could not choose the next step: quota exceeded",
			modelCalls: 0,
		});
	});

	it("turns a failed mask into a reason and takes no picture", async () => {
		const { driver } = fakeDriver({
			mask: vi.fn(async () => {
				throw new Error("Execution context was destroyed\nstack");
			}),
		});
		const decide = scriptedModel([{ kind: "capture" }]);

		const result = await runCaptureLoop(INPUT, driver, decide);

		expect(result).toEqual({
			ok: false,
			reason: "The page could not be captured: Execution context was destroyed",
			modelCalls: 1,
		});
		expect(driver.screenshot).not.toHaveBeenCalled();
	});

	it.each(["Delete project", "Save changes", "Invite member", "Sign out"])(
		"refuses a click on “%s” without performing it",
		async (name) => {
			const { driver } = fakeDriver();
			const decide = scriptedModel([
				{ kind: "click", role: "button", name },
				{ kind: "capture" },
			]);

			const result = await runCaptureLoop(INPUT, driver, decide);

			expect(driver.perform).not.toHaveBeenCalled();
			expect(decide.prompts[1]).toContain(
				`- Refused: “${name}” could change data.`,
			);
			expect(result.ok).toBe(true);
		},
	);

	it("still clicks a control whose name only looks around", async () => {
		const { driver } = fakeDriver();
		const decide = scriptedModel([
			{ kind: "click", role: "tab", name: "Saved filters" },
			{ kind: "capture" },
		]);

		await runCaptureLoop(INPUT, driver, decide);

		expect(driver.perform).toHaveBeenCalledWith({
			kind: "click",
			role: "tab",
			name: "Saved filters",
		});
	});

	it("refuses Enter but presses Escape", async () => {
		const { driver } = fakeDriver();
		const decide = scriptedModel([
			{ kind: "press", key: "Enter" },
			{ kind: "press", key: "Escape" },
			{ kind: "capture" },
		]);

		await runCaptureLoop(INPUT, driver, decide);

		expect(driver.perform).toHaveBeenCalledTimes(1);
		expect(driver.perform).toHaveBeenCalledWith({
			kind: "press",
			key: "Escape",
		});
		expect(decide.prompts[1]).toContain(
			"- Refused: Enter could submit a form.",
		);
	});

	it("gives up instead of capturing a sign-in form", async () => {
		const { driver, calls } = fakeDriver({
			snapshot: vi.fn(async () => SIGN_IN_PAGE),
		});
		const decide = scriptedModel([{ kind: "capture" }]);

		const result = await runCaptureLoop(INPUT, driver, decide);

		expect(result).toEqual({
			ok: false,
			reason: "The page shows a sign-in form instead of the screen to capture.",
			modelCalls: 1,
		});
		expect(calls).toEqual([]);
		expect(driver.mask).not.toHaveBeenCalled();
		expect(driver.screenshot).not.toHaveBeenCalled();
	});

	it.each([
		"/settings",
		"/app/example-org/settings/billing",
		"/admin/users",
		"/organization-settings?tab=members",
		"https://app.example.com/Members/",
		"/%73ettings",
		"/app/example-org/projects/42?tab=settings&settingsTab=newsletter",
		"/app/example-org?view=Billing",
	])("refuses to go to the administration path “%s”", async (path) => {
		const { driver } = fakeDriver();
		const decide = scriptedModel([
			{ kind: "goto", path },
			{ kind: "capture" },
		]);

		const result = await runCaptureLoop(INPUT, driver, decide);

		expect(driver.perform).not.toHaveBeenCalled();
		expect(decide.prompts[1]).toContain(
			"is an administration or settings screen, which captures never show.",
		);
		expect(result.ok).toBe(true);
	});

	it.each([
		"/projects",
		"/app/example-org/projects/42/settlements",
		"/",
		"/app/example-org/security",
		"/team",
		"/app/example-org/projects/42?tab=roadmap",
		"/app/example-org/projects/42?settingsTab=newsletter",
	])("goes to the product path “%s”", async (path) => {
		const { driver } = fakeDriver();
		const decide = scriptedModel([
			{ kind: "goto", path },
			{ kind: "capture" },
		]);

		await runCaptureLoop(INPUT, driver, decide);

		expect(driver.perform).toHaveBeenCalledWith({ kind: "goto", path });
	});

	it("gives up instead of capturing a settings view opened in place", async () => {
		const { driver } = fakeDriver({
			currentUrl: vi.fn(() => SETTINGS_VIEW_URL),
		});
		const decide = scriptedModel([{ kind: "capture" }]);

		const result = await runCaptureLoop(INPUT, driver, decide);

		expect(result.ok).toBe(false);
		expect(driver.screenshot).not.toHaveBeenCalled();
	});

	it("gives up instead of capturing an administration screen", async () => {
		const { driver } = fakeDriver({ currentUrl: vi.fn(() => ADMIN_URL) });
		const decide = scriptedModel([{ kind: "capture" }]);

		const result = await runCaptureLoop(INPUT, driver, decide);

		expect(result).toEqual({
			ok: false,
			reason: "The screen is an administration or settings screen, which captures never show.",
			modelCalls: 1,
		});
		expect(driver.mask).not.toHaveBeenCalled();
		expect(driver.screenshot).not.toHaveBeenCalled();
	});

	it("masks the sign-in name in the description and a give-up reason", async () => {
		const input = {
			...INPUT,
			maskTerms: ["qa.viewer@example.com", "qa.viewer"],
		};
		const captured = await runCaptureLoop(
			input,
			fakeDriver().driver,
			scriptedModel([
				{ kind: "capture", text: "Filters saved by QA.Viewer" },
			]),
		);
		const gaveUp = await runCaptureLoop(
			input,
			fakeDriver().driver,
			scriptedModel([
				{ kind: "give_up", reasoning: "Only qa.viewer can see it." },
			]),
		);

		expect(captured.ok && captured.altText).toBe(
			"Filters saved by Jane Doe",
		);
		expect(gaveUp.ok === false && gaveUp.reason).toBe(
			"The screen could not be reached: Only Jane Doe can see it.",
		);
	});

	it("masks personal data in the description and in a give-up reason", async () => {
		const captured = await runCaptureLoop(
			INPUT,
			fakeDriver().driver,
			scriptedModel([
				{
					kind: "capture",
					text: "Filters saved by someone.real@company.example.org",
				},
			]),
		);
		const gaveUp = await runCaptureLoop(
			INPUT,
			fakeDriver().driver,
			scriptedModel([
				{
					kind: "give_up",
					reasoning:
						"Only someone.real@company.example.org can see it.",
				},
			]),
		);

		expect(captured.ok && captured.altText).toBe(
			"Filters saved by jane.doe@example.com",
		);
		expect(gaveUp.ok === false && gaveUp.reason).toBe(
			"The screen could not be reached: Only jane.doe@example.com can see it.",
		);
	});

	it("records refused operations without performing them", async () => {
		const { driver } = fakeDriver();
		const decide = scriptedModel([{ kind: "submit" }, { kind: "capture" }]);

		await runCaptureLoop(INPUT, driver, decide);

		expect(driver.perform).not.toHaveBeenCalled();
		expect(decide.prompts[1]).toContain(
			"- Refused: The requested operation kind is not supported by the QA runner.",
		);
	});
});

describe("buildCapturePrompt", () => {
	it("carries the instructions, the brief, the steps and the page", () => {
		const prompt = buildCapturePrompt({
			...INPUT,
			steps: ["Clicked button “Filters”."],
			snapshot: 'region "Filters panel"',
			remaining: 14,
		});

		expect(prompt).toContain(INPUT.instructions);
		expect(prompt).toContain("HIGHLIGHT: Saved filters");
		expect(prompt).toContain(`WHAT TO SHOW: ${INPUT.brief}`);
		expect(prompt).toContain("- Clicked button “Filters”.");
		expect(prompt).toContain(
			"Operations left before the capture is abandoned: 14.",
		);
		expect(prompt).toContain('region "Filters panel"');
	});
});
