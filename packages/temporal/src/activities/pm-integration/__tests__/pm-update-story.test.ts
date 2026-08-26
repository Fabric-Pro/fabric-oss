/**
 * The PM-sync wrapper decides who a PM-driven change is credited to.
 *
 * This could not be verified on the deployed environment: every PM-linked story
 * there points at a tracker item that no longer exists, so a pull returns
 * EXTERNAL_ID_NOT_FOUND before it can write anything. The behaviour is asserted
 * here instead, at the boundary that actually makes the decision.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateStoryMock = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", () => ({ updateStory: updateStoryMock }));

import { updateStoryFromPm } from "../pm-update-story";

const STORY = "story-1";
const PROJECT = "project-1";

describe("updateStoryFromPm", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		updateStoryMock.mockResolvedValue({ id: STORY });
	});

	it("credits the PM tool, not a person, when the caller names no source", async () => {
		await updateStoryFromPm(STORY, PROJECT, { title: "Pulled title" });

		const [, , , context] = updateStoryMock.mock.calls[0];
		expect(context.lastEditedSource).toBe("PM_PULL");
		// A pull is nobody's edit; inventing a human here would be worse than
		// leaving it empty.
		expect(context.lastEditedByName).toBeUndefined();
	});

	it("supplies a source for a bare call, so the boundary cannot reject it", async () => {
		// updateStory throws when a classified field changes with no source.
		// Every bare call in the PM-sync modules relies on this default.
		await updateStoryFromPm(STORY, PROJECT, {
			description: "Pulled body",
			labels: ["from-pm"],
			statusId: "status-2",
		});

		const [, , , context] = updateStoryMock.mock.calls[0];
		expect(context.lastEditedSource).toBe("PM_PULL");
	});

	it("does not override a caller that named its own source", async () => {
		await updateStoryFromPm(
			STORY,
			PROJECT,
			{ title: "Resolved by a human" },
			{
				lastEditedSource: "CONFLICT_RESOLUTION",
				lastEditedByName: "Grace Hopper",
			},
		);

		const [, , , context] = updateStoryMock.mock.calls[0];
		expect(context.lastEditedSource).toBe("CONFLICT_RESOLUTION");
		expect(context.lastEditedByName).toBe("Grace Hopper");
	});

	it("passes the story, project and data through untouched", async () => {
		const data = { title: "Pulled title" };
		await updateStoryFromPm(STORY, PROJECT, data);

		const [storyId, projectId, forwarded] = updateStoryMock.mock.calls[0];
		expect(storyId).toBe(STORY);
		expect(projectId).toBe(PROJECT);
		expect(forwarded).toEqual(data);
	});

	it("forwards a caller-supplied transaction client", async () => {
		// This wrapper types itself as `Parameters<typeof updateStory>`, so it
		// advertises every parameter the underlying function grows. A parameter
		// it advertises but does not destructure is dropped silently — the type
		// checker sees the spread and is satisfied. `updateStory` gained an
		// optional transaction client so a caller can run the write inside an
		// already-open row-locked transaction; dropping it here would put the
		// write in its own transaction instead, outside the caller's lock.
		const tx = { marker: "caller-transaction" };

		await updateStoryFromPm(
			STORY,
			PROJECT,
			{ title: "Pulled title" },
			undefined,
			tx as never,
		);

		expect(updateStoryMock.mock.calls[0][4]).toBe(tx);
	});
});
