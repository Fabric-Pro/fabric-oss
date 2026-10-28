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
}));
vi.mock("@repo/database", () => ({
	getCodingRun: f.run,
	getProjectMemberRole: f.role,
	isProjectReadOnly: f.readonly,
	addCodingRunEvent: f.event,
	db: { codingRun: { updateMany: f.update } },
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
