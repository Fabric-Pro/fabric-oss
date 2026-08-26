/**
 * The Temporal activity interceptor that sets the ambient project context.
 * This is the linchpin that auto-covers every activity —
 * including background jobs and future ones — without threading projectId.
 */
import { getAmbientProjectId } from "@repo/utils/project-context";
import { describe, expect, it } from "vitest";
import { ProjectContextActivityInboundInterceptor } from "../project-context-interceptor";

function makeInput(args: unknown[]) {
	// Only `args` is read by the interceptor; the rest of ActivityExecuteInput
	// is irrelevant here.
	return { args, headers: {} } as never;
}

describe("ProjectContextActivityInboundInterceptor", () => {
	it("runs the activity body with the ambient project set from args[0].projectId", async () => {
		const interceptor = new ProjectContextActivityInboundInterceptor();
		let seen: string | undefined;
		await interceptor.execute(makeInput([{ projectId: "proj-1" }]), () => {
			seen = getAmbientProjectId();
			return Promise.resolve(undefined);
		});
		expect(seen).toBe("proj-1");
	});

	it("leaves the ambient project unset when the input has no projectId", async () => {
		const interceptor = new ProjectContextActivityInboundInterceptor();
		let seen: string | undefined = "sentinel";
		await interceptor.execute(makeInput([{ storyId: "s" }]), () => {
			seen = getAmbientProjectId();
			return Promise.resolve(undefined);
		});
		expect(seen).toBeUndefined();
	});

	it("does not carry context outside the activity body", async () => {
		const interceptor = new ProjectContextActivityInboundInterceptor();
		await interceptor.execute(makeInput([{ projectId: "proj-1" }]), () =>
			Promise.resolve(undefined),
		);
		expect(getAmbientProjectId()).toBeUndefined();
	});
});
