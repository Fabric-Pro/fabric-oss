import { beforeEach, describe, expect, it, vi } from "vitest";

type Approvals = typeof import("../frame-runtime-approvals");

/** A fresh copy of the module, as after a reload: its memory is empty, the session's storage is not. */
async function reloaded(): Promise<Approvals> {
	vi.resetModules();
	return import("../frame-runtime-approvals");
}

beforeEach(() => {
	window.sessionStorage.clear();
});

describe("approvalKeyOf", () => {
	it("gives each version of a page its own key", async () => {
		const { approvalKeyOf } = await reloaded();

		expect(approvalKeyOf("frame-1", "aaa")).not.toBe(
			approvalKeyOf("frame-1", "bbb"),
		);
		expect(approvalKeyOf("frame-1", "aaa")).not.toBe(
			approvalKeyOf("frame-2", "aaa"),
		);
		expect(approvalKeyOf("frame-1", "aaa")).toBe(
			approvalKeyOf("frame-1", "aaa"),
		);
	});
});

describe("an approval", () => {
	it("covers the tool it was given for and no other", async () => {
		const { approve, isApproved } = await reloaded();

		approve("frame-1@v1", "fabric_execute_workflow");

		expect(isApproved("frame-1@v1", "fabric_execute_workflow")).toBe(true);
		expect(isApproved("frame-1@v1", "fabric_pause_workflow")).toBe(false);
	});

	it("covers the version it was given for and no other", async () => {
		const { approve, approvalKeyOf, isApproved } = await reloaded();

		approve(approvalKeyOf("frame-1", "v1"), "fabric_execute_workflow");

		expect(
			isApproved(
				approvalKeyOf("frame-1", "v2"),
				"fabric_execute_workflow",
			),
		).toBe(false);
		expect(
			isApproved(
				approvalKeyOf("frame-2", "v1"),
				"fabric_execute_workflow",
			),
		).toBe(false);
	});

	it("is remembered for the browser session, across a reload of the page", async () => {
		const first = await reloaded();
		first.approve("frame-1@v1", "fabric_execute_workflow");

		const second = await reloaded();

		expect(second.isApproved("frame-1@v1", "fabric_execute_workflow")).toBe(
			true,
		);
	});

	it("is not remembered once the session's storage is gone", async () => {
		const first = await reloaded();
		first.approve("frame-1@v1", "fabric_execute_workflow");
		window.sessionStorage.clear();

		const second = await reloaded();

		expect(second.isApproved("frame-1@v1", "fabric_execute_workflow")).toBe(
			false,
		);
	});

	it("is not given by an older approval kept under the page's id alone", async () => {
		window.sessionStorage.setItem(
			"fabric-frame-runtime-approvals",
			JSON.stringify({ "frame-1": ["fabric_execute_workflow"] }),
		);
		const { approvalKeyOf, isApproved } = await reloaded();

		expect(
			isApproved(
				approvalKeyOf("frame-1", "v1"),
				"fabric_execute_workflow",
			),
		).toBe(false);
		expect(isApproved("frame-1", "fabric_execute_workflow")).toBe(true);
	});

	it("survives storage that holds something else", async () => {
		const { approve, isApproved } = await reloaded();
		for (const [index, junk] of [
			"not json",
			"[]",
			"null",
			'{"k":"v"}',
			'{"k":[1]}',
		].entries()) {
			window.sessionStorage.setItem(
				"fabric-frame-runtime-approvals",
				junk,
			);
			const key = `k${index}`;

			expect(isApproved(key, "t")).toBe(false);
			approve(key, "t");
			expect(isApproved(key, "t")).toBe(true);
		}
	});

	it("still holds in memory when storage cannot be used", async () => {
		const { approve, isApproved } = await reloaded();
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});

		approve("frame-1@v1", "fabric_execute_workflow");

		expect(isApproved("frame-1@v1", "fabric_execute_workflow")).toBe(true);
		vi.restoreAllMocks();
	});
});
