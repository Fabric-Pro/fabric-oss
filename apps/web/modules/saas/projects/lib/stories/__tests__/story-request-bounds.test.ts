import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	decisionSaveOptions,
	holdsSentText,
	isServerUnreachable,
	isUnanswered,
	STORY_REQUEST_TIMEOUT_MS,
	settleWithin,
} from "../story-request-bounds";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("isServerUnreachable", () => {
	it.each([
		["an offline fetch in Chromium", new TypeError("Failed to fetch")],
		[
			"an offline fetch in Firefox",
			new TypeError("NetworkError when attempting to fetch resource."),
		],
		["an offline fetch in Safari", new TypeError("Load failed")],
		[
			"an aborted request",
			Object.assign(new Error("aborted"), { name: "AbortError" }),
		],
		[
			"a request with no answer in time",
			Object.assign(new Error("late"), { name: "TimeoutError" }),
		],
	])("is true for %s", (_label, error) => {
		expect(isServerUnreachable(error)).toBe(true);
	});

	it.each([
		[
			"a refusal",
			Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }),
		],
		[
			"a missing story",
			Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
		],
		["any other failure", new Error("Something else")],
		[
			"a TypeError from a fault in the code",
			new TypeError("Cannot read properties of undefined (reading 'id')"),
		],
		["a non-error", "offline"],
	])("is false for %s", (_label, error) => {
		expect(isServerUnreachable(error)).toBe(false);
	});

	it("is true for any TypeError while the browser reports no network", () => {
		vi.stubGlobal("navigator", { onLine: false });

		expect(isServerUnreachable(new TypeError("Request aborted"))).toBe(
			true,
		);
	});
});

describe("settleWithin", () => {
	it("passes an answer through", async () => {
		await expect(
			settleWithin(Promise.resolve("story"), STORY_REQUEST_TIMEOUT_MS),
		).resolves.toBe("story");
	});

	it("gives up with a TimeoutError once the time passes", async () => {
		vi.useFakeTimers();
		const late = settleWithin(
			new Promise<never>(() => undefined),
			STORY_REQUEST_TIMEOUT_MS,
		);
		const settled = expect(late).rejects.toMatchObject({
			name: "TimeoutError",
		});
		await vi.advanceTimersByTimeAsync(STORY_REQUEST_TIMEOUT_MS);
		await settled;
		await expect(late.catch(isServerUnreachable)).resolves.toBe(true);
	});
});

describe("decisionSaveOptions", () => {
	const context = { client: new QueryClient(), meta: undefined };

	it("runs in any network state and keeps the other options", () => {
		const onError = vi.fn();
		const options = decisionSaveOptions({
			mutationFn: (title: string) => Promise.resolve(title),
			onError,
		});

		expect(options.networkMode).toBe("always");
		expect(options.onError).toBe(onError);
	});

	it("passes the variables and context through to the save", async () => {
		const save = vi.fn((title: string) =>
			Promise.resolve(`saved ${title}`),
		);
		const options = decisionSaveOptions({ mutationFn: save });

		await expect(options.mutationFn?.("story", context)).resolves.toBe(
			"saved story",
		);
		expect(save).toHaveBeenCalledWith("story", context);
	});

	it("gives up on a save with no answer once the time passes", async () => {
		vi.useFakeTimers();
		const options = decisionSaveOptions({
			mutationFn: (_title: string) => new Promise<never>(() => undefined),
		});

		const late = options.mutationFn?.("story", context);
		const settled = expect(late).rejects.toMatchObject({
			name: "TimeoutError",
		});
		await vi.advanceTimersByTimeAsync(STORY_REQUEST_TIMEOUT_MS);
		await settled;
	});

	it("leaves a missing save missing", () => {
		expect(decisionSaveOptions({}).mutationFn).toBeUndefined();
	});
});

describe("isUnanswered", () => {
	it("is true only for a request that got no answer in time", async () => {
		vi.useFakeTimers();
		const late = settleWithin(new Promise<never>(() => undefined), 10);
		const settled = late.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(10);

		expect(isUnanswered(await settled)).toBe(true);
		expect(isUnanswered(new TypeError("Failed to fetch"))).toBe(false);
		expect(
			isUnanswered(Object.assign(new Error("x"), { code: "CONFLICT" })),
		).toBe(false);
	});
});

describe("holdsSentText", () => {
	const sent = { description: "Spec", acceptanceCriteria: null };

	it("is true when the story holds every text field the save sent", () => {
		expect(
			holdsSentText(
				{ description: "Spec", acceptanceCriteria: null },
				sent,
			),
		).toBe(true);
		expect(holdsSentText({ description: "Spec" }, sent)).toBe(true);
		expect(
			holdsSentText({ description: "Spec" }, { description: "Spec" }),
		).toBe(true);
	});

	it("is false when a field differs", () => {
		expect(
			holdsSentText(
				{ description: "Older spec", acceptanceCriteria: null },
				sent,
			),
		).toBe(false);
		expect(
			holdsSentText(
				{ description: "Spec", acceptanceCriteria: "- AC 1" },
				sent,
			),
		).toBe(false);
	});
});
