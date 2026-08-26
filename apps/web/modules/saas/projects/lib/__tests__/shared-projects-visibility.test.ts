/**
 * Tests for the "Shared with me" section visibility decision.
 *
 * `ProjectsList` renders the section only when this pure function says so:
 * personal workspace (organizationId === null) AND at least one guest
 * project. The org-context and empty cases must hide the section entirely
 * (no empty-state shell).
 */
import { describe, expect, it } from "vitest";
import { shouldShowSharedProjects } from "../shared-projects-visibility";

describe("shouldShowSharedProjects", () => {
	it("shows the section in personal context when guest projects exist", () => {
		expect(
			shouldShowSharedProjects({
				organizationId: null,
				guestProjectCount: 3,
			}),
		).toBe(true);

		expect(
			shouldShowSharedProjects({
				organizationId: null,
				guestProjectCount: 1,
			}),
		).toBe(true);
	});

	it("hides the section entirely when there are zero shared projects", () => {
		expect(
			shouldShowSharedProjects({
				organizationId: null,
				guestProjectCount: 0,
			}),
		).toBe(false);
	});

	it("hides the section in organization context even when guest projects exist", () => {
		expect(
			shouldShowSharedProjects({
				organizationId: "org-1",
				guestProjectCount: 5,
			}),
		).toBe(false);
	});

	it("hides the section in organization context with zero shared projects", () => {
		expect(
			shouldShowSharedProjects({
				organizationId: "org-1",
				guestProjectCount: 0,
			}),
		).toBe(false);
	});
});
