/**
 * useTopicStatusOverlay (Fizzy #2646) — the optimistic status the topic list
 * and the topic page share.
 *
 * The rule under test: a topic stays BUSY from the moment a status write
 * starts until a fetch that completed AFTER the write landed reaches the
 * query that owns the topic (its updatedAt passes the settle time) — judged
 * at READ time, so a value that is already newer at settle retires the write
 * in that same render. Nothing that decides what is SHOWN compares values:
 * every question is "which happened later", on this browser's own clock.
 */
import {
	applyStatusOverlay,
	OVERLAY_MAX_MS,
	type OverlayServerTopic,
	SAVED_DISPLAY_MS,
	type TopicStatusOverlay,
	useTopicStatusOverlay,
} from "@saas/projects/components/publishing-suite/use-topic-status-overlay";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SELECTED: TopicStatusOverlay = {
	status: "SELECTED",
	declineReason: null,
	publishedUrl: null,
};
const T0 = Date.parse("2026-09-24T10:00:00Z");

function server(
	overrides: Partial<OverlayServerTopic> = {},
): OverlayServerTopic {
	return {
		id: "t1",
		status: "SUGGESTION",
		declineReason: null,
		publishedUrl: null,
		...overrides,
	};
}

function deferred() {
	let resolve!: () => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** `updatedAt` is the owning query's `dataUpdatedAt`, `errorAt` its `errorUpdatedAt`. */
type Props = {
	topics: OverlayServerTopic[];
	updatedAt: number;
	errorAt?: number;
};

function setup(initial: Props = { topics: [server()], updatedAt: 0 }) {
	return renderHook(
		({ topics, updatedAt, errorAt = 0 }: Props) =>
			useTopicStatusOverlay(topics, updatedAt, errorAt),
		{ initialProps: initial },
	);
}

const never = () => new Promise<never>(() => {});
const noop = () => {};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("applyStatusOverlay", () => {
	it("returns the SAME object when there is no overlay", () => {
		const topic = {
			status: "PUBLISHED",
			declineReason: null,
			publishedUrl: "https://example.com/x",
		};
		expect(applyStatusOverlay(topic, null)).toBe(topic);
	});

	it("replaces status, reason and URL together", () => {
		const topic = {
			status: "PUBLISHED",
			declineReason: null,
			publishedUrl: "https://example.com/x",
			title: "T",
		};
		expect(
			applyStatusOverlay(topic, {
				status: "DECLINED",
				declineReason: "why",
				publishedUrl: null,
			}),
		).toEqual({
			status: "DECLINED",
			declineReason: "why",
			publishedUrl: null,
			title: "T",
		});
	});
});

describe("useTopicStatusOverlay", () => {
	it("shows the overlay, 'saving' and busy from the first moment", () => {
		const { result } = setup();
		act(() => {
			void result.current.run("t1", SELECTED, never, noop);
		});
		expect(result.current.overlayFor("t1")).toEqual(SELECTED);
		expect(result.current.saveStateFor("t1")).toBe("saving");
		expect(result.current.isBusy("t1")).toBe(true);
	});

	it("stays busy until a fetch that completed AFTER the write arrives, then releases in that render", async () => {
		const { result, rerender } = setup();
		const gate = deferred();
		let run!: Promise<void>;
		act(() => {
			run = result.current.run("t1", SELECTED, () => gate.promise, noop);
		});
		vi.setSystemTime(T0 + 50);
		await act(async () => {
			gate.resolve();
			await run;
		});
		expect(result.current.saveStateFor("t1")).toBe("saved");
		expect(result.current.isBusy("t1")).toBe(true);
		expect(result.current.overlayFor("t1")).toEqual(SELECTED);

		// Completed before the write landed: not the confirmation.
		rerender({ topics: [server()], updatedAt: T0 + 10 });
		expect(result.current.isBusy("t1")).toBe(true);

		// Completed after it: released in this very render.
		rerender({
			topics: [server({ status: "SELECTED" })],
			updatedAt: T0 + 60,
		});
		expect(result.current.isBusy("t1")).toBe(false);
		expect(result.current.overlayFor("t1")).toBeNull();
	});

	it("releases immediately when the owning query is ALREADY newer at settle", async () => {
		// The instant-refetch world the mocked suites model. An implementation
		// that only reacted to a CHANGE of the timestamp would leave the topic
		// busy here until the safety net.
		const { result } = setup({
			topics: [server()],
			updatedAt: Number.MAX_SAFE_INTEGER,
		});
		await act(async () => {
			await result.current.run("t1", SELECTED, async () => {}, noop);
		});
		expect(result.current.isBusy("t1")).toBe(false);
		expect(result.current.overlayFor("t1")).toBeNull();
		expect(result.current.saveStateFor("t1")).toBe("saved");
	});

	it("never releases a write that is still in flight", () => {
		const { result, rerender } = setup();
		act(() => {
			void result.current.run("t1", SELECTED, never, noop);
		});
		rerender({ topics: [server()], updatedAt: Number.MAX_SAFE_INTEGER });
		expect(result.current.overlayFor("t1")).toEqual(SELECTED);
		expect(result.current.isBusy("t1")).toBe(true);
		// Nor unlocks it on a failed read.
		rerender({
			topics: [server()],
			updatedAt: 0,
			errorAt: Number.MAX_SAFE_INTEGER,
		});
		expect(result.current.overlayFor("t1")).toEqual(SELECTED);
		expect(result.current.isBusy("t1")).toBe(true);
	});

	it("keeps 'Saved' for as long as the topic is busy, then SAVED_DISPLAY_MS more", async () => {
		const { result, rerender } = setup();
		await act(async () => {
			await result.current.run("t1", SELECTED, async () => {}, noop);
		});
		act(() => {
			vi.advanceTimersByTime(SAVED_DISPLAY_MS + 1000); // slow confirmation
		});
		expect(result.current.saveStateFor("t1")).toBe("saved");

		rerender({
			topics: [server({ status: "SELECTED" })],
			updatedAt: Date.now() + 1,
		});
		expect(result.current.saveStateFor("t1")).toBe("saved");
		act(() => {
			vi.advanceTimersByTime(SAVED_DISPLAY_MS);
		});
		expect(result.current.saveStateFor("t1")).toBe("idle");
	});

	it("unlocks after OVERLAY_MAX_MS but keeps showing the saved value until a later fetch; refreshes again and says so in the console", async () => {
		// The cached status is known to be OLDER than the write the server
		// accepted: falling back to it on the timeout would let the user act
		// on a stale value (e.g. re-publish from an empty seeded URL).
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const refresh = vi.fn();
		const { result, rerender } = setup();
		await act(async () => {
			await result.current.run("t1", SELECTED, async () => {}, refresh);
		});
		const settledAt = Date.now();
		expect(refresh).toHaveBeenCalledTimes(1);
		act(() => {
			vi.advanceTimersByTime(OVERLAY_MAX_MS);
		});
		expect(result.current.isBusy("t1")).toBe(false);
		expect(result.current.overlayFor("t1")).toEqual(SELECTED);
		expect(result.current.saveStateFor("t1")).toBe("saved");
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("not confirmed by a refetch"),
			{ topicId: "t1" },
		);

		act(() => {
			vi.advanceTimersByTime(SAVED_DISPLAY_MS);
		});
		expect(result.current.saveStateFor("t1")).toBe("idle");
		expect(result.current.overlayFor("t1")).toEqual(SELECTED);

		// A fetch stamped at the settle time itself still does not count.
		rerender({ topics: [server()], updatedAt: settledAt });
		expect(result.current.overlayFor("t1")).toEqual(SELECTED);
		expect(result.current.isBusy("t1")).toBe(false);

		// One that completed after the write retires the saved value.
		rerender({
			topics: [server({ status: "SELECTED" })],
			updatedAt: settledAt + 1,
		});
		expect(result.current.overlayFor("t1")).toBeNull();
		expect(result.current.isBusy("t1")).toBe(false);
	});

	it("accepts a second write once the safety net has unlocked the topic", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { result } = setup();
		await act(async () => {
			await result.current.run("t1", SELECTED, async () => {}, noop);
		});
		act(() => {
			vi.advanceTimersByTime(OVERLAY_MAX_MS);
		});
		expect(result.current.isBusy("t1")).toBe(false);

		const IN_PROGRESS: TopicStatusOverlay = {
			status: "IN_PROGRESS",
			declineReason: null,
			publishedUrl: null,
		};
		const second = vi.fn(never);
		act(() => {
			void result.current.run("t1", IN_PROGRESS, second, noop);
		});
		expect(second).toHaveBeenCalledTimes(1);
		expect(result.current.overlayFor("t1")).toEqual(IN_PROGRESS);
		expect(result.current.saveStateFor("t1")).toBe("saving");
		expect(result.current.isBusy("t1")).toBe(true);
	});

	it("a failed confirming refetch unlocks the topic but keeps showing the saved value", async () => {
		// A failed read carries no new data: the value the server accepted is
		// still the best knowledge, so the cached (pre-write) one is never
		// swapped in. But no confirmation is coming either, so the topic is
		// free again — silently, and without another refresh: the read has
		// already failed, and the owner's error UI offers the retry.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const refresh = vi.fn();
		const { result, rerender } = setup();
		await act(async () => {
			await result.current.run("t1", SELECTED, async () => {}, refresh);
		});
		const settledAt = Date.now();
		expect(result.current.isBusy("t1")).toBe(true);
		expect(refresh).toHaveBeenCalledTimes(1);

		// A failure stamped at the settle time itself does not count.
		rerender({ topics: [server()], updatedAt: 0, errorAt: settledAt });
		expect(result.current.isBusy("t1")).toBe(true);

		// The refetch the settle started fails.
		rerender({ topics: [server()], updatedAt: 0, errorAt: settledAt + 1 });
		expect(result.current.isBusy("t1")).toBe(false);
		expect(result.current.overlayFor("t1")).toEqual(SELECTED);
		expect(result.current.saveStateFor("t1")).toBe("saved");
		expect(warn).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledTimes(1);

		// The safety net does not fire for a write already unlocked.
		act(() => {
			vi.advanceTimersByTime(OVERLAY_MAX_MS);
		});
		expect(warn).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(result.current.saveStateFor("t1")).toBe("idle");
		expect(result.current.overlayFor("t1")).toEqual(SELECTED);

		// A successful fetch that completed after the write retires it.
		rerender({
			topics: [server({ status: "SELECTED" })],
			updatedAt: settledAt + 2,
			errorAt: settledAt + 1,
		});
		expect(result.current.overlayFor("t1")).toBeNull();
		expect(result.current.isBusy("t1")).toBe(false);
	});

	it("accepts a second write once a failed confirming refetch has unlocked the topic", async () => {
		// The busy token must be gone by the time the control shows enabled:
		// otherwise `run` refuses a write the UI offers.
		const { result, rerender } = setup();
		await act(async () => {
			await result.current.run("t1", SELECTED, async () => {}, noop);
		});
		const settledAt = Date.now();
		rerender({ topics: [server()], updatedAt: 0, errorAt: settledAt + 1 });
		expect(result.current.isBusy("t1")).toBe(false);

		const IN_PROGRESS: TopicStatusOverlay = {
			status: "IN_PROGRESS",
			declineReason: null,
			publishedUrl: null,
		};
		const second = vi.fn(never);
		act(() => {
			void result.current.run("t1", IN_PROGRESS, second, noop);
		});
		expect(second).toHaveBeenCalledTimes(1);
		expect(result.current.overlayFor("t1")).toEqual(IN_PROGRESS);
		expect(result.current.saveStateFor("t1")).toBe("saving");
		expect(result.current.isBusy("t1")).toBe(true);
	});

	describe("a second write that FAILS after an unlocked, accepted first one", () => {
		// Write 1 was accepted but no successful fetch has confirmed it, so the
		// cached value is known to predate it. If write 2 then fails, the
		// control must fall back to write 1's value — never to the cache.
		const PUBLISHED: TopicStatusOverlay = {
			status: "PUBLISHED",
			declineReason: null,
			publishedUrl: "https://example.com/post",
		};
		const boom = new Error("nope");
		const failing = async () => {
			throw boom;
		};

		it("shows write 1's value again when the safety net had unlocked it", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const { result, rerender } = setup();
			await act(async () => {
				await result.current.run("t1", SELECTED, async () => {}, noop);
			});
			const settledAt = Date.now();
			act(() => {
				vi.advanceTimersByTime(OVERLAY_MAX_MS);
			});
			expect(result.current.isBusy("t1")).toBe(false);
			expect(result.current.overlayFor("t1")).toEqual(SELECTED);

			await act(async () => {
				await expect(
					result.current.run("t1", PUBLISHED, failing, noop),
				).rejects.toBe(boom);
			});
			expect(result.current.overlayFor("t1")).toEqual(SELECTED);
			expect(result.current.isBusy("t1")).toBe(false);
			expect(result.current.saveStateFor("t1")).toBe("error");

			// A successful fetch that completed after write 1 still retires it.
			rerender({
				topics: [server({ status: "SELECTED" })],
				updatedAt: settledAt + 1,
			});
			expect(result.current.overlayFor("t1")).toBeNull();
			expect(result.current.isBusy("t1")).toBe(false);
		});

		it("shows write 1's value again when a failed confirming fetch had unlocked it", async () => {
			const { result, rerender } = setup();
			await act(async () => {
				await result.current.run("t1", SELECTED, async () => {}, noop);
			});
			const settledAt = Date.now();
			rerender({
				topics: [server()],
				updatedAt: 0,
				errorAt: settledAt + 1,
			});
			expect(result.current.isBusy("t1")).toBe(false);
			expect(result.current.overlayFor("t1")).toEqual(SELECTED);

			await act(async () => {
				await expect(
					result.current.run("t1", PUBLISHED, failing, noop),
				).rejects.toBe(boom);
			});
			expect(result.current.overlayFor("t1")).toEqual(SELECTED);
			expect(result.current.isBusy("t1")).toBe(false);
			expect(result.current.saveStateFor("t1")).toBe("error");

			rerender({
				topics: [server({ status: "SELECTED" })],
				updatedAt: settledAt + 2,
				errorAt: settledAt + 1,
			});
			expect(result.current.overlayFor("t1")).toBeNull();
			expect(result.current.isBusy("t1")).toBe(false);
		});

		it("does not bring write 1's value back once a fetch newer than it arrived while write 2 was out", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const { result, rerender } = setup();
			await act(async () => {
				await result.current.run("t1", SELECTED, async () => {}, noop);
			});
			const settledAt = Date.now();
			act(() => {
				vi.advanceTimersByTime(OVERLAY_MAX_MS);
			});
			expect(result.current.isBusy("t1")).toBe(false);

			const gate = deferred();
			let second!: Promise<void>;
			act(() => {
				second = result.current.run(
					"t1",
					PUBLISHED,
					() => gate.promise,
					noop,
				);
			});
			// Newer than write 1, while write 2 is still out: write 2's value
			// stays on screen, but write 1's is superseded.
			rerender({
				topics: [server({ status: "SELECTED" })],
				updatedAt: settledAt + 1,
			});
			expect(result.current.overlayFor("t1")).toEqual(PUBLISHED);
			expect(result.current.isBusy("t1")).toBe(true);

			await act(async () => {
				gate.reject(boom);
				await second.catch(() => {});
			});
			expect(result.current.overlayFor("t1")).toBeNull();
			expect(result.current.isBusy("t1")).toBe(false);
			expect(result.current.saveStateFor("t1")).toBe("error");
		});
	});

	it("calls refresh once, and only AFTER the write has resolved", async () => {
		// The retirement rule rests on this: a refetch started before the server
		// commits can land after the settle time carrying the OLD value and
		// retire the overlay onto it (panel C). This is the only case that pins
		// the ORDER: moving refresh in front of the write reddens the failure
		// and unmount cases too, but only through their call counts.
		const refresh = vi.fn();
		const { result } = setup();
		const gate = deferred();
		let run!: Promise<void>;
		act(() => {
			run = result.current.run(
				"t1",
				SELECTED,
				() => gate.promise,
				refresh,
			);
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(refresh).not.toHaveBeenCalled();
		await act(async () => {
			gate.resolve();
			await run;
		});
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("after its owner unmounts, a late success still refreshes but arms no safety net", async () => {
		// Pick a status, then open the topic before the write returns: the list
		// is gone. A timer armed now would never be cleared and would log a
		// false "not confirmed" 10 s later (panel B #2).
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const refresh = vi.fn();
		const { result, unmount } = setup();
		const gate = deferred();
		let run!: Promise<void>;
		act(() => {
			run = result.current.run(
				"t1",
				SELECTED,
				() => gate.promise,
				refresh,
			);
		});
		unmount();
		await act(async () => {
			gate.resolve();
			await run;
		});
		expect(refresh).toHaveBeenCalledTimes(1);
		act(() => {
			vi.advanceTimersByTime(OVERLAY_MAX_MS + 1);
		});
		expect(warn).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("an earlier write's safety timer never unlocks a later write", async () => {
		const { result, rerender } = setup();
		await act(async () => {
			await result.current.run("t1", SELECTED, async () => {}, noop);
		});
		vi.setSystemTime(T0 + 400);
		rerender({
			topics: [server({ status: "SELECTED" })],
			updatedAt: T0 + 400,
		});
		expect(result.current.isBusy("t1")).toBe(false);

		act(() => {
			vi.advanceTimersByTime(9_500); // t = 9.9 s after write 1 settled
		});
		const IN_PROGRESS: TopicStatusOverlay = {
			status: "IN_PROGRESS",
			declineReason: null,
			publishedUrl: null,
		};
		act(() => {
			void result.current.run("t1", IN_PROGRESS, never, noop);
		});
		act(() => {
			vi.advanceTimersByTime(500); // past write 1's 10 s mark
		});
		expect(result.current.overlayFor("t1")).toEqual(IN_PROGRESS);
		expect(result.current.isBusy("t1")).toBe(true);
	});

	it("on failure: drops the overlay, frees the topic, refreshes, and says 'error'", async () => {
		const refresh = vi.fn();
		const { result } = setup();
		const boom = new Error("nope");
		await act(async () => {
			await expect(
				result.current.run(
					"t1",
					SELECTED,
					async () => {
						throw boom;
					},
					refresh,
				),
			).rejects.toBe(boom);
		});
		expect(result.current.overlayFor("t1")).toBeNull();
		expect(result.current.isBusy("t1")).toBe(false);
		expect(result.current.saveStateFor("t1")).toBe("error");
		// A request can fail AFTER the server committed; the cache must catch up.
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("keeps 'error' while the server shows something else, and turns 'saved' if it shows the attempted value", async () => {
		const { result, rerender } = setup();
		await act(async () => {
			await result.current
				.run(
					"t1",
					SELECTED,
					async () => {
						throw new Error("timeout");
					},
					noop,
				)
				.catch(() => {});
		});
		rerender({
			topics: [server({ status: "SUGGESTION" })],
			updatedAt: Date.now() + 1,
		});
		expect(result.current.saveStateFor("t1")).toBe("error");

		// The write had committed after all.
		rerender({
			topics: [server({ status: "SELECTED" })],
			updatedAt: Date.now() + 2,
		});
		expect(result.current.saveStateFor("t1")).toBe("saved");
	});

	it("refuses a second write for a busy topic, silently and without calling it", async () => {
		const { result } = setup({
			topics: [server(), server({ id: "t2" })],
			updatedAt: 0,
		});
		act(() => {
			void result.current.run("t1", SELECTED, never, noop);
		});
		const second = vi.fn(async () => {});
		await act(async () => {
			await expect(
				result.current.run("t1", SELECTED, second, noop),
			).rejects.toThrow();
		});
		expect(second).not.toHaveBeenCalled();
		expect(result.current.saveStateFor("t1")).toBe("saving");

		const other = vi.fn(async () => {});
		await act(async () => {
			await result.current.run("t2", SELECTED, other, noop);
		});
		expect(other).toHaveBeenCalledTimes(1);
	});

	it("drops everything for a topic that leaves the owning query", async () => {
		const { result, rerender } = setup();
		await act(async () => {
			await result.current.run("t1", SELECTED, async () => {}, noop);
		});
		rerender({ topics: [], updatedAt: 0 });
		expect(result.current.overlayFor("t1")).toBeNull();
		expect(result.current.isBusy("t1")).toBe(false);
		expect(result.current.saveStateFor("t1")).toBe("idle");
	});

	it("a write whose topic left the owning query mid-write still refreshes, but arms no safety net", async () => {
		// The write committed, so the cache must still catch up — but nothing
		// on screen waits for it, so no timer may be armed for it either.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const refresh = vi.fn();
		const { result, rerender } = setup();
		const gate = deferred();
		let run!: Promise<void>;
		act(() => {
			run = result.current.run(
				"t1",
				SELECTED,
				() => gate.promise,
				refresh,
			);
		});
		rerender({ topics: [], updatedAt: 0 });
		await act(async () => {
			gate.resolve();
			await run;
		});
		expect(refresh).toHaveBeenCalledTimes(1);
		act(() => {
			vi.advanceTimersByTime(OVERLAY_MAX_MS + 1);
		});
		expect(warn).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("a stale write that fails never overwrites a newer write's 'saving'", async () => {
		const IN_PROGRESS: TopicStatusOverlay = {
			status: "IN_PROGRESS",
			declineReason: null,
			publishedUrl: null,
		};
		const { result, rerender } = setup();
		const first = deferred();
		let firstRun!: Promise<void>;
		act(() => {
			firstRun = result.current.run(
				"t1",
				SELECTED,
				() => first.promise,
				noop,
			);
		});
		// t1 leaves the query (its state is dropped) and comes back while
		// write 1 is still out, so a second write can start.
		rerender({ topics: [], updatedAt: 0 });
		rerender({ topics: [server()], updatedAt: 0 });
		act(() => {
			void result.current.run("t1", IN_PROGRESS, never, noop);
		});
		await act(async () => {
			first.reject(new Error("late failure"));
			await firstRun.catch(() => {});
		});
		expect(result.current.saveStateFor("t1")).toBe("saving");
		expect(result.current.overlayFor("t1")).toEqual(IN_PROGRESS);
	});
});
