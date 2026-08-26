/**
 * What an empty pipeline-sources list is allowed to say.
 *
 * The unsupported-source requirement. "Nothing is connected" and "the thing you connected cannot do
 * this" are different situations with different next actions, and the empty
 * state used to give both the same sentence. A customer who connected Azure
 * DevOps as their PM tool has already done what they believe was asked; sending
 * them to check that connection wastes their time on something working
 * perfectly well at its own job.
 */

import { describe, expect, it } from "vitest";
import { describeMissingResultSource } from "../qa-result-source";

describe("describeMissingResultSource", () => {
	it("asks a project with nothing connected to connect a repository", () => {
		const message = describeMissingResultSource(null);

		expect(message).toContain("No repositories are connected");
		expect(message).toContain("Settings ▸ Development");
		// Must not raise a PM tool that isn't there.
		expect(message).not.toContain("project-management");
	});

	it("names the PM tool and says it cannot return test runs", () => {
		const message = describeMissingResultSource("Azure DevOps");

		expect(message).toContain("Azure DevOps");
		expect(message).toContain("cannot return test runs");
		// Still ends with the action that fixes it — naming the problem without
		// naming the remedy is the failure mode this replaces.
		expect(message).toContain("Settings ▸ Development");
	});

	it("uses whichever tool is connected, not a hardcoded example", () => {
		expect(describeMissingResultSource("Jira")).toContain("Jira");
		expect(describeMissingResultSource("Linear")).toContain("Linear");
	});
});
