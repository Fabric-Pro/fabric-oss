import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	handler: undefined as unknown as (arg: any) => Promise<any>,
	run: vi.fn(),
	role: vi.fn(),
	allowed: vi.fn(),
	readonly: vi.fn(),
	send: vi.fn(),
	event: vi.fn(),
	update: vi.fn(),
	start: vi.fn(),
	query: vi.fn(),
	describe: vi.fn(),
	findEvent: vi.fn(),
	createEvent: vi.fn(),
	audit: vi.fn(),
}));
vi.mock("../../../lib/audit", () => ({ recordAuditFromRequest: f.audit }));
vi.mock("@repo/database", () => ({
	getCodingRun: f.run,
	getProjectMemberRole: f.role,
	canEditProject: f.allowed,
	isProjectReadOnly: f.readonly,
	addCodingRunEvent: f.event,
	db: {
		codingRun: { updateMany: f.update },
		codingRunEvent: { findUnique: f.findEvent },
		$transaction: (callback: (tx: unknown) => Promise<unknown>) =>
			callback({
				codingRun: { updateMany: f.update },
				codingRunEvent: { create: f.createEvent },
			}),
	},
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: f.start,
			getHandle: () => ({ query: f.query, describe: f.describe }),
		},
	}),
}));
vi.mock("@repo/permissions", () => ({
	hasPermission: f.allowed,
	Permissions: { STORY_UPDATE: "story:update" },
	resolveProjectPermissions: vi.fn(),
}));
vi.mock("@repo/temporal/coding-execution", () => ({
	getCodingExecutionProvider: () => ({ sendPrompt: f.send }),
}));
vi.mock("../../../orpc/procedures", () => {
	const chain: any = {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: any) => {
			f.handler = fn;
			return {};
		},
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: { AGENT_EXECUTE: "agent:execute" },
		requirePermission: () => vi.fn(),
		requireInputOrgPermission: () => vi.fn(),
		resolveOrganizationId: (id: string) => id,
	};
});
import "../procedures/send-follow-up";
const input = {
	id: "example-run",
	organizationId: "example-org",
	message: "Continue",
	promptId: "00000000-0000-4000-8000-000000000001",
};
const invoke = () =>
	f.handler({
		input,
		context: { user: { id: "example-user" }, session: {} },
	});
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
	vi.stubEnv("BACKGROUND_AGENTS_URL", "https://example.com");
	f.run.mockResolvedValue({
		id: input.id,
		projectId: "example-project",
		provider: "BACKGROUND_AGENTS",
		providerSessionId: "example-session",
		status: "AWAITING_REVIEW",
	});
	f.allowed.mockReturnValue(true);
	f.readonly.mockResolvedValue(false);
	f.send.mockResolvedValue({ messageId: "example-native-message" });
	f.update.mockResolvedValue({ count: 1 });
	f.start.mockResolvedValue({ query: f.query });
	f.query.mockResolvedValue({ messageId: "example-continuation-message" });
	f.describe.mockResolvedValue({ status: { name: "COMPLETED" } });
	let reserved = false;
	f.createEvent.mockImplementation(async () => {
		reserved = true;
	});
	f.findEvent.mockImplementation(
		async ({ where }: { where: { id: string } }) =>
			reserved && where.id.startsWith("follow-up-request:")
				? {
						payloadJson: {
							digest: createHash("sha256")
								.update(input.message)
								.digest("hex"),
							authorId: "example-user",
						},
					}
				: null,
	);
});
describe("follow-up prompt receipts", () => {
	it("passes stable identity and retains the native receipt in the run event", async () => {
		expect(await invoke()).toEqual({
			sent: true,
			messageId: "example-native-message",
		});
		expect(f.run).toHaveBeenCalledWith(
			input.id,
			"example-user",
			input.organizationId,
		);
		expect(f.send).toHaveBeenCalledWith(
			"example-session",
			input.message,
			"example-user",
			{ promptId: input.promptId },
		);
		expect(f.event).toHaveBeenCalledWith(
			input.id,
			"follow_up_sent",
			expect.objectContaining({
				promptId: input.promptId,
				messageId: "example-native-message",
			}),
		);
	});
	it.each(["RECOVERY_REQUIRED", "INPUT_REQUIRED"])(
		"keeps %s actionable and never claims success",
		async (code) => {
			f.send.mockRejectedValue(
				Object.assign(new Error("Open the existing session"), { code }),
			);
			await expect(invoke()).rejects.toMatchObject({
				code: "CONFLICT",
				data: { errorCode: code },
			});
			expect(f.event).not.toHaveBeenCalled();
			expect(f.update).not.toHaveBeenCalled();
		},
	);
	it("does not send after project permission revocation", async () => {
		f.allowed.mockReturnValue(false);
		await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(f.send).not.toHaveBeenCalled();
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it("retains webhook-only legacy follow-ups without worker credentials in the API", async () => {
	vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", undefined);
	vi.stubEnv("BACKGROUND_AGENTS_URL", undefined);
	vi.stubEnv("BACKGROUND_AGENTS_INTERNAL_SECRET", undefined);
	vi.stubEnv("FABRIC_BOT_URL", "https://example.com");
	vi.stubEnv("FABRIC_BOT_SECRET", "synthetic-legacy-bot-secret");
	const fetch = vi
		.fn()
		.mockResolvedValue(new Response("{}", { status: 202 }));
	vi.stubGlobal("fetch", fetch);
	await expect(
		f.handler({
			input: { ...input, promptId: undefined },
			context: { user: { id: "example-user" }, session: {} },
		}),
	).resolves.toEqual({ sent: true });
	expect(fetch).toHaveBeenCalledWith(
		"https://example.com/webhook",
		expect.objectContaining({
			body: JSON.stringify({
				action: "prompted",
				codingRunId: input.id,
				workflowId: `coding-run-${input.id}`,
				prompt: input.message,
				organizationId: input.organizationId,
			}),
		}),
	);
	expect(f.send).not.toHaveBeenCalled();
});

it("requires stable native identity before delivery", async () => {
	await expect(
		f.handler({
			input: { ...input, promptId: undefined },
			context: { user: { id: "example-user" }, session: {} },
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(f.send).not.toHaveBeenCalled();
});

it.each(["CANCELLED", "COMPLETED"])(
	"does not resurrect a run that becomes %s during delivery",
	async (terminal) => {
		let currentStatus = "AWAITING_REVIEW";
		f.send.mockImplementation(async () => {
			currentStatus = terminal;
			return { messageId: "example-native-message" };
		});
		f.update.mockImplementation(async ({ where, data }) => {
			if (currentStatus === where.status) {
				currentStatus = data.status;
			}
			return { count: 0 };
		});
		await invoke();
		expect(currentStatus).toBe(terminal);
		expect(f.update).toHaveBeenCalledWith({
			where: {
				id: input.id,
				projectId: "example-project",
				status: "AWAITING_REVIEW",
			},
			data: { status: "RUNNING" },
		});
	},
);

describe("completed native session continuation", () => {
	const native = {
		organizationId: input.organizationId,
		id: input.id,
		projectId: "example-project",
		provider: "BACKGROUND_AGENTS",
		providerSessionId: "example-session",
		status: "COMPLETED",
		workflowId: "coding-run-example-run",
		providerMetadata: {
			executionRuntime: "fabric-agent-server",
			executionTarget: {
				url: "https://example.com",
				profileId: "example-profile",
			},
		},
	};
	it("recovers a failed Temporal start with the same reserved identity without reclaiming the active slot", async () => {
		f.run.mockResolvedValue(native);
		f.start.mockRejectedValueOnce(
			new Error("Temporal start ACK unavailable"),
		);
		await expect(invoke()).rejects.toThrow(
			"Temporal start ACK unavailable",
		);
		f.run.mockResolvedValue({
			...native,
			status: "STARTING",
			workflowId: `coding-follow-up-${input.id}-${input.promptId}`,
		});
		expect(await invoke()).toEqual({
			sent: true,
			messageId: "example-continuation-message",
		});
		expect(f.createEvent).toHaveBeenCalledTimes(1);
		expect(f.update).toHaveBeenCalledTimes(1);
		expect(f.start).toHaveBeenCalledTimes(2);
		expect(f.start.mock.calls[0][1].workflowId).toBe(
			f.start.mock.calls[1][1].workflowId,
		);
		expect(f.send).not.toHaveBeenCalled();
	});
	it("starts an observer on the existing session and returns only its durable receipt", async () => {
		f.run.mockResolvedValue(native);
		expect(await invoke()).toEqual({
			sent: true,
			messageId: "example-continuation-message",
		});
		expect(f.start).toHaveBeenCalledWith(
			"codingRunFollowUpWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						sessionId: native.providerSessionId,
						promptId: input.promptId,
						organizationId: input.organizationId,
					}),
				],
				workflowIdReusePolicy: "REJECT_DUPLICATE",
			}),
		);
		expect(f.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: input.id, status: "COMPLETED" },
				data: expect.objectContaining({ status: "STARTING" }),
			}),
		);
		expect(f.send).not.toHaveBeenCalled();
		expect(f.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "weave.session.continuation_requested",
				resource: { type: "coding_run", id: input.id },
			}),
		);
	});
	it("does not race the previous workflow's cleanup", async () => {
		f.run.mockResolvedValue(native);
		f.describe.mockResolvedValue({ status: { name: "RUNNING" } });
		await expect(invoke()).rejects.toMatchObject({ code: "CONFLICT" });
		expect(f.update).not.toHaveBeenCalled();
		expect(f.start).not.toHaveBeenCalled();
	});
	it("rejects overlapping continuation rather than sending unobserved work", async () => {
		f.run.mockResolvedValue({ ...native, status: "RUNNING" });
		await expect(invoke()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { errorCode: "INPUT_REQUIRED" },
		});
		expect(f.send).not.toHaveBeenCalled();
		expect(f.start).not.toHaveBeenCalled();
	});
	it("recovers a saved receipt after completion without claiming the slot again", async () => {
		f.run.mockResolvedValue(native);
		f.findEvent.mockImplementation(
			async ({ where }: { where: { id: string } }) =>
				where.id.startsWith("follow-up-request:")
					? {
							payloadJson: {
								digest: createHash("sha256")
									.update(input.message)
									.digest("hex"),
								authorId: "example-user",
							},
						}
					: { providerEventId: "example-saved-message" },
		);
		expect(await invoke()).toEqual({
			sent: true,
			messageId: "example-saved-message",
		});
		expect(f.update).not.toHaveBeenCalled();
		expect(f.start).not.toHaveBeenCalled();
	});
	it("recovers the existing receipt while its continuation is still running", async () => {
		f.run.mockResolvedValue({ ...native, status: "RUNNING" });
		f.findEvent.mockImplementation(
			async ({ where }: { where: { id: string } }) =>
				where.id.startsWith("follow-up-request:")
					? {
							payloadJson: {
								digest: createHash("sha256")
									.update(input.message)
									.digest("hex"),
								authorId: "example-user",
							},
						}
					: { providerEventId: "example-saved-message" },
		);
		expect(await invoke()).toEqual({
			sent: true,
			messageId: "example-saved-message",
		});
		expect(f.start).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
	});
	it.each(["FAILED", "CANCELLED"])(
		"recovers an accepted receipt after observation ends as %s",
		async (status) => {
			f.run.mockResolvedValue({ ...native, status });
			f.findEvent.mockImplementation(
				async ({ where }: { where: { id: string } }) =>
					where.id.startsWith("follow-up-request:")
						? {
								payloadJson: {
									digest: createHash("sha256")
										.update(input.message)
										.digest("hex"),
									authorId: "example-user",
								},
							}
						: { providerEventId: "example-saved-message" },
			);
			expect(await invoke()).toEqual({
				sent: true,
				messageId: "example-saved-message",
			});
			expect(f.start).not.toHaveBeenCalled();
		},
	);
	it("returns conflict when another run owns the active story slot", async () => {
		f.run.mockResolvedValue(native);
		f.update.mockRejectedValueOnce({
			code: "P2002",
			meta: { target: "coding_run_one_active_per_story" },
		});
		await expect(invoke()).rejects.toMatchObject({ code: "CONFLICT" });
		expect(f.start).not.toHaveBeenCalled();
	});
	it("can continue a retained native session after Temporal history expires", async () => {
		f.run.mockResolvedValue(native);
		f.describe.mockRejectedValueOnce(
			Object.assign(new Error("History expired"), {
				name: "WorkflowNotFoundError",
			}),
		);
		expect(await invoke()).toEqual({
			sent: true,
			messageId: "example-continuation-message",
		});
	});
	it("rejects changed content on a reused continuation identity", async () => {
		f.run.mockResolvedValue(native);
		f.findEvent.mockResolvedValue({
			payloadJson: { digest: "changed", authorId: "example-user" },
		});
		await expect(invoke()).rejects.toMatchObject({ code: "CONFLICT" });
		expect(f.start).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
	});
});
