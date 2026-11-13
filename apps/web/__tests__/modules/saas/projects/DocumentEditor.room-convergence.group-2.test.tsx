import {
	act,
	BODY_A,
	BODY_B,
	clickSave,
	describe,
	editorBody,
	expect,
	harness,
	hashOf,
	it,
	mainEditor,
	nudge,
	occurrences,
	offerBackCalls,
	openTab,
	persistRoom,
	ROOM_SAVE_AWARENESS_FIELD,
	readConvergenceClaim,
	readRoomStamp,
	type render,
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
	showsSavedBody,
	type Tab,
	toast,
	type,
	userEvent,
	vi,
	waitFor,
	within,
} from "./DocumentEditor.room-convergence.harness";

describe("guarded saves and convergence (Fizzy #2946)", () => {
	it("a save between a run's body save and its version step is refused on the body, writes nothing, and the room converges with the typed text offered back", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Typed after the last save.");

		// The run's final save lands: the new body at the old version.
		server.content = BODY_B;
		await clickSave(tab);

		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		expect(server.content).toBe(BODY_B);

		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(tab)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(editorBody(tab)).not.toContain("Typed after the last save.");
		expect(saveCalls).toHaveLength(1);

		// The typed text is offered back, once.
		expect(offerBackCalls()).toHaveLength(1);
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		const options = offerBackCalls()[0]?.[1] as {
			action: { label: string; onClick: () => void };
		};
		expect(options.action.label).toBe("offerBack.copy");
		options.action.onClick();
		expect(writeText).toHaveBeenCalledWith(
			expect.stringContaining("Typed after the last save."),
		);
	});

	it("two editors converging behind a paused relay leave one copy of the body and save nothing", async () => {
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const second = await openTab("second", { clientId: 20 });
		await settle(30);

		room.paused = true;
		server.content = BODY_B;
		server.version = 8;
		await nudge(first, second);
		// Long enough for both to observe twice and for the second in line
		// to fall through: each sees the room still behind.
		await waitFor(
			() => {
				expect(editorBody(first)).toContain("rewritten by the run");
				expect(editorBody(second)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(saveCalls).toEqual([]);

		await resume();
		await waitFor(
			async () => {
				expect(
					occurrences(await roomBody(), "rewritten by the run"),
				).toBe(1);
				expect(
					occurrences(editorBody(first), "rewritten by the run"),
				).toBe(1);
				expect(
					occurrences(editorBody(second), "rewritten by the run"),
				).toBe(1);
			},
			{ timeout: 3000 },
		);
		await waitFor(() => {
			expect(readConvergenceClaim(room.doc)?.settled).toBe("verified");
		});
		expect(saveCalls).toEqual([]);
	});

	it("a colleague's save in flight is not taken for a stale room: the other editor's typing survives", async () => {
		// The save is answered well inside the interval it holds the stale
		// rule back for.
		harness.timings.fallThroughMs = 5000;
		await persistRoom(BODY_A, savedStamp());
		const saver = await openTab("saver", { clientId: 10 });
		const typist = await openTab("typist", { clientId: 20 });
		await type(saver, " Saved by the first editor.");

		server.holdAnswers = true;
		await clickSave(saver);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(
			typist.awareness.view.get(10)?.[ROOM_SAVE_AWARENESS_FIELD],
		).toEqual({ version: 7, contentHash: hashOf(BODY_A) });

		// The typist types, and its refetch brings the saved document before
		// the saver has advanced the stamp.
		await type(typist, " Typed by the second editor.");
		await nudge(typist);
		await settle(400);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(editorBody(typist)).toContain("Typed by the second editor.");

		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		});
		expect(saver.awareness.own[ROOM_SAVE_AWARENESS_FIELD]).toBeNull();
		await nudge(typist);
		await settle(200);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(editorBody(typist)).toContain("Typed by the second editor.");
		expect(await roomBody()).toContain("Typed by the second editor.");
		expect(offerBackCalls()).toHaveLength(0);
	});

	it("a CONFLICT after a colleague's save of the same room is retried once, silently, from the moved stamp", async () => {
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const second = await openTab("second", { clientId: 20 });
		await type(first, " A shared edit.");
		await waitFor(() => {
			expect(editorBody(second)).toContain("A shared edit.");
		});
		await type(second, " And another.");

		server.holdAnswers = true;
		await clickSave(first);
		await clickSave(second);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		server.holdAnswers = false;
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
			tab: "second",
			expectedVersion: 8,
		});
		await settle(100);
		expect(saveCalls).toHaveLength(3);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		expect(toast.error).not.toHaveBeenCalled();
		expect(toast.info).not.toHaveBeenCalledWith("saveConflictRoom");
		expect(server.content).toContain("And another.");
	});

	it("offers back what a colleague typed since their last save when another editor's convergence replaces it", async () => {
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const typist = await openTab("typist", { clientId: 20 });
		await type(typist, " Unsaved by the typist.");

		server.content = BODY_B;
		server.version = 8;
		await nudge(first, typist);
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(typist)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(readConvergenceClaim(room.doc)?.clientId).toBe(10);
		expect(editorBody(typist)).not.toContain("Unsaved by the typist.");

		// Offered to the typist alone: the editor that applied had typed
		// nothing.
		expect(offerBackCalls()).toHaveLength(1);
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		(
			offerBackCalls()[0]?.[1] as { action: { onClick: () => void } }
		).action.onClick();
		expect(writeText).toHaveBeenCalledWith(
			expect.stringContaining("Unsaved by the typist."),
		);
		expect(saveCalls).toEqual([]);
	});

	it("a server write outside a run reaches both open editors without a reload, applied by one", async () => {
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		const second = await openTab("second", { clientId: 20 });
		const roomUpdatesBefore = second.localUpdates;

		// An update through the API, with its nudge.
		server.content = BODY_B;
		server.version = 8;
		await nudge(first, second);

		await waitFor(
			() => {
				expect(editorBody(first)).toContain("rewritten by the run");
				expect(editorBody(second)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		await waitFor(() => {
			expect(readConvergenceClaim(room.doc)).toMatchObject({
				clientId: 10,
				settled: "verified",
			});
		});
		// The second, later in the order, wrote nothing to the room.
		expect(second.localUpdates).toBe(roomUpdatesBefore);
		expect(occurrences(await roomBody(), "rewritten by the run")).toBe(1);
		expect(saveCalls).toEqual([]);
	});
});

describe("a room nobody kept up (Fizzy #2946)", () => {
	it("a member opening a room persisted behind the saved document sees the saved body, never the room's, and the first autosave carries it plus the edit", async () => {
		await persistRoom(BODY_A, { version: 7, contentHash: hashOf(BODY_A) });
		server.content = BODY_B;
		server.version = 8;
		// Room for a look at the screen before the second observation, and
		// while the room is replaced.
		harness.timings.observationGapMs = 400;
		harness.timings.claimSettleMs = 300;

		const tab = await openTab("member");
		// The first look only checks: the editor stays on screen, and saves
		// wait.
		expect(showsSavedBody(tab)).toBe(false);
		expect(roomEditorContent(tab)?.className).not.toContain("hidden");
		expect(within(tab.syncSlot).getByText("updating")).toBeInTheDocument();
		// Once the room is being brought up, the saved body is what shows.
		await waitFor(
			() => {
				expect(showsSavedBody(tab)).toBe(true);
			},
			{ timeout: 3000 },
		);
		expect(savedBodyViewText(tab)).toContain("rewritten by the run");
		expect(roomEditorContent(tab)?.className).toContain("hidden");

		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(showsSavedBody(tab)).toBe(false);
			},
			{ timeout: 3000 },
		);
		expect(editorBody(tab)).toContain("rewritten by the run");
		expect(
			within(tab.syncSlot).getByTestId("sync-pill"),
		).toBeInTheDocument();

		// The autosave, ten seconds into the pause after the edit.
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " An edit on the saved body.");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		vi.useRealTimers();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]).not.toHaveProperty("completeDraft");
		expect(saveCalls[0]?.content).toContain("rewritten by the run");
		expect(saveCalls[0]?.content).toContain("An edit on the saved body.");
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 8,
			expectedContentHash: hashOf(BODY_B),
		});
		// Nothing typed here was replaced.
		expect(offerBackCalls()).toHaveLength(0);
	});

	it("a viewer alone sees the saved body read-only and leaves the room as it was", async () => {
		await persistRoom(BODY_A, { version: 7, contentHash: hashOf(BODY_A) });
		server.content = BODY_B;
		server.version = 8;

		const viewer = await openTab("viewer", { role: "viewer" });
		await settle(250);
		expect(showsSavedBody(viewer)).toBe(true);
		expect(savedBodyViewText(viewer)).toContain("rewritten by the run");
		expect(mainEditor(viewer)?.isEditable).toBe(false);
		expect(viewer.localUpdates).toBe(0);
		expect(readRoomStamp(room.doc)).toEqual({
			version: 7,
			contentHash: hashOf(BODY_A),
		});
		expect(await roomBody()).toContain("Phase one, then two.");
		expect(readConvergenceClaim(room.doc)).toBeNull();
	});

	it("a room from before the stamp that differs from the saved body is replaced by it, and what it held is offered back", async () => {
		await persistRoom(`${BODY_A}\n\nUnsaved text from before.`, null);
		server.content = BODY_B;
		server.version = 8;

		const tab = await openTab("member");
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(tab)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(editorBody(tab)).not.toContain("Unsaved text from before.");
		expect(offerBackCalls()).toHaveLength(1);
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(window.navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		(
			offerBackCalls()[0]?.[1] as { action: { onClick: () => void } }
		).action.onClick();
		expect(writeText).toHaveBeenCalledWith(
			expect.stringContaining("Unsaved text from before."),
		);
	});

	it("a room from before the stamp that equals the saved body only gets its stamp", async () => {
		await persistRoom(BODY_A, null);
		const tab = await openTab("member");
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
			},
			{ timeout: 3000 },
		);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(editorBody(tab)).toContain("Phase one, then two.");
		expect(offerBackCalls()).toHaveLength(0);
	});
});

