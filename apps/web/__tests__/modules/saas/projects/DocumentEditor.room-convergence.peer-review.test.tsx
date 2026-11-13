import {
	acceptChange,
	act,
	addPeer,
	BODY_A,
	BODY_B,
	type DiffRange,
	describe,
	type Editor,
	editorBody,
	expect,
	findDiffRanges,
	fireEvent,
	generate,
	harness,
	hashOf,
	it,
	mainEditor,
	notify,
	nudge,
	occurrences,
	offerBackCalls,
	openTab,
	PROPOSAL_REVIEW_AWARENESS_FIELD,
	persistRoom,
	ROOM_BODY_FRAGMENT,
	ROOM_PEER_AWARENESS_FIELD,
	rawTextarea,
	readConvergenceClaim,
	readRoomStamp,
	render,
	rerender,
	resume,
	room,
	roomBody,
	saveButton,
	saveCalls,
	savedStamp,
	server,
	settle,
	type Tab,
	toast,
	toggleRawView,
	type,
	UNSAVED_ACCEPT_RECORD,
	vi,
	waitFor,
	within,
	writeConvergenceClaim,
	Y,
} from "./DocumentEditor.room-convergence.harness";

/**
 * An assistant proposal under review is in the room: the reviewing tab's
 * editor holds it, so every other tab shows it before anyone has answered.
 * While the reviewing tab publishes it — from its assistant's first frame —
 * every other tab that may edit holds still — no input in the editor or the
 * raw view, no saves, the view switch, Update using context, Regenerate,
 * restore and its own assistant's proposals held — and says why; the room
 * is not brought to a newer saved body underneath it. The answer, a run
 * that ends without a card, the reviewing tab leaving, or its state leaving
 * the room ends the hold (Fizzy #2946).
 */
