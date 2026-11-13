import {
	act,
	addPeer,
	BODY_A,
	BODY_B,
	beforeEach,
	clickSave,
	describe,
	diffPartialText,
	editorBody,
	expect,
	fireEvent,
	harness,
	hashOf,
	it,
	mainEditor,
	nudge,
	offerBackCalls,
	openTab,
	persistRoom,
	ROOM_PEER_AWARENESS_FIELD,
	ROOM_SAVE_AWARENESS_FIELD,
	rawTextarea,
	readConvergenceClaim,
	readRoomStamp,
	rerender,
	room,
	SAVE_FAILED_TOAST,
	saveButton,
	saveCalls,
	savedStamp,
	server,
	settle,
	showsSavedBody,
	type Tab,
	toast,
	toggleRawView,
	type,
	useCopilotReadable,
	userEvent,
	vi,
	waitFor,
	within,
} from "./DocumentEditor.room-convergence.harness";

describe("what the convergence listens to (Fizzy #2946)", () => {
	it("a colleague's cursor moving does not render the editor again; a change in what the convergence reads does", async () => {
		await persistRoom(BODY_A, savedStamp());
		await openTab("tab", { clientId: 50 });
		const colleague = (extra: Record<string, unknown>) => ({
			[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
			...extra,
		});
		act(() => {
			addPeer(900, colleague({ cursor: { anchor: 1, head: 1 } }));
		});
		await settle(100);
		const renders = () => vi.mocked(useCopilotReadable).mock.calls.length;
		const settled = renders();

		for (let at = 2; at < 12; at += 1) {
			act(() => {
				addPeer(900, colleague({ cursor: { anchor: at, head: at } }));
			});
		}
		await settle(100);
		expect(renders()).toBe(settled);

		act(() => {
			addPeer(
				900,
				colleague({
					cursor: { anchor: 11, head: 11 },
					[ROOM_SAVE_AWARENESS_FIELD]: {
						version: 7,
						contentHash: hashOf(BODY_A),
					},
				}),
			);
		});
		await settle(100);
		expect(renders()).toBeGreaterThan(settled);
	});
});

describe("one save at a time, when things go wrong (Fizzy #2946)", () => {
	beforeEach(() => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
	});

	/** The autosave, ten seconds into the pause after an edit, held. */
	async function autosaveInFlight(tab: Tab, text: string) {
		await type(tab, text);
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
	}

	async function answerHeld() {
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	it("a save asked for while the one in flight fails is not sent; a later save still goes", async () => {
		const tab = await openTab("solo");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		server.failNext = new Error("Service unavailable");
		await autosaveInFlight(tab, " First edit.");

		// The save before an assistant turn, asked for meanwhile.
		await type(tab, " Second edit.");
		harness.chatLoading = true;
		rerender(tab);
		await settle(50);
		expect(saveCalls).toHaveLength(1);

		server.holdAnswers = false;
		await answerHeld();
		// In the reader's words, never the server's (Fizzy #2946).
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"failed",
				SAVE_FAILED_TOAST,
			);
		});
		expect(toast.error).not.toHaveBeenCalledWith(
			expect.stringContaining("Service unavailable"),
		);
		await settle(50);
		expect(saveCalls).toHaveLength(1);
		expect(server.version).toBe(7);

		harness.chatLoading = false;
		rerender(tab);
		await type(tab, " Third edit.");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		vi.useRealTimers();
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		expect(saveCalls[1]?.content).toContain("Third edit.");
		await waitFor(() => {
			expect(server.content).toContain("Third edit.");
		});
	});

	it("a Save & Close asked for during the autosave leaves the page only on the answer of its own save, reported as a manual save", async () => {
		const user = userEvent.setup({
			advanceTimers: (ms) => vi.advanceTimersByTime(ms),
		});
		const tab = await openTab("solo");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " First edit.");
		// The menu was open when the autosave went out.
		await user.click(
			within(tab.saveSlot).getByRole("button", {
				name: "More save options",
			}),
		);
		const saveAndClose = await waitFor(() =>
			window.document.body.querySelector<HTMLElement>(
				'[role="menuitem"]',
			),
		);
		expect(saveAndClose?.textContent).toContain("Save & Close");
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});

		await type(tab, " Second edit.");
		await user.click(saveAndClose as HTMLElement);
		await settle(50);
		expect(saveCalls).toHaveLength(1);

		// The autosave answers: nothing is said, and the page stays.
		await answerHeld();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		expect(harness.routerPush).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
		expect(saveCalls[1]?.content).toContain("Second edit.");
		expect(saveCalls[1]).toMatchObject({ expectedVersion: 8 });

		// Its own save answers: reported as a manual save, then the page goes.
		server.holdAnswers = false;
		await answerHeld();
		await waitFor(() => {
			expect(harness.routerPush).toHaveBeenCalledTimes(1);
		});
		vi.useRealTimers();
		expect(harness.routerPush).toHaveBeenCalledWith(
			"/app/example-org/projects/proj-1",
		);
		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalledWith(
			expect.stringMatching(/^Document saved/),
		);
	});

	it("an assistant proposal accepted during the autosave is saved after that answer, from the base it produced: the single-user editor keeps saving", async () => {
		const tab = await openTab("solo");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await autosaveInFlight(tab, " First edit.");

		// The assistant proposes a body, and the person accepts it while the
		// autosave is still in flight.
		const proposed = `${editorBody(tab)}\n\nAn accepted paragraph.`;
		harness.agentState = { document: proposed };
		rerender(tab);
		await settle(20);
		const respond = vi.fn();
		let card: any;
		await act(async () => {
			card = tab.actions
				.get("confirm_changes")
				?.renderAndWaitForResponse({
					args: {},
					respond,
					status: "executing",
				});
			await Promise.resolve();
		});
		await settle(50);
		await act(async () => {
			card?.props.onConfirm();
		});
		await settle(50);
		expect(respond).toHaveBeenCalledWith({ accepted: true });
		expect(saveCalls).toHaveLength(1);

		server.holdAnswers = false;
		await answerHeld();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		vi.useRealTimers();
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 8,
			expectedContentHash: hashOf(String(saveCalls[0]?.content)),
		});
		expect(saveCalls[1]?.content).toContain("An accepted paragraph.");
		await waitFor(() => {
			expect(server.content).toContain("An accepted paragraph.");
		});
		expect(server.version).toBe(9);
		// One report, for the accept's own save.
		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalledWith(
			"Changes applied — saved as v9",
		);
		expect(toast.error).not.toHaveBeenCalled();
	});
});