describe("leaving within the app with unsaved typing in the room (Fizzy #2946)", () => {
	// The page's Close and its breadcrumb links both navigate within the
	// app: the editor unmounts, and no `beforeunload` fires.
	async function leaveWithinApp(tab: Tab) {
		await act(async () => {
			tab.view?.unmount();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	it("saves the typing on the way out as an autosave, from the room's stamp", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");

		await type(tab, " Typed before leaving.");
		expect(saveCalls).toHaveLength(0);
		await leaveWithinApp(tab);

		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		expect(saveCalls[0]?.content).toContain("Typed before leaving.");
		expect(saveCalls[0]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		expect(saveCalls[0]).not.toHaveProperty("completeDraft");
		await waitFor(() => {
			expect(server.content).toContain("Typed before leaving.");
		});
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("saves nothing when the typing is already saved", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Saved before leaving.");
		await clickSave(tab);
		await waitFor(() => {
			expect(server.content).toContain("Saved before leaving.");
		});
		await settle(20);

		await leaveWithinApp(tab);
		await settle(50);

		expect(saveCalls).toHaveLength(1);
	});

	it("saves nothing when nothing was typed", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");

		await leaveWithinApp(tab);
		await settle(50);

		expect(saveCalls).toHaveLength(0);
	});

	it("never saves for a client that may not edit the room", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("viewer", { role: "viewer" });
		await settle(50);

		await leaveWithinApp(tab);
		await settle(50);

		expect(saveCalls).toHaveLength(0);
	});

	it("never saves around the room: a sync loss that unmounts the editor sends nothing, and neither does leaving while the room is away", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Typed before the drop.");

		tab.synced = false;
		rerender(tab);
		await settle(50);
		expect(mainEditor(tab)).toBeNull();
		expect(saveCalls).toHaveLength(0);

		await leaveWithinApp(tab);
		await settle(50);

		expect(saveCalls).toHaveLength(0);
	});

	it("waits for the save in flight, then saves the rest from the base its answer produced", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " First edit.");
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});

		await type(tab, " Typed during the save.");
		await leaveWithinApp(tab);
		expect(saveCalls).toHaveLength(1);

		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await vi.advanceTimersByTimeAsync(10);
		});
		vi.useRealTimers();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 8,
			expectedContentHash: hashOf(String(saveCalls[0]?.content)),
		});
		expect(saveCalls[1]?.content).toContain("Typed during the save.");
		await waitFor(() => {
			expect(server.content).toContain("Typed during the save.");
		});
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("saves on the way out what was typed while the last save was in flight, once that save is answered", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " First edit.");
		server.holdAnswers = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_500);
		});
		await waitFor(() => {
			expect(saveCalls).toHaveLength(1);
		});
		await type(tab, " Typed during the save.");

		server.holdAnswers = false;
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await vi.advanceTimersByTimeAsync(10);
		});
		await settle(220);
		expect(saveCalls).toHaveLength(1);

		await leaveWithinApp(tab);
		vi.useRealTimers();
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 8,
			expectedContentHash: hashOf(String(saveCalls[0]?.content)),
		});
		expect(saveCalls[1]?.content).toContain("Typed during the save.");
		await waitFor(() => {
			expect(server.content).toContain("Typed during the save.");
		});
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("never reads the editor it left behind: the answer of the save on the way out, and the autosave delay after it, serialize nothing", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		await type(tab, " Typed before leaving.");
		const consoleError = vi.spyOn(console, "error");

		await leaveWithinApp(tab);
		await waitFor(() => {
			expect(server.content).toContain("Typed before leaving.");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(21_000);
		});
		vi.useRealTimers();

		expect(saveCalls).toHaveLength(1);
		expect(
			consoleError.mock.calls.filter(
				([message]) =>
					typeof message === "string" &&
					message.includes("[editor-markdown-save]"),
			),
		).toEqual([]);
	});

	it("says so, with the text to copy, when the save on the way out is refused, and sends it only once", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Typed before leaving.");
		// A server write the room has not heard of yet.
		server.content = BODY_B;
		server.version = 8;

		await leaveWithinApp(tab);
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"leaveSaveFailed",
				expect.objectContaining({
					action: expect.objectContaining({
						label: "offerBack.copy",
					}),
				}),
			);
		});
		await settle(50);

		expect(saveCalls).toHaveLength(1);
		expect(server.content).toBe(BODY_B);
	});
});

