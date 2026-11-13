import {
	act,
	BODY_A,
	BODY_B,
	beforeEach,
	clickSave,
	describe,
	type Editor,
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
	rawTextarea,
	readRoomStamp,
	rerender,
	room,
	roomBody,
	SAVE_FAILED_TOAST,
	saveButton,
	saveCalls,
	savedBodyViewText,
	savedStamp,
	server,
	settle,
	showsSavedBody,
	type Tab,
	toast,
	toggleRawView,
	type,
	vi,
	waitFor,
	within,
} from "./DocumentEditor.room-convergence.harness";

describe("a tab that typed nothing in a room (Fizzy #2946)", () => {
	it("stays saved and never autosaves while a colleague types into the room", async () => {
		harness.autosave.delayMs = 300;
		await persistRoom(BODY_A, savedStamp());
		const typist = await openTab("typist", { clientId: 10 });
		const watcher = await openTab("watcher", { clientId: 20 });

		await type(typist, " Typed by a colleague.");
		await waitFor(() => {
			expect(editorBody(watcher)).toContain("Typed by a colleague.");
		});
		await settle(50);
		expect(saveButton(watcher)).toBeDisabled();

		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		await settle(700);
		expect(saveCalls.map((call) => call.tab)).toEqual(["typist"]);
		expect(saveButton(watcher)).toBeDisabled();
	});

	it("counts an edit in the raw view as typing: a saved body the room brings in does not replace it", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await toggleRawView();
		const edited = `${rawTextarea(tab).value}\n\nEdited in the raw view.`;
		await act(async () => {
			fireEvent.change(rawTextarea(tab), { target: { value: edited } });
		});
		await settle(50);
		expect(saveButton(tab)).not.toBeDisabled();

		// The saved document's unannounced version step, which an editor
		// with nothing typed takes as its saved body.
		server.version = 8;
		await nudge(tab);
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		await settle(100);

		expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
		expect(saveButton(tab)).not.toBeDisabled();
	});

	it("offers back the raw view's edits when the room is brought to a newer saved body, and keeps them there, unsaved", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await toggleRawView();
		const edited = `${rawTextarea(tab).value}\n\nEdited in the raw view.`;
		await act(async () => {
			fireEvent.change(rawTextarea(tab), { target: { value: edited } });
		});
		await settle(50);

		// A write from outside the room: the room is behind it.
		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			},
			{ timeout: 3000 },
		);
		await settle(100);

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
			expect.stringContaining("Edited in the raw view."),
		);
		expect(rawTextarea(tab).value).toContain("Edited in the raw view.");
		expect(saveButton(tab)).not.toBeDisabled();
		expect(await roomBody()).toContain("rewritten by the run");
		expect(saveCalls).toEqual([]);
	});

	it("a raw view with no edits of its own shows a colleague's typing as it reaches the room, and stays saved", async () => {
		await persistRoom(BODY_A, savedStamp());
		// Opened first, so the shortcut opens the raw view in this tab only.
		const watcher = await openTab("watcher", { clientId: 20 });
		await toggleRawView();
		const typist = await openTab("typist", { clientId: 10 });

		await type(typist, " Typed by a colleague.");
		await waitFor(() => {
			expect(rawTextarea(watcher).value).toContain(
				"Typed by a colleague.",
			);
		});
		expect(rawTextarea(watcher).disabled).toBe(false);
		await settle(200);
		expect(saveButton(watcher)).toBeDisabled();
		expect(saveCalls.filter((call) => call.tab === "watcher")).toEqual([]);
	});

	it("a raw view someone is reading keeps the caret in its place in the text while a colleague's typing reaches it", async () => {
		await persistRoom(BODY_A, savedStamp());
		const watcher = await openTab("watcher", { clientId: 20 });
		await toggleRawView();
		const typist = await openTab("typist", { clientId: 10 });
		const area = rawTextarea(watcher);
		const at = area.value.indexOf("A fixed fee");
		act(() => {
			area.focus();
			area.setSelectionRange(at, at + "A fixed".length);
		});

		// Typed after the caret: the caret stays where it is.
		await type(typist, " Typed by a colleague.");
		await waitFor(() => {
			expect(rawTextarea(watcher).value).toContain(
				"Typed by a colleague.",
			);
		});
		expect(rawTextarea(watcher).selectionStart).toBe(at);
		expect(rawTextarea(watcher).selectionEnd).toBe(at + "A fixed".length);

		// Typed before it: the caret moves with the text after it.
		const typistEditor = mainEditor(typist) as Editor;
		await act(async () => {
			// At the start of the paragraph after the first heading.
			const first = typistEditor.state.doc.firstChild;
			typistEditor.commands.insertContentAt(
				(first?.nodeSize ?? 0) + 1,
				"Added ",
			);
		});
		await waitFor(() => {
			expect(rawTextarea(watcher).value).toContain("Added ");
		});
		const moved = rawTextarea(watcher).value.indexOf("A fixed fee");
		expect(moved).toBeGreaterThan(at);
		expect(rawTextarea(watcher).selectionStart).toBe(moved);
		expect(rawTextarea(watcher).selectionEnd).toBe(
			moved + "A fixed".length,
		);
	});

	it("a raw view with edits of its own keeps them as they are while a colleague's typing reaches the room", async () => {
		await persistRoom(BODY_A, savedStamp());
		const watcher = await openTab("watcher", { clientId: 20 });
		await toggleRawView();
		const edited = `${rawTextarea(watcher).value}\n\nEdited in the raw view.`;
		await act(async () => {
			fireEvent.change(rawTextarea(watcher), {
				target: { value: edited },
			});
		});
		const typist = await openTab("typist", { clientId: 10 });

		await type(typist, " Typed by a colleague.");
		await waitFor(() => {
			expect(editorBody(watcher)).toContain("Typed by a colleague.");
		});
		await settle(200);

		expect(rawTextarea(watcher).value).toBe(edited);
		expect(saveButton(watcher)).not.toBeDisabled();
	});

	it("a trip to the raw view and back with no edit is no typing: a colleague's text stays theirs to save", async () => {
		harness.autosave.delayMs = 300;
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		// A colleague's typing reaches the room; their editor saves it.
		await act(async () => {
			await persistRoom(`${BODY_A} Typed by a colleague.`, null);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(editorBody(tab)).toContain("Typed by a colleague.");
		});

		await toggleRawView();
		expect(rawTextarea(tab).value).toContain("Typed by a colleague.");
		await toggleRawView();
		expect(editorBody(tab)).toContain("Typed by a colleague.");
		await settle(700);

		expect(saveButton(tab)).toBeDisabled();
		expect(saveCalls).toEqual([]);
		expect(await roomBody()).toContain("Typed by a colleague.");
	});

	it("the single-user editor still autosaves its typing", async () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		harness.autosave.delayMs = 300;
		const tab = await openTab("solo");
		await type(tab, " Typed alone.");
		expect(saveButton(tab)).not.toBeDisabled();

		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]?.content).toContain("Typed alone.");
	});
});

