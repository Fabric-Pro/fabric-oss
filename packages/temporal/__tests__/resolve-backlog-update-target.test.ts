import { describe, expect, it } from "vitest";
import { resolveBacklogUpdateTarget } from "../src/lib/resolve-backlog-update-target";

const items = [
	{
		id: "ckaaaaaaaaaaaaaaaaaaaaaaa",
		identifier: "F-1",
		title: "Login page",
		externalId: "JIRA-9",
	},
	{
		id: "ckbbbbbbbbbbbbbbbbbbbbbbb",
		identifier: "F-2",
		title: "Signup page",
		externalId: null,
	},
];

describe("resolveBacklogUpdateTarget", () => {
	it("resolves by valid Fabric id present in the snapshot", () => {
		const r = resolveBacklogUpdateTarget(items, {
			existingId: "ckaaaaaaaaaaaaaaaaaaaaaaa",
			title: { to: "Login page v2" },
		});
		expect(r).toEqual({
			status: "resolved",
			storyId: "ckaaaaaaaaaaaaaaaaaaaaaaa",
			identifier: "F-1",
			title: "Login page",
			resolvedBy: "id",
		});
	});

	it("resolves by identifier when id is not a Fabric id", () => {
		const r = resolveBacklogUpdateTarget(items, {
			existingId: "FEAT-023",
			existingIdentifier: "F-2",
			title: { to: "Signup page" },
		});
		expect(r).toMatchObject({
			status: "resolved",
			storyId: "ckbbbbbbbbbbbbbbbbbbbbbbb",
			resolvedBy: "identifier",
		});
	});

	it("resolves by externalId", () => {
		const r = resolveBacklogUpdateTarget(items, {
			existingExternalId: "JIRA-9",
			title: { to: "x" },
		});
		expect(r).toMatchObject({
			status: "resolved",
			storyId: "ckaaaaaaaaaaaaaaaaaaaaaaa",
			resolvedBy: "externalId",
		});
	});

	it("resolves by exact case-insensitive title (from preferred over to)", () => {
		const r = resolveBacklogUpdateTarget(items, {
			title: { from: "LOGIN PAGE", to: "Login page renamed" },
		});
		expect(r).toMatchObject({
			status: "resolved",
			storyId: "ckaaaaaaaaaaaaaaaaaaaaaaa",
			resolvedBy: "title",
		});
	});

	it("returns unresolved for a phantom reference (FEAT-023, no match anywhere)", () => {
		const r = resolveBacklogUpdateTarget(items, {
			existingId: "FEAT-023",
			existingIdentifier: "FEAT-023",
			title: { to: "Feature Maturation Workflow Redesign" },
		});
		expect(r).toEqual({ status: "unresolved" });
	});

	it("treats a valid-looking Fabric id absent from the snapshot as unresolved", () => {
		const r = resolveBacklogUpdateTarget(items, {
			existingId: "ckzzzzzzzzzzzzzzzzzzzzzzzz",
			title: { to: "Ghost" },
		});
		expect(r).toEqual({ status: "unresolved" });
	});

	it("resolves by title.to when from is absent", () => {
		const r = resolveBacklogUpdateTarget(items, {
			title: { to: "Signup page" },
		});
		expect(r).toMatchObject({
			status: "resolved",
			storyId: "ckbbbbbbbbbbbbbbbbbbbbbbb",
			resolvedBy: "title",
		});
	});
});
