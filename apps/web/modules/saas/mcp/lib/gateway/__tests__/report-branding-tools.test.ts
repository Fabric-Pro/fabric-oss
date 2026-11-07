import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ read: vi.fn(), apply: vi.fn() }));
vi.mock("@repo/database", async () => {
	const { z } = await import("zod");
	return {
		FRAME_SURFACES: ["artifact", "workspace"],
		getReportInstanceBranding: m.read,
		applyReportInstanceBranding: m.apply,
		ReportBrandingCommandError: class extends Error {},
		reportInstanceBrandingUpdateSchema: z.strictObject({
			expectedInstanceVersion: z.number().int().positive(),
			expectedUpdatedAt: z.iso.datetime({ offset: true }),
			branding: z
				.strictObject({
					source: z.enum(["CLIENT", "COMPANY"]),
					expectedBrandVersion: z.number().int().nonnegative(),
				})
				.nullable(),
		}),
	};
});

import { FABRIC_FRAME_TOOL_DEFINITIONS } from "@repo/temporal/fabric-frame-tool-definitions";
import { createFrameTools } from "../tools/frame-tools";
import type { GatewaySession } from "../types";

const family = createFrameTools(() => true);
function applyHandler() {
	const handler = family.handlers.get("fabric_apply_report_branding");
	if (!handler) {
		throw new Error("Report branding handler is missing");
	}
	return handler;
}
const session = (scopes: string[]) =>
	({
		userId: "example-user",
		organizationId: "example-org",
		credential: "organization-key",
		scopes,
	}) as GatewaySession;
const input = {
	instanceId: "example-report",
	expectedInstanceVersion: 2,
	expectedUpdatedAt: "2026-11-01T00:00:00Z",
	branding: { source: "CLIENT", expectedBrandVersion: 3 },
};
beforeEach(() => {
	vi.clearAllMocks();
	m.read.mockResolvedValue({ instanceVersion: 2 });
	m.apply.mockResolvedValue({ instanceVersion: 2 });
});
describe("report branding tools", () => {
	it("requires exact report consent and confirms writes", async () => {
		const handler = applyHandler();
		expect((await handler(input, session(["mcp:write"]))).isError).toBe(
			true,
		);
		expect(m.apply).not.toHaveBeenCalled();
		expect(
			FABRIC_FRAME_TOOL_DEFINITIONS.find(
				(tool) => tool.name === "fabric_apply_report_branding",
			)?.confirm,
		).toBe("always");
	});
	it("binds reviewed report changes to the current session actor", async () => {
		const handler = applyHandler();
		expect(
			(await handler(input, session(["reports:write"]))).isError,
		).not.toBe(true);
		const { instanceId, ...change } = input;
		expect(m.apply).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "example-user",
				organizationId: "example-org",
			}),
			instanceId,
			change,
		);
	});
	it("rejects missing CAS and authority injection before mutation", async () => {
		const handler = applyHandler();
		expect(
			(
				await handler(
					{ ...input, expectedUpdatedAt: undefined },
					session(["reports:write"]),
				)
			).isError,
		).toBe(true);
		expect(
			(
				await handler(
					{ ...input, organizationId: "example-other" },
					session(["reports:write"]),
				)
			).isError,
		).toBe(true);
		expect(m.apply).not.toHaveBeenCalled();
	});
});
