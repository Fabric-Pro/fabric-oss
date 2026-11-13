import {
	act,
	addPeer,
	BODY_A,
	BODY_B,
	clickSave,
	describe,
	editorBody,
	expect,
	harness,
	hashOf,
	isRoomBodyEmpty,
	it,
	mainEditor,
	nudge,
	occurrences,
	offerBackCalls,
	openTab,
	persistRoom,
	ROOM_META_MAP,
	ROOM_PEER_AWARENESS_FIELD,
	ROOM_SAVE_AWARENESS_FIELD,
	readConvergenceClaim,
	readRoomStamp,
	rerender,
	room,
	roomBody,
	SAVE_FAILED_TOAST,
	saveButton,
	saveCalls,
	savedStamp,
	server,
	settle,
	type Tab,
	toast,
	type,
	vi,
	waitFor,
	within,
} from "./DocumentEditor.room-convergence.harness";

describe("a colleague's save in flight (Fizzy #2946)", () => {
	const savingAt = () => ({
		[ROOM_SAVE_AWARENESS_FIELD]: {
			version: 7,
			contentHash: hashOf(BODY_A),
		},
	});

	async function staleRoomConverges(tab: Tab) {
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(tab)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(readConvergenceClaim(room.doc)?.clientId).toBe(50);
	}

	it("claimed by a client that may not edit does not hold a stale room back", async () => {
		// Long enough that only who claims the save decides.
		harness.timings.fallThroughMs = 5000;
		await persistRoom(BODY_A, savedStamp());
		addPeer(900, {
			[ROOM_PEER_AWARENESS_FIELD]: { canEdit: false, visible: true },
			...savingAt(),
		});
		const tab = await openTab("tab", { clientId: 50 });

		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);

		await staleRoomConverges(tab);
	});

	it("from an editor that keeps naming a new base holds a stale room back for one fall-through interval only", async () => {
		await persistRoom(BODY_A, savedStamp());
		const peer = (round: number) => ({
			[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: false },
			[ROOM_SAVE_AWARENESS_FIELD]: {
				version: 7,
				contentHash: `rotated-${round}`,
			},
		});
		addPeer(900, peer(0));
		const tab = await openTab("tab", { clientId: 50 });

		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);
		let round = 0;
		const rotate = setInterval(() => {
			round += 1;
			act(() => addPeer(900, peer(round)));
		}, 100);
		try {
			// Converged while the peer is still rotating its base.
			await staleRoomConverges(tab);
		} finally {
			clearInterval(rotate);
		}
		expect(round).toBeGreaterThanOrEqual(3);
	});

	it("from many clients appearing one after another holds a stale room back for one fall-through interval only", async () => {
		await persistRoom(BODY_A, savedStamp());
		const peer = () => ({
			[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: false },
			...savingAt(),
		});
		addPeer(900, peer());
		const tab = await openTab("tab", { clientId: 50 });

		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);
		let next = 901;
		const appear = setInterval(() => {
			const clientId = next;
			next += 1;
			act(() => addPeer(clientId, peer()));
		}, 100);
		try {
			await staleRoomConverges(tab);
		} finally {
			clearInterval(appear);
		}
		expect(next).toBeGreaterThanOrEqual(904);
	});

	it("that is never answered holds a stale room back for one fall-through interval only", async () => {
		await persistRoom(BODY_A, savedStamp());
		// An editor behind this one in the election: hidden, larger id.
		addPeer(900, {
			[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: false },
			...savingAt(),
		});
		const tab = await openTab("tab", { clientId: 50 });

		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);
		// Inside the interval, the room is left alone.
		await settle(150);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(editorBody(tab)).toContain("Phase one, then two.");

		await staleRoomConverges(tab);
	});
});