describe("a regeneration's review in the single-user editor, with the room flag on (Fizzy #2946)", () => {
	const BODY_C =
		"## Scope\n\nPhase one, written after the review opened.\n\n## Pricing\n\nA fixed fee.";

	/**
	 * A run this editor started ends on BODY_B at version 8; its review is
	 * open. `beforeRun` acts on the tab before the run starts.
	 */
	async function soloReview(
		beforeRun?: (tab: Tab) => Promise<void>,
	): Promise<Tab> {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		const tab = await openTab("solo");
		await beforeRun?.(tab);
		await act(async () => {
			tab.actions.get("regenerate_document")?.renderAndWaitForResponse({
				args: { prompt: "Rewrite it" },
				respond: vi.fn(),
				status: "executing",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		server.status = "GENERATING";
		await nudge(tab);
		server.content = BODY_B;
		server.version = 8;
		server.status = "COMPLETE";
		await nudge(tab);
		await waitFor(() => {
			expect(
				tab.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
			expect(editorBody(tab)).toContain("rewritten by the run");
		});
		return tab;
	}

	it("a review a newer saved body superseded closes onto that body, which the next save names as its base", async () => {
		const tab = await soloReview();

		server.content = BODY_C;
		server.version = 9;
		await nudge(tab);
		await waitFor(() => {
			expect(
				tab.view?.queryByTestId("regeneration-confirm-modal"),
			).toBeNull();
		});
		expect(toast.info).toHaveBeenCalledWith("reviewSuperseded");
		await waitFor(() => {
			expect(editorBody(tab)).toContain(
				"written after the review opened",
			);
		});
		expect(editorBody(tab)).not.toContain("rewritten by the run");
		// The review winds down a second after it closes.
		await settle(1200);
		expect(saveButton(tab)).toBeDisabled();

		await type(tab, " Typed after.");
		await clickSave(tab);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 9,
			expectedContentHash: hashOf(BODY_C),
		});
		expect(saveCalls[0]?.content).toContain(
			"written after the review opened",
		);
		expect(saveCalls[0]?.content).toContain("Typed after.");
		await waitFor(() => {
			expect(server.content).toContain("Typed after.");
		});
	});

	async function clickSoloReject(tab: Tab) {
		await act(async () => {
			within(
				tab.view?.getByTestId(
					"regeneration-confirm-modal",
				) as HTMLElement,
			)
				.getByRole("button", { name: "Reject" })
				.click();
			await new Promise((resolve) => setTimeout(resolve, 900));
		});
	}

	it("ignores the view shortcut while the Reject is unanswered, keeping the raw view's edits", async () => {
		server.beforeRun = { content: BODY_A, version: 7 };
		// Edited in the raw view before the run: the views do not switch,
		// and the raw view takes no input, while it writes or is reviewed.
		const tab = await soloReview(async (solo) => {
			await toggleRawView();
			const edited = `${rawTextarea(solo).value}\n\nEdited in the raw view.`;
			await act(async () => {
				fireEvent.change(rawTextarea(solo), {
					target: { value: edited },
				});
			});
		});
		server.holdAnswers = true;
		await clickSoloReject(tab);
		await settle(1200);
		expect(server.held).toHaveLength(1);

		await toggleRawView();
		expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
		expect(editorBody(tab)).not.toContain("Edited in the raw view.");

		await act(async () => {
			server.held.shift()?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(toast.info).toHaveBeenCalledWith("regenerationRejected");
		});
		await settle(50);
		expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
		expect(saveButton(tab)).not.toBeDisabled();
	});

	it("keeps the editor read-only while the Reject is unanswered", async () => {
		server.beforeRun = { content: BODY_A, version: 7 };
		const tab = await soloReview();
		server.holdAnswers = true;

		await clickSoloReject(tab);
		await settle(1200);
		expect(server.held).toHaveLength(1);
		expect(mainEditor(tab)?.isEditable).toBe(false);
		expect(saveButton(tab)).toBeDisabled();

		await act(async () => {
			server.held.shift()?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(true);
		});
		expect(toast.info).toHaveBeenCalledWith("regenerationRejected");
	});

	it("offers back text typed after the Reject went before a stale refusal brings in the newer saved body", async () => {
		const tab = await soloReview();
		server.rejectError = Object.assign(new Error("stale"), {
			code: "CONFLICT",
			data: { code: "REJECT_REVIEW_STALE" },
		});
		server.holdAnswers = true;
		await clickSoloReject(tab);
		await settle(1200);
		// The editor is read-only meanwhile; typing that still reached it
		// is not dropped.
		await act(async () => {
			mainEditor(tab)?.setEditable(true);
		});
		await type(tab, " Typed while the Reject was out.");
		server.content = BODY_C;
		server.version = 9;

		await act(async () => {
			server.held.shift()?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("rejectReviewStale");
		});
		await waitFor(() => {
			expect(editorBody(tab)).toContain(
				"written after the review opened",
			);
		});
		expect(offerBackCalls()).toHaveLength(1);
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		const options = offerBackCalls()[0]?.[1] as {
			action: { onClick: () => void };
		};
		options.action.onClick();
		expect(writeText).toHaveBeenCalledWith(
			expect.stringContaining("Typed while the Reject was out."),
		);
		expect(saveCalls).toEqual([]);
	});

	it("a Reject the server rewinds to a body other than the one the editor remembered ends on the server's body, saved", async () => {
		server.beforeRun = { content: BODY_C, version: 7 };
		const tab = await soloReview();

		await act(async () => {
			within(
				tab.view?.getByTestId(
					"regeneration-confirm-modal",
				) as HTMLElement,
			)
				.getByRole("button", { name: "Reject" })
				.click();
			await new Promise((resolve) => setTimeout(resolve, 900));
		});
		await waitFor(() => {
			expect(toast.info).toHaveBeenCalledWith("regenerationRejected");
		});
		await waitFor(() => {
			expect(editorBody(tab)).toContain(
				"written after the review opened",
			);
		});
		// The rewind is the choice's own doing, not a newer write.
		expect(toast.info).not.toHaveBeenCalledWith("reviewSuperseded");
		expect(editorBody(tab)).not.toContain("Phase one, then two.");
		await settle(1200);
		expect(saveButton(tab)).toBeDisabled();

		await type(tab, " Typed after.");
		await clickSave(tab);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_C),
		});
		expect(saveCalls[0]?.content).toContain(
			"written after the review opened",
		);
	});
});

