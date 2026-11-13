import type * as Y from "yjs";
import {
	act,
	BODY_A,
	BODY_B,
	describe,
	type Editor,
	editorBody,
	expect,
	GENERATION_RUN_AWARENESS_FIELD,
	harness,
	hashOf,
	it,
	mainEditor,
	nudge,
	occurrences,
	offerBackCalls,
	openTab,
	persistRoom,
	ROOM_BODY_FRAGMENT,
	ROOM_META_MAP,
	ROOM_SAVE_AWARENESS_FIELD,
	rawTextarea,
	readConvergenceClaim,
	readRoomStamp,
	rerender,
	resume,
	room,
	roomBody,
	roomEditorContent,
	saveButton,
	saveCalls,
	savedBodyViewText,
	savedStamp,
	server,
	settle,
	type Tab,
	toast,
	toggleRawView,
	transactionTouches,
	type,
	vi,
	waitFor,
	within,
} from "./DocumentEditor.room-convergence.harness";

// ---- Scenarios -------------------------------------------------------------

describe("the room at the end of a run (Fizzy #2946)", () => {
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

	it("the starter's review and an attached follower both end on the run's body, held once by the room, with no save", async () => {
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		expect(editorBody(starter)).toContain("Phase one, then two.");

		await startRunFromChat(starter);
		server.status = "GENERATING";
		await nudge(starter, follower);
		await settle(30);
		expect(follower.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"attached",
		);

		// The run's final save: the new body at the old version.
		server.content = BODY_B;
		server.status = "COMPLETE";
		await nudge(starter, follower);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
		});
		await waitFor(() => {
			expect(editorBody(starter)).toContain("rewritten by the run");
			expect(editorBody(follower)).toContain("rewritten by the run");
		});
		expect(readRoomStamp(room.doc)).toEqual({
			version: 7,
			contentHash: hashOf(BODY_B),
		});

		// Its version step: the same body, so only the stamp moves.
		server.version = 8;
		await nudge(starter, follower);
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		expect(occurrences(await roomBody(), "rewritten by the run")).toBe(1);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(saveCalls).toEqual([]);
	});

	it("a Reject that rewinds the version brings the room back to the earlier body, stamped, with no save", async () => {
		await persistRoom(BODY_A, savedStamp());
		// The stamp follows the rewind itself, not a later look at the room.
		harness.timings.observationGapMs = 5000;
		const starter = await openTab("starter");
		const colleague = await openTab("colleague");
		server.beforeRun = { content: BODY_A, version: 7 };
		await startRunFromChat(starter);
		server.status = "GENERATING";
		await nudge(starter, colleague);

		server.content = BODY_B;
		server.version = 8;
		server.status = "COMPLETE";
		await nudge(starter, colleague);
		await waitFor(() => {
			expect(editorBody(colleague)).toContain("rewritten by the run");
		});
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());

		await act(async () => {
			within(
				starter.view?.getByTestId(
					"regeneration-confirm-modal",
				) as HTMLElement,
			)
				.getByRole("button", { name: "Reject" })
				.click();
			// The dialog closes on a short delay before it rejects.
			await new Promise((resolve) => setTimeout(resolve, 900));
		});

		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual({
				version: 7,
				contentHash: hashOf(BODY_A),
			});
		});
		expect(server.content).toBe(BODY_A);
		const held = await roomBody();
		expect(occurrences(held, "Phase one, then two.")).toBe(1);
		expect(held).not.toContain("rewritten by the run");
		expect(editorBody(colleague)).toContain("Phase one, then two.");
		expect(starter.awareness.own[ROOM_SAVE_AWARENESS_FIELD]).toBeNull();
		// The colleague takes the rewind for the room's own doing: nothing
		// converges and nothing is saved.
		await nudge(colleague);
		await settle(200);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		expect(saveCalls).toEqual([]);
		expect(offerBackCalls()).toHaveLength(0);
	});

	/**
	 * Types two characters at the end and deletes them again: Save is on in
	 * between, and off after only if the editor's saved body is what it
	 * holds.
	 */
	async function typeAndDeleteBack(tab: Tab) {
		const editor = mainEditor(tab) as Editor;
		const at = editor.state.doc.content.size - 1;
		await act(async () => {
			editor.commands.insertContentAt(at, " x");
		});
		await settle(220);
		expect(saveButton(tab)).not.toBeDisabled();
		await act(async () => {
			editor.commands.deleteRange({ from: at, to: at + 2 });
		});
		await settle(220);
	}

	/** Whether this tab, and not another, draws the saved body. */
	function drawsSavedBody(tab: Tab): boolean {
		return (
			tab.view?.container.querySelector(
				'[data-testid="room-saved-body"]',
			) != null
		);
	}

	/** A run the starter began ends on BODY_B, at version 7 still. */
	async function runEndsOnBody(starter: Tab, ...others: Tab[]) {
		await startRunFromChat(starter);
		server.status = "GENERATING";
		await nudge(starter, ...others);
		await settle(30);
		server.content = BODY_B;
		server.status = "COMPLETE";
		await nudge(starter, ...others);
	}

	it("a background starter whose frames are held still puts the run's body into the room at once: neither tab hides its editor behind the saved body", async () => {
		// Production waits: a convergence would take seconds.
		Object.assign(harness.timings, {
			observationGapMs: 3000,
			claimSettleMs: 1500,
			fallThroughMs: 10_000,
		});
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		await startRunFromChat(starter);
		server.status = "GENERATING";
		await nudge(starter, follower);
		await settle(30);

		// A background tab: frames wait until it is shown again.
		const heldFrames: FrameRequestCallback[] = [];
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
			heldFrames.push(cb);
			return heldFrames.length;
		});
		server.content = BODY_B;
		server.status = "COMPLETE";
		await nudge(starter, follower);

		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(starter)).toContain("rewritten by the run");
				expect(editorBody(follower)).toContain("rewritten by the run");
			},
			{ timeout: 500 },
		);
		for (let look = 0; look < 6; look += 1) {
			expect(drawsSavedBody(starter)).toBe(false);
			expect(drawsSavedBody(follower)).toBe(false);
			await settle(100);
		}
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(occurrences(await roomBody(), "rewritten by the run")).toBe(1);
		expect(saveCalls).toEqual([]);
	});

	/**
	 * Steps through the end of a run in production waits and lists every
	 * moment a tab showed the previous body in an editor that takes input, or
	 * had Save on, until the room holds `marker` under the saved stamp.
	 */
	async function watchRunEnd(tabs: Tab[], marker: string) {
		const STEP_MS = 250;
		const violations: string[] = [];
		const converged = () =>
			readRoomStamp(room.doc)?.contentHash === hashOf(server.content) &&
			tabs.every(
				(tab) =>
					!drawsSavedBody(tab) && editorBody(tab).includes(marker),
			);
		for (let at = 0; at <= 20_000; at += STEP_MS) {
			for (const tab of tabs) {
				const editorHidden =
					roomEditorContent(tab)?.className.includes("hidden") ??
					true;
				const previousBody = !editorBody(tab).includes(marker);
				const editable = mainEditor(tab)?.isEditable === true;
				const saveOff = saveButton(tab).hasAttribute("disabled");
				if ((!editorHidden && previousBody && editable) || !saveOff) {
					violations.push(
						`${at} ms ${tab.name}: ${previousBody ? "previous" : "run's"} body${editable ? ", editable" : ""}; Save ${saveOff ? "off" : "on"}`,
					);
				}
			}
			if (converged()) {
				break;
			}
			await act(async () => {
				await vi.advanceTimersByTimeAsync(STEP_MS);
			});
		}
		return { violations, converged: converged() };
	}

	const BODY_C =
		"## Scope\n\nPhase one, then two, rewritten by a later run.\n\n## Pricing\n\nA fixed fee per phase.";

	/**
	 * A later run that no open tab started — a colleague whose tab is closed,
	 * the API, the MCP gateway, a batch: the open tabs only hear that the
	 * document generates, then that it is complete on BODY_C.
	 */
	async function laterRunStartsOutside(...tabs: Tab[]) {
		server.generationStartedAt = new Date(
			Date.now() + 60_000,
		).toISOString();
		server.status = "GENERATING";
		await nudge(...tabs);
		// A closed review stops counting as open a second later.
		await settle(1100);
		await nudge(...tabs);
		await settle(30);
	}

	it("a run started outside the open tabs, while one tab still holds the review of an earlier run, never leaves the previous body editable when it ends", async () => {
		// Production waits: a convergence would take seconds.
		Object.assign(harness.timings, {
			observationGapMs: 3000,
			claimSettleMs: 1500,
			fallThroughMs: 10_000,
		});
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", {
			clientId: 20,
			attachToServerRun: true,
		});
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		server.generationStartedAt = new Date().toISOString();
		await runEndsOnBody(starter, follower);
		server.version = 8;
		await nudge(starter, follower);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
			expect(editorBody(follower)).toContain("rewritten by the run");
		});

		// The starter leaves its review open; a later run starts elsewhere.
		// The review no longer describes the document, so it closes, and the
		// starter follows the later run like the follower does (Fizzy #2946).
		await laterRunStartsOutside(starter, follower);
		expect(
			starter.view?.queryByTestId("regeneration-confirm-modal"),
		).toBeNull();
		expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
			"reviewSupersededByRun",
		);
		expect(starter.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"attached",
		);
		expect(follower.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"attached",
		);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		server.content = BODY_C;
		server.status = "COMPLETE";
		await nudge(starter, follower);
		const { violations, converged } = await watchRunEnd(
			[starter, follower],
			"rewritten by a later run",
		);
		vi.useRealTimers();

		expect(violations).toEqual([]);
		expect(converged).toBe(true);
		// One editor wrote the run's body with its stamp: no second look, no
		// claim, no save.
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(occurrences(await roomBody(), "rewritten by a later run")).toBe(
			1,
		);
		expect(saveCalls).toEqual([]);
	});

	it("an attached tab writes the body of a run started outside the open tabs even when the tab holding an earlier run's review learns of that run only as it ends", async () => {
		Object.assign(harness.timings, {
			observationGapMs: 3000,
			claimSettleMs: 1500,
			fallThroughMs: 10_000,
		});
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", {
			clientId: 20,
			attachToServerRun: true,
		});
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		server.generationStartedAt = new Date().toISOString();
		await runEndsOnBody(starter, follower);
		server.version = 8;
		await nudge(starter, follower);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
			expect(editorBody(follower)).toContain("rewritten by the run");
		});

		// Only the follower hears that the later run started.
		await laterRunStartsOutside(follower);
		expect(
			starter.view?.queryByTestId("regeneration-confirm-modal"),
		).not.toBeNull();
		expect(starter.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"started",
		);
		expect(follower.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"attached",
		);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		server.content = BODY_C;
		server.status = "COMPLETE";
		await nudge(starter, follower);
		const { violations, converged } = await watchRunEnd(
			[starter, follower],
			"rewritten by a later run",
		);
		vi.useRealTimers();

		expect(violations).toEqual([]);
		expect(converged).toBe(true);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(occurrences(await roomBody(), "rewritten by a later run")).toBe(
			1,
		);
		expect(saveCalls).toEqual([]);
	});

	it("a starter whose page has not read its run's identity yet still writes that run's body alone, even when a follower reads the end first and the room relays late", async () => {
		await persistRoom(BODY_A, savedStamp());
		// An earlier run's identity, all the starter's page has read.
		server.generationStartedAt = "2026-10-21T09:00:00.000Z";
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		await startRunFromChat(starter);
		server.generationStartedAt = new Date().toISOString();
		server.status = "GENERATING";
		await nudge(follower);
		await settle(30);
		expect(follower.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"attached",
		);

		server.content = BODY_B;
		server.status = "COMPLETE";
		room.paused = true;
		await nudge(follower);
		await settle(50);
		await nudge(starter);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
		});
		await settle(50);
		await resume();
		await settle(100);

		expect(occurrences(await roomBody(), "rewritten by the run")).toBe(1);
		expect(saveCalls).toEqual([]);
	});

	it("without the room's stamps, a tab that does not follow runs keeps the review of an earlier run until a later run's body arrives, then shows that body", async () => {
		harness.flags = { DOCUMENT_ROOM_CONVERGENCE: false };
		await persistRoom(BODY_A, null);
		const starter = await openTab("starter");
		server.generationStartedAt = new Date().toISOString();
		await runEndsOnBody(starter);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
		});

		// Closing it now would leave the earlier body on screen: nothing
		// brings this editor the later run's body.
		await laterRunStartsOutside(starter);
		expect(
			starter.view?.queryByTestId("regeneration-confirm-modal"),
		).not.toBeNull();

		server.content = BODY_C;
		server.status = "COMPLETE";
		await nudge(starter);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).toBeNull();
			expect(editorBody(starter)).toContain("rewritten by a later run");
		});
		expect(vi.mocked(toast.info)).toHaveBeenCalledWith("reviewSuperseded");
		expect(saveCalls).toEqual([]);
	});

	it("a tab alone with the review of an earlier run follows a run started elsewhere and puts its body into the room when it ends", async () => {
		Object.assign(harness.timings, {
			observationGapMs: 3000,
			claimSettleMs: 1500,
			fallThroughMs: 10_000,
		});
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { attachToServerRun: true });
		server.generationStartedAt = new Date().toISOString();
		await runEndsOnBody(starter);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
		});

		await laterRunStartsOutside(starter);
		expect(
			starter.view?.queryByTestId("regeneration-confirm-modal"),
		).toBeNull();
		expect(starter.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
			"attached",
		);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		server.content = BODY_C;
		server.status = "COMPLETE";
		await nudge(starter);
		const { violations, converged } = await watchRunEnd(
			[starter],
			"rewritten by a later run",
		);
		vi.useRealTimers();

		expect(violations).toEqual([]);
		expect(converged).toBe(true);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(occurrences(await roomBody(), "rewritten by a later run")).toBe(
			1,
		);
		expect(saveCalls).toEqual([]);
	});

	it("an attached follower that typed nothing keeps Save off and never autosaves once the run's body lands, whether the version step is announced or not; nor does the starter after Accept", async () => {
		harness.autosave.delayMs = 300;
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		await runEndsOnBody(starter, follower);
		await waitFor(() => {
			expect(editorBody(follower)).toContain("rewritten by the run");
		});
		await settle(200);
		expect(saveButton(follower)).toHaveAccessibleName(
			"Document saved, no changes to save",
		);
		expect(saveButton(follower)).toBeDisabled();

		// The run's version step, which nothing announces.
		server.version = 8;
		await settle(700);
		expect(saveButton(follower)).toBeDisabled();
		expect(saveCalls).toEqual([]);

		// Something else announces a change later: the stamp moves.
		await nudge(starter, follower);
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		await settle(700);
		expect(saveButton(follower)).toBeDisabled();
		expect(saveCalls).toEqual([]);

		await act(async () => {
			within(
				starter.view?.getByTestId(
					"regeneration-confirm-modal",
				) as HTMLElement,
			)
				.getByRole("button", { name: "Accept" })
				.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(1500);
		expect(saveButton(starter)).toHaveAccessibleName(
			"Document saved, no changes to save",
		);
		expect(saveButton(follower)).toBeDisabled();
		expect(saveCalls).toEqual([]);
	});

	it("an attached follower takes the run's body as its saved body: typing and deleting it back turns Save off again", async () => {
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		await runEndsOnBody(starter, follower);
		await waitFor(() => {
			expect(editorBody(follower)).toContain("rewritten by the run");
		});
		await settle(200);

		await typeAndDeleteBack(follower);
		expect(editorBody(follower)).toBe(editorBody(starter));
		expect(saveButton(follower)).toBeDisabled();
	});

	it("an attached follower takes the run's body as its saved body when the version step's stamp reaches the room before it looks", async () => {
		const { starter, follower } = await reviewWithFollower({
			content: BODY_A,
			version: 7,
		});

		await typeAndDeleteBack(follower);
		expect(editorBody(follower)).toBe(editorBody(starter));
		expect(saveButton(follower)).toBeDisabled();
	});

	it("the run's unannounced version step moves the room's stamp at once, without a second look or a claim", async () => {
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		await runEndsOnBody(starter, follower);
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		await settle(100);
		// A second look would take five seconds.
		harness.timings.observationGapMs = 5000;

		server.version = 8;
		await nudge(follower);
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			},
			{ timeout: 500 },
		);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(drawsSavedBody(follower)).toBe(false);
		expect(saveCalls).toEqual([]);
	});

	/**
	 * The starter reviews the run's BODY_B at version 8 and an attached
	 * follower holds it; the rewind goes back to `beforeRun`.
	 */
	async function reviewWithFollower(beforeRun: {
		content: string;
		version: number;
	}) {
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		server.beforeRun = beforeRun;
		await runEndsOnBody(starter, follower);
		server.version = 8;
		await nudge(starter, follower);
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			expect(editorBody(follower)).toContain("rewritten by the run");
		});
		await settle(200);
		return { starter, follower };
	}

	async function clickReject(tab: Tab) {
		await act(async () => {
			within(
				tab.view?.getByTestId(
					"regeneration-confirm-modal",
				) as HTMLElement,
			)
				.getByRole("button", { name: "Reject" })
				.click();
			// The dialog closes on a short delay before it rejects.
			await new Promise((resolve) => setTimeout(resolve, 900));
		});
	}

	/** Room transactions that changed the body without its stamp. */
	function watchUnstampedBodyWrites(): Y.Transaction[] {
		const unstamped: Y.Transaction[] = [];
		const meta = room.doc.getMap(ROOM_META_MAP);
		const body = room.doc.getXmlFragment(ROOM_BODY_FRAGMENT);
		room.doc.on("afterTransaction", (transaction: Y.Transaction) => {
			if (
				transactionTouches(transaction, body) &&
				!transaction.changed
					.get(meta as unknown as Y.AbstractType<Y.YEvent<any>>)
					?.has("stamp")
			) {
				unstamped.push(transaction);
			}
		});
		return unstamped;
	}

	it("a Reject leaves the room alone until the server answers, then puts the rewound body in with its stamp, and no one saves", async () => {
		harness.autosave.delayMs = 300;
		const { starter, follower } = await reviewWithFollower({
			content: BODY_A,
			version: 7,
		});
		const unstamped = watchUnstampedBodyWrites();
		server.holdAnswers = true;
		await clickReject(starter);

		expect(server.held).toHaveLength(1);
		expect(await roomBody()).toContain("rewritten by the run");
		expect(readRoomStamp(room.doc)).toEqual({
			version: 8,
			contentHash: hashOf(BODY_B),
		});
		expect(editorBody(follower)).toContain("rewritten by the run");
		expect(saveButton(follower)).toBeDisabled();

		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual({
				version: 7,
				contentHash: hashOf(BODY_A),
			});
		});
		const held = await roomBody();
		expect(occurrences(held, "Phase one, then two.")).toBe(1);
		expect(held).not.toContain("rewritten by the run");
		expect(unstamped).toEqual([]);
		await waitFor(() => {
			expect(editorBody(follower)).toContain("Phase one, then two.");
		});

		await nudge(starter, follower);
		await settle(700);
		expect(saveButton(follower)).toBeDisabled();
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_A);
	});

	it("a Reject the server rewinds to a body other than the one the editor remembered ends the room on the server's body, under its stamp, and nothing writes the remembered one", async () => {
		harness.autosave.delayMs = 300;
		const BODY_C =
			"## Scope\n\nPhase one, then two, as saved before the run.\n\n## Pricing\n\nA fixed fee.";
		const { starter, follower } = await reviewWithFollower({
			content: BODY_C,
			version: 7,
		});
		await clickReject(starter);

		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual({
				version: 7,
				contentHash: hashOf(BODY_C),
			});
		});
		expect(await roomBody()).toContain("as saved before the run");
		await waitFor(() => {
			expect(editorBody(starter)).toContain("as saved before the run");
			expect(editorBody(follower)).toContain("as saved before the run");
		});

		await nudge(starter, follower);
		await settle(700);
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_C);
		expect(server.version).toBe(7);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
	});

	it("a Reject's answer leaves the room alone when a colleague's save moved it after the rewind: the colleague's body stays, under its stamp", async () => {
		const BODY_C =
			"## Scope\n\nPhase one, saved by a colleague after the rewind.\n\n## Pricing\n\nA fixed fee.";
		const { starter, follower } = await reviewWithFollower({
			content: BODY_A,
			version: 7,
		});
		// Only the answer may move the room here, not a later look at it.
		harness.timings.observationGapMs = 5000;
		server.holdAnswers = true;
		await clickReject(starter);
		expect(server.held).toHaveLength(1);
		expect(server.content).toBe(BODY_A);

		// The rewind is done; a colleague's save lands before its answer,
		// and the colleague's editor puts it into the room with its stamp.
		server.content = BODY_C;
		server.version = 8;
		await act(async () => {
			await persistRoom(BODY_C, savedStamp());
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(editorBody(starter)).toContain("saved by a colleague");
		});

		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(100);

		expect(readRoomStamp(room.doc)).toEqual({
			version: 8,
			contentHash: hashOf(BODY_C),
		});
		const held = await roomBody();
		expect(occurrences(held, "saved by a colleague")).toBe(1);
		expect(held).not.toContain("Phase one, then two.");
		expect(editorBody(starter)).toContain("saved by a colleague");
		expect(editorBody(follower)).toContain("saved by a colleague");
		expect(starter.awareness.own[ROOM_SAVE_AWARENESS_FIELD]).toBeNull();
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_C);
	});

	it("a Reject the server refuses as stale leaves the room to the stale rule: it ends on the newer saved body, and a colleague's unsaved typing is offered back", async () => {
		const BODY_C =
			"## Scope\n\nPhase one, written outside the room.\n\n## Pricing\n\nA fixed fee.";
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		server.beforeRun = { content: BODY_A, version: 7 };
		await runEndsOnBody(starter, follower);
		await waitFor(() => {
			expect(editorBody(follower)).toContain("rewritten by the run");
		});
		await settle(200);
		harness.autosave.delayMs = 60_000;
		await type(follower, " Typed by the follower.");
		// A write from outside the room that nobody announced yet.
		server.content = BODY_C;
		server.version = 8;
		server.rejectError = Object.assign(new Error("stale"), {
			code: "CONFLICT",
			data: { code: "REJECT_REVIEW_STALE" },
		});

		await clickReject(starter);
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("rejectReviewStale");
		});
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual({
					version: 8,
					contentHash: hashOf(BODY_C),
				});
			},
			{ timeout: 3000 },
		);
		await settle(200);
		expect(offerBackCalls()).toHaveLength(1);
		const held = await roomBody();
		expect(occurrences(held, "written outside the room")).toBe(1);
		expect(held).not.toContain("rewritten by the run");
		expect(saveCalls).toEqual([]);
		expect(server.content).toBe(BODY_C);
	});

	it("a review a newer saved body superseded closes in the room without writing anything: the stale rule brings the room to the newer body", async () => {
		const BODY_C =
			"## Scope\n\nPhase one, rewritten by a second run.\n\n## Pricing\n\nA fixed fee.";
		const { starter, follower } = await reviewWithFollower({
			content: BODY_A,
			version: 7,
		});
		const unstamped = watchUnstampedBodyWrites();

		server.content = BODY_C;
		server.version = 9;
		await nudge(starter, follower);
		await waitFor(() => {
			expect(
				starter.view?.queryByTestId("regeneration-confirm-modal"),
			).toBeNull();
		});
		expect(toast.info).toHaveBeenCalledWith("reviewSuperseded");
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual({
					version: 9,
					contentHash: hashOf(BODY_C),
				});
			},
			{ timeout: 3000 },
		);
		await settle(100);
		expect(occurrences(await roomBody(), "rewritten by a second run")).toBe(
			1,
		);
		expect(editorBody(starter)).toContain("rewritten by a second run");
		expect(editorBody(follower)).toContain("rewritten by a second run");
		expect(unstamped).toEqual([]);
		expect(saveCalls).toEqual([]);
	});

	it("an editor mounted after the review opened leaves a room that already holds the reviewed body, and a colleague's typing on it, alone", async () => {
		await persistRoom(BODY_A, savedStamp());
		const starter = await openTab("starter", { clientId: 20 });
		const follower = await openTab("follower", {
			clientId: 30,
			attachToServerRun: true,
		});
		await startRunFromChat(starter);
		server.status = "GENERATING";
		await nudge(starter, follower);
		await settle(30);

		// The starter's room drops before the run ends: no editor of its
		// is on screen when its review opens.
		starter.synced = false;
		rerender(starter);
		await settle(20);
		expect(mainEditor(starter)).toBeNull();
		server.content = BODY_B;
		server.status = "COMPLETE";
		await nudge(starter, follower);
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(follower)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		await settle(200);
		harness.autosave.delayMs = 60_000;
		await type(follower, " Typed by the follower.");

		// The starter's room is back while its review is open.
		starter.synced = true;
		rerender(starter);
		await waitFor(() => {
			expect(mainEditor(starter)).not.toBeNull();
		});
		await settle(100);

		expect(
			starter.view?.queryByTestId("regeneration-confirm-modal"),
		).not.toBeNull();
		expect(editorBody(starter)).toContain("Typed by the follower.");
		expect(editorBody(follower)).toContain("Typed by the follower.");
		const held = await roomBody();
		expect(occurrences(held, "rewritten by the run")).toBe(1);
		expect(held).toContain("Typed by the follower.");
		expect(saveCalls).toEqual([]);
	});

	describe("what a tab shows between learning of a run's end and the room holding its body", () => {
		/** Production waits: a second look takes a poll, a claim seconds. */
		const PRODUCTION_TIMINGS = {
			observationGapMs: 3000,
			savedBodyGraceMs: 750,
			claimSettleMs: 1500,
			fallThroughMs: 10_000,
		};
		const FAKE_CLOCK = {
			toFake: ["setTimeout", "clearTimeout", "Date"],
		} as const;
		const BODY_C =
			"## Scope\n\nPhase one, then two, rewritten by a later run.\n\n## Pricing\n\nA fixed fee per phase.";

		/** Which body a text is: before the run, the run's, a later run's. */
		function bodyMarker(text: string): string {
			if (text.includes("rewritten by a later run")) {
				return "later";
			}
			if (text.includes("rewritten by the run")) {
				return "run";
			}
			if (text.includes("Phase one, then two.")) {
				return "before";
			}
			return text.trim() ? "other" : "empty";
		}

		type Sample = {
			at: number;
			tab: string;
			body: string;
			savedView: boolean;
			editable: boolean;
			saveOff: boolean;
			/** The saved body's editor is built, hidden, ahead of showing. */
			savedBodyReady: boolean;
		};

		function describeSample(sample: Sample): string {
			const how = sample.savedView
				? "saved body"
				: sample.editable
					? "editable"
					: "read-only";
			return `${sample.at} ms ${sample.tab}: ${sample.body}, ${how}, Save ${sample.saveOff ? "off" : "on"}`;
		}

		// The view's queries search the whole page, which holds every tab:
		// these look in one tab's own part of it.
		function drawsSavedBody(tab: Tab): boolean {
			return (
				tab.view?.container.querySelector(
					'[data-testid="room-saved-body"]',
				) != null
			);
		}
		function roomEditorHidden(tab: Tab): boolean {
			const content = [
				...(tab.view?.container.querySelectorAll(
					'[data-testid="editor-content"]',
				) ?? []),
			].find(
				(element) =>
					!element.closest('[data-testid="room-saved-body"]'),
			);
			return content?.className.includes("hidden") ?? true;
		}

		/** Steps the fake clock, noting every `stepMs` what each tab shows. */
		async function sampleShown(tabs: Tab[], untilMs: number, stepMs = 250) {
			const samples: Sample[] = [];
			for (let at = 0; at <= untilMs; at += stepMs) {
				for (const tab of tabs) {
					const savedView = drawsSavedBody(tab);
					const editorHidden = roomEditorHidden(tab);
					samples.push({
						at,
						tab: tab.name,
						body: bodyMarker(
							savedView
								? savedBodyViewText(tab)
								: editorBody(tab),
						),
						savedView,
						editable:
							!editorHidden &&
							mainEditor(tab)?.isEditable === true,
						saveOff: saveButton(tab).hasAttribute("disabled"),
						savedBodyReady:
							tab.view?.container.querySelector(
								'[data-testid="room-saved-body-ready"]',
							) != null,
					});
				}
				await act(async () => {
					await vi.advanceTimersByTimeAsync(stepMs);
				});
			}
			return samples;
		}

		/**
		 * The moments a tab showed another body than the run's other than as
		 * allowed: the body from before, read-only with Save off, within the
		 * grace.
		 */
		function otherThanTheRuns(samples: Sample[], body: string): string[] {
			return samples
				.filter(
					(sample) =>
						sample.body !== body &&
						(sample.at > PRODUCTION_TIMINGS.savedBodyGraceMs ||
							sample.editable ||
							sample.savedView ||
							!sample.saveOff),
				)
				.map(describeSample);
		}

		/** Steps the fake clock until `done`, at most `maxMs`. */
		async function stepUntil(done: () => boolean, maxMs = 20_000) {
			for (let at = 0; at <= maxMs; at += 100) {
				if (done()) {
					return true;
				}
				await act(async () => {
					await vi.advanceTimersByTimeAsync(100);
				});
			}
			return done();
		}

		/** The room holds the saved body under its stamp, and the tabs show it. */
		function convergedOn(tabs: Tab[], body: string) {
			return () =>
				readRoomStamp(room.doc)?.contentHash ===
					hashOf(server.content) &&
				tabs.every(
					(tab) =>
						!drawsSavedBody(tab) &&
						bodyMarker(editorBody(tab)) === body &&
						within(tab.syncSlot).queryByTestId("sync-pill") !==
							null,
				);
		}

		it("a passive follower that learns of a UI-started run's end a poll before its starter never shows the previous body editable: it holds it still, then shows the run's saved body until the starter's review puts it into the room", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			const starter = await openTab("starter", { clientId: 20 });
			const follower = await openTab("follower", {
				clientId: 30,
				attachToServerRun: true,
			});
			await startRunFromChat(starter);
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(starter, follower);
			await settle(30);
			expect(starter.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
				"started",
			);
			expect(follower.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
				"attached",
			);

			vi.useFakeTimers(FAKE_CLOCK);
			// The run's final save. The follower's poll lands just after it,
			// the starter's a poll later.
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(follower);
			const meanwhile = await sampleShown([follower], 2750);
			await nudge(starter);
			const converged = await stepUntil(
				convergedOn([starter, follower], "run"),
			);
			vi.useRealTimers();

			expect(otherThanTheRuns(meanwhile, "run")).toEqual([]);
			expect(meanwhile.some((sample) => sample.savedView)).toBe(true);
			// The starter's review put the body in, once; no claim, no save.
			expect(converged).toBe(true);
			expect(readConvergenceClaim(room.doc)).toBeNull();
			expect(occurrences(await roomBody(), "rewritten by the run")).toBe(
				1,
			);
			expect(saveCalls).toEqual([]);
		});

		it("a run no open tab follows: every tab holds the previous body still, then shows the run's saved body until the room is brought to it", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			// Not on the artifact page: neither tab attaches to the run.
			const one = await openTab("one", { clientId: 20 });
			const two = await openTab("two", { clientId: 30 });
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(one, two);
			await settle(30);

			vi.useFakeTimers(FAKE_CLOCK);
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(one, two);
			const meanwhile = await sampleShown([one, two], 6000);
			const converged = await stepUntil(convergedOn([one, two], "run"));
			vi.useRealTimers();

			expect(otherThanTheRuns(meanwhile, "run")).toEqual([]);
			expect(meanwhile.some((sample) => sample.savedView)).toBe(true);
			// The fallback brought the room to the saved body: one claim, the
			// body once, no save.
			expect(converged).toBe(true);
			expect(readConvergenceClaim(room.doc)?.settled).toBe("verified");
			expect(occurrences(await roomBody(), "rewritten by the run")).toBe(
				1,
			);
			expect(saveCalls).toEqual([]);
		});

		it("a tab alone with the review of an earlier run that learns of a newer run only from its end holds the reviewed body still, then shows the newer run's saved body", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("alone", { attachToServerRun: true });
			server.generationStartedAt = new Date().toISOString();
			await startRunFromChat(tab);
			server.status = "GENERATING";
			await nudge(tab);
			await settle(30);
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(tab);
			await waitFor(() => {
				expect(
					tab.view?.queryByTestId("regeneration-confirm-modal"),
				).not.toBeNull();
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			});
			await settle(100);

			vi.useFakeTimers(FAKE_CLOCK);
			// A later run started elsewhere: this tab hears of it only as it
			// ends.
			server.generationStartedAt = new Date(
				Date.now() + 60_000,
			).toISOString();
			server.content = BODY_C;
			server.status = "COMPLETE";
			await nudge(tab);
			const meanwhile = await sampleShown([tab], 6000);
			const converged = await stepUntil(convergedOn([tab], "later"));
			vi.useRealTimers();

			expect(otherThanTheRuns(meanwhile, "later")).toEqual([]);
			expect(meanwhile.some((sample) => sample.savedView)).toBe(true);
			expect(converged).toBe(true);
			expect(
				tab.view?.queryByTestId("regeneration-confirm-modal"),
			).toBeNull();
			expect(
				occurrences(await roomBody(), "rewritten by a later run"),
			).toBe(1);
			expect(saveCalls).toEqual([]);
		});

		it("the run's saved body is drawn with its text from the first frame it is shown in", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			const one = await openTab("one", { clientId: 20 });
			const two = await openTab("two", { clientId: 30 });
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(one, two);
			await settle(30);

			vi.useFakeTimers(FAKE_CLOCK);
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(one, two);
			const meanwhile = await sampleShown([one, two], 1500);
			vi.useRealTimers();

			expect(meanwhile.some((sample) => sample.savedView)).toBe(true);
			expect(harness.blankSavedBodyFrames).toEqual([]);
		});

		it("tabs opened while the run is under way hold the previous body still at its end, then show the run's saved body", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			// Neither tab saw the room before the run.
			const one = await openTab("one", { clientId: 20 });
			const two = await openTab("two", { clientId: 30 });
			await settle(30);

			vi.useFakeTimers(FAKE_CLOCK);
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(one, two);
			const meanwhile = await sampleShown([one, two], 3000);
			const converged = await stepUntil(convergedOn([one, two], "run"));
			vi.useRealTimers();

			expect(otherThanTheRuns(meanwhile, "run")).toEqual([]);
			expect(meanwhile.some((sample) => sample.savedView)).toBe(true);
			expect(converged).toBe(true);
			expect(occurrences(await roomBody(), "rewritten by the run")).toBe(
				1,
			);
			expect(saveCalls).toEqual([]);
		});

		it("a write outside any run — the API, an agent — leaves the second look as it was: the room's body stays on screen, editable, while saves wait", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			// The row names an earlier run, which the room took in.
			server.generationStartedAt = new Date().toISOString();
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");

			vi.useFakeTimers(FAKE_CLOCK);
			server.content = BODY_B;
			server.version = 8;
			await nudge(tab);
			const meanwhile = await sampleShown([tab], 2750);
			const converged = await stepUntil(convergedOn([tab], "run"));
			vi.useRealTimers();

			expect(
				meanwhile
					.filter(
						(sample) =>
							sample.body !== "before" ||
							!sample.editable ||
							sample.savedView ||
							!sample.saveOff,
					)
					.map(describeSample),
			).toEqual([]);
			// Nor is a hidden saved body built for a look that keeps the
			// room's body on screen (Fizzy #2946).
			expect(
				meanwhile
					.filter((sample) => sample.savedBodyReady)
					.map(describeSample),
			).toEqual([]);
			expect(converged).toBe(true);
			expect(saveCalls).toEqual([]);
		});

		it("a tab back from a drop, whose copy of the document predates a rewind the room took at the same version meanwhile, keeps the room's body: no run ended, so its older copy is never shown", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			// The row names an earlier run, and holds its body.
			server.generationStartedAt = new Date().toISOString();
			server.content = BODY_B;
			await persistRoom(BODY_B, savedStamp());
			const tab = await openTab("tab");
			expect(editorBody(tab)).toContain("rewritten by the run");

			tab.synced = false;
			rerender(tab);
			await settle(20);
			expect(mainEditor(tab)).toBeNull();
			// Meanwhile a colleague rejects that run with no version to go
			// back to: the row and the room go back to the body before it at
			// the same version, and this tab's copy is not asked again.
			server.content = BODY_A;
			await persistRoom(BODY_A, savedStamp());

			vi.useFakeTimers(FAKE_CLOCK);
			tab.synced = true;
			rerender(tab);
			const meanwhile = await sampleShown([tab], 3500);
			const converged = await stepUntil(convergedOn([tab], "before"));
			vi.useRealTimers();

			expect(
				meanwhile
					.filter((sample) => sample.body !== "before")
					.map(describeSample),
			).toEqual([]);
			expect(converged).toBe(true);
			expect(saveCalls).toEqual([]);
		});

		it("a tab back from a drop after a run ended while it was away holds the previous body still: with nothing to tell a run's end from a rewind, it waits read-only for the second look", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");

			tab.synced = false;
			rerender(tab);
			await settle(20);
			expect(mainEditor(tab)).toBeNull();
			// A run starts and ends while the room is away; the tab's copy of
			// the document hears of it.
			server.generationStartedAt = new Date().toISOString();
			server.content = BODY_B;
			await nudge(tab);

			vi.useFakeTimers(FAKE_CLOCK);
			tab.synced = true;
			rerender(tab);
			const meanwhile = await sampleShown([tab], 2750);
			const converged = await stepUntil(convergedOn([tab], "run"));
			vi.useRealTimers();

			expect(
				meanwhile
					.filter(
						(sample) =>
							sample.body !== "run" &&
							(sample.editable || !sample.saveOff),
					)
					.map(describeSample),
			).toEqual([]);
			expect(converged).toBe(true);
			expect(occurrences(await roomBody(), "rewritten by the run")).toBe(
				1,
			);
			expect(saveCalls).toEqual([]);
		});

		it("the raw markdown view holds still too, and shows the run's saved body with the rich view", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			const tab = await openTab("tab");
			// Opened before the run: the views do not switch while it writes.
			await toggleRawView();
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(tab);
			await settle(30);
			expect(rawTextarea(tab).value).toContain("Phase one, then two.");

			vi.useFakeTimers(FAKE_CLOCK);
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(tab);
			const meanwhile: string[] = [];
			for (let at = 0; at <= 2750; at += 250) {
				const area = rawTextarea(tab);
				meanwhile.push(
					`${at} ms: ${bodyMarker(area.value)}, ${area.disabled ? "read-only" : "editable"}`,
				);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(250);
				});
			}
			const converged = await stepUntil(
				() =>
					readRoomStamp(room.doc)?.contentHash === hashOf(BODY_B) &&
					!rawTextarea(tab).disabled,
			);
			vi.useRealTimers();

			expect(
				meanwhile.filter(
					(sample) =>
						sample.endsWith("editable") ||
						(!sample.includes(": run,") &&
							Number(sample.split(" ")[0]) >
								PRODUCTION_TIMINGS.savedBodyGraceMs),
				),
			).toEqual([]);
			expect(meanwhile.some((sample) => sample.includes(": run,"))).toBe(
				true,
			);
			expect(converged).toBe(true);
			expect(rawTextarea(tab).value).toContain("rewritten by the run");
			expect(saveCalls).toEqual([]);
		});

		/**
		 * What a tab's raw view shows, every `stepMs`, until `untilMs`, and
		 * which body the room holds meanwhile.
		 */
		async function sampleRawView(tab: Tab, untilMs: number, stepMs = 250) {
			const samples: string[] = [];
			for (let at = 0; at <= untilMs; at += stepMs) {
				const area = rawTextarea(tab);
				samples.push(
					`${at} ms: ${bodyMarker(area.value)}, ${area.disabled ? "read-only" : "editable"}, room ${readRoomStamp(room.doc)?.contentHash === hashOf(BODY_B) ? "run" : "before"}`,
				);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(stepMs);
				});
			}
			return samples;
		}

		it("a raw view open while a run is under way takes no input, and shows the run's body once the starter's review puts it into the room: never the previous body editable", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			// Opened first, so the shortcut opens the raw view in this tab only.
			const viewer = await openTab("viewer", { clientId: 30 });
			await toggleRawView();
			expect(rawTextarea(viewer).value).toContain("Phase one, then two.");
			const starter = await openTab("starter", { clientId: 20 });

			await startRunFromChat(starter);
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(starter, viewer);
			await settle(30);

			vi.useFakeTimers(FAKE_CLOCK);
			const during = await sampleRawView(viewer, 1000);
			// The run's final save; the viewer's poll lands a poll after the
			// starter's.
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(starter);
			const meanwhile = await sampleRawView(viewer, 2750);
			await nudge(viewer);
			const after = await sampleRawView(viewer, 3000);
			const converged = await stepUntil(
				() =>
					readRoomStamp(room.doc)?.contentHash === hashOf(BODY_B) &&
					!rawTextarea(viewer).disabled,
			);
			vi.useRealTimers();

			expect(
				[...during, ...meanwhile, ...after].filter((sample) =>
					sample.includes(": before, editable"),
				),
			).toEqual([]);
			expect(during.every((sample) => sample.includes("read-only"))).toBe(
				true,
			);
			// Once the room holds the run's body, the raw view shows it. The
			// first look is taken in the tick the room took it in, before the
			// tab has rendered.
			expect(
				[...meanwhile.slice(1), ...after].filter(
					(sample) =>
						sample.endsWith("room run") &&
						!sample.includes(": run,"),
				),
			).toEqual([]);
			expect(converged).toBe(true);
			expect(rawTextarea(viewer).value).toContain("rewritten by the run");
			expect(occurrences(await roomBody(), "rewritten by the run")).toBe(
				1,
			);
			expect(saveCalls).toEqual([]);
		});

		it("the raw view of the editor that writes an attached run's body itself shows that body when the run ends", async () => {
			Object.assign(harness.timings, PRODUCTION_TIMINGS);
			await persistRoom(BODY_A, savedStamp());
			// A run started elsewhere, which this tab alone follows.
			const tab = await openTab("follower", { attachToServerRun: true });
			await toggleRawView();
			server.generationStartedAt = new Date().toISOString();
			server.status = "GENERATING";
			await nudge(tab);
			await settle(30);
			expect(tab.awareness.own[GENERATION_RUN_AWARENESS_FIELD]).toBe(
				"attached",
			);
			expect(rawTextarea(tab).disabled).toBe(true);

			vi.useFakeTimers(FAKE_CLOCK);
			server.content = BODY_B;
			server.status = "COMPLETE";
			await nudge(tab);
			const meanwhile = await sampleRawView(tab, 2750);
			vi.useRealTimers();

			expect(
				meanwhile.filter((sample) => !sample.includes(": run,")),
			).toEqual([]);
			expect(meanwhile.at(-1)).toMatch(/: run, editable,/);
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			expect(occurrences(await roomBody(), "rewritten by the run")).toBe(
				1,
			);
			expect(saveCalls).toEqual([]);
		});
	});
});