describe("a room nobody has written yet (Fizzy #2946)", () => {
	it("is seeded once by the first editor, with the saved body's stamp; a second editor does not seed it again", async () => {
		const first = await openTab("first", { clientId: 50 });
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			expect(editorBody(first)).toContain("Phase one, then two.");
		});
		expect(occurrences(await roomBody(), "Phase one, then two.")).toBe(1);

		const second = await openTab("second", { clientId: 60 });
		await settle(200);

		expect(editorBody(second)).toContain("Phase one, then two.");
		expect(occurrences(await roomBody(), "Phase one, then two.")).toBe(1);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		expect(second.localUpdates).toBe(0);
		expect(saveCalls).toEqual([]);
	});

	it("is never seeded by a viewer", async () => {
		const tab = await openTab("viewer", { role: "viewer" });
		await settle(200);

		expect(isRoomBodyEmpty(room.doc)).toBe(true);
		expect(readRoomStamp(room.doc)).toBeNull();
		expect(saveCalls).toEqual([]);
		expect(tab.localUpdates).toBe(0);
	});

	it("waits to seed until the project says whether this client may edit", async () => {
		let release: () => void = () => {};
		server.projectGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tab = await openTab("tab");
		await settle(200);
		expect(isRoomBodyEmpty(room.doc)).toBe(true);
		expect(readRoomStamp(room.doc)).toBeNull();

		await act(async () => {
			release();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		rerender(tab);

		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		expect(occurrences(await roomBody(), "Phase one, then two.")).toBe(1);
	});

	it("takes only the stamp of an empty saved body", async () => {
		server.content = "";
		const tab = await openTab("tab");

		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		expect(isRoomBodyEmpty(room.doc)).toBe(true);
		expect(editorBody(tab).trim()).toBe("");
		expect(saveCalls).toEqual([]);
	});
});