describe("an assistant proposal under review in another tab (Fizzy #2946)", () => {
	const PROPOSED = "A paragraph the assistant proposes.";
	const TYPED = " Typed in the other tab.";

	/** The confirm card the reviewing tab's chat renders, in a root of its own. */
	function cardFor(tab: Tab) {
		let view: ReturnType<typeof render> | null = null;
		const respond = vi.fn();
		return {
			respond,
			/**
			 * The assistant proposes the body with `PROPOSED` added — unless it
			 * already streamed its proposal, which the card then holds.
			 */
			async open({ streamed = false }: { streamed?: boolean } = {}) {
				if (!streamed) {
					harness.agentState = {
						document: `${editorBody(tab)}\n\n${PROPOSED}`,
					};
					rerender(tab);
					await settle(20);
				}
				await act(async () => {
					view = render(
						tab.actions
							.get("confirm_changes")
							?.renderAndWaitForResponse({
								args: {},
								respond,
								status: "executing",
							}),
					);
					await Promise.resolve();
				});
				await settle(50);
			},
			async answer(testId: "confirm-button" | "reject-button") {
				await act(async () => {
					fireEvent.click(
						within(view?.container as HTMLElement).getByTestId(
							testId,
						),
					);
				});
				await settle(50);
			},
			/** Whether the card still offers its answers. */
			offersAnswers(): boolean {
				return (
					view !== null &&
					within(view.container).queryByTestId("confirm-button") !==
						null
				);
			},
			/** The answered call, rendered in place, as CopilotKit does. */
			async complete() {
				await act(async () => {
					view?.rerender(
						tab.actions
							.get("confirm_changes")
							?.renderAndWaitForResponse({
								args: {},
								respond,
								status: "complete",
								result: { accepted: false },
							}),
					);
				});
				await settle(20);
			},
			unmount() {
				view?.unmount();
			},
		};
	}

	/** Another editor in the room that reviews a proposal of its own. */
	const ELSEWHERE = 99;
	/**
	 * A review as an editor publishes it: when it began, then its id. By
	 * default one that began a minute ago, before any review in the test.
	 */
	function reviewBegun(at = Date.now() - 60_000) {
		return `${at}:review-elsewhere`;
	}
	function peerStartsReview(review = reviewBegun()) {
		act(() => {
			addPeer(ELSEWHERE, {
				[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
				[PROPOSAL_REVIEW_AWARENESS_FIELD]: review,
			});
		});
	}
	function peerAnswersReview() {
		act(() => {
			room.peers.delete(ELSEWHERE);
			for (const tab of room.tabs) {
				tab.awareness.view.delete(ELSEWHERE);
				notify(tab);
			}
		});
	}

	/**
	 * An update using context in `tab` shows its diff: the proposal goes into
	 * the editor, as the hook puts it there, after its review is published.
	 */
	async function showContextPreview(tab: Tab) {
		harness.contextUpdateIn = tab.name;
		rerender(tab);
		await settle(20);
		const before = editorBody(tab);
		harness.contextBaselines.set(tab.name, before);
		const options = harness.contextOptionsByTab.get(tab.name);
		await act(async () => {
			options?.beforePreview?.();
			options?.editor?.commands.setContent(
				options.fromMarkdown(`${before}\n\n${PROPOSED}`),
			);
		});
		await settle(50);
	}

	/** The assistant streams `document` into `tab`'s editor, as one frame. */
	async function stream(tab: Tab, document: string) {
		harness.chatIn = tab.name;
		harness.chatLoading = true;
		rerender(tab);
		await settle(20);
		harness.agentState = { document };
		rerender(tab);
		await settle(50);
	}

	function heldStatus(tab: Tab): HTMLElement | null {
		return within(tab.syncSlot).queryByText("proposalElsewhere");
	}

	/** The other tab holds still, and says why. */
	async function expectHeld(tab: Tab) {
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(false);
		});
		expect(heldStatus(tab)).not.toBeNull();
		expect(saveButton(tab)).toBeDisabled();
		expect(saveButton(tab)).toHaveAccessibleDescription(
			"saveBlocked.proposalElsewhere",
		);
	}

	function orphanedStatus(tab: Tab): HTMLElement | null {
		return within(tab.syncSlot).queryByText("proposalOrphaned");
	}

	/**
	 * A tab holds still for a proposal the room holds that nobody reviews any
	 * more, and says so — not that another tab reviews it.
	 */
	async function expectHeldForUnanswered(tab: Tab) {
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(false);
		});
		await waitFor(() => {
			expect(orphanedStatus(tab)).not.toBeNull();
		});
		expect(heldStatus(tab)).toBeNull();
		expect(saveButton(tab)).toBeDisabled();
		expect(saveButton(tab)).toHaveAccessibleDescription(
			"saveBlocked.proposalOrphaned",
		);
	}

	/** The other tab takes input again, and no longer says it holds. */
	async function expectResumed(tab: Tab) {
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(true);
		});
		expect(heldStatus(tab)).toBeNull();
		expect(orphanedStatus(tab)).toBeNull();
		expect(saveButton(tab)).not.toHaveAccessibleDescription(
			"saveBlocked.proposalElsewhere",
		);
		expect(saveButton(tab)).not.toHaveAccessibleDescription(
			"saveBlocked.proposalOrphaned",
		);
	}

	/** What the tabs said of a proposal nobody answered, taken out. */
	function unansweredRemovedToasts() {
		return vi
			.mocked(toast.info)
			.mock.calls.filter(
				([message]) => message === "proposalOrphanedRemoved",
			);
	}

	/** The reviewing tab's state leaves the room, as on a dropped connection. */
	function leaveRoomAwareness(gone: Tab) {
		act(() => {
			for (const other of room.tabs) {
				if (other !== gone) {
					other.awareness.view.delete(gone.awareness.clientID);
					notify(other);
				}
			}
		});
	}

	/**
	 * The reviewing tab dies without leaving its page — a crash, a killed
	 * browser: no `pagehide`, nothing put back. Its editor goes as on a sync
	 * loss, which takes nothing out of the room, and its state times out of
	 * the room. Unmounted by the test that killed it.
	 */
	async function killTab(tab: Tab) {
		tab.synced = false;
		rerender(tab);
		await settle(50);
		leaveRoomAwareness(tab);
		const index = room.tabs.indexOf(tab);
		if (index >= 0) {
			room.tabs.splice(index, 1);
		}
	}

	async function openRoom() {
		await persistRoom(BODY_A, savedStamp());
		const reviewing = await openTab("reviewing", { clientId: 10 });
		const other = await openTab("other", { clientId: 20 });
		await settle(200);
		return { reviewing, other };
	}

	it("holds the other tab still: no input, its autosave saves nothing, Save says why, and so does the status", async () => {
		harness.autosave.delayMs = 1000;
		const { reviewing, other } = await openRoom();
		await type(other, TYPED);
		expect(editorBody(reviewing)).toContain(TYPED.trim());
		expect(saveButton(other)).not.toBeDisabled();

		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);
		expect(editorBody(other)).toContain(PROPOSED);
		// The typing's autosave falls due and stands down.
		await settle(1200);
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_A);
		await expectHeld(other);
		card.unmount();
	});

	it("holds the other tab's raw view and view switch still", async () => {
		await persistRoom(BODY_A, savedStamp());
		const other = await openTab("other", {
			clientId: 20,
			withActions: true,
		});
		await settle(200);
		await toggleRawView();
		expect(rawTextarea(other)).not.toBeDisabled();
		const reviewing = await openTab("reviewing", { clientId: 10 });
		await settle(200);

		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);
		await waitFor(() => {
			expect(rawTextarea(other)).toBeDisabled();
		});
		expect(
			within(other.actionSlot as HTMLElement).getByRole("button", {
				name: "Switch to rich editor",
			}),
		).toBeDisabled();

		await card.answer("reject-button");
		await expectResumed(other);
		expect(rawTextarea(other)).not.toBeDisabled();
		card.unmount();
	});

	it("rejected: the other tab resumes, its typing from before is kept and autosaved, and the proposal is never saved", async () => {
		harness.autosave.delayMs = 1000;
		const { reviewing, other } = await openRoom();
		await type(other, TYPED);
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);
		await settle(1200);
		expect(saveCalls).toEqual([]);

		await card.answer("reject-button");
		expect(card.respond).toHaveBeenCalledWith({ accepted: false });
		await expectResumed(other);
		expect(editorBody(other)).toContain(TYPED.trim());
		expect(editorBody(other)).not.toContain(PROPOSED);
		// The autosave that stood down goes once saves may go again.
		await waitFor(
			() => {
				expect(server.content).toContain(TYPED.trim());
			},
			{ timeout: 3000 },
		);
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({ tab: "other" });
		expect(server.content).not.toContain(PROPOSED);
		expect(server.content).toContain("Phase one, then two.");
		card.unmount();
	});

	it("rejected, with nothing typed in the other tab: nothing is saved and the server keeps the body from before the proposal", async () => {
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		await card.answer("reject-button");
		await expectResumed(other);
		expect(editorBody(other)).not.toContain(PROPOSED);
		await settle(300);
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_A);
		card.unmount();
	});

	it("accepted: the other tab resumes on the accepted body, saved once, by the reviewing tab", async () => {
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		await card.answer("confirm-button");
		expect(card.respond).toHaveBeenCalledWith({ accepted: true });
		await waitFor(() => {
			expect(server.content).toContain(PROPOSED);
		});
		await expectResumed(other);
		expect(editorBody(other)).toContain(PROPOSED);
		await settle(300);
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({ tab: "reviewing" });
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		card.unmount();
	});

	it("the reviewing tab's page left while it reviews: the other tab resumes", async () => {
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		// The page goes while the chat still holds the card unanswered.
		await act(async () => {
			reviewing.view?.unmount();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(
			reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toBeNull();
		await expectResumed(other);
		expect(saveCalls).toEqual([]);
		card.unmount();
	});

	it("the other tab's page left within the app while it holds: nothing is saved, and its unsaved typing is offered to copy, said to hold the proposal too", async () => {
		harness.autosave.delayMs = 60_000;
		const { reviewing, other } = await openRoom();
		await type(other, TYPED);
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		await act(async () => {
			other.view?.unmount();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(100);
		expect(saveCalls).toEqual([]);
		const offers = vi
			.mocked(toast.error)
			.mock.calls.filter(
				([message]) => message === "leaveWhileProposalElsewhere",
			);
		expect(offers).toHaveLength(1);
		const options = offers[0]?.[1] as {
			id: string;
			action: { onClick: () => void };
		};
		expect(options.id).toBe("raw-edits-offer:doc-1");
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		options.action.onClick();
		expect(writeText).toHaveBeenCalledWith(
			expect.stringContaining(TYPED.trim()),
		);
		card.unmount();
	});

	it("the reviewing tab's state leaves the room, as when its connection drops: the other tab holds on for the proposal nobody reviews, holds for the review again when it is back, and withdraws nothing", async () => {
		harness.timings.proposalCardLateLimitMs = 1500;
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		// The room still holds the proposal, which a save from the other tab
		// would write as accepted: it keeps holding, for a proposal nobody
		// reviews now.
		leaveRoomAwareness(reviewing);
		await expectHeldForUnanswered(other);
		expect(editorBody(other)).toContain(PROPOSED);

		// Reconnected within the wait: its state, review included, reaches
		// the room again.
		await settle(300);
		act(() => {
			other.awareness.view.set(
				reviewing.awareness.clientID,
				reviewing.awareness.own,
			);
			notify(other);
		});
		await expectHeld(other);
		// Past the wait from when its state left: nothing is taken out.
		await settle(1500);
		await expectHeld(other);
		expect(await roomBody()).toContain(PROPOSED);
		expect(editorBody(reviewing)).toContain(PROPOSED);
		expect(card.offersAnswers()).toBe(true);
		expect(unansweredRemovedToasts()).toHaveLength(0);
		expect(saveCalls).toEqual([]);
		card.unmount();
	});

	it("the reviewing tab's state stays out of the room past the wait: the other tab rejects the proposal where it stands and says so once; the reviewing tab answers its card as not applied and stops holding anyone", async () => {
		harness.timings.proposalCardLateLimitMs = 400;
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		leaveRoomAwareness(reviewing);
		await expectHeldForUnanswered(other);
		await settle(200);
		expect(await roomBody()).toContain(PROPOSED);

		await settle(400);
		await expectResumed(other);
		expect(editorBody(other)).toBe(BODY_A);
		expect(await roomBody()).toBe(BODY_A);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		expect(unansweredRemovedToasts()).toHaveLength(1);
		// The reviewing tab's proposal is gone from under its card: nothing of
		// it can be accepted, so the card is answered as not applied, once,
		// and its review leaves the room.
		await waitFor(() => {
			expect(card.respond).toHaveBeenCalledWith({ accepted: false });
		});
		expect(card.respond).toHaveBeenCalledTimes(1);
		expect(toast.info).toHaveBeenCalledWith("ownProposalRemoved");
		expect(harness.recordOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				accepted: false,
				summary:
					"Not applied: it was removed from the document because nobody answered it in time.",
			}),
		);
		expect(
			reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toBeNull();
		expect(editorBody(reviewing)).toBe(BODY_A);

		// Its state back in the room holds nobody.
		act(() => {
			other.awareness.view.set(
				reviewing.awareness.clientID,
				reviewing.awareness.own,
			);
			notify(other);
		});
		await settle(50);
		await expectResumed(other);
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_A);
		card.unmount();
	});

	it("the reviewing tab dies while the other tab's typing waits for its autosave: the proposal is rejected around that typing, which stays and saves without the proposal", async () => {
		harness.autosave.delayMs = 1000;
		harness.timings.proposalCardLateLimitMs = 400;
		const { reviewing, other } = await openRoom();
		await type(other, TYPED);
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		await killTab(reviewing);
		await expectHeldForUnanswered(other);
		expect(saveCalls).toEqual([]);

		await settle(600);
		await expectResumed(other);
		expect(editorBody(other)).toContain(TYPED.trim());
		expect(editorBody(other)).not.toContain(PROPOSED);
		expect(unansweredRemovedToasts()).toHaveLength(1);
		await waitFor(
			() => {
				expect(server.content).toContain(TYPED.trim());
			},
			{ timeout: 3000 },
		);
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({ tab: "other" });
		expect(server.content).not.toContain(PROPOSED);
		expect(server.content).toContain("Phase one, then two.");
		expect(offerBackCalls()).toHaveLength(0);
		card.unmount();
		reviewing.view?.unmount();
	});

	it("the reviewing tab dies with two other tabs held: both reject the proposal at once — what it added goes, what it deleted stays — and the room holds the body once", async () => {
		harness.timings.proposalCardLateLimitMs = 400;
		await persistRoom(BODY_A, savedStamp());
		const reviewing = await openTab("reviewing", { clientId: 10 });
		const first = await openTab("first", { clientId: 20 });
		const second = await openTab("second", { clientId: 30 });
		await settle(200);
		harness.chatIn = "reviewing";
		// It deletes words as well as adding a paragraph.
		harness.agentState = {
			document: `${BODY_A.replace("Phase one, then two.", "Phase one.")}\n\n${PROPOSED}`,
		};
		rerender(reviewing);
		await settle(20);
		const card = cardFor(reviewing);
		await card.open({ streamed: true });
		await expectHeld(first);
		await expectHeld(second);
		expect(editorBody(first)).toContain(PROPOSED);
		expect(editorBody(first)).not.toContain("then two");

		await killTab(reviewing);
		await expectHeldForUnanswered(first);
		await expectHeldForUnanswered(second);
		// Neither hears of the other's reject before it rejects.
		room.paused = true;
		try {
			await settle(600);
			expect(unansweredRemovedToasts()).toHaveLength(2);
		} finally {
			await resume();
		}
		await settle(50);

		for (const tab of [first, second]) {
			await expectResumed(tab);
			expect(editorBody(tab)).toBe(BODY_A);
		}
		expect(await roomBody()).toBe(BODY_A);
		expect(occurrences(await roomBody(), "Phase one, then two.")).toBe(1);
		expect(saveCalls).toEqual([]);
		card.unmount();
		reviewing.view?.unmount();
	});

	it("a reviewer that answers every change one by one keeps its card live: a write from the room afterwards does not take its proposal for removed", async () => {
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);
		const editor = mainEditor(reviewing) as Editor;

		// As the review bar's per-change Approve does, for every change.
		await act(async () => {
			for (
				let ranges = findDiffRanges(editor.state.doc);
				ranges.length > 0;
				ranges = findDiffRanges(editor.state.doc)
			) {
				harness.reviewBarProps?.onBeforeChange?.();
				acceptChange(editor, ranges[0] as DiffRange);
				harness.reviewBarProps?.onAfterChange?.();
			}
		});
		await settle(50);
		expect(findDiffRanges(editor.state.doc)).toEqual([]);

		// Any write from another client: here, the room's own record.
		await act(async () => {
			room.doc.transact(() => {
				room.doc.getMap("probe-example").set("written", true);
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(50);
		expect(card.respond).not.toHaveBeenCalled();
		expect(card.offersAnswers()).toBe(true);
		expect(toast.info).not.toHaveBeenCalledWith("ownProposalRemoved");
		expect(
			reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toEqual(expect.any(String));

		// Its answer is its own, and goes as before.
		await card.answer("confirm-button");
		expect(card.respond).toHaveBeenCalledWith({ accepted: true });
		await waitFor(() => {
			expect(server.content).toContain(PROPOSED);
		});
		await expectResumed(other);
		card.unmount();
	});

	it("a sync loss in the reviewing tab leaves its proposal to nobody: its card, rendered again, is answered as not applied and says why, and the proposal is rejected past the wait", async () => {
		harness.timings.proposalCardLateLimitMs = 400;
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		reviewing.synced = false;
		rerender(reviewing);
		await settle(50);
		reviewing.synced = true;
		rerender(reviewing);
		await waitFor(() => {
			expect(mainEditor(reviewing)).not.toBeNull();
		});
		await settle(50);
		const respond = vi.fn();
		await act(async () => {
			render(
				reviewing.actions
					.get("confirm_changes")
					?.renderAndWaitForResponse({
						args: {},
						respond,
						status: "executing",
					}),
			);
			await Promise.resolve();
		});
		await settle(50);
		expect(respond).toHaveBeenCalledWith({ accepted: false });
		expect(toast.info).toHaveBeenCalledWith("proposalOrphanedHeld");
		expect(toast.info).not.toHaveBeenCalledWith("proposalElsewhereHeld");
		expect(harness.recordOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				accepted: false,
				summary:
					"Not applied: the document held an unanswered assistant proposal that nobody was reviewing.",
			}),
		);

		await settle(600);
		await expectResumed(other);
		await expectResumed(reviewing);
		expect(await roomBody()).toBe(BODY_A);
		expect(saveCalls).toEqual([]);
		card.unmount();
	});

	it("never holds the tab that reviews it: its own review keeps it editable, with its own reason to wait", async () => {
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();

		expect(
			reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toEqual(expect.any(String));
		await expectHeld(other);
		expect(mainEditor(reviewing)?.isEditable).toBe(true);
		expect(heldStatus(reviewing)).toBeNull();
		expect(saveButton(reviewing)).toHaveAccessibleDescription(
			"saveBlocked.proposal",
		);

		await card.answer("reject-button");
		expect(
			reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toBeNull();
		card.unmount();
	});

	it("leaves a viewer as it was: read-only, with no hold of its own to say", async () => {
		await persistRoom(BODY_A, savedStamp());
		const reviewing = await openTab("reviewing", { clientId: 10 });
		const viewer = await openTab("viewer", { clientId: 5, role: "viewer" });
		const other = await openTab("other", { clientId: 20 });
		await settle(200);
		expect(mainEditor(viewer)?.isEditable).toBe(false);

		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);
		expect(mainEditor(viewer)?.isEditable).toBe(false);
		expect(heldStatus(viewer)).toBeNull();
		expect(saveButton(viewer)).not.toHaveAccessibleDescription(
			"saveBlocked.proposalElsewhere",
		);
		card.unmount();
	});

	it("is not replaced by a newer saved body while it is under review: the room is brought to it once the proposal is answered", async () => {
		const { reviewing, other } = await openRoom();
		const card = cardFor(reviewing);
		await card.open();
		await expectHeld(other);

		// A write outside the room — an agent, the API — lands meanwhile.
		server.content = BODY_B;
		server.version = 8;
		await nudge(reviewing, other);
		// Not even looked at as a room behind the saved document: neither tab
		// says it is updating, and the other tab still says why it holds.
		await settle(30);
		expect(within(reviewing.syncSlot).queryByText("updating")).toBeNull();
		expect(within(other.syncSlot).queryByText("updating")).toBeNull();
		expect(heldStatus(other)).not.toBeNull();
		// Past both looks of the stale rule and every turn of the election.
		await settle(1200);
		await nudge(reviewing, other);
		await settle(1200);
		expect(editorBody(reviewing)).toContain(PROPOSED);
		expect(editorBody(other)).toContain(PROPOSED);
		expect(await roomBody()).toContain(PROPOSED);
		expect(readRoomStamp(room.doc)).toEqual({
			version: 7,
			contentHash: hashOf(BODY_A),
		});

		await card.answer("reject-button");
		await waitFor(
			() => {
				expect(editorBody(reviewing)).toContain("rewritten by the run");
				expect(editorBody(other)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		expect(editorBody(other)).not.toContain(PROPOSED);
		expect(saveCalls).toEqual([]);
		expect(offerBackCalls()).toHaveLength(0);
		card.unmount();
	});

	it("is not replaced by the saved body when the claimant of an earlier convergence went quiet before reading it back", async () => {
		harness.timings.fallThroughMs = 1500;
		await persistRoom(BODY_A, savedStamp());
		// A convergence to the saved body whose claimant left before it read
		// its body back.
		writeConvergenceClaim(room.doc, { clientId: 99, target: savedStamp() });
		const reviewing = await openTab("reviewing", { clientId: 10 });
		const other = await openTab("other", { clientId: 20 });
		const card = cardFor(reviewing);
		await card.open();
		expect(editorBody(reviewing)).toContain(PROPOSED);

		// Past the claimant's turn and every editor's after it.
		await settle(5000);
		expect(editorBody(reviewing)).toContain(PROPOSED);
		expect(editorBody(other)).toContain(PROPOSED);
		expect(await roomBody()).toContain(PROPOSED);
		await expectHeld(other);
		expect(saveCalls).toEqual([]);
		card.unmount();
	});

	it("holds the other tab, Update using context included, while an update using context is under way in the reviewing tab", async () => {
		const { reviewing, other } = await openRoom();
		// The other tab's own button: a view's queries reach every tab.
		const updateButton = () =>
			(within(other.view?.container as HTMLElement)
				.queryAllByText(/Update\s+using\s+context/)
				.map((label) => label.closest("button"))
				.find(Boolean) ?? null) as HTMLButtonElement | null;
		expect(updateButton()).not.toBeDisabled();

		harness.contextUpdateIn = "reviewing";
		rerender(reviewing);
		await expectHeld(other);
		expect(updateButton()).toBeDisabled();

		harness.contextUpdateIn = null;
		rerender(reviewing);
		await expectResumed(other);
		expect(updateButton()).not.toBeDisabled();
	});

	/**
	 * The reviewing tab's page left within the app — its Close, a link —
	 * while its proposal is unanswered rejects it on the way out: the body
	 * from before the proposal goes back into the room before the room is
	 * torn down, so the other tab's next save never carries the proposal.
	 */
	describe("the reviewing tab's page left while its proposal is unanswered", () => {
		async function leave(tab: Tab) {
			await act(async () => {
				tab.view?.unmount();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(50);
		}

		/** The other tab resumes on the body from before the proposal. */
		async function expectProposalTakenBack(other: Tab) {
			await expectResumed(other);
			expect(editorBody(other)).not.toContain(PROPOSED);
			expect(editorBody(other)).toContain("Phase one, then two.");
			expect(await roomBody()).not.toContain(PROPOSED);
			expect(await roomBody()).toContain(
				"A fixed fee for the first phase.",
			);
			// Nothing is saved on the way out, the leave's own save included.
			expect(saveCalls).toEqual([]);
			expect(server.content).toBe(BODY_A);
		}

		/** The other tab's typing autosaves without the proposal. */
		async function expectTypingSavedWithoutProposal(other: Tab) {
			await type(other, TYPED);
			await waitFor(
				() => {
					expect(server.content).toContain(TYPED.trim());
				},
				{ timeout: 3000 },
			);
			expect(saveCalls).toHaveLength(1);
			expect(saveCalls[0]).toMatchObject({ tab: "other" });
			expect(server.content).not.toContain(PROPOSED);
			expect(server.content).toContain("Phase one, then two.");
		}

		it("on its confirm card: the room gets the body from before it back, and the other tab saves its typing on that body", async () => {
			harness.autosave.delayMs = 1000;
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			expect(await roomBody()).toContain(PROPOSED);

			await leave(reviewing);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
			await expectProposalTakenBack(other);
			// The chat went with the page: its call is not answered from here.
			expect(card.respond).not.toHaveBeenCalled();
			await expectTypingSavedWithoutProposal(other);
			card.unmount();
		});

		it("while its assistant still streams it in: the same", async () => {
			harness.autosave.delayMs = 1000;
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			await expectHeld(other);
			expect(await roomBody()).toContain(PROPOSED);

			await leave(reviewing);
			await expectProposalTakenBack(other);
			await expectTypingSavedWithoutProposal(other);
		});

		it("with an update using context's diff on screen: it is rejected, and the room gets the body from before it back", async () => {
			const { reviewing, other } = await openRoom();
			await showContextPreview(reviewing);
			await expectHeld(other);
			expect(await roomBody()).toContain(PROPOSED);

			await leave(reviewing);
			expect(harness.contextReject).toHaveBeenCalledTimes(1);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
			await expectProposalTakenBack(other);
		});

		it("typing of its own from before the proposal, unsaved, is saved on the way out: the body from before it, never the proposal", async () => {
			harness.autosave.delayMs = 60_000;
			const { reviewing, other } = await openRoom();
			const OWN_TYPING = " Typed in the reviewing tab.";
			await type(reviewing, OWN_TYPING);
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			expect(saveCalls).toEqual([]);

			await leave(reviewing);
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			expect(saveCalls[0]).toMatchObject({ tab: "reviewing" });
			expect(server.content).toContain(OWN_TYPING.trim());
			expect(server.content).not.toContain(PROPOSED);
			expect(await roomBody()).not.toContain(PROPOSED);
			card.unmount();
		});

		it("typing of its own is not saved on the way out while a run writes the document", async () => {
			harness.autosave.delayMs = 60_000;
			const { reviewing, other } = await openRoom();
			await type(reviewing, " Typed in the reviewing tab.");
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			// A run started elsewhere meanwhile.
			server.status = "GENERATING";
			await nudge(reviewing, other);
			await settle(50);

			await leave(reviewing);
			await settle(100);
			expect(saveCalls).toEqual([]);
			expect(await roomBody()).not.toContain(PROPOSED);
			card.unmount();
		});

		it("the page going for good (closed or reloaded) takes it back too; kept in the back-forward cache, it does not", async () => {
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			const pageHide = (persisted: boolean) =>
				act(() => {
					const event = new Event("pagehide");
					Object.defineProperty(event, "persisted", {
						value: persisted,
					});
					window.dispatchEvent(event);
				});

			pageHide(true);
			await settle(50);
			await expectHeld(other);
			expect(await roomBody()).toContain(PROPOSED);

			pageHide(false);
			await settle(50);
			await expectProposalTakenBack(other);
			card.unmount();
		});

		it("once it was accepted, nothing is put back: the other tab keeps the accepted body", async () => {
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await card.answer("confirm-button");
			await waitFor(() => {
				expect(server.content).toContain(PROPOSED);
			});
			await expectResumed(other);
			// Typed on the accepted body, which leaving must not replace.
			await type(other, TYPED);

			await leave(reviewing);
			await settle(100);
			expect(editorBody(other)).toContain(PROPOSED);
			expect(editorBody(other)).toContain(TYPED.trim());
			expect(await roomBody()).toContain(PROPOSED);
			expect(await roomBody()).toContain(TYPED.trim());
			expect(saveCalls).toHaveLength(1);
			card.unmount();
		});

		it("a sync loss in the reviewing tab is no leaving: the room keeps what it holds", async () => {
			const { reviewing } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			expect(await roomBody()).toContain(PROPOSED);

			reviewing.synced = false;
			rerender(reviewing);
			await settle(50);
			expect(mainEditor(reviewing)).toBeNull();
			expect(await roomBody()).toContain(PROPOSED);
			expect(saveCalls).toEqual([]);
			card.unmount();
		});

		/**
		 * A tab that dies without leaving its page takes nothing back out:
		 * the persisted room keeps the proposal under the saved version's
		 * stamp. A tab opened later on it must not take the proposal for the
		 * saved body.
		 */
		it("the reviewing tab dies without leaving its page: a tab opened later holds and saves nothing, then takes the proposal out of the room once, and its typing saves without it", async () => {
			harness.timings.proposalCardLateLimitMs = 500;
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const reviewing = await openTab("reviewing", { clientId: 10 });
			await settle(200);
			harness.chatIn = "reviewing";
			const card = cardFor(reviewing);
			await card.open();
			expect(await roomBody()).toContain(PROPOSED);

			await killTab(reviewing);
			expect(await roomBody()).toContain(PROPOSED);
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());

			const later = await openTab("later", { clientId: 30 });
			await expectHeldForUnanswered(later);
			expect(editorBody(later)).toContain(PROPOSED);
			await settle(200);
			expect(saveCalls).toEqual([]);
			expect(await roomBody()).toContain(PROPOSED);

			await settle(500);
			await expectResumed(later);
			expect(editorBody(later)).toBe(BODY_A);
			expect(await roomBody()).toBe(BODY_A);
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			expect(unansweredRemovedToasts()).toHaveLength(1);
			expect(saveCalls).toEqual([]);
			expect(saveButton(later)).toBeDisabled();

			await type(later, TYPED);
			await waitFor(
				() => {
					expect(server.content).toContain(TYPED.trim());
				},
				{ timeout: 3000 },
			);
			expect(saveCalls).toHaveLength(1);
			expect(saveCalls[0]).toMatchObject({
				tab: "later",
				expectedVersion: 7,
				expectedContentHash: hashOf(BODY_A),
			});
			expect(server.content).not.toContain(PROPOSED);
			expect(server.content).toContain("Phase one, then two.");
			expect(unansweredRemovedToasts()).toHaveLength(1);
			card.unmount();
			reviewing.view?.unmount();
		});
	});

	/**
	 * A proposal left waiting for its answer holds the other tabs for at most
	 * the idle limit: past it, with nothing done in the reviewing tab, that
	 * tab answers it as rejected and says so. The other tabs never stop
	 * holding on their own.
	 */
	describe("a proposal left unanswered", () => {
		const LIMIT_MS = 400;

		function timedOutToasts() {
			return vi
				.mocked(toast.info)
				.mock.calls.filter(
					([message]) => message === "proposalReviewTimedOut",
				);
		}

		it("is rejected by the reviewing tab once it waited the limit with nothing done there, and the other tab resumes on the body from before it", async () => {
			harness.timings.proposalReviewIdleLimitMs = LIMIT_MS;
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);

			await settle(LIMIT_MS + 200);
			expect(card.respond).toHaveBeenCalledWith({ accepted: false });
			expect(timedOutToasts()).toHaveLength(1);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
			await expectResumed(other);
			expect(editorBody(other)).not.toContain(PROPOSED);
			expect(await roomBody()).not.toContain(PROPOSED);
			expect(saveCalls).toEqual([]);
			card.unmount();
		});

		it("waits the limit again from each key, pointer, wheel or scroll in the reviewing tab, and from the tab coming back into view", async () => {
			harness.timings.proposalReviewIdleLimitMs = LIMIT_MS;
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();

			const activity: Array<() => void> = [
				() =>
					window.dispatchEvent(
						new KeyboardEvent("keydown", { key: "ArrowDown" }),
					),
				() => window.dispatchEvent(new Event("pointerdown")),
				() => window.dispatchEvent(new Event("wheel")),
				// A scroll inside the editor reaches the window when captured.
				() => window.document.body.dispatchEvent(new Event("scroll")),
				() =>
					window.document.dispatchEvent(
						new Event("visibilitychange"),
					),
			];
			for (const act_ of activity) {
				await settle(LIMIT_MS - 150);
				act(act_);
			}
			await settle(LIMIT_MS - 150);
			expect(card.respond).not.toHaveBeenCalled();
			expect(card.offersAnswers()).toBe(true);
			await expectHeld(other);

			await settle(300);
			expect(card.respond).toHaveBeenCalledWith({ accepted: false });
			expect(timedOutToasts()).toHaveLength(1);
			card.unmount();
		});

		it("an update using context's diff left unanswered is rejected the same way", async () => {
			harness.timings.proposalReviewIdleLimitMs = LIMIT_MS;
			const { reviewing, other } = await openRoom();
			await showContextPreview(reviewing);
			await expectHeld(other);

			await settle(LIMIT_MS + 200);
			expect(harness.contextReject).toHaveBeenCalledTimes(1);
			expect(timedOutToasts()).toHaveLength(1);
			expect(await roomBody()).not.toContain(PROPOSED);
		});

		it("holds nobody, so waits, while no other editor is in the room: it starts once one joins", async () => {
			harness.timings.proposalReviewIdleLimitMs = LIMIT_MS;
			await persistRoom(BODY_A, savedStamp());
			const reviewing = await openTab("reviewing", { clientId: 10 });
			await settle(200);
			const card = cardFor(reviewing);
			await card.open();

			await settle(LIMIT_MS * 2);
			expect(card.respond).not.toHaveBeenCalled();
			expect(card.offersAnswers()).toBe(true);
			expect(timedOutToasts()).toHaveLength(0);

			const other = await openTab("other", { clientId: 20 });
			await expectHeld(other);
			await settle(LIMIT_MS + 200);
			expect(card.respond).toHaveBeenCalledWith({ accepted: false });
			await expectResumed(other);
			card.unmount();
		});

		it("is stamped on the card's tool call as rejected, as the review bar's Reject stamps it, for the chat's outcome chip", async () => {
			harness.timings.proposalReviewIdleLimitMs = LIMIT_MS;
			await persistRoom(BODY_A, savedStamp());
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
			const reviewing = await openTab("reviewing", {
				clientId: 10,
				conversationId: "conversation-example",
			});
			await openTab("other", { clientId: 20 });
			await settle(200);
			const card = cardFor(reviewing);
			await card.open();

			await settle(LIMIT_MS + 200);
			expect(card.respond).toHaveBeenCalledWith({ accepted: false });
			await waitFor(() => {
				expect(harness.recordDiffOutcome).toHaveBeenCalledTimes(1);
			});
			expect(harness.recordDiffOutcome).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId: "conversation-example",
					messageId: "text-1",
					toolCallId: "call-1",
					outcome: "rejected",
				}),
			);
			card.unmount();
		});

		it("never releases a tab held by another editor's review: only that editor answers it", async () => {
			harness.timings.proposalReviewIdleLimitMs = LIMIT_MS;
			const { other } = await openRoom();
			peerStartsReview();
			await expectHeld(other);

			await settle(LIMIT_MS * 3);
			await expectHeld(other);
			expect(timedOutToasts()).toHaveLength(0);
			expect(saveCalls).toEqual([]);
		});
	});

	it("says who reviews the proposal when the reviewing editor names them", async () => {
		const { other } = await openRoom();
		act(() => {
			addPeer(ELSEWHERE, {
				[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
				[PROPOSAL_REVIEW_AWARENESS_FIELD]: reviewBegun(),
				user: { name: "Example Reviewer", color: "#000" },
			});
		});
		await waitFor(() => {
			expect(
				within(other.syncSlot).queryByText("proposalElsewhereBy"),
			).not.toBeNull();
		});
		expect(heldStatus(other)).toBeNull();
		expect(mainEditor(other)?.isEditable).toBe(false);

		peerAnswersReview();
		await expectResumed(other);
		expect(
			within(other.syncSlot).queryByText("proposalElsewhereBy"),
		).toBeNull();
	});

	describe("in the order the room carries it", () => {
		/** What the reviewing tab sends the room, in order. */
		function recordSends(tab: Tab) {
			const order: string[] = [];
			const publish = tab.awareness.setLocalStateField;
			tab.awareness.setLocalStateField = (field, value) => {
				if (field === PROPOSAL_REVIEW_AWARENESS_FIELD) {
					order.push(value ? "review" : "cleared");
				}
				publish(field, value);
			};
			const onBody = () => order.push("body");
			tab.doc.on("update", onBody);
			return order;
		}

		/** The review reaches the other tab's room, not yet rendered there. */
		function reviewArrivesUnrendered(tab: Tab) {
			tab.awareness.view.set(ELSEWHERE, {
				[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
				[PROPOSAL_REVIEW_AWARENESS_FIELD]: reviewBegun(),
			});
		}

		it("the review goes before the first of a streamed proposal's body", async () => {
			const { reviewing } = await openRoom();
			const order = recordSends(reviewing);
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			expect(order.slice(0, 2)).toEqual(["review", "body"]);
		});

		it("the review goes before a confirm card's diff", async () => {
			const { reviewing } = await openRoom();
			const order = recordSends(reviewing);
			const card = cardFor(reviewing);
			await card.open();
			expect(order.slice(0, 2)).toEqual(["review", "body"]);
			card.unmount();
		});

		it("an autosave that falls due before the other tab rendered the review sends nothing", async () => {
			harness.autosave.delayMs = 300;
			const { other } = await openRoom();
			await type(other, TYPED);
			reviewArrivesUnrendered(other);
			await settle(700);
			expect(saveCalls).toEqual([]);

			act(() => {
				notify(other);
			});
			await expectHeld(other);
		});

		it("leaving before the other tab rendered the review sends nothing, and offers its typing to copy", async () => {
			harness.autosave.delayMs = 60_000;
			const { other } = await openRoom();
			await type(other, TYPED);
			reviewArrivesUnrendered(other);
			await act(async () => {
				other.view?.unmount();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(100);
			expect(saveCalls).toEqual([]);
			expect(
				vi
					.mocked(toast.error)
					.mock.calls.filter(
						([message]) =>
							message === "leaveWhileProposalElsewhere",
					),
			).toHaveLength(1);
		});

		it("an accepted proposal's save that waited behind another save is not sent once a review elsewhere began, and stays unsaved", async () => {
			harness.autosave.delayMs = 300;
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			await type(tab, TYPED);
			server.holdAnswers = true;
			await waitFor(
				() => {
					expect(saveCalls).toHaveLength(1);
				},
				{ timeout: 3000 },
			);
			const card = cardFor(tab);
			await card.open();
			await card.answer("confirm-button");
			expect(card.respond).toHaveBeenCalledWith({ accepted: true });

			reviewArrivesUnrendered(tab);
			server.holdAnswers = false;
			await act(async () => {
				for (const answer of server.held.splice(0)) {
					answer();
				}
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(100);
			expect(saveCalls).toHaveLength(1);
			expect(server.content).not.toContain(PROPOSED);
			expect(editorBody(tab)).toContain(PROPOSED);
			expect(toast.info).toHaveBeenCalledWith("proposalElsewhereHeld");
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				UNSAVED_ACCEPT_RECORD,
			);
			card.unmount();
		});

		it("an update using context is handed the hold as the room has it now, and says its own review before its preview goes in", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			expect(harness.contextUpdateOptions.heldElsewhere?.()).toBe(false);
			reviewArrivesUnrendered(tab);
			expect(harness.contextUpdateOptions.heldElsewhere?.()).toBe(true);
			tab.awareness.view.delete(ELSEWHERE);

			act(() => {
				harness.contextUpdateOptions.beforePreview?.();
			});
			expect(tab.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD]).toEqual(
				expect.any(String),
			);
		});
	});

	it("a convergence that applied the saved body does not apply it again over a proposal whose review and body reached its editor before it rendered that review", async () => {
		harness.timings.claimSettleMs = 1500;
		harness.timings.fallThroughMs = 60_000;
		await persistRoom(BODY_A, savedStamp());
		const reviewing = await openTab("reviewing", { clientId: 30 });
		const other = await openTab("other", { clientId: 20 });
		await settle(200);

		server.content = BODY_B;
		server.version = 8;
		await nudge(reviewing, other);
		await waitFor(
			() => {
				expect(readConvergenceClaim(room.doc)).toMatchObject({
					clientId: 20,
				});
				expect(editorBody(other)).toContain("rewritten by the run");
				expect(editorBody(reviewing)).toContain("rewritten by the run");
			},
			{ timeout: 5000 },
		);

		// The review and its body reach the claimant, which renders neither
		// before its read-back falls due.
		const listening = new Set(other.awareness.listeners);
		other.awareness.listeners.clear();
		const card = cardFor(reviewing);
		await card.open();
		expect(
			other.awareness.view.get(30)?.[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toEqual(expect.any(String));
		expect(editorBody(other)).toContain(PROPOSED);
		await settle(2500);
		expect(editorBody(other)).toContain(PROPOSED);
		expect(await roomBody()).toContain(PROPOSED);

		for (const listener of listening) {
			other.awareness.listeners.add(listener);
		}
		act(() => {
			notify(other);
		});
		await card.answer("reject-button");
		await waitFor(
			() => {
				expect(readConvergenceClaim(room.doc)).toMatchObject({
					clientId: 20,
					settled: "verified",
				});
			},
			{ timeout: 5000 },
		);
		expect(await roomBody()).not.toContain(PROPOSED);
		card.unmount();
	});

	it("two reviews begun before either tab heard of the other: the one that began first holds, the other is answered as not applied, and the room keeps the first one's proposal", async () => {
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const second = await openTab("second", { clientId: 20 });
		await settle(200);
		const OWN = "A paragraph the second tab's assistant proposes.";

		room.paused = true;
		harness.chatIn = "first";
		const firstCard = cardFor(first);
		await firstCard.open();
		harness.chatIn = "second";
		harness.agentState = { document: `${BODY_A}\n\n${OWN}` };
		rerender(second);
		await settle(20);
		const secondCard = cardFor(second);
		await secondCard.open({ streamed: true });
		expect(first.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD]).toEqual(
			expect.any(String),
		);
		expect(second.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD]).toEqual(
			expect.any(String),
		);
		await resume();
		await settle(100);

		// One review holds: the first one's.
		expect(secondCard.respond).toHaveBeenCalledWith({ accepted: false });
		expect(harness.recordOutcome).toHaveBeenCalledWith({
			accepted: false,
			summary:
				"Not applied: another tab was reviewing an assistant proposal.",
		});
		expect(
			second.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toBeNull();
		expect(firstCard.respond).not.toHaveBeenCalled();
		expect(firstCard.offersAnswers()).toBe(true);
		expect(mainEditor(first)?.isEditable).toBe(true);
		expect(heldStatus(first)).toBeNull();
		await expectHeld(second);
		await waitFor(async () => {
			const body = await roomBody();
			expect(body).toContain(PROPOSED);
			expect(body).not.toContain(OWN);
		});
		expect(editorBody(first)).not.toContain(OWN);
		expect(editorBody(second)).not.toContain(OWN);
		expect(occurrences(await roomBody(), PROPOSED)).toBe(1);
		await secondCard.complete();

		// The first one's answer goes, and nobody holds afterwards.
		await firstCard.answer("confirm-button");
		expect(firstCard.respond).toHaveBeenCalledWith({ accepted: true });
		await waitFor(() => {
			expect(server.content).toContain(PROPOSED);
		});
		expect(server.content).not.toContain(OWN);
		await expectResumed(second);
		expect(mainEditor(first)?.isEditable).toBe(true);
		expect(heldStatus(first)).toBeNull();
		firstCard.unmount();
		secondCard.unmount();
	});

	it("two reviews begun at once, the first one still streaming: it puts its streamed frame back over what the other wrote", async () => {
		harness.liveAgentState = true;
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const second = await openTab("second", { clientId: 20 });
		await settle(200);
		const OWN = "A paragraph the second tab's assistant proposes.";

		room.paused = true;
		harness.tabChats.set("first", { loading: true, state: {} });
		rerender(first);
		await settle(20);
		harness.tabChats.set("first", {
			loading: true,
			state: { document: `${BODY_A}\n\n${PROPOSED}` },
		});
		rerender(first);
		await settle(50);
		harness.tabChats.set("second", {
			loading: false,
			state: { document: `${BODY_A}\n\n${OWN}` },
		});
		rerender(second);
		await settle(20);
		const secondCard = cardFor(second);
		await secondCard.open({ streamed: true });
		// The first one's review reaches the second tab before anything else
		// does: it withdraws while its editor still holds its own diff.
		await act(async () => {
			room.queue.shift()?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(50);
		expect(secondCard.respond).toHaveBeenCalledWith({ accepted: false });
		expect(editorBody(second)).toContain(OWN);
		// Its agent works from the body before its proposal, not from that.
		expect(
			String(harness.tabChats.get("second")?.state.document),
		).not.toContain(OWN);
		await resume();
		await settle(100);

		expect(first.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD]).toEqual(
			expect.any(String),
		);
		await waitFor(async () => {
			const body = await roomBody();
			expect(body).toContain(PROPOSED);
			expect(body).not.toContain(OWN);
		});
		expect(occurrences(await roomBody(), PROPOSED)).toBe(1);
		await expectHeld(second);
		secondCard.unmount();
	});

	it("a colleague who reviews nothing and typed before hearing of the review is not written over by it", async () => {
		await persistRoom(BODY_A, savedStamp());
		const reviewing = await openTab("reviewing", { clientId: 10 });
		const other = await openTab("other", { clientId: 20 });
		await settle(200);

		room.paused = true;
		const card = cardFor(reviewing);
		await card.open();
		// The review has not reached the other tab yet.
		expect(mainEditor(other)?.isEditable).toBe(true);
		await type(other, TYPED);
		const writesBefore = reviewing.localUpdates;
		await resume();
		await settle(100);

		expect(reviewing.localUpdates).toBe(writesBefore);
		expect(editorBody(reviewing)).toContain(TYPED.trim());
		expect(editorBody(reviewing)).toContain(PROPOSED);
		expect(await roomBody()).toContain(TYPED.trim());
		await expectHeld(other);
		expect(saveCalls).toEqual([]);
		card.unmount();
	});

	it("two reviews begun at once: a Reject in the first one's tab puts its body back, and nobody holds afterwards", async () => {
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const second = await openTab("second", { clientId: 20 });
		await settle(200);
		const OWN = "A paragraph the second tab's assistant proposes.";

		room.paused = true;
		harness.chatIn = "first";
		const firstCard = cardFor(first);
		await firstCard.open();
		harness.chatIn = "second";
		harness.agentState = { document: `${BODY_A}\n\n${OWN}` };
		rerender(second);
		await settle(20);
		const secondCard = cardFor(second);
		await secondCard.open({ streamed: true });
		await resume();
		await settle(100);
		expect(secondCard.respond).toHaveBeenCalledWith({ accepted: false });
		await secondCard.complete();

		await firstCard.answer("reject-button");
		await expectResumed(second);
		await waitFor(async () => {
			const body = await roomBody();
			expect(body).not.toContain(PROPOSED);
			expect(body).not.toContain(OWN);
			expect(body).toContain("Phase one, then two.");
		});
		expect(saveCalls).toEqual([]);
		firstCard.unmount();
		secondCard.unmount();
	});

	it("a convergence that applied the saved body does not apply it again over a proposal whose review began before it read the body back, and completes once that is answered", async () => {
		// A read-back long enough to begin a review in, and no editor after
		// the first in the election stepping in meanwhile.
		harness.timings.claimSettleMs = 1500;
		harness.timings.fallThroughMs = 60_000;
		await persistRoom(BODY_A, savedStamp());
		// The other tab is first in the election, so its convergence applies.
		const reviewing = await openTab("reviewing", { clientId: 30 });
		const other = await openTab("other", { clientId: 20 });
		await settle(200);

		server.content = BODY_B;
		server.version = 8;
		await nudge(reviewing, other);
		await waitFor(
			() => {
				expect(readConvergenceClaim(room.doc)).toMatchObject({
					clientId: 20,
				});
				expect(editorBody(other)).toContain("rewritten by the run");
				expect(editorBody(reviewing)).toContain("rewritten by the run");
			},
			{ timeout: 5000 },
		);
		expect(readConvergenceClaim(room.doc)?.settled).toBeUndefined();

		// Before the body is read back, a proposal is reviewed over it.
		const card = cardFor(reviewing);
		await card.open();
		expect(editorBody(reviewing)).toContain(PROPOSED);
		// Past the read-back.
		await settle(2500);
		expect(editorBody(reviewing)).toContain(PROPOSED);
		expect(await roomBody()).toContain(PROPOSED);
		expect(readConvergenceClaim(room.doc)?.settled).toBeUndefined();

		await card.answer("reject-button");
		await waitFor(
			() => {
				expect(readConvergenceClaim(room.doc)).toMatchObject({
					clientId: 20,
					settled: "verified",
				});
			},
			{ timeout: 5000 },
		);
		expect(occurrences(await roomBody(), "rewritten by the run")).toBe(1);
		expect(await roomBody()).not.toContain(PROPOSED);
		expect(saveCalls).toEqual([]);
		card.unmount();
	});

	describe("while the reviewing tab's assistant streams it in", () => {
		it("a chat answer that writes nothing into the editor holds nobody", async () => {
			const { reviewing, other } = await openRoom();
			await stream(reviewing, BODY_A);
			await settle(100);

			expect(mainEditor(other)?.isEditable).toBe(true);
			expect(heldStatus(other)).toBeNull();
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD] ??
					null,
			).toBeNull();
		});

		it("holds the other tab from the first frame, before the confirm card, and stays one review through the card until it is answered", async () => {
			const { reviewing, other } = await openRoom();
			harness.chatIn = "reviewing";
			harness.chatLoading = true;
			rerender(reviewing);
			await settle(50);
			// Under way, with nothing written yet.
			expect(mainEditor(other)?.isEditable).toBe(true);
			expect(heldStatus(other)).toBeNull();

			harness.agentState = { document: `${BODY_A}\n\n${PROPOSED}` };
			rerender(reviewing);
			await settle(50);
			await expectHeld(other);
			expect(editorBody(other)).toContain(PROPOSED);
			const review =
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD];
			expect(review).toEqual(expect.any(String));

			// Its confirm card, then the end of the run.
			const card = cardFor(reviewing);
			await card.open({ streamed: true });
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(50);
			expect(card.offersAnswers()).toBe(true);
			// Past the wait for a card: the card holds the same review.
			await settle(2500);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBe(review);
			await expectHeld(other);

			await card.answer("reject-button");
			await expectResumed(other);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
			expect(editorBody(other)).not.toContain(PROPOSED);
			expect(saveCalls).toEqual([]);
			card.unmount();
		});

		it("answered while the run is still under way, the review ends with the answer", async () => {
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			await expectHeld(other);
			const card = cardFor(reviewing);
			await card.open({ streamed: true });

			await card.answer("reject-button");
			await expectResumed(other);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
			card.unmount();
		});

		it("a run that ends without a confirm card takes its frames back out of the room once the card had its moment: the other tab resumes on the body from before the run and never saves them", async () => {
			harness.autosave.delayMs = 1000;
			// The agent's shared state follows what the editor sets.
			harness.liveAgentState = true;
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			await expectHeld(other);
			expect(await roomBody()).toContain(PROPOSED);

			// Stopped, or failed: no card comes.
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(2500);
			await expectResumed(other);
			expect(editorBody(reviewing)).not.toContain(PROPOSED);
			expect(editorBody(other)).not.toContain(PROPOSED);
			expect(await roomBody()).not.toContain(PROPOSED);
			expect(await roomBody()).toContain("Phase one, then two.");
			// The agent's document goes back with it, and it is said.
			expect(harness.agentState.document).not.toContain(PROPOSED);
			expect(toast.info).toHaveBeenCalledWith("assistantRunTakenBack");

			await type(other, TYPED);
			await waitFor(
				() => {
					expect(server.content).toContain(TYPED.trim());
				},
				{ timeout: 3000 },
			);
			expect(saveCalls).toHaveLength(1);
			expect(server.content).not.toContain(PROPOSED);
		});

		it("a run whose confirm card comes keeps its proposal in the room past the card's moment, under review", async () => {
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			const card = cardFor(reviewing);
			await card.open({ streamed: true });
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(2500);
			expect(card.offersAnswers()).toBe(true);
			await expectHeld(other);
			expect(editorBody(reviewing)).toContain(PROPOSED);
			expect(await roomBody()).toContain(PROPOSED);
			card.unmount();
		});

		it("a card that comes after the card's moment still finds the proposal under review while the chat holds its unanswered call, and an Accept saves it", async () => {
			harness.chatMessages = [
				{ id: "user-1", role: "user", content: "Add a paragraph." },
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
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(2500);
			// Its call is on its way: nothing is taken back meanwhile.
			await expectHeld(other);
			expect(await roomBody()).toContain(PROPOSED);
			expect(toast.info).not.toHaveBeenCalledWith(
				"assistantRunTakenBack",
			);

			const card = cardFor(reviewing);
			await card.open({ streamed: true });
			expect(card.offersAnswers()).toBe(true);
			await card.answer("confirm-button");
			expect(card.respond).toHaveBeenCalledWith({ accepted: true });
			await waitFor(() => {
				expect(server.content).toContain(PROPOSED);
			});
			await expectResumed(other);
			card.unmount();
		});

		it("a card its chat announced that never comes is waited for only so long: past the limit the frames are taken back, the editor follows its own body again, and nothing saved the frames meanwhile", async () => {
			harness.timings.proposalCardLateLimitMs = 3000;
			harness.autosave.delayMs = 500;
			harness.liveAgentState = true;
			harness.chatMessages = [
				{ id: "user-1", role: "user", content: "Add a paragraph." },
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
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			// The run failed after naming its call: the call never runs.
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(300);
			// Typing here while the card is awaited autosaves nothing: the
			// editor holds the frames, unanswered.
			await type(reviewing, " Typed while the card was awaited.");
			await settle(1500);
			expect(saveCalls).toEqual([]);
			await expectHeld(other);
			expect(saveButton(reviewing)).toHaveAccessibleDescription(
				"saveBlocked.proposal",
			);

			await settle(3000);
			await expectResumed(other);
			expect(await roomBody()).not.toContain(PROPOSED);
			expect(toast.info).toHaveBeenCalledWith("assistantRunTakenBack");
			expect(saveCalls).toEqual([]);
			// The agent's document follows the editor again.
			await type(reviewing, " Typed afterwards.");
			await waitFor(() => {
				expect(harness.agentState.document).toContain(
					"Typed afterwards.",
				);
			});
			expect(harness.agentState.document).not.toContain(PROPOSED);
			for (const call of saveCalls) {
				expect(String(call.content)).not.toContain(PROPOSED);
			}
		});

		it("a second run started before the first one's frames were taken back is taken back to the body from before the first", async () => {
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(500);
			await stream(
				reviewing,
				`${BODY_A}\n\n${PROPOSED}\n\nA second paragraph.`,
			);
			harness.chatLoading = false;
			rerender(reviewing);
			await settle(2500);

			await expectResumed(other);
			expect(await roomBody()).not.toContain(PROPOSED);
			expect(await roomBody()).not.toContain("A second paragraph.");
			expect(await roomBody()).toContain("Phase one, then two.");
			expect(saveCalls).toEqual([]);
		});

		it("a run that ends without a confirm card releases the other tab once the card had its moment", async () => {
			const { reviewing, other } = await openRoom();
			await stream(reviewing, `${BODY_A}\n\n${PROPOSED}`);
			await expectHeld(other);

			harness.chatLoading = false;
			rerender(reviewing);
			await settle(500);
			await expectHeld(other);
			await settle(2000);
			await expectResumed(other);
			expect(
				reviewing.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
		});
	});

	describe("what else would write the other tab's body", () => {
		const OWN = "A paragraph the other tab's assistant proposes.";

		function regenerateButton(tab: Tab): HTMLButtonElement | null {
			return (within(tab.view?.container as HTMLElement)
				.queryAllByText("Regenerate")
				.map((label) => label.closest("button"))
				.find(Boolean) ?? null) as HTMLButtonElement | null;
		}

		function regenerateFromChat(
			tab: Tab,
			status: "executing" | "complete",
		) {
			const respond = vi.fn();
			act(() => {
				tab.actions
					.get("regenerate_document")
					?.renderAndWaitForResponse({
						args: { prompt: "Rewrite it" },
						respond,
						status,
					});
			});
			return respond;
		}

		it("Regenerate waits, from its button, its confirmation and the chat, and says why; it can start once the proposal is answered", async () => {
			const { reviewing, other } = await openRoom();
			expect(regenerateButton(other)).not.toBeDisabled();
			// Asked for before the review: its confirmation is open.
			await act(async () => {
				regenerateButton(other)?.click();
			});
			const confirmRegenerate = () =>
				within(other.view?.container as HTMLElement)
					.getAllByRole("button", { name: /Regenerate/ })
					.find((button) => button !== regenerateButton(other));
			expect(confirmRegenerate()).toBeDefined();

			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			expect(regenerateButton(other)).toBeDisabled();
			expect(regenerateButton(other)).toHaveAccessibleDescription(
				"proposalElsewhereHeld",
			);
			await act(async () => {
				confirmRegenerate()?.click();
			});
			const respond = regenerateFromChat(other, "executing");
			await settle(50);
			// Answered as not started, and why.
			expect(respond).toHaveBeenCalledWith({
				accepted: false,
				reason: "heldElsewhere",
			});
			// Rendered again while its call is still executing: still none.
			regenerateFromChat(other, "executing");
			await settle(100);
			expect(toast.info).toHaveBeenCalledWith("proposalElsewhereHeld");
			expect(generate.calls).toBe(0);

			await card.answer("reject-button");
			await expectResumed(other);
			expect(regenerateButton(other)).not.toBeDisabled();
			expect(regenerateButton(other)).not.toHaveAccessibleDescription(
				"proposalElsewhereHeld",
			);
			// The call answered as not started never starts one.
			regenerateFromChat(other, "executing");
			await settle(100);
			expect(generate.calls).toBe(0);
			regenerateFromChat(other, "complete");
			regenerateFromChat(other, "executing");
			await waitFor(() => {
				expect(generate.calls).toBe(1);
			});
			card.unmount();
		});

		it("the chat's line about an answered regeneration says what became of it: not started while another tab reviewed, not applied, or completed", async () => {
			const { other } = await openRoom();
			function answered(result: unknown): string {
				const view = render(
					other.actions
						.get("regenerate_document")
						?.renderAndWaitForResponse({
							args: { prompt: "Rewrite it" },
							respond: vi.fn(),
							status: "complete",
							result,
						}),
				);
				const text = view.container.textContent ?? "";
				view.unmount();
				return text;
			}
			const held = "regenerationCall.heldElsewhere";
			expect(answered({ accepted: false, reason: "heldElsewhere" })).toBe(
				held,
			);
			// As the chat reads it back from the conversation.
			expect(
				answered(
					JSON.stringify({
						accepted: false,
						reason: "heldElsewhere",
					}),
				),
			).toBe(held);
			expect(answered({ accepted: false })).toBe(
				"regenerationCall.notApplied",
			);
			expect(answered({ accepted: true })).toBe(
				"regenerationCall.completed",
			);
			expect(answered(undefined)).toBe("regenerationCall.completed");
		});

		it("version restore waits, and says why", async () => {
			const { reviewing, other } = await openRoom();
			expect(other.versionHistoryProps?.restoreBlockedReason).toBeNull();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			expect(other.versionHistoryProps?.restoreBlockedReason).toBe(
				"proposalElsewhere",
			);
			expect(
				reviewing.versionHistoryProps?.restoreBlockedReason,
			).toBeNull();

			await card.answer("reject-button");
			await expectResumed(other);
			expect(other.versionHistoryProps?.restoreBlockedReason).toBeNull();
			card.unmount();
		});

		it("its own assistant puts nothing in: no frame reaches the room, and its confirm is answered as not applied; once the proposal is answered, a new one is put in and accepted", async () => {
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);

			await stream(other, `${BODY_A}\n\n${OWN}`);
			expect(editorBody(other)).not.toContain(OWN);
			expect(await roomBody()).not.toContain(OWN);
			expect(await roomBody()).toContain(PROPOSED);
			expect(
				other.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD] ?? null,
			).toBeNull();
			harness.chatLoading = false;
			const declined = cardFor(other);
			await declined.open({ streamed: true });
			expect(declined.respond).toHaveBeenCalledWith({ accepted: false });
			expect(declined.offersAnswers()).toBe(false);
			expect(toast.info).toHaveBeenCalledWith("proposalElsewhereHeld");
			expect(editorBody(other)).not.toContain(OWN);
			expect(mainEditor(reviewing)?.isEditable).toBe(true);
			await expectHeld(other);
			await declined.complete();

			await card.answer("reject-button");
			await expectResumed(other);
			await stream(other, `${BODY_A}\n\n${OWN}`);
			expect(editorBody(other)).toContain(OWN);
			harness.chatLoading = false;
			const accepted = cardFor(other);
			await accepted.open({ streamed: true });
			await accepted.answer("confirm-button");
			expect(accepted.respond).toHaveBeenCalledWith({ accepted: true });
			await waitFor(() => {
				expect(server.content).toContain(OWN);
			});
			expect(server.content).not.toContain(PROPOSED);
			card.unmount();
			declined.unmount();
			accepted.unmount();
		});

		it("its own assistant's final diff is not put in either", async () => {
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);

			harness.chatIn = "other";
			harness.agentState = { document: `${BODY_A}\n\n${OWN}` };
			harness.nodeName = "end";
			rerender(other);
			await settle(50);
			expect(editorBody(other)).not.toContain(OWN);
			expect(await roomBody()).not.toContain(OWN);
			expect(await roomBody()).toContain(PROPOSED);
			card.unmount();
		});

		it("its own assistant's run that began while another tab reviewed is not put in, also when its card comes after that review, nor by the run its answer resumes", async () => {
			harness.autosave.delayMs = 1000;
			harness.liveAgentState = true;
			const { reviewing, other } = await openRoom();
			const card = cardFor(reviewing);
			await card.open();
			await expectHeld(other);
			await stream(other, `${BODY_A}\n\n${OWN}`);

			// Answered while the other tab's run still goes on.
			await card.answer("reject-button");
			await waitFor(() => {
				expect(heldStatus(other)).toBeNull();
			});
			harness.chatLoading = false;
			const late = cardFor(other);
			await late.open({ streamed: true });
			expect(late.respond).toHaveBeenCalledWith({ accepted: false });
			expect(late.offersAnswers()).toBe(false);
			expect(harness.recordOutcome).toHaveBeenCalledWith({
				accepted: false,
				summary:
					"Not applied: another tab was reviewing an assistant proposal.",
			});
			expect(editorBody(other)).not.toContain(OWN);
			expect(await roomBody()).not.toContain(OWN);
			await settle(300);
			expect(saveCalls).toEqual([]);
			await late.complete();

			// The answer resumes the agent for one more short run.
			harness.chatLoading = true;
			rerender(other);
			await settle(100);
			expect(editorBody(other)).not.toContain(OWN);
			expect(await roomBody()).not.toContain(OWN);
			expect(
				other.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD] ?? null,
			).toBeNull();
			harness.chatLoading = false;
			rerender(other);
			await settle(100);
			expect(mainEditor(reviewing)?.isEditable).toBe(true);
			await type(reviewing, " Typed afterwards.");
			await waitFor(
				() => {
					expect(server.content).toContain("Typed afterwards.");
				},
				{ timeout: 3000 },
			);
			for (const call of saveCalls) {
				expect(String(call.content)).not.toContain(OWN);
			}
			card.unmount();
			late.unmount();
		});

		it("its own review is withdrawn when a review that began first elsewhere reaches it: an Accept in the moment before does nothing, its card is answered as not applied, and nothing is written over the room", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const card = cardFor(tab);
			await card.open();
			expect(card.offersAnswers()).toBe(true);

			// Reached the room, not rendered yet.
			tab.awareness.view.set(ELSEWHERE, {
				[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
				[PROPOSAL_REVIEW_AWARENESS_FIELD]: reviewBegun(),
			});
			await card.answer("confirm-button");
			let answered: unknown;
			act(() => {
				answered = harness.reviewBarProps?.onAcceptAll();
			});
			expect(answered).toBeNull();
			expect(card.respond).not.toHaveBeenCalled();
			expect(toast.info).toHaveBeenCalledWith("proposalElsewhereHeld");

			const writesBefore = tab.localUpdates;
			act(() => {
				notify(tab);
			});
			await waitFor(() => {
				expect(card.respond).toHaveBeenCalledWith({ accepted: false });
			});
			expect(harness.recordOutcome).toHaveBeenCalledWith({
				accepted: false,
				summary:
					"Not applied: another tab was reviewing an assistant proposal.",
			});
			await settle(100);
			expect(tab.localUpdates).toBe(writesBefore);
			expect(
				tab.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD],
			).toBeNull();
			await expectHeld(tab);
			expect(saveCalls).toEqual([]);
			card.unmount();
		});

		it("a Reject of its own proposal in the moment before it withdraws puts nothing back over the room", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const card = cardFor(tab);
			await card.open();

			tab.awareness.view.set(ELSEWHERE, {
				[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
				[PROPOSAL_REVIEW_AWARENESS_FIELD]: reviewBegun(),
			});
			const writesBefore = tab.localUpdates;
			await card.answer("reject-button");
			expect(card.respond).toHaveBeenCalledWith({ accepted: false });
			expect(tab.localUpdates).toBe(writesBefore);
			expect(editorBody(tab)).toContain(PROPOSED);
			card.unmount();
		});

		it("a proposal whose card armed just before a review that began first reached it does not go in", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			harness.agentState = { document: `${BODY_A}\n\n${PROPOSED}` };
			rerender(tab);
			await settle(20);
			const respond = vi.fn();
			let view: ReturnType<typeof render> | null = null;
			await act(async () => {
				const card = tab.actions
					.get("confirm_changes")
					?.renderAndWaitForResponse({
						args: {},
						respond,
						status: "executing",
					});
				// Between the card arming and its diff going in.
				tab.awareness.view.set(ELSEWHERE, {
					[ROOM_PEER_AWARENESS_FIELD]: {
						canEdit: true,
						visible: true,
					},
					[PROPOSAL_REVIEW_AWARENESS_FIELD]: reviewBegun(),
				});
				view = render(card);
				await Promise.resolve();
			});
			await settle(50);
			expect(respond).toHaveBeenCalledWith({ accepted: false });
			expect(editorBody(tab)).not.toContain(PROPOSED);
			expect(
				tab.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD] ?? null,
			).toBeNull();
			(view as ReturnType<typeof render> | null)?.unmount();
		});

		it("an update using context of its own is withdrawn when a review that began first reaches it, and put in again when one that began later wrote over it", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			harness.contextUpdateIn = "tab";
			rerender(tab);
			await settle(20);
			expect(tab.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD]).toEqual(
				expect.any(String),
			);

			// Begun later, and wrote into the room before it withdrew.
			peerStartsReview(reviewBegun(Date.now() + 60_000));
			const later = new Y.Doc();
			later.clientID = ELSEWHERE;
			Y.applyUpdate(later, Y.encodeStateAsUpdate(room.doc));
			const paragraph = new Y.XmlElement("paragraph");
			paragraph.insert(0, [
				new Y.XmlText("Written by the later review."),
			]);
			later.getXmlFragment(ROOM_BODY_FRAGMENT).insert(0, [paragraph]);
			await act(async () => {
				Y.applyUpdate(
					room.doc,
					Y.encodeStateAsUpdate(later, Y.encodeStateVector(room.doc)),
					"later",
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await settle(20);
			expect(harness.contextReassert).toHaveBeenCalledTimes(1);
			expect(harness.contextWithdraw).not.toHaveBeenCalled();

			// Begun first.
			peerStartsReview(reviewBegun());
			await settle(20);
			expect(harness.contextWithdraw).toHaveBeenCalled();
			later.destroy();
		});

		it("a review that began after its own never holds it: its Accept answers, and is saved", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const card = cardFor(tab);
			await card.open();

			peerStartsReview(reviewBegun(Date.now() + 60_000));
			await settle(50);
			expect(mainEditor(tab)?.isEditable).toBe(true);
			expect(heldStatus(tab)).toBeNull();
			expect(card.respond).not.toHaveBeenCalled();
			await card.answer("confirm-button");
			expect(card.respond).toHaveBeenCalledWith({ accepted: true });
			await waitFor(() => {
				expect(server.content).toContain(PROPOSED);
			});
			card.unmount();
		});

		it("an image whose upload finishes while another tab reviews a proposal goes in once that is answered, never meanwhile", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			let stored: (key: string) => void = () => {};
			harness.uploadImage = () =>
				new Promise<string>((resolve) => {
					stored = resolve;
				});
			const images = () => {
				let count = 0;
				mainEditor(tab)?.state.doc.descendants((node) => {
					if (node.type.name === "image") {
						count += 1;
					}
				});
				return count;
			};
			const file = new File(
				[new Uint8Array([137, 80, 78, 71])],
				"flow.png",
				{
					type: "image/png",
				},
			);
			let uploading: Promise<void> | undefined;
			await act(async () => {
				uploading = harness.slashImageUpload?.({
					0: file,
					length: 1,
				} as unknown as FileList);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});

			peerStartsReview();
			await waitFor(() => {
				expect(mainEditor(tab)?.isEditable).toBe(false);
			});
			const roomUpdatesBefore = tab.localUpdates;
			await act(async () => {
				stored("projects/proj-1/documents/doc-1/flow.png");
				await new Promise((resolve) => setTimeout(resolve, 50));
			});
			expect(images()).toBe(0);
			expect(tab.localUpdates).toBe(roomUpdatesBefore);

			peerAnswersReview();
			await act(async () => {
				await uploading;
			});
			expect(images()).toBe(1);
		});

		it("a diagram the assistant suggests is not inserted while another tab reviews a proposal, and is once it is answered", async () => {
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			await settle(200);
			const suggest = () =>
				tab.actions.get("suggest_diagram")?.handler({
					mermaidCode: "graph TD; Scope-->Pricing",
					rationale: "Shows the order of the phases.",
				});

			peerStartsReview();
			await waitFor(() => {
				expect(mainEditor(tab)?.isEditable).toBe(false);
			});
			let result: unknown;
			await act(async () => {
				result = await suggest();
			});
			expect(result).toEqual(expect.stringContaining("not inserted"));
			expect(editorBody(tab)).not.toContain("Scope-->Pricing");

			peerAnswersReview();
			await waitFor(() => {
				expect(mainEditor(tab)?.isEditable).toBe(true);
			});
			await act(async () => {
				result = await suggest();
			});
			expect(result).toEqual(
				expect.stringContaining("Diagram inserted."),
			);
		});
	});
});
