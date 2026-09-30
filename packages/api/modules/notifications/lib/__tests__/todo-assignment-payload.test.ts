/**
 * The two to-do assignment notification payloads (Fizzy #2340).
 *
 * TODO_ASSIGNED is written by `fanOut.todoAssigned` in
 * packages/api/lib/notification-service.ts. TODO_MEETING_ITEMS_ASSIGNED is
 * written from the Temporal worker by a writer in `@repo/database`, which
 * cannot import this module — so the schema here is the only thing that says
 * what that row must look like.
 */

import {
	buildTodoMeetingAssignmentPayload,
	NotificationType,
	TODO_MEETING_NOTIFICATION_MAX_AGE_DAYS,
} from "@repo/database";
import { describe, expect, it } from "vitest";
import { TODO_AGE_THRESHOLD_DAYS } from "../../../todos/lib/visibility";
import { validatePayload } from "../payloads";

const TODO_ASSIGNED = {
	todoId: "todo-1",
	projectId: "proj-1",
	assignedByUserId: "user-actor",
	previousAssigneeUserId: "user-before",
} as const;

const MEETING_ITEMS_ASSIGNED = {
	transcriptId: "transcript-1",
	projectId: "proj-1",
	todoIds: ["todo-1", "todo-2"],
	itemCount: 2,
} as const;

describe("TODO_ASSIGNED payload schema", () => {
	it("accepts the emitted shape", () => {
		expect(
			validatePayload(NotificationType.TODO_ASSIGNED, TODO_ASSIGNED),
		).toMatchObject(TODO_ASSIGNED);
	});

	it("accepts a to-do with no project and no previous assignee", () => {
		const projectless = {
			...TODO_ASSIGNED,
			projectId: null,
			previousAssigneeUserId: null,
		};
		expect(
			validatePayload(NotificationType.TODO_ASSIGNED, projectless),
		).toMatchObject(projectless);
	});

	it("rejects a payload without the to-do it is about", () => {
		const { todoId: _omit, ...partial } = TODO_ASSIGNED;
		expect(() =>
			validatePayload(NotificationType.TODO_ASSIGNED, partial),
		).toThrow();
	});
});

describe("TODO_MEETING_ITEMS_ASSIGNED payload schema", () => {
	it("accepts the emitted shape", () => {
		expect(
			validatePayload(
				NotificationType.TODO_MEETING_ITEMS_ASSIGNED,
				MEETING_ITEMS_ASSIGNED,
			),
		).toMatchObject(MEETING_ITEMS_ASSIGNED);
	});

	it("rejects a row that names no to-do", () => {
		expect(() =>
			validatePayload(NotificationType.TODO_MEETING_ITEMS_ASSIGNED, {
				...MEETING_ITEMS_ASSIGNED,
				todoIds: [],
			}),
		).toThrow();
	});

	it("rejects a row that does not say which meeting", () => {
		const { transcriptId: _omit, ...partial } = MEETING_ITEMS_ASSIGNED;
		expect(() =>
			validatePayload(
				NotificationType.TODO_MEETING_ITEMS_ASSIGNED,
				partial,
			),
		).toThrow();
	});
});

describe("the meeting notice writer in @repo/database", () => {
	it("builds a payload this schema accepts", () => {
		// The writer cannot import `validatePayload`, so this is the only place
		// the two packages' idea of the row is compared. A field renamed on
		// either side fails here instead of at read time.
		const payload = buildTodoMeetingAssignmentPayload({
			transcriptId: "transcript-1",
			projectId: "proj-1",
			todoIds: ["todo-1", "todo-2"],
		});

		expect(
			validatePayload(
				NotificationType.TODO_MEETING_ITEMS_ASSIGNED,
				payload,
			),
		).toEqual(payload);
	});

	it("builds a payload this schema accepts for a single item", () => {
		const payload = buildTodoMeetingAssignmentPayload({
			transcriptId: "transcript-1",
			projectId: "proj-1",
			todoIds: ["todo-1"],
		});

		expect(
			validatePayload(
				NotificationType.TODO_MEETING_ITEMS_ASSIGNED,
				payload,
			),
		).toEqual(payload);
	});
});

describe("the meeting notice's freshness window", () => {
	it("matches the To Do page's age cutoff", () => {
		// A meeting the page already age-hides must not ring the bell: the
		// notice would link to a list that does not show the items it names.
		expect(TODO_MEETING_NOTIFICATION_MAX_AGE_DAYS).toBe(
			TODO_AGE_THRESHOLD_DAYS,
		);
	});
});