describe("rejecting a regeneration in a room (Fizzy #2946)", () => {
	async function startRunFromChat(tab: Tab) {
		await act(async () => {
			tab.actions.get("regenerate_document")?.renderAndWaitForResponse({
				args: { prompt: "Rewrite it" },
				respond: vi.fn(),
				status: "executing",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	/** A run this tab started ends on BODY_B at version 8; its review is open. */
	async function reviewRun(tab: Tab) {
		await startRunFromChat(tab);
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
		});
		await waitFor(() => {
			expect(editorBody(tab)).toContain("rewritten by the run");
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
	}

	/** Reject, then the dialog's closing delay and the review's own wind-down. */
	async function reject(tab: Tab) {
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
			expect(
				tab.view?.queryByTestId("regeneration-confirm-modal"),
			).toBeNull();
		});
	}

	/** The server finds no earlier version to rewind to. */
	function noPriorVersion() {
		return Object.assign(
			new Error(
				"This document has no prior version to revert to. The current content is still in place.",
			),
			{ code: "CONFLICT" },
		);
	}

	/** Answers the oldest held write, and only it. */
	async function answerOldest() {
		await act(async () => {
			server.held.shift()?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	it("says the regeneration was rejected only once the server has rewound it", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		server.beforeRun = { content: BODY_A, version: 7 };
		await reviewRun(tab);
		server.holdAnswers = true;

		await reject(tab);
		await settle(50);
		expect(server.held).toHaveLength(1);
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");

		await answerOldest();
		await waitFor(() => {
			expect(toast.info).toHaveBeenCalledWith("regenerationRejected");
		});
		expect(toast.error).not.toHaveBeenCalled();
		expect(saveCalls).toEqual([]);
	});

	it("a Reject the server refuses says why in the reader's words, and never that it was rejected", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		await reviewRun(tab);
		server.rejectError = Object.assign(new Error("Database unavailable"), {
			code: "INTERNAL_SERVER_ERROR",
		});

		await reject(tab);
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("failed");
		});
		await settle(50);
		expect(toast.error).not.toHaveBeenCalledWith(
			expect.stringContaining("Database unavailable"),
		);
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_B);
	});

	it("keeps the editor read-only through a sync loss while the Reject is unanswered, and offers back what still reached the editor before the rewind replaces it", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		server.beforeRun = { content: BODY_A, version: 7 };
		await reviewRun(tab);
		server.holdAnswers = true;
		await reject(tab);
		expect(server.held).toHaveLength(1);

		// The room drops and comes back while the Reject is out.
		tab.synced = false;
		rerender(tab);
		await settle(20);
		expect(mainEditor(tab)).toBeNull();
		tab.synced = true;
		rerender(tab);
		await waitFor(() => {
			expect(mainEditor(tab)).not.toBeNull();
		});
		// Past the review's own wind-down.
		await settle(1200);
		expect(mainEditor(tab)?.isEditable).toBe(false);
		expect(saveButton(tab)).toBeDisabled();

		// Typing that reached the editor anyway is not dropped.
		await act(async () => {
			mainEditor(tab)?.setEditable(true);
		});
		await type(tab, " Typed while the Reject was out.");

		await answerOldest();
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual({
				version: 7,
				contentHash: hashOf(BODY_A),
			});
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
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(true);
		});
		expect(saveCalls).toEqual([]);
	});

	it("keeps the editor read-only while the Reject is unanswered, and gives it back once the answer is applied", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		server.beforeRun = { content: BODY_A, version: 7 };
		await reviewRun(tab);
		server.holdAnswers = true;

		await reject(tab);
		// Past the review's own wind-down.
		await settle(1200);
		expect(server.held).toHaveLength(1);
		expect(mainEditor(tab)?.isEditable).toBe(false);
		expect(saveButton(tab)).toBeDisabled();

		await answerOldest();
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual({
				version: 7,
				contentHash: hashOf(BODY_A),
			});
		});
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(true);
		});
		expect(editorBody(tab)).toContain("Phase one, then two.");
	});

	it("with nothing to rewind to, the earlier body is not saved over a colleague's save that landed while the Reject was unanswered: the review is said to be stale and the colleague's text stays", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		const colleague = await openTab("colleague");
		await reviewRun(tab);
		server.rejectError = noPriorVersion();
		server.holdAnswers = true;
		await reject(tab);
		expect(server.held).toHaveLength(1);

		// The colleague saves meanwhile; its answer comes first and moves
		// the room's stamp.
		await type(colleague, " Saved by a colleague.");
		await clickSave(colleague);
		await waitFor(() => {
			expect(server.held).toHaveLength(2);
		});
		await act(async () => {
			server.held.splice(1, 1)[0]?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});

		// The Reject's answer: nothing to rewind to.
		server.holdAnswers = false;
		await answerOldest();
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("rejectReviewStale");
		});
		await settle(100);
		expect(saveCalls.map((call) => call.tab)).toEqual(["colleague"]);
		expect(server.version).toBe(9);
		expect(server.content).toContain("Saved by a colleague.");
		expect(await roomBody()).toContain("Saved by a colleague.");
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(true);
		});
	});

	it("with nothing to rewind to, says the regeneration was rejected only once the earlier body's save has landed", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		await reviewRun(tab);
		server.rejectError = noPriorVersion();
		server.holdAnswers = true;
		await reject(tab);
		expect(server.held).toHaveLength(1);

		// The Reject's answer: nothing to rewind to. The earlier body goes,
		// from the run's stamp, and its answer is held.
		await answerOldest();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			content: BODY_A,
			skipVersionBump: true,
			expectedVersion: 8,
			expectedContentHash: hashOf(BODY_B),
		});
		await settle(50);
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");

		await answerOldest();
		await waitFor(() => {
			expect(toast.info).toHaveBeenCalledWith("regenerationRejected");
		});
		expect(server.content).toBe(BODY_A);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("with nothing to rewind to, a refused save of the earlier body says why, and never that the regeneration was rejected", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		await reviewRun(tab);
		server.rejectError = noPriorVersion();
		server.failNext = new Error("Service unavailable");

		await reject(tab);
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"failed",
				SAVE_FAILED_TOAST,
			);
		});
		await settle(50);
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({
			content: BODY_A,
			skipVersionBump: true,
		});
		expect(server.content).toBe(BODY_B);
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");
	});

	it("with nothing to rewind to, in a room without a stamp, sends nothing and says the editor is updating to the latest version", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("starter");
		await reviewRun(tab);
		// The room loses its stamp, and is looked at again only after the
		// observation gap.
		harness.timings.observationGapMs = 60_000;
		await act(async () => {
			room.doc.getMap(ROOM_META_MAP).delete("stamp");
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(readRoomStamp(tab.doc)).toBeNull();
		server.rejectError = noPriorVersion();

		await reject(tab);
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"saveBlocked.updatingToLatest",
			);
		});
		await settle(50);
		expect(readRoomStamp(room.doc)).toBeNull();
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_B);
		expect(toast.info).not.toHaveBeenCalledWith("regenerationRejected");
	});
});
