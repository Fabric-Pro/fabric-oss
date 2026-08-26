/**
 * The shared external-dispatch funnel + Read-only gate (Fizzy #2007).
 *
 * Covers the behaviours the whole global-interceptor design rests on: a write
 * tool is blocked (its dispatch closure never runs) when the project is
 * read-only; reads pass; the owning project is resolved from the AMBIENT
 * project context when not passed explicitly (this is what covers routes and
 * future activities that don't thread projectId); and unknown projects / no
 * context fall through.
 */

import { runWithProjectContext } from "@repo/utils/project-context";
import { beforeEach, describe, expect, it, vi } from "vitest";

const isProjectReadOnly = vi.fn(async () => false);
vi.mock("@repo/database", () => ({ isProjectReadOnly }));

const { callMcpTool, guardToolWriteForReadOnly } = await import(
	"../read-only-gate"
);

describe("callMcpTool funnel + read-only gate", () => {
	beforeEach(() => {
		isProjectReadOnly.mockReset();
		isProjectReadOnly.mockResolvedValue(false);
	});

	it("runs the dispatch when the project is not read-only", async () => {
		const execute = vi.fn(async () => "OK");
		const res = await callMcpTool({
			toolName: "create_card",
			projectId: "p1",
			execute,
		});
		expect(res).toBe("OK");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("BLOCKS a write tool (dispatch never runs) when the project is read-only", async () => {
		isProjectReadOnly.mockResolvedValue(true);
		const execute = vi.fn(async () => "OK");
		const res = await callMcpTool({
			toolName: "create_card",
			projectId: "p1",
			execute,
		});
		expect(execute).not.toHaveBeenCalled();
		expect((res as { code?: string; error?: string }).code).toBe(
			"PROJECT_READ_ONLY",
		);
	});

	it("lets a read tool through even when the project is read-only", async () => {
		isProjectReadOnly.mockResolvedValue(true);
		const execute = vi.fn(async () => "DATA");
		const res = await callMcpTool({
			toolName: "get_card",
			projectId: "p1",
			execute,
		});
		expect(res).toBe("DATA");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("resolves the project from the AMBIENT context when projectId is omitted", async () => {
		isProjectReadOnly.mockResolvedValue(true);
		const execute = vi.fn(async () => "OK");
		const res = await runWithProjectContext("ambient-p", () =>
			callMcpTool({ toolName: "update_ticket", execute }),
		);
		expect(execute).not.toHaveBeenCalled();
		expect((res as { code?: string }).code).toBe("PROJECT_READ_ONLY");
		expect(isProjectReadOnly).toHaveBeenCalledWith("ambient-p");
	});

	it("does not gate when there is neither an explicit nor an ambient project", async () => {
		isProjectReadOnly.mockResolvedValue(true);
		const execute = vi.fn(async () => "OK");
		const res = await callMcpTool({ toolName: "create_card", execute });
		expect(res).toBe("OK");
		expect(isProjectReadOnly).not.toHaveBeenCalled();
	});

	it("does NOT exempt fabric_-named tools — everything in this funnel is an external dispatch", async () => {
		// The earlier name-based exemption was a write escape (post-ship review
		// finding): a third-party server can expose `fabric_update_page`. Only
		// the worker-side twin exempts fabric_* — and only for the in-process
		// Fabric AI switch, via an explicit opt-in.
		isProjectReadOnly.mockResolvedValue(true);
		const blocked = await guardToolWriteForReadOnly(
			"p1",
			"fabric_create_story",
		);
		expect(blocked).not.toBeNull();
		expect(blocked?.code).toBe("PROJECT_READ_ONLY");
	});
});