describe("a long drop after the first sync (Fizzy #2946)", () => {
	it("shows the saved body read-only after forty-five seconds, with a reload and the text typed here to copy, and gives the editor back with the room", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Typed before the drop.");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});

		tab.synced = false;
		rerender(tab);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(44_000);
		});
		expect(tab.view?.getByText("reconnecting.title")).toBeInTheDocument();
		expect(showsSavedBody(tab)).toBe(false);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		await waitFor(() => {
			expect(showsSavedBody(tab)).toBe(true);
		});
		expect(tab.view?.getByText("away.title")).toBeInTheDocument();
		expect(savedBodyViewText(tab)).toContain("Phase one, then two.");
		expect(savedBodyViewText(tab)).not.toContain("Typed before the drop.");
		// No editor on screen, so nothing to save from.
		expect(mainEditor(tab)).toBeNull();
		expect(within(tab.saveSlot).queryByRole("button")).toBeNull();
		expect(
			tab.view?.getByRole("button", { name: "reload" }),
		).toBeInTheDocument();

		const copy = await waitFor(() => {
			const button = tab.view?.queryByRole("button", {
				name: "offerBack.copy",
			});
			expect(button).toBeTruthy();
			return button as HTMLElement;
		});
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		await act(async () => {
			copy.click();
		});
		expect(writeText).toHaveBeenCalledWith(
			expect.stringContaining("Typed before the drop."),
		);
		vi.useRealTimers();

		tab.synced = true;
		rerender(tab);
		await waitFor(() => {
			expect(showsSavedBody(tab)).toBe(false);
			expect(editorBody(tab)).toContain("Typed before the drop.");
		});
		expect(tab.view?.queryByText("away.title")).toBeNull();
	});

	it("text typed before a short drop is offered back once when the room comes back behind a newer saved document", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Typed before the drop.");

		// The room drops before the autosave, and the saved document moves
		// on meanwhile — a run's final save, an API write, a restore.
		tab.synced = false;
		rerender(tab);
		await settle(20);
		expect(mainEditor(tab)).toBeNull();
		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);

		tab.synced = true;
		rerender(tab);

		await waitFor(
			() => {
				expect(editorBody(tab)).toContain("rewritten by the run");
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			},
			{ timeout: 3000 },
		);
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
			expect.stringContaining("Typed before the drop."),
		);
		expect(saveCalls).toEqual([]);
	});

	it("keeps typing from before a short drop unsaved once the room is back: Save stays on, and one autosave carries it after the autosave delay", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " Typed before the drop.");
		expect(saveButton(tab)).toHaveAccessibleName("Save document");

		tab.synced = false;
		rerender(tab);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4_000);
		});
		expect(mainEditor(tab)).toBeNull();

		tab.synced = true;
		rerender(tab);
		await waitFor(() => {
			expect(editorBody(tab)).toContain("Typed before the drop.");
		});
		await waitFor(() => {
			expect(saveButton(tab)).toHaveAccessibleName("Save document");
		});
		expect(saveCalls).toHaveLength(0);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]?.content).toContain("Typed before the drop.");
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		await waitFor(() => {
			expect(server.content).toContain("Typed before the drop.");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(11_000);
		});
		vi.useRealTimers();
		expect(saveCalls).toHaveLength(1);
		expect(saveButton(tab)).toHaveAccessibleName(
			"Document saved, no changes to save",
		);
	});

	it("keeps typing unsaved when the save in flight across a short drop fails after the room is back: the save's optimistic body is no saved baseline", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " Typed before the drop.");
		// The autosave goes out, and its answer is slow.
		server.failNext = new Error("Service unavailable");
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});

		tab.synced = false;
		rerender(tab);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(4_000);
		});
		expect(mainEditor(tab)).toBeNull();
		tab.synced = true;
		rerender(tab);
		await waitFor(() => {
			expect(editorBody(tab)).toContain("Typed before the drop.");
		});

		// Only now does the save answer, with a failure: nothing was written.
		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"failed",
				SAVE_FAILED_TOAST,
			);
		});
		expect(server.content).toBe(BODY_A);
		await waitFor(() => {
			expect(saveButton(tab)).toHaveAccessibleName("Save document");
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		vi.useRealTimers();
		expect(saveCalls[1]?.content).toContain("Typed before the drop.");
		await waitFor(() => {
			expect(server.content).toContain("Typed before the drop.");
		});
	});

	it("offers nothing to copy when nothing was typed here since the last save", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		tab.synced = false;
		rerender(tab);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(46_000);
		});
		await waitFor(() => {
			expect(showsSavedBody(tab)).toBe(true);
		});
		await settle(50);
		vi.useRealTimers();
		expect(
			tab.view?.queryByRole("button", { name: "offerBack.copy" }),
		).toBeNull();
	});
});

