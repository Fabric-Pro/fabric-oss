import {
	act,
	BODY_A,
	BODY_B,
	beforeEach,
	CLOSED_ACCEPT_RECORD,
	clickSave,
	describe,
	type Editor,
	editorBody,
	expect,
	FAILED_ACCEPT_RECORD,
	FAILED_OFFERED_ACCEPT_RECORD,
	Fragment,
	fireEvent,
	fromMarkdown,
	harness,
	hashOf,
	it,
	mainEditor,
	nudge,
	offerBackCalls,
	openTab,
	persistRoom,
	rawTextarea,
	readRoomStamp,
	render,
	rerender,
	room,
	roomBody,
	SAVE_FAILED_TOAST,
	SAVED_ACCEPT_RECORD,
	saveButton,
	saveCalls,
	savedStamp,
	server,
	settle,
	type Tab,
	toast,
	toggleRawView,
	type,
	UNDONE_ACCEPT_RECORD,
	UNSAVED_ACCEPT_RECORD,
	undo,
	userEvent,
	vi,
	waitFor,
	within,
} from "./DocumentEditor.room-convergence.harness";

describe("an assistant proposal accepted in a room (Fizzy #2946)", () => {
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

	/** The assistant proposes `proposed`, and the person accepts it. */
	async function acceptProposal(tab: Tab, proposed: string) {
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
		return respond;
	}

	it("during the autosave, is saved after that answer, from the room's stamp the answer produced", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await autosaveInFlight(tab, " First edit.");
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});

		const respond = await acceptProposal(
			tab,
			`${editorBody(tab)}\n\nAn accepted paragraph.`,
		);
		expect(respond).toHaveBeenCalledWith({ accepted: true });
		expect(saveCalls).toHaveLength(1);

		server.holdAnswers = false;
		await answerHeld();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		vi.useRealTimers();
		const firstAnswer = {
			version: 8,
			contentHash: hashOf(String(saveCalls[0]?.content)),
		};
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: firstAnswer.version,
			expectedContentHash: firstAnswer.contentHash,
		});
		expect(saveCalls[1]?.content).toContain("An accepted paragraph.");
		await waitFor(() => {
			expect(server.content).toContain("An accepted paragraph.");
		});
		expect(server.version).toBe(9);
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		// One report, for the accept's own save; no conflict.
		expect(toast.success).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalledWith(
			"Changes applied — saved as v9",
		);
		expect(toast.error).not.toHaveBeenCalled();
		expect(offerBackCalls()).toHaveLength(0);
	});

	it("whose save has landed, undone with the editor's undo, is saved back to the body before it", async () => {
		harness.autosave.delayMs = 300;
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await settle(200);
		await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
		await waitFor(() => {
			expect(server.content).toContain("An accepted paragraph.");
		});
		await settle(100);

		await undo(tab);
		expect(editorBody(tab)).not.toContain("An accepted paragraph.");
		await waitFor(
			() => {
				expect(saveCalls).toHaveLength(2);
			},
			{ timeout: 3000 },
		);
		expect(server.content).not.toContain("An accepted paragraph.");
		expect(server.content).toContain("Phase one, then two.");
	});

	it("whose save fails stays unsaved in the editor that accepted it, which saves it later", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		// The dirty check the editor scheduled while it opened has run, so
		// only the accept itself can say the accepted text is unsaved.
		await settle(200);
		server.failNext = new Error("Service unavailable");

		const respond = await acceptProposal(
			tab,
			`${BODY_A}\n\nAn accepted paragraph.`,
		);
		expect(respond).toHaveBeenCalledWith({ accepted: true });
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		await settle(300);
		expect(server.content).toBe(BODY_A);
		expect(editorBody(tab)).toContain("An accepted paragraph.");
		await waitFor(
			() => {
				expect(saveButton(tab)).toHaveAccessibleName("Save document");
				expect(saveButton(tab)).not.toBeDisabled();
			},
			{ timeout: 3000 },
		);

		await clickSave(tab);
		await waitFor(() => {
			expect(server.content).toContain("An accepted paragraph.");
		});
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
	});

	it("is saved once when the assistant goes on to its next turn while that save is in flight", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await settle(200);
		server.holdAnswers = true;

		await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
		await waitFor(() => {
			expect(server.held).toHaveLength(1);
		});
		// The assistant answers the accept and starts its next turn.
		harness.chatLoading = true;
		rerender(tab);
		await settle(50);
		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(300);

		expect(saveCalls).toHaveLength(1);
		expect(server.content).toContain("An accepted paragraph.");
	});

	it("whose save fails after the editor showed that save's optimistic answer stays unsaved past the autosave delay, and is saved on leaving the page", async () => {
		harness.autosave.delayMs = 300;
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await settle(200);
		server.failNext = new Error("Service unavailable");
		server.holdAnswers = true;

		await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
		await waitFor(() => {
			expect(server.held).toHaveLength(1);
		});
		// The editor renders the save's optimistic answer before the failure
		// arrives.
		await settle(100);
		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(server.content).toBe(BODY_A);
		await settle(500);
		expect(saveButton(tab)).toHaveAccessibleName("Save document");
		expect(saveCalls).toHaveLength(1);

		await act(async () => {
			tab.view?.unmount();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(server.content).toContain("An accepted paragraph.");
		});
	});

	it("in a room without a stamp yet, is not sent: it stays in the editor, unsaved, and the editor says it is updating to the latest version", async () => {
		// A room from before the stamp, still being looked at: it takes its
		// stamp only after the observation gap.
		await persistRoom(BODY_A, null);
		harness.timings.observationGapMs = 60_000;
		const tab = await openTab("tab");
		expect(readRoomStamp(room.doc)).toBeNull();

		const respond = await acceptProposal(
			tab,
			`${BODY_A}\n\nAn accepted paragraph.`,
		);
		await settle(50);

		expect(readRoomStamp(room.doc)).toBeNull();
		expect(toast.info).toHaveBeenCalledWith("saveBlocked.updatingToLatest");
		expect(respond).toHaveBeenCalledWith({ accepted: true });
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_A);
		expect(editorBody(tab)).toContain("An accepted paragraph.");
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
		// The chat records it as kept in the editor, never as applied.
		expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
		expect(harness.recordOutcome).toHaveBeenCalledWith(
			UNSAVED_ACCEPT_RECORD,
		);
	});

	/**
	 * The chat is answered at once, and the assistant acknowledges the
	 * accept from that answer; what the chat records of the accepted text
	 * waits for its save to be answered, and is recorded once.
	 */
	describe("what the chat records (Fizzy #2946)", () => {
		it("records nothing until the save is answered, then a refused save once, as a failure", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			server.failNext = new Error("Service unavailable");
			server.holdAnswers = true;

			const respond = await acceptProposal(
				tab,
				`${BODY_A}\n\nAn accepted paragraph.`,
			);
			await waitFor(() => {
				expect(server.held).toHaveLength(1);
			});
			expect(respond).toHaveBeenCalledTimes(1);
			expect(respond).toHaveBeenCalledWith({ accepted: true });
			await settle(100);
			expect(harness.recordOutcome).not.toHaveBeenCalled();

			server.holdAnswers = false;
			await answerHeld();
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				FAILED_ACCEPT_RECORD,
			);
			await settle(300);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			expect(server.content).toBe(BODY_A);
			expect(respond).toHaveBeenCalledTimes(1);
		});

		it("records a save that lands once, as applied, only once it is answered", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			server.holdAnswers = true;

			await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
			await waitFor(() => {
				expect(server.held).toHaveLength(1);
			});
			await settle(100);
			expect(harness.recordOutcome).not.toHaveBeenCalled();

			server.holdAnswers = false;
			await answerHeld();
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				SAVED_ACCEPT_RECORD,
			);
			await settle(300);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			expect(server.content).toContain("An accepted paragraph.");
		});

		it("records an accept that waited for an autosave that failed, and so was never sent, once, as kept unsaved in the editor", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			vi.useFakeTimers({
				toFake: ["setTimeout", "clearTimeout"],
				shouldAdvanceTime: true,
			});
			server.failNext = new Error("Service unavailable");
			await autosaveInFlight(tab, " First edit.");

			await acceptProposal(
				tab,
				`${editorBody(tab)}\n\nAn accepted paragraph.`,
			);
			expect(harness.recordOutcome).not.toHaveBeenCalled();

			server.holdAnswers = false;
			await answerHeld();
			vi.useRealTimers();
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				UNSAVED_ACCEPT_RECORD,
			);
			await settle(300);
			expect(saveCalls).toHaveLength(1);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			expect(editorBody(tab)).toContain("An accepted paragraph.");
		});

		it("records a save refused after the page was left once, as a failure whose text was offered to copy", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			server.failNext = new Error("Service unavailable");
			server.holdAnswers = true;

			await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
			await waitFor(() => {
				expect(server.held).toHaveLength(1);
			});
			// Left within the app while the save is in flight.
			await act(async () => {
				tab.view?.unmount();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(harness.recordOutcome).not.toHaveBeenCalled();

			server.holdAnswers = false;
			await answerHeld();
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				FAILED_OFFERED_ACCEPT_RECORD,
			);
			expect(toast.error).toHaveBeenCalledWith(
				"leaveSaveFailed",
				expect.anything(),
			);
			await settle(100);
			expect(saveCalls).toHaveLength(1);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
		});

		/**
		 * An accept waiting behind an autosave when the page is left: the
		 * save on leaving carries its text, and its answer is what the accept
		 * records — never nothing, and never "in the editor".
		 */
		describe("when the page is left while it waits behind an autosave", () => {
			async function leaveWithinApp(tab: Tab) {
				await act(async () => {
					tab.view?.unmount();
					await new Promise((resolve) => setTimeout(resolve, 0));
				});
			}

			/** Answers the held autosave, and lets what waited for it go. */
			async function answerAutosave() {
				server.holdAnswers = false;
				await answerHeld();
				await act(async () => {
					await vi.advanceTimersByTimeAsync(50);
				});
				vi.useRealTimers();
			}

			/**
			 * Typing, its autosave held, and a proposal accepted behind it.
			 * Returns the editor's body from just before the proposal.
			 */
			async function acceptBehindAutosave(tab: Tab): Promise<string> {
				vi.useFakeTimers({
					toFake: ["setTimeout", "clearTimeout"],
					shouldAdvanceTime: true,
				});
				await autosaveInFlight(tab, " First edit.");
				const before = editorBody(tab);
				await acceptProposal(
					tab,
					`${before}\n\nAn accepted paragraph.`,
				);
				expect(saveCalls).toHaveLength(1);
				return before;
			}

			async function acceptBehindAutosaveThenLeave(tab: Tab) {
				await acceptBehindAutosave(tab);
				await leaveWithinApp(tab);
				expect(harness.recordOutcome).not.toHaveBeenCalled();
			}

			/** The person edits the editor back to `markdown`, as by undo. */
			async function editBackTo(tab: Tab, markdown: string) {
				await act(async () => {
					mainEditor(tab)?.commands.setContent(
						fromMarkdown(markdown),
					);
				});
				await settle(220);
				expect(editorBody(tab).trim()).toBe(markdown.trim());
			}

			/** The confirm resolves, and the assistant proposes again. */
			async function acceptAgain(tab: Tab): Promise<string> {
				const first = editorBody(tab);
				await act(async () => {
					tab.actions
						.get("confirm_changes")
						?.renderAndWaitForResponse({
							args: {},
							respond: vi.fn(),
							status: "complete",
						});
				});
				await acceptProposal(
					tab,
					`${first}\n\nA second accepted paragraph.`,
				);
				expect(saveCalls).toHaveLength(1);
				return first;
			}

			function savesCarryingTheAccept() {
				return saveCalls.filter((call) =>
					String(call.content).includes("An accepted paragraph."),
				);
			}

			it("undone back to the saved body before leaving, is never saved: the server ends on that body, and the accept records once that it was undone", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await acceptBehindAutosave(tab);
				await editBackTo(tab, BODY_A);
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				await settle(100);
				expect(savesCarryingTheAccept()).toEqual([]);
				expect(server.content).toContain("Phase one, then two.");
				expect(server.content).not.toContain("First edit.");
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					UNDONE_ACCEPT_RECORD,
				);
			});

			it("undone back to the body it was accepted over before leaving, is never saved, and records once that it was undone", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				const before = await acceptBehindAutosave(tab);
				await editBackTo(tab, before);
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				await settle(100);
				expect(savesCarryingTheAccept()).toEqual([]);
				expect(server.content).toContain("First edit.");
				expect(server.content).not.toContain("An accepted paragraph.");
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					UNDONE_ACCEPT_RECORD,
				);
			});

			it("typed on after the accept before leaving, goes in the save on leaving with that typing, and records its answer once", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await acceptBehindAutosave(tab);
				await type(tab, " Typed after the accept.");
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).toContain(
					"An accepted paragraph.",
				);
				expect(saveCalls[1]?.content).toContain(
					"Typed after the accept.",
				);
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				});
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					SAVED_ACCEPT_RECORD,
				);
				expect(server.content).toContain("Typed after the accept.");
			});

			it("whose own save is in flight, undone with the editor's undo before leaving: the server ends on the body before it, and it records once that it was undone", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await settle(200);
				server.holdAnswers = true;
				await acceptProposal(
					tab,
					`${BODY_A}\n\nAn accepted paragraph.`,
				);
				await waitFor(() => {
					expect(server.held).toHaveLength(1);
				});
				await undo(tab);
				expect(editorBody(tab)).not.toContain("An accepted paragraph.");
				await leaveWithinApp(tab);

				server.holdAnswers = false;
				await answerHeld();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				await settle(100);
				expect(saveCalls[1]?.content).not.toContain(
					"An accepted paragraph.",
				);
				expect(server.content).not.toContain("An accepted paragraph.");
				expect(server.content).toContain("Phase one, then two.");
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					UNDONE_ACCEPT_RECORD,
				);
			});

			it("whose own save is in flight, undone back to the saved body before leaving: the server ends on that body, and it records once that it was undone, never that it was applied", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await settle(200);
				server.holdAnswers = true;
				await acceptProposal(
					tab,
					`${BODY_A}\n\nAn accepted paragraph.`,
				);
				await waitFor(() => {
					expect(server.held).toHaveLength(1);
				});
				await editBackTo(tab, BODY_A);
				await leaveWithinApp(tab);

				server.holdAnswers = false;
				await answerHeld();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				await settle(100);
				expect(saveCalls[1]?.content).not.toContain(
					"An accepted paragraph.",
				);
				expect(server.content).not.toContain("An accepted paragraph.");
				expect(server.content).toContain("Phase one, then two.");
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					UNDONE_ACCEPT_RECORD,
				);
			});

			it("of two accepts waiting behind an autosave, the second undone back to the first's text before leaving: the first records its answer and the second that it was undone, under their own keys", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await acceptBehindAutosave(tab);
				const first = await acceptAgain(tab);
				await editBackTo(tab, first);
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).toContain(
					"An accepted paragraph.",
				);
				expect(saveCalls[1]?.content).not.toContain(
					"A second accepted paragraph.",
				);
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(2);
				});
				expect(harness.recordOutcome).toHaveBeenNthCalledWith(
					1,
					UNDONE_ACCEPT_RECORD,
				);
				expect(harness.recordOutcome).toHaveBeenNthCalledWith(
					2,
					SAVED_ACCEPT_RECORD,
				);
				const [undoneKey, savedKey] =
					harness.recordOutcome.mock.calls.map(
						(call) => call[0].operationKey,
					);
				expect(undoneKey).not.toBe(savedKey);
				expect(server.content).toContain("An accepted paragraph.");
				expect(server.content).not.toContain(
					"A second accepted paragraph.",
				);
			});

			it("that put the saved body back is carried by the save on leaving, and records that it was applied", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				vi.useFakeTimers({
					toFake: ["setTimeout", "clearTimeout"],
					shouldAdvanceTime: true,
				});
				await autosaveInFlight(tab, " First edit.");
				// The proposal is the saved body: it takes the typing back out.
				await acceptProposal(tab, BODY_A);
				expect(editorBody(tab).trim()).toBe(BODY_A.trim());
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).not.toContain("First edit.");
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				});
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					SAVED_ACCEPT_RECORD,
				);
				expect(server.content).not.toContain("First edit.");
			});

			it("in the single-user editor, of two accepts waiting behind an autosave, the second undone back to the first's text before it was closed: the server ends on the first's text, the first records its answer and the second that it was undone", async () => {
				vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
				const tab = await openTab("solo");
				await settle(200);
				await acceptBehindAutosave(tab);
				const first = await acceptAgain(tab);
				await editBackTo(tab, first);
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).not.toContain(
					"A second accepted paragraph.",
				);
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(2);
				});
				expect(harness.recordOutcome).toHaveBeenNthCalledWith(
					1,
					UNDONE_ACCEPT_RECORD,
				);
				expect(harness.recordOutcome).toHaveBeenNthCalledWith(
					2,
					SAVED_ACCEPT_RECORD,
				);
				expect(server.content).toContain("An accepted paragraph.");
				expect(server.content).not.toContain(
					"A second accepted paragraph.",
				);
			});

			it("in the single-user editor, undone back to the saved body — past the edit its autosave carries — before it was closed: the server ends on the saved body, and it records once that it was undone", async () => {
				vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
				const tab = await openTab("solo");
				await settle(200);
				await acceptBehindAutosave(tab);
				await editBackTo(tab, BODY_A);
				await leaveWithinApp(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				await settle(100);
				expect(savesCarryingTheAccept()).toEqual([]);
				expect(server.content).not.toContain("First edit.");
				expect(server.content).toContain("Phase one, then two.");
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					UNDONE_ACCEPT_RECORD,
				);
			});

			it("in a room with the room flag off, leaves an accept's waiting save to the room on leaving: the close handling outside a room does not run there", async () => {
				harness.flags = {};
				const tab = await openTab("tab");
				await settle(200);
				const before = await acceptBehindAutosave(tab);
				await editBackTo(tab, before);
				await leaveWithinApp(tab);

				await answerAutosave();
				// The waiting save goes as it always has in such a room; the
				// close handling would have dropped it.
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).toContain(
					"An accepted paragraph.",
				);
			});

			it("in the single-user editor, undone back to the body it was accepted over before it was closed, is never saved, and records once that it was undone", async () => {
				vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
				const tab = await openTab("solo");
				await settle(200);
				const before = await acceptBehindAutosave(tab);
				await editBackTo(tab, before);
				await leaveWithinApp(tab);

				await answerAutosave();
				await settle(100);
				expect(saveCalls).toHaveLength(1);
				expect(savesCarryingTheAccept()).toEqual([]);
				expect(server.content).not.toContain("An accepted paragraph.");
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					UNDONE_ACCEPT_RECORD,
				);
			});

			it("records the save on leaving once, as applied, when it lands", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await acceptBehindAutosaveThenLeave(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).toContain(
					"An accepted paragraph.",
				);
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				});
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					SAVED_ACCEPT_RECORD,
				);
				expect(server.content).toContain("An accepted paragraph.");
				await settle(100);
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});

			it("records the save on leaving once, as a failure whose text was offered to copy, when it is refused", async () => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await acceptBehindAutosaveThenLeave(tab);
				// The autosave lands; the save on leaving is refused.
				server.failNext = new Error("Service unavailable");

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				});
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					FAILED_OFFERED_ACCEPT_RECORD,
				);
				expect(toast.error).toHaveBeenCalledWith(
					"leaveSaveFailed",
					expect.anything(),
				);
				await settle(100);
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});

			it("in the single-user editor, records an autosave refused after it was closed once, as not saved — not as still in the editor", async () => {
				vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
				const tab = await openTab("solo");
				await settle(200);
				server.failNext = new Error("Service unavailable");
				await acceptBehindAutosaveThenLeave(tab);

				await answerAutosave();
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				});
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					CLOSED_ACCEPT_RECORD,
				);
				await settle(100);
				expect(saveCalls).toHaveLength(1);
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});

			it("in the single-user editor, records its own save refused after it was closed once, as not saved — not as still in the editor", async () => {
				vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
				const tab = await openTab("solo");
				await settle(200);
				await acceptBehindAutosaveThenLeave(tab);
				// The autosave lands; the accept's own save then goes, and is
				// refused.
				server.failNext = new Error("Service unavailable");

				await answerAutosave();
				await waitFor(() => {
					expect(saveCalls).toHaveLength(2);
				});
				expect(saveCalls[1]?.content).toContain(
					"An accepted paragraph.",
				);
				await waitFor(() => {
					expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
				});
				expect(harness.recordOutcome).toHaveBeenCalledWith(
					CLOSED_ACCEPT_RECORD,
				);
				await settle(100);
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
		});

		it("records an accept that a later accept displaced while both waited behind an autosave from the later one's answer, once each", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			vi.useFakeTimers({
				toFake: ["setTimeout", "clearTimeout"],
				shouldAdvanceTime: true,
			});
			await autosaveInFlight(tab, " First edit.");
			await acceptProposal(
				tab,
				`${editorBody(tab)}\n\nA first accepted paragraph.`,
			);
			// The confirm resolves, and the assistant proposes again before
			// the autosave has been answered.
			await act(async () => {
				tab.actions.get("confirm_changes")?.renderAndWaitForResponse({
					args: {},
					respond: vi.fn(),
					status: "complete",
				});
			});
			await acceptProposal(
				tab,
				`${editorBody(tab)}\n\nA second accepted paragraph.`,
			);
			expect(harness.confirmDraft).toHaveBeenCalledTimes(2);
			expect(harness.confirmDraft.mock.calls[0]?.[0]?.draftId).not.toBe(
				harness.confirmDraft.mock.calls[1]?.[0]?.draftId,
			);
			expect(saveCalls).toHaveLength(1);
			expect(harness.recordOutcome).not.toHaveBeenCalled();

			server.holdAnswers = false;
			await answerHeld();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});
			vi.useRealTimers();
			await waitFor(() => {
				expect(saveCalls).toHaveLength(2);
			});
			expect(saveCalls[1]?.content).toContain(
				"A first accepted paragraph.",
			);
			expect(saveCalls[1]?.content).toContain(
				"A second accepted paragraph.",
			);
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(2);
			});
			expect(harness.recordOutcome).toHaveBeenNthCalledWith(
				1,
				SAVED_ACCEPT_RECORD,
			);
			expect(harness.recordOutcome).toHaveBeenNthCalledWith(
				2,
				SAVED_ACCEPT_RECORD,
			);
			const [first, second] = harness.recordOutcome.mock.calls.map(
				(call) => call[0].operationKey,
			);
			expect(first).not.toBe(second);
			await settle(100);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(2);
		});

		it("records a save refused with CONFLICT after a colleague's save as the answer of the one save sent again, not as that refusal", async () => {
			await persistRoom(BODY_A, savedStamp());
			const accepting = await openTab("accepting", { clientId: 10 });
			const colleague = await openTab("colleague", { clientId: 20 });
			await settle(200);
			await type(colleague, " A colleague's edit.");
			await waitFor(() => {
				expect(editorBody(accepting)).toContain("A colleague's edit.");
			});

			// The colleague's save lands first; the accept's, sent from the
			// same base, is refused. Both answers are held.
			server.holdAnswers = true;
			await clickSave(colleague);
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			await acceptProposal(
				accepting,
				`${editorBody(accepting)}\n\nAn accepted paragraph.`,
			);
			await waitFor(() => {
				expect(saveCalls).toHaveLength(2);
			});
			expect(saveCalls[1]).toMatchObject({
				tab: "accepting",
				expectedVersion: 7,
			});
			expect(server.version).toBe(8);

			// The refusal is answered, and the save sent again is held.
			await act(async () => {
				for (const answer of server.held.splice(0)) {
					answer();
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
			});
			await waitFor(() => {
				expect(saveCalls).toHaveLength(3);
			});
			expect(saveCalls[2]).toMatchObject({
				tab: "accepting",
				expectedVersion: 8,
			});
			await settle(100);
			expect(harness.recordOutcome).not.toHaveBeenCalled();

			server.holdAnswers = false;
			await answerHeld();
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				SAVED_ACCEPT_RECORD,
			);
			await settle(300);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			expect(server.content).toContain("An accepted paragraph.");
			expect(server.version).toBe(9);
		});

		it("records a save refused with CONFLICT that is not sent again — the room is brought back to the saved document — once, as a failure whose text was offered to copy", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			// A server write the room has not heard of yet: the room's stamp
			// did not move, so the refusal is not sent again.
			server.content = BODY_B;
			server.version = 8;

			await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
			await waitFor(() => {
				expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				FAILED_OFFERED_ACCEPT_RECORD,
			);
			expect(saveCalls).toHaveLength(1);
			expect(server.content).toBe(BODY_B);
			// What it says is what happened: the room takes the saved body,
			// and the accepted text is offered back.
			await waitFor(
				() => {
					expect(editorBody(tab)).toContain("rewritten by the run");
					expect(offerBackCalls()).toHaveLength(1);
				},
				{ timeout: 3000 },
			);
			await settle(100);
			expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
		});

		it("posts both an accept's record and the record of another proposal's reject made while that accept's save was in flight", async () => {
			harness.postRecords = true;
			// The reject's record is still being sent when the accept's
			// save answers.
			harness.recordOperationResult.mockImplementation(
				(input: { outcome: string }) =>
					input.outcome === "cancelled"
						? new Promise(() => {})
						: Promise.resolve({
								messageId: "message-example",
								deduplicated: false,
							}),
			);
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			server.holdAnswers = true;

			await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
			await waitFor(() => {
				expect(server.held).toHaveLength(1);
			});
			// The confirm resolves, and the assistant proposes again.
			await act(async () => {
				tab.actions.get("confirm_changes")?.renderAndWaitForResponse({
					args: {},
					respond: vi.fn(),
					status: "complete",
				});
			});
			harness.agentState = {
				document: `${BODY_A}\n\nAn accepted paragraph.\n\nA rejected paragraph.`,
			};
			rerender(tab);
			await settle(20);
			const respondToReject = vi.fn();
			let card: any;
			await act(async () => {
				card = tab.actions
					.get("confirm_changes")
					?.renderAndWaitForResponse({
						args: {},
						respond: respondToReject,
						status: "executing",
					});
				await Promise.resolve();
			});
			await settle(50);
			await act(async () => {
				card?.props.onReject();
			});
			expect(respondToReject).toHaveBeenCalledWith({ accepted: false });
			await waitFor(() => {
				expect(harness.recordOperationResult).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordOperationResult).toHaveBeenCalledWith(
				expect.objectContaining({ outcome: "cancelled" }),
			);

			server.holdAnswers = false;
			await answerHeld();
			await waitFor(() => {
				expect(harness.recordOperationResult).toHaveBeenCalledTimes(2);
			});
			const [rejectRecord, acceptRecord] =
				harness.recordOperationResult.mock.calls.map((call) => call[0]);
			expect(acceptRecord).toMatchObject({
				outcome: "success",
				summary: "Changes applied.",
				operationKey: expect.any(String),
			});
			expect(acceptRecord.operationKey).not.toBe(
				rejectRecord.operationKey,
			);
		});
	});

	describe("a refused save's toast (Fizzy #2946)", () => {
		it("carries one id for the document, and the next save that lands takes it away", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			server.failNext = new Error("Service unavailable");

			await acceptProposal(tab, `${BODY_A}\n\nAn accepted paragraph.`);
			await waitFor(() => {
				expect(toast.error).toHaveBeenCalledTimes(1);
			});
			expect(toast.error).toHaveBeenCalledWith(
				"failed",
				SAVE_FAILED_TOAST,
			);
			expect(toast.dismiss).not.toHaveBeenCalled();

			await waitFor(
				() => {
					expect(saveButton(tab)).toHaveAccessibleName(
						"Save document",
					);
					expect(saveButton(tab)).not.toBeDisabled();
				},
				{ timeout: 3000 },
			);
			await clickSave(tab);
			await waitFor(() => {
				expect(server.content).toContain("An accepted paragraph.");
			});
			await waitFor(() => {
				expect(toast.dismiss).toHaveBeenCalledWith(
					SAVE_FAILED_TOAST.id,
				);
			});
			expect(toast.error).toHaveBeenCalledTimes(1);
		});
	});

	/**
	 * The chat renders the card the `confirm_changes` action returns. While
	 * its tool call is executing, the card tells the editor a proposal is
	 * under review; the chat mounts a row again when a message enters the
	 * history ahead of it (an accept's operation result, a persisted reply),
	 * which brings an answered card back (Fizzy #2946).
	 */
	describe("the chat's confirm card", () => {
		const ACCEPTED = "An accepted paragraph.";

		beforeEach(() => {
			harness.autosave.delayMs = 300;
		});

		/** The card the action renders, in a root of its own, as the chat holds it. */
		function chatFor(tab: Tab) {
			let view: ReturnType<typeof render> | null = null;
			let mountKey = 0;
			const card = (
				status: "executing" | "complete",
				respond?: unknown,
			) =>
				tab.actions.get("confirm_changes")?.renderAndWaitForResponse({
					args: {},
					respond,
					status,
					result:
						status === "complete" ? { accepted: true } : undefined,
				});
			const click = async (testId: string) => {
				await act(async () => {
					fireEvent.click(
						within(view?.container as HTMLElement).getByTestId(
							testId,
						),
					);
				});
				await settle(50);
			};
			return {
				/** The tool call is executing: the card offers Confirm and Reject. */
				async open(respond: unknown) {
					await act(async () => {
						view = render(
							<Fragment key={mountKey}>
								{card("executing", respond)}
							</Fragment>,
						);
						await Promise.resolve();
					});
					await settle(50);
				},
				confirm: () => click("confirm-button"),
				reject: () => click("reject-button"),
				/** The answered tool call, rendered in place, as CopilotKit does. */
				async complete() {
					await act(async () => {
						view?.rerender(
							<Fragment key={mountKey}>
								{card("complete")}
							</Fragment>,
						);
					});
					await settle(20);
				},
				/**
				 * The same tool call mounted again, under a new key — answered,
				 * unless it is still executing.
				 */
				async remount(
					status: "executing" | "complete" = "complete",
					respond?: unknown,
				) {
					mountKey += 1;
					await act(async () => {
						view?.rerender(
							<Fragment key={mountKey}>
								{card(status, respond)}
							</Fragment>,
						);
					});
					await settle(20);
				},
				unmount() {
					view?.unmount();
				},
			};
		}

		/** The assistant proposes the body with `ACCEPTED` added. */
		async function propose(
			tab: Tab,
			proposed = `${BODY_A}\n\n${ACCEPTED}`,
		) {
			harness.agentState = { document: proposed };
			rerender(tab);
			await settle(20);
		}

		/** Selects the last paragraph's text, then deletes it and its line. */
		async function deleteLastParagraph(tab: Tab) {
			const editor = mainEditor(tab) as Editor;
			await act(async () => {
				const size = editor.state.doc.content.size;
				const last = editor.state.doc.lastChild;
				if (last) {
					editor
						.chain()
						.deleteRange({
							from: size - last.nodeSize + 1,
							to: size - 1,
						})
						.run();
				}
			});
			await settle(20);
			await act(async () => {
				const size = editor.state.doc.content.size;
				const last = editor.state.doc.lastChild;
				if (last) {
					editor
						.chain()
						.deleteRange({ from: size - last.nodeSize, to: size })
						.run();
				}
			});
			await settle(220);
		}

		/** Whether the editor holds a proposal under review. */
		function reviewOpen(tab: Tab): boolean {
			return (
				tab.view?.container.querySelector(".streaming-diff-active") !=
				null
			);
		}

		it("after an accept whose save failed, the card mounted again and Save, deleting the accepted text is saved, and the room's stamp names the body it holds", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			// The dirty check the editor scheduled while it opened has run.
			await settle(200);
			const chat = chatFor(tab);
			server.failNext = new Error("Service unavailable");
			await propose(tab);
			const respond = vi.fn();
			await chat.open(respond);
			await chat.confirm();
			expect(respond).toHaveBeenCalledWith({ accepted: true });
			await chat.complete();
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			await settle(300);
			expect(server.content).toBe(BODY_A);
			await chat.remount();
			await clickSave(tab);
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await settle(400);
			expect(saveCalls).toHaveLength(2);

			await deleteLastParagraph(tab);
			expect(editorBody(tab)).not.toContain(ACCEPTED);
			await waitFor(
				() => {
					expect(saveCalls).toHaveLength(3);
				},
				{ timeout: 3000 },
			);
			expect(server.content).not.toContain(ACCEPTED);
			await waitFor(() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			});
			expect(await roomBody()).not.toContain(ACCEPTED);
			chat.unmount();
		});

		it("after an accept whose save landed and the card mounted again, deleting the accepted text is saved", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await settle(300);
			await chat.remount();

			await deleteLastParagraph(tab);
			expect(editorBody(tab)).not.toContain(ACCEPTED);
			await waitFor(
				() => {
					expect(saveCalls).toHaveLength(2);
				},
				{ timeout: 3000 },
			);
			expect(server.content).not.toContain(ACCEPTED);
			await waitFor(() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			});
			chat.unmount();
		});

		it("in the single-user editor, after an accept whose save landed and the card mounted again, typing is autosaved", async () => {
			vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
			const tab = await openTab("solo");
			await settle(200);
			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await settle(300);
			await chat.remount();

			await type(tab, " Typed after the accept.");
			await waitFor(
				() => {
					expect(server.content).toContain("Typed after the accept.");
				},
				{ timeout: 3000 },
			);
			chat.unmount();
		});

		it("an answered card that leaves the chat keeps a newer proposal's review open", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const first = chatFor(tab);
			await propose(tab);
			await first.open(vi.fn());
			await first.confirm();
			await first.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await settle(300);

			const second = chatFor(tab);
			await propose(tab, `${server.content}\n\nA second paragraph.`);
			await second.open(vi.fn());
			expect(reviewOpen(tab)).toBe(true);

			await act(async () => {
				first.unmount();
			});
			await settle(50);
			expect(reviewOpen(tab)).toBe(true);
			second.unmount();
		});

		it("records a human Reject once", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const chat = chatFor(tab);
			await propose(tab);
			const respond = vi.fn();
			await chat.open(respond);

			await chat.reject();
			expect(respond).toHaveBeenCalledWith({ accepted: false });
			expect(harness.confirmDraft).toHaveBeenCalledTimes(1);
			expect(harness.confirmDraft).toHaveBeenCalledWith(
				expect.objectContaining({
					surface: "document",
					verdict: "rejected",
				}),
			);
			chat.unmount();
		});
		it.each(["null", "empty"] as const)(
			"records no human verdict for %s extraction on Approve",
			async (mode) => {
				await persistRoom(BODY_A, savedStamp());
				const tab = await openTab("tab");
				await settle(200);
				const chat = chatFor(tab);
				await propose(tab);
				const respond = vi.fn();
				await chat.open(respond);
				harness.serializationMode = mode;
				try {
					await chat.confirm();
				} finally {
					harness.serializationMode = null;
				}
				expect(respond).toHaveBeenCalledWith({ accepted: false });
				expect(harness.confirmDraft).not.toHaveBeenCalled();
				expect(saveCalls).toEqual([]);
				chat.unmount();
			},
		);
		it("records no human verdict for the unchanged-document machine gate", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await propose(tab, BODY_A);
			const respond = vi.fn();
			await act(async () => {
				tab.actions.get("confirm_changes")?.renderAndWaitForResponse({
					args: {},
					status: "executing",
					respond,
				});
			});
			expect(respond).toHaveBeenCalledWith({ accepted: false });
			expect(harness.confirmDraft).not.toHaveBeenCalled();
			expect(saveCalls).toEqual([]);
		});
		it("stamps the person's choice on the card's tool call, accepted or rejected, for the chat's outcome chip", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab", {
				conversationId: "conversation-example",
			});
			await settle(200);
			/** A turn whose tool call proposes the change, as the chat holds it. */
			const turn = (n: number) => [
				{ id: `user-${n}`, role: "user", content: "Add a paragraph." },
				{ id: `text-${n}`, role: "assistant", content: "Proposed." },
				{
					id: `tools-${n}`,
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: `call-${n}`,
							type: "function",
							function: {
								name: "confirm_changes",
								arguments: "{}",
							},
						},
					],
				},
			];

			harness.chatMessages = turn(1);
			const accepting = chatFor(tab);
			await propose(tab);
			await accepting.open(vi.fn());
			await accepting.confirm();
			await waitFor(() => {
				expect(harness.recordDiffOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordDiffOutcome).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId: "conversation-example",
					projectId: "proj-1",
					messageId: "text-1",
					toolCallId: "call-1",
					outcome: "accepted",
				}),
			);
			await accepting.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await settle(300);

			harness.chatMessages = [...turn(1), ...turn(2)];
			const rejecting = chatFor(tab);
			await propose(tab, `${server.content}\n\nA second paragraph.`);
			await rejecting.open(vi.fn());
			await rejecting.reject();
			await waitFor(() => {
				expect(harness.recordDiffOutcome).toHaveBeenCalledTimes(2);
			});
			expect(harness.recordDiffOutcome).toHaveBeenLastCalledWith(
				expect.objectContaining({
					messageId: "text-2",
					toolCallId: "call-2",
					outcome: "rejected",
				}),
			);
			accepting.unmount();
			rejecting.unmount();
		});

		it("stamps an Accept that could not read the editor as nothing accepted", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab", {
				conversationId: "conversation-example",
			});
			await settle(200);
			harness.chatMessages = [
				{ id: "user-1", role: "user", content: "Add a paragraph." },
				{ id: "text-1", role: "assistant", content: "Proposed." },
				{
					id: "tools-1",
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call-1",
							type: "function",
							function: {
								name: "confirm_changes",
								arguments: "{}",
							},
						},
					],
				},
			];
			const chat = chatFor(tab);
			await propose(tab);
			const respond = vi.fn();
			await chat.open(respond);
			// The editor reads back empty against the body the review began
			// from: the Accept applies nothing.
			await act(async () => {
				mainEditor(tab)?.commands.clearContent();
			});
			await chat.confirm();

			expect(respond).toHaveBeenCalledWith({ accepted: false });
			await waitFor(() => {
				expect(harness.recordDiffOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordDiffOutcome).toHaveBeenCalledWith(
				expect.objectContaining({
					toolCallId: "call-1",
					outcome: "rejected",
				}),
			);
			expect(saveCalls).toEqual([]);
			chat.unmount();
		});

		it("mounted again while its call is executing, leaves the review bar able to accept", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const chat = chatFor(tab);
			await propose(tab);
			const respond = vi.fn();
			await chat.open(respond);
			await chat.remount("executing", respond);
			expect(reviewOpen(tab)).toBe(true);

			let answered: unknown;
			await act(async () => {
				answered = harness.reviewBarProps?.onAcceptAll();
			});
			expect(answered).toBe(true);
			expect(respond).toHaveBeenCalledWith({ accepted: true });
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			chat.unmount();
		});

		it("a raw view open while a proposal is under review takes no input and nothing is saved; a Reject leaves the saved body as it was", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await toggleRawView();
			const chat = chatFor(tab);
			await propose(tab);
			const respond = vi.fn();
			await chat.open(respond);
			// The raw view follows the editor, which holds the proposal.
			expect(rawTextarea(tab).value).toContain(ACCEPTED);
			expect(rawTextarea(tab).disabled).toBe(true);

			await userEvent.type(rawTextarea(tab), " Typed during the review.");
			await settle(600);
			expect(rawTextarea(tab).value).not.toContain(
				"Typed during the review.",
			);
			expect(saveCalls).toEqual([]);

			await chat.reject();
			expect(respond).toHaveBeenCalledWith({ accepted: false });
			await settle(600);
			expect(saveCalls).toEqual([]);
			expect(server.content).toBe(BODY_A);
			expect(rawTextarea(tab).value).not.toContain(ACCEPTED);
			chat.unmount();
		});

		it("saves the typing from before a rejected proposal with the next autosave, with no run after the answer to save it", async () => {
			harness.autosave.delayMs = 1000;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await type(tab, " Typed before.");
			const chat = chatFor(tab);
			await propose(tab, `${editorBody(tab)}\n\n${ACCEPTED}`);
			const respond = vi.fn();
			await chat.open(respond);
			// The autosave falls due during the review and stands down.
			await settle(1200);
			expect(saveCalls).toEqual([]);

			// Rejected, and no assistant run follows to save first.
			await chat.reject();
			await waitFor(
				() => {
					expect(server.content).toContain("Typed before.");
				},
				{ timeout: 3000 },
			);
			expect(server.content).not.toContain(ACCEPTED);
			chat.unmount();
		});

		it("saves nothing while a proposal is under review, unsaved typing from before it included, and Save waits for the answer", async () => {
			harness.autosave.delayMs = 1000;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await type(tab, " Typed before.");
			const chat = chatFor(tab);
			await propose(tab, `${editorBody(tab)}\n\n${ACCEPTED}`);
			const respond = vi.fn();
			await chat.open(respond);
			// The autosave falls due during the review.
			await settle(1200);
			expect(saveCalls).toEqual([]);
			expect(saveButton(tab)).toBeDisabled();
			expect(saveButton(tab)).toHaveAccessibleDescription(
				"saveBlocked.proposal",
			);

			await chat.reject();
			expect(server.content).toBe(BODY_A);
			await clickSave(tab);
			await waitFor(() => {
				expect(server.content).toContain("Typed before.");
			});
			expect(server.content).not.toContain(ACCEPTED);
			chat.unmount();
		});

		/** Edits the raw view: a paragraph added at its end. */
		async function editRawView(tab: Tab) {
			const edited = `${rawTextarea(tab).value}\n\nEdited in the raw view.`;
			await act(async () => {
				fireEvent.change(rawTextarea(tab), {
					target: { value: edited },
				});
			});
		}

		/** Warnings that kept raw-view edits on a body the editor moved past. */
		function staleRawEditCalls() {
			return vi
				.mocked(toast.warning)
				.mock.calls.filter(
					([message]) => message === "rawEditsStale.message",
				);
		}

		it("raw-view edits a save carried go into the editor, so a proposal accepted later is never saved over by them", async () => {
			vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
			const tab = await openTab("solo");
			await settle(200);
			await toggleRawView();
			await editRawView(tab);
			await waitFor(() => {
				expect(server.content).toContain("Edited in the raw view.");
			});
			await settle(100);
			// The editor holds what was saved, which the assistant works from.
			expect(editorBody(tab)).toContain("Edited in the raw view.");

			const chat = chatFor(tab);
			await propose(tab, `${editorBody(tab)}\n\n${ACCEPTED}`);
			await chat.open(vi.fn());
			// The raw view follows the editor again.
			expect(rawTextarea(tab).value).toContain(ACCEPTED);
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			const saves = saveCalls.length;
			await settle(1000);

			expect(saveCalls).toHaveLength(saves);
			expect(server.content).toContain(ACCEPTED);
			expect(server.content).toContain("Edited in the raw view.");
			expect(saveButton(tab)).toBeDisabled();
			chat.unmount();
		});

		it("raw-view edits still unsaved when a proposal is accepted are not saved over it: they stay in the raw view, unsaved, and leave it offered to copy", async () => {
			vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
			harness.autosave.delayMs = 1500;
			const tab = await openTab("solo");
			await settle(200);
			await toggleRawView();
			await editRawView(tab);

			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			// Past the raw edits' autosave, due again after the accept's save.
			await settle(2000);

			expect(saveCalls).toHaveLength(1);
			expect(server.content).toContain(ACCEPTED);
			expect(server.content).not.toContain("Edited in the raw view.");
			expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
			expect(saveButton(tab)).not.toBeDisabled();
			expect(staleRawEditCalls()).toHaveLength(1);

			// Back to the rich editor: it keeps the accepted body, and the raw
			// edits are offered to copy in place of the warning that kept them.
			await toggleRawView();
			expect(editorBody(tab)).toContain(ACCEPTED);
			expect(editorBody(tab)).not.toContain("Edited in the raw view.");
			expect(offerBackCalls()).toHaveLength(1);
			expect(offerBackCalls()[0]?.[1]).toMatchObject({
				id: "raw-edits-offer:doc-1",
			});
			await settle(500);
			expect(saveCalls).toHaveLength(1);
			chat.unmount();
		});

		it("in a room, typing more in the raw view after a proposal was accepted over its edits saves nothing over it", async () => {
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await toggleRawView();
			// Edited, then the proposal arrives before the edit's autosave.
			harness.autosave.delayMs = 1500;
			await editRawView(tab);
			harness.autosave.delayMs = 300;
			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await settle(100);

			await act(async () => {
				fireEvent.change(rawTextarea(tab), {
					target: { value: `${rawTextarea(tab).value} More.` },
				});
			});
			await settle(2000);

			expect(saveCalls).toHaveLength(1);
			expect(server.content).toContain(ACCEPTED);
			expect(rawTextarea(tab).value).toContain(
				"Edited in the raw view. More.",
			);
			expect(await roomBody()).toContain(ACCEPTED);
			expect(staleRawEditCalls()).toHaveLength(1);
			chat.unmount();
		});

		/** The view switch drawn among the page's actions. */
		function viewSwitch(tab: Tab): HTMLElement {
			return within(tab.actionSlot as HTMLElement).getByRole("button", {
				name: /^(View raw markdown|Switch to rich editor)$/,
			});
		}

		/**
		 * Tries both ways to leave the raw view — the shortcut and the button —
		 * and checks that neither wrote the raw edits anywhere.
		 */
		async function triesToLeaveRawView(tab: Tab) {
			const editorBefore = editorBody(tab);
			const roomBefore = await roomBody();
			await toggleRawView();
			expect(viewSwitch(tab)).toBeDisabled();
			expect(viewSwitch(tab)).toHaveAccessibleDescription(
				/^Switching views waits/,
			);
			await act(async () => {
				fireEvent.click(viewSwitch(tab));
			});
			await settle(50);
			expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
			expect(editorBody(tab)).toBe(editorBefore);
			expect(await roomBody()).toBe(roomBefore);
			expect(editorBody(tab)).not.toContain("Edited in the raw view.");
		}

		it("the views do not switch while a proposal is under review: the editor and the room keep their body", async () => {
			harness.autosave.delayMs = 10_000;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab", { withActions: true });
			await settle(200);
			await toggleRawView();
			await editRawView(tab);
			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			expect(rawTextarea(tab).disabled).toBe(true);

			await triesToLeaveRawView(tab);
			expect(saveCalls).toEqual([]);
			chat.unmount();
		});

		it("the views do not switch while a generation run writes the document: the editor and the room keep their body", async () => {
			harness.autosave.delayMs = 10_000;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab", { withActions: true });
			await settle(200);
			await toggleRawView();
			await editRawView(tab);
			expect(viewSwitch(tab)).not.toBeDisabled();
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(tab);
			await settle(30);

			await triesToLeaveRawView(tab);
			expect(saveCalls).toEqual([]);
		});

		/** The clipboard, recording what is copied to it. */
		function stubClipboard() {
			const writeText = vi.fn(async (_text: string) => undefined);
			Object.defineProperty(window.navigator, "clipboard", {
				value: { writeText },
				configurable: true,
			});
			return writeText;
		}

		/** Clicks the copy action of a toast `call` recorded. */
		function clickCopy(call: unknown[] | undefined) {
			(call?.[1] as { action: { onClick: () => void } }).action.onClick();
		}

		it("raw-view edits typed after they went stale are what their offer copies, also after the page is left within the app", async () => {
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await toggleRawView();
			harness.autosave.delayMs = 1500;
			await editRawView(tab);
			harness.autosave.delayMs = 300;
			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			expect(staleRawEditCalls()).toHaveLength(1);
			await act(async () => {
				fireEvent.change(rawTextarea(tab), {
					target: { value: `${rawTextarea(tab).value} Typed later.` },
				});
			});
			await settle(100);
			// Still on the page, the warning copies the text as it stands.
			const copiedBefore = stubClipboard();
			clickCopy(staleRawEditCalls()[0]);
			expect(copiedBefore).toHaveBeenCalledWith(
				expect.stringContaining("Edited in the raw view. Typed later."),
			);

			// Left within the app: the editor unmounts.
			chat.unmount();
			await act(async () => {
				tab.view?.unmount();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(50);

			expect(saveCalls).toHaveLength(1);
			const left = vi
				.mocked(toast.error)
				.mock.calls.filter(
					([message]) => message === "leaveSaveFailed",
				);
			expect(left).toHaveLength(1);
			// In place of the warning that kept the edits in the raw view.
			expect(left[0]?.[1]).toMatchObject({ id: "raw-edits-offer:doc-1" });
			const writeText = stubClipboard();
			clickCopy(left[0]);
			clickCopy(staleRawEditCalls()[0]);
			expect(writeText).toHaveBeenCalledTimes(2);
			for (const [copied] of writeText.mock.calls) {
				expect(copied).toContain(
					"Edited in the raw view. Typed later.",
				);
			}
		});

		it("a raw save answered after a proposal changed the editor leaves the proposal in the editor, and the raw edits stale and unsaved", async () => {
			vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
			harness.autosave.delayMs = 300;
			const tab = await openTab("solo");
			await settle(200);
			await toggleRawView();
			server.holdAnswers = true;
			await editRawView(tab);
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			expect(server.held).toHaveLength(1);

			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			expect(editorBody(tab)).toContain(ACCEPTED);
			expect(staleRawEditCalls()).toHaveLength(1);

			server.holdAnswers = false;
			await act(async () => {
				server.held.shift()?.();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(1000);

			expect(editorBody(tab)).toContain(ACCEPTED);
			expect(editorBody(tab)).not.toContain("Edited in the raw view.");
			expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
			expect(saveCalls).toHaveLength(1);

			// Rejected: the editor goes back to the body the proposal was
			// made on, and the raw edits are still not saved over it.
			await chat.reject();
			await settle(1000);
			expect(saveCalls).toHaveLength(1);
			expect(editorBody(tab)).not.toContain(ACCEPTED);
			expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
			chat.unmount();
		});

		it("a raw save answered after a later write reached the page leaves that write in the cached document", async () => {
			vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
			harness.autosave.delayMs = 300;
			const tab = await openTab("solo");
			await settle(200);
			await toggleRawView();
			server.holdAnswers = true;
			await editRawView(tab);
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			expect(server.version).toBe(8);
			// A later write: a run's, another editor's.
			server.content = BODY_B;
			server.version = 9;
			await nudge(tab);
			await settle(50);

			server.holdAnswers = false;
			await act(async () => {
				server.held.shift()?.();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(100);

			const [[, cached]] = tab.queryClient.getQueriesData<{
				document: { content: string; version: number };
			}>({ queryKey: ["projects", "documents", "get"] });
			expect(cached?.document.version).toBe(9);
			expect(cached?.document.content).toBe(BODY_B);
		});

		it("a raw save whose body a colleague's editor put into the room before its answer leaves nothing stale: the raw view follows the editor again", async () => {
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await toggleRawView();
			server.holdAnswers = true;
			await editRawView(tab);
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			// The save wrote the document; a colleague's editor brings the
			// room to it, body and stamp together, before this tab hears the
			// answer.
			await act(async () => {
				await persistRoom(server.content, savedStamp());
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(50);

			server.holdAnswers = false;
			await act(async () => {
				server.held.shift()?.();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(100);

			expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
			expect(saveButton(tab)).toBeDisabled();
			if (staleRawEditCalls().length > 0) {
				expect(toast.dismiss).toHaveBeenCalledWith(
					"raw-edits-offer:doc-1",
				);
			}
			// It follows the editor again: a colleague's typing reaches it.
			await act(async () => {
				await persistRoom(
					`${server.content} Typed by a colleague.`,
					null,
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await waitFor(() => {
				expect(rawTextarea(tab).value).toContain(
					"Typed by a colleague.",
				);
			});
			await settle(500);
			expect(saveCalls).toHaveLength(1);
		});

		/** Raw edits made stale by an accepted proposal, then typed on. */
		async function staleRawEditsTypedOn(tab: Tab) {
			await settle(200);
			await toggleRawView();
			harness.autosave.delayMs = 1500;
			await editRawView(tab);
			harness.autosave.delayMs = 300;
			const chat = chatFor(tab);
			await propose(tab);
			await chat.open(vi.fn());
			await chat.confirm();
			await chat.complete();
			await waitFor(() => {
				expect(server.content).toContain(ACCEPTED);
			});
			await act(async () => {
				fireEvent.change(rawTextarea(tab), {
					target: { value: `${rawTextarea(tab).value} Typed later.` },
				});
			});
			await settle(100);
			chat.unmount();
		}

		async function leaveWithinApp(tab: Tab) {
			await act(async () => {
				tab.view?.unmount();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(50);
		}

		function leaveSaveFailedCalls() {
			return vi
				.mocked(toast.error)
				.mock.calls.filter(
					([message]) => message === "leaveSaveFailed",
				);
		}

		it("stale raw edits whose explicit Save is in flight when the page is left are not said to be unsaved once that save lands", async () => {
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await staleRawEditsTypedOn(tab);
			server.holdAnswers = true;
			await clickSave(tab);
			expect(saveCalls).toHaveLength(2);
			expect(saveCalls[1]?.content).toContain(
				"Edited in the raw view. Typed later.",
			);

			await leaveWithinApp(tab);
			expect(leaveSaveFailedCalls()).toHaveLength(0);
			server.holdAnswers = false;
			await act(async () => {
				server.held.shift()?.();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(100);

			expect(leaveSaveFailedCalls()).toHaveLength(0);
			expect(server.content).toContain(
				"Edited in the raw view. Typed later.",
			);
		});

		it("stale raw edits whose explicit Save fails after the page is left are said to be unsaved once, under the toast that kept them", async () => {
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await staleRawEditsTypedOn(tab);
			server.holdAnswers = true;
			server.failNext = new Error("Service unavailable");
			await clickSave(tab);

			await leaveWithinApp(tab);
			server.holdAnswers = false;
			await act(async () => {
				server.held.shift()?.();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(100);

			const left = leaveSaveFailedCalls();
			expect(left).toHaveLength(1);
			expect(left[0]?.[1]).toMatchObject({ id: "raw-edits-offer:doc-1" });
			expect(staleRawEditCalls()[0]?.[1]).toMatchObject({
				id: "raw-edits-offer:doc-1",
			});
			const writeText = stubClipboard();
			clickCopy(left[0]);
			expect(writeText).toHaveBeenCalledWith(
				expect.stringContaining("Edited in the raw view. Typed later."),
			);
		});

		it("raw edits the room offered back as it replaced the body leave the page under that same toast", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await toggleRawView();
			await editRawView(tab);
			// A write from outside the room: the room is brought to it.
			server.content = BODY_B;
			server.version = 8;
			await nudge(tab);
			await waitFor(
				() => {
					expect(offerBackCalls()).toHaveLength(1);
				},
				{ timeout: 3000 },
			);
			await settle(100);
			await act(async () => {
				fireEvent.change(rawTextarea(tab), {
					target: { value: `${rawTextarea(tab).value} Typed later.` },
				});
			});
			await settle(50);

			await leaveWithinApp(tab);

			expect(offerBackCalls()[0]?.[1]).toMatchObject({
				id: "raw-edits-offer:doc-1",
			});
			const left = leaveSaveFailedCalls();
			expect(left).toHaveLength(1);
			expect(left[0]?.[1]).toMatchObject({ id: "raw-edits-offer:doc-1" });
			const writeText = stubClipboard();
			clickCopy(left[0]);
			expect(writeText).toHaveBeenCalledWith(
				expect.stringContaining("Edited in the raw view. Typed later."),
			);
		});
	});
});
