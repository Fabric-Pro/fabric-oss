import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DraftVerdictRecorder,
	useConfirmChangesVerdict,
	useConfirmChangesVerdictCard,
} from "../useConfirmChangesVerdict";

const { confirmDraft } = vi.hoisted(() => ({ confirmDraft: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { ai: { feedback: { confirmDraft } } },
}));
afterEach(() => {
	vi.restoreAllMocks();
	confirmDraft.mockReset();
});

describe("human draft verdicts independent of conversation history", () => {
	it.each([
		[true, "accepted"],
		[false, "rejected"],
	] as const)(
		"records %s without a conversation",
		async (accepted, verdict) => {
			const { result } = renderHook(() =>
				useConfirmChangesVerdict({
					surface: "document",
					projectId: "example-project",
				}),
			);
			await result.current()(accepted);
			expect(confirmDraft).toHaveBeenCalledWith({
				surface: "document",
				projectId: "example-project",
				verdict,
				draftId: expect.any(String),
			});
		},
	);
	it("records at most one verdict per binding, with a distinct id for a second offer", async () => {
		const { result } = renderHook(() =>
			useConfirmChangesVerdict({ surface: "prompt-enhancer" }),
		);
		const first = result.current();
		await first(true);
		await first(false);
		const second = result.current();
		await second(false);
		expect(confirmDraft).toHaveBeenCalledTimes(2);
		expect(confirmDraft.mock.calls[0][0].draftId).not.toBe(
			confirmDraft.mock.calls[1][0].draftId,
		);
	});
	it("keeps card 1 and its captured review controls bound through loading flips, then records card 2 separately", async () => {
		const captured = new Map<string, DraftVerdictRecorder>();
		function Card({
			name,
			record,
		}: {
			name: string;
			record: DraftVerdictRecorder;
		}) {
			useConfirmChangesVerdictCard(record);
			return (
				<button
					type="button"
					onClick={() => void record(name === "two")}
				>
					{name}
				</button>
			);
		}
		function Surface({
			loading,
			second,
		}: {
			loading: boolean;
			second: boolean;
		}) {
			const factory = useConfirmChangesVerdict({
				surface: "document",
				projectId: "example-project",
			});
			const first = factory();
			if (!captured.has("one")) {
				captured.set("one", first);
			}
			return (
				<div aria-busy={loading}>
					<Card key="one" name="one" record={first} />
					{second && <Card key="two" name="two" record={factory()} />}
				</div>
			);
		}
		const uuid = vi.spyOn(crypto, "randomUUID");
		const { rerender } = render(<Surface loading={false} second={false} />);
		rerender(<Surface loading second={false} />);
		rerender(<Surface loading={false} second />);
		// Offering and re-rendering cards allocates no random identifiers during render.
		expect(uuid).not.toHaveBeenCalled();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "one" }));
		});
		await captured.get("one")?.(true); // The earlier review-bar callback is the same draft.
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "two" }));
		});
		expect(confirmDraft).toHaveBeenCalledTimes(2);
		expect(confirmDraft.mock.calls.map(([input]) => input.verdict)).toEqual(
			["rejected", "accepted"],
		);
		expect(confirmDraft.mock.calls[0][0].draftId).not.toBe(
			confirmDraft.mock.calls[1][0].draftId,
		);
	});
	it("swallows and warns on failures", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		confirmDraft.mockRejectedValueOnce(new Error("example failure"));
		const { result } = renderHook(() =>
			useConfirmChangesVerdict({ surface: "document-generator" }),
		);
		await expect(result.current()(true)).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledOnce();
	});
});

it.each([undefined, "malformed", `msg_1793200000000_${"a".repeat(32)}`])(
	"uses server card identity or a fallback: %s",
	async (id) => {
		const { result } = renderHook(() => {
			const factory = useConfirmChangesVerdict({
				surface: "prompt-enhancer",
			});
			const record = factory();
			useConfirmChangesVerdictCard(record, id);
			return record;
		});
		await result.current(true);
		const actual = confirmDraft.mock.calls[0][0].draftId;
		if (id?.startsWith("msg_")) {
			expect(actual).toBe(id);
		} else {
			expect(actual).toMatch(/^[0-9a-f-]{36}$/);
		}
	},
);