describe("leaving with unsaved typing in the room (Fizzy #2946)", () => {
	function leave(): boolean {
		// `false` when a listener asked the browser to confirm.
		return window.dispatchEvent(
			new Event("beforeunload", { cancelable: true }),
		);
	}

	it("asks first while typing here is not covered by a save, and no longer once the save answers", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		expect(leave()).toBe(true);

		await type(tab, " Not saved yet.");
		expect(leave()).toBe(false);

		await clickSave(tab);
		await waitFor(() => {
			expect(server.content).toContain("Not saved yet.");
		});
		await settle(20);
		expect(leave()).toBe(true);
	});

	it("never asks a client that may not edit the room", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("viewer", { role: "viewer" });
		await settle(50);

		expect(mainEditor(tab)?.isEditable ?? false).toBe(false);
		expect(leave()).toBe(true);
	});
});

describe("one save at a time (Fizzy #2946)", () => {
	it("the save before an assistant run, asked for while the autosave is in flight, goes once that one is answered, from the base its answer produced: the single-user editor keeps saving", async () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		const tab = await openTab("solo");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});

		// The autosave, ten seconds into the pause after the edit; the
		// server writes it and holds its answer.
		await type(tab, " First edit.");
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});

		// More typing, then the assistant starts a turn: the save before it
		// is asked for while the autosave is still in flight.
		await type(tab, " Second edit.");
		harness.chatLoading = true;
		rerender(tab);
		await settle(50);
		expect(saveCalls).toHaveLength(1);

		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		vi.useRealTimers();
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 8,
			expectedContentHash: hashOf(String(saveCalls[0]?.content)),
		});
		expect(saveCalls[1]?.content).toContain("Second edit.");
		await settle(50);
		expect(saveCalls).toHaveLength(2);
		expect(server.version).toBe(9);
		expect(server.content).toContain("Second edit.");
		expect(toast.error).not.toHaveBeenCalled();
	});
});

describe("typing while a save is in flight (Fizzy #2946)", () => {
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
		server.holdAnswers = false;
	}

	async function answerHeld() {
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await vi.advanceTimersByTimeAsync(10);
		});
		await settle(220);
	}

	it("opens saved, with nothing to save", async () => {
		const tab = await openTab("solo");
		await settle(220);
		expect(saveButton(tab)).toHaveAccessibleName(
			"Document saved, no changes to save",
		);
	});

	it("keeps the typing the save did not carry unsaved once that save is answered, and autosaves it", async () => {
		const tab = await openTab("solo");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await autosaveInFlight(tab, " First edit.");
		await type(tab, " Typed during the save.");

		await answerHeld();
		expect(server.content).not.toContain("Typed during the save.");
		expect(saveButton(tab)).toHaveAccessibleName("Save document");

		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		vi.useRealTimers();
		expect(saveCalls[1]?.content).toContain("Typed during the save.");
		await waitFor(() => {
			expect(server.content).toContain("Typed during the save.");
		});
		await settle(220);
		expect(saveButton(tab)).toHaveAccessibleName(
			"Document saved, no changes to save",
		);
	});

	it("reads as saved once the save is answered when nothing was typed meanwhile", async () => {
		const tab = await openTab("solo");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await autosaveInFlight(tab, " First edit.");

		await answerHeld();
		expect(saveButton(tab)).toHaveAccessibleName(
			"Document saved, no changes to save",
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		vi.useRealTimers();
		expect(saveCalls).toHaveLength(1);
	});
});