describe("an update using context (Fizzy #2946)", () => {
	function updateUsingContext(tab: Tab): HTMLButtonElement | null {
		return (tab.view
			?.queryAllByText(/Update\s+using\s+context/)
			.map((label) => label.closest("button"))
			.find(Boolean) ?? null) as HTMLButtonElement | null;
	}

	it("confirms against the base the editor's saves name: the room's stamp", async () => {
		await persistRoom(BODY_A, savedStamp());
		await openTab("tab");

		expect(harness.contextUpdateOptions.resolveBase?.()).toEqual(
			savedStamp(),
		);
	});

	it("cannot be started while a run is generating the document", async () => {
		await persistRoom(BODY_A, savedStamp());
		const idle = await openTab("idle");
		const idleButton = updateUsingContext(idle);
		expect(idleButton).not.toBeNull();
		expect(idleButton).not.toBeDisabled();
		idle.view?.unmount();
		idle.view = null;
		room.tabs.splice(room.tabs.indexOf(idle), 1);

		server.status = "GENERATING";
		const during = await openTab("during");
		await waitFor(() => {
			expect(updateUsingContext(during)).toBeDisabled();
		});
	});

	it("cannot be started from the narrow layout's menu while a run is generating the document", async () => {
		const user = userEvent.setup();
		/** The menu's item, once the menu is open. */
		async function menuItem(tab: Tab): Promise<HTMLElement> {
			await user.click(
				(tab.view as ReturnType<typeof render>).getByRole("button", {
					name: "More document actions",
				}),
			);
			return waitFor(() => {
				const item = [
					...window.document.body.querySelectorAll<HTMLElement>(
						'[role="menuitem"]',
					),
				].find((element) =>
					/Update\s+using\s+context/.test(element.textContent ?? ""),
				);
				expect(item).toBeDefined();
				return item as HTMLElement;
			});
		}

		await persistRoom(BODY_A, savedStamp());
		const idle = await openTab("idle");
		expect(await menuItem(idle)).not.toHaveAttribute("aria-disabled");
		idle.view?.unmount();
		idle.view = null;
		room.tabs.splice(room.tabs.indexOf(idle), 1);

		server.status = "GENERATING";
		const during = await openTab("during");
		expect(await menuItem(during)).toHaveAttribute("aria-disabled", "true");
	});
});