describe("with the room flag off (Fizzy #2946)", () => {
	beforeEach(() => {
		harness.flags = { DOCUMENT_ROOM_CONVERGENCE: false };
	});

	/**
	 * A proposal the room holds that nobody reviews is held and rejected only
	 * with the room's stamps: with the flag off the editor saves as it always
	 * did, the flag being the way back to that.
	 */
	it("leaves a proposal the room holds to the editor as before: nothing holds, and a save goes", async () => {
		const PROPOSED = "A paragraph the assistant proposes.";
		await persistRoom(BODY_A, null);
		const tab = await openTab("tab");
		await type(tab, " Typed here.");

		await act(async () => {
			void persistRoom(
				diffPartialText(BODY_A, `${BODY_A}\n\n${PROPOSED}`, true),
				null,
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(100);
		expect(editorBody(tab)).toContain(PROPOSED);
		expect(mainEditor(tab)?.isEditable).toBe(true);
		expect(within(tab.syncSlot).queryByText("proposalOrphaned")).toBeNull();
		expect(saveButton(tab)).not.toHaveAccessibleDescription(
			"saveBlocked.proposalOrphaned",
		);

		await type(tab, " More typing.");
		await clickSave(tab);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(toast.info).not.toHaveBeenCalledWith(
			"saveBlocked.proposalOrphaned",
		);
		await settle(300);
		expect(editorBody(tab)).toContain(PROPOSED);
	});

	it("sends nothing when the page is left within the app with typing unsaved", async () => {
		await persistRoom(BODY_A, null);
		const tab = await openTab("tab");
		await type(tab, " Typed before leaving.");

		await act(async () => {
			tab.view?.unmount();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(50);

		expect(saveCalls).toHaveLength(0);
	});

	it("seeds, saves and leaves the room as after the run-state fix: no stamp, no base, no convergence", async () => {
		await persistRoom(BODY_A, { version: 7, contentHash: hashOf(BODY_A) });
		server.content = BODY_B;
		server.version = 8;
		const tab = await openTab("tab");

		// The first sync seeds the room with the loaded body, as before.
		await waitFor(() => {
			expect(editorBody(tab)).toContain("rewritten by the run");
		});
		expect(showsSavedBody(tab)).toBe(false);

		await type(tab, " An edit.");
		await clickSave(tab);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).not.toHaveProperty("expectedVersion");
		expect(saveCalls[0]).not.toHaveProperty("expectedContentHash");
		expect(tab.awareness.own[ROOM_SAVE_AWARENESS_FIELD]).toBeUndefined();
		expect(tab.awareness.own[ROOM_PEER_AWARENESS_FIELD]).toBeUndefined();
		await settle(200);
		expect(readRoomStamp(room.doc)).toEqual({
			version: 7,
			contentHash: hashOf(BODY_A),
		});
		expect(readConvergenceClaim(room.doc)).toBeNull();
	});
});