describe("a save refused because a generation run holds the document (Fizzy #2946)", () => {
	/** The server's answer to a save once a run queued or is writing. */
	function runLiveRefusal() {
		return Object.assign(
			new Error(
				"A generation run is writing this document; try again when it finishes.",
			),
			{
				code: "CONFLICT",
				data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
			},
		);
	}

	/** Why the Save button refuses, as its description reads, if it does. */
	function saveRefusal(tab: Tab): string | null {
		const id = saveButton(tab).getAttribute("aria-describedby");
		return id
			? (tab.saveSlot.querySelector(`[id="${id}"]`)?.textContent ?? null)
			: null;
	}

	it("the single-user editor says a run is writing, keeps the text unsaved, and saves it from its base once the run ends", async () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		const tab = await openTab("solo");
		await type(tab, " Typed as a run queued.");

		// A run queued after the editor last read the document.
		server.status = "GENERATING";
		server.failNext = runLiveRefusal();
		await clickSave(tab);

		await waitFor(() => {
			expect(toast.info).toHaveBeenCalledWith("saveBlocked.runLive");
		});
		expect(saveCalls).toHaveLength(1);
		expect(server.content).toBe(BODY_A);
		expect(server.version).toBe(7);
		expect(toast.error).not.toHaveBeenCalled();
		expect(editorBody(tab)).toContain("Typed as a run queued.");
		// The refetch brings the run, whose state holds saves back.
		await waitFor(() => {
			expect(saveRefusal(tab)).toBe("saveBlocked.runLive");
		});

		// The run ends without moving the body: the base the editor holds is
		// still the saved one, and the text, still unsaved, saves.
		server.status = "COMPLETE";
		await nudge(tab);
		await waitFor(() => {
			expect(saveRefusal(tab)).toBeNull();
		});
		await clickSave(tab);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		await waitFor(() => {
			expect(server.content).toContain("Typed as a run queued.");
		});
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("a room's save is not taken for a room behind the saved document: nothing is converged or offered back, and the text saves once the run ends", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Typed as a run queued.");

		server.status = "GENERATING";
		server.failNext = runLiveRefusal();
		await clickSave(tab);

		await waitFor(() => {
			expect(toast.info).toHaveBeenCalledWith("saveBlocked.runLive");
		});
		await waitFor(() => {
			expect(saveRefusal(tab)).toBe("saveBlocked.runLive");
		});
		await settle(200);
		expect(toast.info).not.toHaveBeenCalledWith("saveConflictRoom");
		expect(toast.error).not.toHaveBeenCalled();
		expect(saveCalls).toHaveLength(1);
		expect(server.content).toBe(BODY_A);
		expect(readRoomStamp(room.doc)).toEqual(savedStamp());
		expect(offerBackCalls()).toHaveLength(0);
		expect(editorBody(tab)).toContain("Typed as a run queued.");
		expect(await roomBody()).toContain("Typed as a run queued.");

		server.status = "COMPLETE";
		await nudge(tab);
		await waitFor(() => {
			expect(saveRefusal(tab)).toBeNull();
		});
		await clickSave(tab);
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		expect(saveCalls[1]).toMatchObject({
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		await waitFor(() => {
			expect(server.content).toContain("Typed as a run queued.");
		});
		expect(offerBackCalls()).toHaveLength(0);
	});

	it("a CONFLICT that names no run still stops the single-user editor's saves until a reload", async () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		const tab = await openTab("solo");
		await type(tab, " Typed over a moved base.");

		server.failNext = Object.assign(new Error("Document changed"), {
			code: "CONFLICT",
		});
		await clickSave(tab);

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"saveConflictSolo",
				expect.objectContaining({
					cancel: expect.objectContaining({ label: "reload" }),
				}),
			);
		});
		expect(toast.info).not.toHaveBeenCalledWith("saveBlocked.runLive");
		await waitFor(() => {
			expect(saveRefusal(tab)).toBe("saveBlocked.staleBase");
		});
		expect(saveCalls).toHaveLength(1);
		expect(editorBody(tab)).toContain("Typed over a moved base.");
	});
});
