import {
	act,
	addPeer,
	BODY_A,
	BODY_B,
	beforeEach,
	buildSectionMap,
	clickSave,
	createCollaborativeExtensions,
	describe,
	Editor,
	editorBody,
	expect,
	FAILED_OFFERED_ACCEPT_RECORD,
	fromMarkdown,
	GENERATION_RUN_AWARENESS_FIELD,
	harness,
	hashOf,
	it,
	mainEditor,
	nudge,
	occurrences,
	openTab,
	PROPOSAL_REVIEW_AWARENESS_FIELD,
	persistRoom,
	ROOM_PEER_AWARENESS_FIELD,
	readConvergenceClaim,
	readRoomStamp,
	rerender,
	room,
	roomBody,
	SAVED_ACCEPT_RECORD,
	saveButton,
	saveCalls,
	savedStamp,
	server,
	settle,
	showsSavedBody,
	type Tab,
	toast,
	type,
	undo,
	vi,
	waitFor,
	within,
	writeConvergenceClaim,
} from "./DocumentEditor.room-convergence.harness";

describe("the convergence election (Fizzy #2946)", () => {
	it("never elects a read-only client, whatever its client id or forged run role: an editor converges and the viewer never writes", async () => {
		// A candidate ahead of the editor would hold it back this long.
		harness.timings.fallThroughMs = 5000;
		await persistRoom(BODY_A, savedStamp());
		const viewer = await openTab("viewer", { role: "viewer", clientId: 1 });
		const editor = await openTab("editor", { clientId: 50 });
		act(() => {
			viewer.awareness.setLocalStateField(
				GENERATION_RUN_AWARENESS_FIELD,
				"started",
			);
		});
		expect(
			editor.awareness.view.get(1)?.[ROOM_PEER_AWARENESS_FIELD],
		).toEqual({ canEdit: false, visible: true });

		server.content = BODY_B;
		server.version = 8;
		await nudge(viewer, editor);
		// The viewer may show the saved body while the room is behind, but only
		// if its refetch lands before the editor converges; when the editor is
		// first, the viewer never sees the room behind. Either way it ends on
		// the new body without writing.
		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(editor)).toContain("rewritten by the run");
			},
			{ timeout: 2000 },
		);
		expect(readConvergenceClaim(room.doc)?.clientId).toBe(50);
		await waitFor(() => {
			expect(showsSavedBody(viewer)).toBe(false);
			expect(editorBody(viewer)).toContain("rewritten by the run");
		});
		expect(viewer.localUpdates).toBe(0);
	});

	it("replaces an elected editor that never converges after the bounded interval", async () => {
		await persistRoom(BODY_A, savedStamp());
		addPeer(5, {
			[ROOM_PEER_AWARENESS_FIELD]: { canEdit: true, visible: true },
		});
		const tab = await openTab("tab", { clientId: 50 });

		server.content = BODY_B;
		server.version = 8;
		await nudge(tab);
		// Two looks and the claim settle are well under the interval the
		// silent editor ahead is given.
		await settle(200);
		expect(readConvergenceClaim(room.doc)).toBeNull();
		expect(editorBody(tab)).toContain("Phase one, then two.");

		await waitFor(
			() => {
				expect(readRoomStamp(room.doc)).toEqual(savedStamp());
				expect(editorBody(tab)).toContain("rewritten by the run");
			},
			{ timeout: 3000 },
		);
		expect(readConvergenceClaim(room.doc)?.clientId).toBe(50);
	});
});

describe("a convergence that failed (Fizzy #2946)", () => {
	/** A room whose stamp names the saved body while it holds the older one. */
	async function persistFailedRoom(claimant: number, failedAt?: number) {
		server.content = BODY_B;
		server.version = 8;
		await persistRoom(BODY_A, savedStamp());
		writeConvergenceClaim(room.doc, {
			clientId: claimant,
			target: savedStamp(),
			settled: "failed",
			...(failedAt === undefined ? {} : { failedAt }),
		});
	}

	function saysUpdateFailed(tab: Tab): boolean {
		return within(tab.syncSlot).queryByText("updateFailed") !== null;
	}

	async function expectConvergedBy(tab: Tab, clientId: number) {
		await waitFor(
			() => {
				expect(editorBody(tab)).toContain("rewritten by the run");
				expect(readConvergenceClaim(room.doc)).toMatchObject({
					clientId,
					settled: "verified",
				});
				expect(showsSavedBody(tab)).toBe(false);
			},
			{ timeout: 3000 },
		);
		expect(occurrences(await roomBody(), "rewritten by the run")).toBe(1);
		expect(saysUpdateFailed(tab)).toBe(false);
		expect(mainEditor(tab)?.isEditable).toBe(true);
	}

	it("a failure the room kept from an editor that is gone does not freeze an editor opened later: it makes one more attempt and the room converges", async () => {
		// Written a moment ago, well inside the while a witness would wait.
		await persistFailedRoom(999, Date.now());

		const tab = await openTab("member", { clientId: 50 });

		await expectConvergedBy(tab, 50);
		expect(saveCalls).toEqual([]);
	});

	it("an editor that saw another editor's convergence fail leaves the room alone for a short while, then makes one more attempt", async () => {
		harness.timings.failedClaimExpiryMs = 400;
		server.content = BODY_B;
		server.version = 8;
		await persistRoom(BODY_B, savedStamp());
		const tab = await openTab("witness", { clientId: 50 });
		await settle(50);
		expect(saysUpdateFailed(tab)).toBe(false);

		// Another editor's convergence fails: the room ends up holding the
		// older body under the saved stamp, and its claim says so.
		await act(async () => {
			const writer = new Editor({
				extensions:
					createCollaborativeExtensions({
						ydoc: room.doc,
						provider: null,
						user: { name: "Colleague", color: "#000" },
						projectId: null,
						documentId: null,
					}) ?? [],
			});
			room.doc.transact(() => {
				writer.commands.setContent(fromMarkdown(BODY_A));
				writeConvergenceClaim(room.doc, {
					clientId: 999,
					target: savedStamp(),
					settled: "failed",
					failedAt: Date.now(),
				});
			});
			writer.destroy();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(saysUpdateFailed(tab)).toBe(true);
		});
		expect(showsSavedBody(tab)).toBe(true);
		expect(readConvergenceClaim(room.doc)?.clientId).toBe(999);

		await expectConvergedBy(tab, 50);
	});

	it.each([
		["ten minutes ahead", () => Date.now() + 10 * 60_000],
		["ten minutes behind", () => Date.now() - 10 * 60_000],
		["absurdly far ahead", () => Number.MAX_SAFE_INTEGER / 2],
	])(
		"a failure stamped by a claimant's clock %s holds an editor that sees it for the short while from when it saw it, no more and no less",
		async (_skew, failedAt) => {
			harness.timings.failedClaimExpiryMs = 400;
			server.content = BODY_B;
			server.version = 8;
			await persistRoom(BODY_B, savedStamp());
			const tab = await openTab("witness", { clientId: 50 });
			await settle(50);
			const timeout = vi.spyOn(globalThis, "setTimeout");

			await act(async () => {
				const writer = new Editor({
					extensions:
						createCollaborativeExtensions({
							ydoc: room.doc,
							provider: null,
							user: { name: "Colleague", color: "#000" },
							projectId: null,
							documentId: null,
						}) ?? [],
				});
				room.doc.transact(() => {
					writer.commands.setContent(fromMarkdown(BODY_A));
					writeConvergenceClaim(room.doc, {
						clientId: 999,
						target: savedStamp(),
						settled: "failed",
						failedAt: failedAt(),
					});
				});
				writer.destroy();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await waitFor(() => {
				expect(saysUpdateFailed(tab)).toBe(true);
			});
			// Still held a moment later, whichever way the clocks disagree.
			await settle(200);
			expect(saysUpdateFailed(tab)).toBe(true);
			expect(readConvergenceClaim(room.doc)?.clientId).toBe(999);
			// No wait a timer cannot hold — which browsers fire at once — is
			// ever asked for.
			expect(
				timeout.mock.calls.some(
					([, ms]) => typeof ms === "number" && ms > 2 ** 31 - 1,
				),
			).toBe(false);
			timeout.mockRestore();

			await expectConvergedBy(tab, 50);
		},
	);

	it("an editor whose own convergence failed stays frozen until the person asks to reload the latest version, which makes one more attempt", async () => {
		// Written by this session: the client id is the editor's own.
		await persistFailedRoom(50, Date.now());

		const tab = await openTab("member", { clientId: 50 });
		await settle(200);
		expect(saysUpdateFailed(tab)).toBe(true);
		expect(showsSavedBody(tab)).toBe(true);
		expect(await roomBody()).toContain("Phase one, then two.");

		await act(async () => {
			within(tab.syncSlot)
				.getByRole("button", { name: "reloadLatest" })
				.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		await expectConvergedBy(tab, 50);
	});
});

/**
 * In a room the editor's undo goes through the room's undo manager, which
 * the binding applies as it applies a colleague's change; it is still this
 * person's edit, and is saved like typing (Fizzy #2946).
 */
describe("an undo in the editor (Fizzy #2946)", () => {
	it("in a room, of an edit whose save has landed, is saved like typing: the server ends on the body before the edit", async () => {
		harness.autosave.delayMs = 300;
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await settle(200);
		await type(tab, " First edit.");
		await waitFor(
			() => {
				expect(server.content).toContain("First edit.");
			},
			{ timeout: 3000 },
		);
		await settle(100);

		await undo(tab);
		expect(editorBody(tab)).not.toContain("First edit.");
		await waitFor(
			() => {
				expect(saveCalls).toHaveLength(2);
			},
			{ timeout: 3000 },
		);
		expect(saveCalls[1]?.content).not.toContain("First edit.");
		expect(server.content).not.toContain("First edit.");
		expect(server.content).toContain("Phase one, then two.");
	});

	it("in the single-user editor, of an edit whose save has landed, is saved as before", async () => {
		vi.stubEnv("NEXT_PUBLIC_ENABLE_COLLABORATION", "false");
		harness.autosave.delayMs = 300;
		const tab = await openTab("solo");
		await settle(200);
		await type(tab, " First edit.");
		await waitFor(
			() => {
				expect(server.content).toContain("First edit.");
			},
			{ timeout: 3000 },
		);
		await settle(100);

		await undo(tab);
		expect(editorBody(tab)).not.toContain("First edit.");
		await waitFor(
			() => {
				expect(saveCalls).toHaveLength(2);
			},
			{ timeout: 3000 },
		);
		expect(server.content).not.toContain("First edit.");
	});
});

describe("restoring a version while a run holds the document (Fizzy #2946)", () => {
	it("is refused for a run on a run-guarded document, and for this tab's regeneration and its review; not otherwise", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		expect(harness.versionHistoryProps.restoreBlockedReason).toBeNull();

		// A run started elsewhere on a Proposal.
		server.status = "GENERATING";
		await nudge(tab);
		await waitFor(() => {
			expect(harness.versionHistoryProps.restoreBlockedReason).toBe(
				"runLive",
			);
		});
		server.status = "COMPLETE";
		await nudge(tab);
		await waitFor(() => {
			expect(harness.versionHistoryProps.restoreBlockedReason).toBeNull();
		});

		// This tab's own run, and then its review.
		await act(async () => {
			tab.actions.get("regenerate_document")?.renderAndWaitForResponse({
				args: { prompt: "Rewrite it" },
				respond: vi.fn(),
				status: "executing",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await waitFor(() => {
			expect(harness.versionHistoryProps.restoreBlockedReason).toBe(
				"regenerating",
			);
		});
		server.status = "GENERATING";
		await nudge(tab);
		await waitFor(() => {
			expect(harness.versionHistoryProps.restoreBlockedReason).toBe(
				"runLive",
			);
		});
		server.content = BODY_B;
		server.version = 8;
		server.status = "COMPLETE";
		await nudge(tab);
		await waitFor(() => {
			expect(
				tab.view?.queryByTestId("regeneration-confirm-modal"),
			).not.toBeNull();
		});
		expect(harness.versionHistoryProps.restoreBlockedReason).toBe(
			"regenerating",
		);
	});

	it("is not refused for a run on a document type the server does not guard", async () => {
		server.type = "PRD";
		await persistRoom(BODY_A, savedStamp());
		server.status = "GENERATING";
		await openTab("tab");
		await settle(50);
		expect(harness.versionHistoryProps.restoreBlockedReason).toBeNull();
	});
});

describe("a save from an editor older than the server (Fizzy #2946)", () => {
	it("says to reload to keep editing, and keeps the text", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		await type(tab, " Kept in the editor.");
		server.requireBase = true;
		await clickSave(tab);

		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"baseRequired",
				expect.objectContaining({
					action: expect.objectContaining({ label: "reload" }),
				}),
			);
		});
		expect(editorBody(tab)).toContain("Kept in the editor.");
	});
});

describe("an AI accept on a client-document Proposal in a room (Fizzy #2946)", () => {
	const ACCEPTED = "An accepted paragraph.";

	beforeEach(() => {
		harness.flags = {
			DOCUMENT_ROOM_CONVERGENCE: true,
			PROPOSAL_ARTIFACT: true,
		};
	});

	async function openRoom() {
		await persistRoom(BODY_A, savedStamp());
		const reviewing = await openTab("reviewing", { clientId: 10 });
		const other = await openTab("other", { clientId: 20 });
		await settle(200);
		return { reviewing, other };
	}

	/** The assistant proposes `proposed` in `tab`, and the person accepts it. */
	async function acceptProposal(tab: Tab, proposed: string) {
		harness.chatIn = tab.name;
		harness.agentState = {
			document: proposed,
			proposalPatchedSectionKeys: ["p1:pricing#0"],
		};
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

	async function answerHeld() {
		await act(async () => {
			for (const answer of server.held.splice(0)) {
				answer();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await settle(50);
	}

	function reviewPublished(tab: Tab): boolean {
		return Boolean(tab.awareness.own[PROPOSAL_REVIEW_AWARENESS_FIELD]);
	}

	async function expectHeld(tab: Tab) {
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(false);
		});
		expect(saveButton(tab)).toBeDisabled();
		expect(saveButton(tab)).toHaveAccessibleDescription(
			"saveBlocked.proposalElsewhere",
		);
	}

	async function expectResumed(tab: Tab) {
		await waitFor(() => {
			expect(mainEditor(tab)?.isEditable).toBe(true);
		});
		expect(saveButton(tab)).not.toHaveAccessibleDescription(
			"saveBlocked.proposalElsewhere",
		);
	}

	function refusedTextOffers() {
		return vi
			.mocked(toast.warning)
			.mock.calls.filter(([message]) => message === "offerBack");
	}

	it("keeps its review published and its editor read-only until the save answers: the other tab is held, and neither autosaves in that gap", async () => {
		harness.autosave.delayMs = 300;
		const { reviewing, other } = await openRoom();
		server.holdAnswers = true;

		const respond = await acceptProposal(
			reviewing,
			`${BODY_A}\n\n${ACCEPTED}`,
		);
		expect(respond).toHaveBeenCalledWith({ accepted: true });
		await waitFor(() => {
			expect(server.held).toHaveLength(1);
		});
		expect(saveCalls[0]).toMatchObject({
			tab: "reviewing",
			aiReview: { kind: "CHAT", patchedSectionKeys: ["p1:pricing#0"] },
			expectedVersion: 7,
			expectedContentHash: hashOf(BODY_A),
		});
		expect(reviewPublished(reviewing)).toBe(true);
		expect(mainEditor(reviewing)?.isEditable).toBe(false);
		await expectHeld(other);
		// Past the autosave's delay, nothing else goes from either tab.
		await settle(700);
		expect(saveCalls).toHaveLength(1);

		server.holdAnswers = false;
		await answerHeld();
		await waitFor(() => {
			expect(server.content).toContain(ACCEPTED);
		});
		await expectResumed(other);
		await waitFor(() => {
			expect(mainEditor(reviewing)?.isEditable).toBe(true);
		});
		expect(reviewPublished(reviewing)).toBe(false);
		expect(editorBody(other)).toContain(ACCEPTED);
		await settle(500);
		expect(saveCalls).toHaveLength(1);
		expect(harness.recordOutcome).toHaveBeenCalledWith(SAVED_ACCEPT_RECORD);
	});

	it("refused: every tab ends on the body it was accepted over, the refused text is offered once, it is recorded as not applied, and nothing more is saved", async () => {
		harness.autosave.delayMs = 300;
		const { reviewing, other } = await openRoom();
		const before = editorBody(reviewing);
		server.failNext = Object.assign(new Error("refused"), {
			code: "PRECONDITION_FAILED",
			data: { code: "REVISION_OUTSIDE_TARGET" },
		});

		await acceptProposal(reviewing, `${BODY_A}\n\n${ACCEPTED}`);
		await waitFor(() => {
			expect(editorBody(reviewing)).toBe(before);
		});
		await waitFor(() => {
			expect(editorBody(other)).toBe(before);
		});
		await expectResumed(other);
		await waitFor(() => {
			expect(mainEditor(reviewing)?.isEditable).toBe(true);
		});
		expect(refusedTextOffers()).toHaveLength(1);
		expect(harness.recordOutcome).toHaveBeenCalledTimes(1);
		expect(harness.recordOutcome).toHaveBeenCalledWith({
			accepted: false,
			summary:
				"Not applied: it changed a section outside the one it targeted.",
			operationKey: expect.any(String),
		});
		await settle(800);
		expect(saveCalls).toHaveLength(1);
		expect(server.content).toBe(BODY_A);
		expect(editorBody(reviewing)).not.toContain(ACCEPTED);
	});

	it("a version conflict keeps today's answer: the room is brought back to the saved document and the accepted text offered", async () => {
		const { reviewing } = await openRoom();
		server.failNext = Object.assign(new Error("Document changed"), {
			code: "CONFLICT",
		});

		await acceptProposal(reviewing, `${BODY_A}\n\n${ACCEPTED}`);
		await waitFor(() => {
			expect(harness.recordOutcome).toHaveBeenCalledWith(
				FAILED_OFFERED_ACCEPT_RECORD,
			);
		});
		expect(refusedTextOffers()).toHaveLength(0);
		// Not sent again without its descriptor.
		expect(saveCalls).toHaveLength(1);
	});

	it("waiting behind the autosave when the page is left, its save still names its descriptor", async () => {
		await persistRoom(BODY_A, savedStamp());
		const tab = await openTab("tab");
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			shouldAdvanceTime: true,
		});
		try {
			await type(tab, " First edit.");
			server.holdAnswers = true;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10_500);
			});
			await waitFor(() => {
				expect(saveCalls).toHaveLength(1);
			});
			await acceptProposal(tab, `${editorBody(tab)}\n\n${ACCEPTED}`);
			expect(saveCalls).toHaveLength(1);
			await act(async () => {
				tab.view?.unmount();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});

			server.holdAnswers = false;
			await act(async () => {
				for (const answer of server.held.splice(0)) {
					answer();
				}
				await vi.advanceTimersByTimeAsync(50);
			});
		} finally {
			vi.useRealTimers();
		}
		await waitFor(() => {
			expect(saveCalls).toHaveLength(2);
		});
		expect(saveCalls[1]?.content).toContain(ACCEPTED);
		expect(saveCalls[1]).toMatchObject({
			aiReview: { kind: "CHAT", patchedSectionKeys: ["p1:pricing#0"] },
		});
	});

	/**
	 * A diagram proposed in a tab that died unanswered stayed in the room.
	 * Taken for the saved body by the tab opened next, it was the base of
	 * that tab's next proposal, which added the diagram again: its accept
	 * saved both.
	 */
	it("a proposal left in the room by a tab that died is taken out before the next one: accepting that one saves the proposed diagram once", async () => {
		harness.timings.proposalCardLateLimitMs = 400;
		const DIAGRAM =
			"```mermaid\nflowchart LR\n  Kickoff --> Design --> Build\n```";
		const IN_DIAGRAM = "Kickoff --> Design";
		await persistRoom(BODY_A, savedStamp());
		const first = await openTab("first", { clientId: 10 });
		await settle(200);
		harness.chatIn = first.name;
		harness.agentState = {
			document: `${BODY_A}\n\n${DIAGRAM}`,
			proposalPatchedSectionKeys: ["p1:pricing#0"],
		};
		rerender(first);
		await settle(20);
		await act(async () => {
			first.actions.get("confirm_changes")?.renderAndWaitForResponse({
				args: {},
				respond: vi.fn(),
				status: "executing",
			});
			await Promise.resolve();
		});
		await settle(50);
		expect(await roomBody()).toContain(IN_DIAGRAM);

		// The tab dies: no `pagehide`, nothing put back.
		first.synced = false;
		rerender(first);
		await settle(50);
		const index = room.tabs.indexOf(first);
		if (index >= 0) {
			room.tabs.splice(index, 1);
		}
		expect(await roomBody()).toContain(IN_DIAGRAM);

		const later = await openTab("later", { clientId: 30 });
		await waitFor(() => {
			expect(mainEditor(later)?.isEditable).toBe(false);
		});
		await settle(600);
		await waitFor(() => {
			expect(mainEditor(later)?.isEditable).toBe(true);
		});
		expect(editorBody(later)).toBe(BODY_A);
		expect(saveCalls).toEqual([]);

		const respond = await acceptProposal(
			later,
			`${editorBody(later)}\n\n${DIAGRAM}`,
		);
		expect(respond).toHaveBeenCalledWith({ accepted: true });
		await waitFor(() => {
			expect(server.content).toContain(IN_DIAGRAM);
		});
		expect(occurrences(server.content, IN_DIAGRAM)).toBe(1);
		expect(saveCalls).toHaveLength(1);
		expect(saveCalls[0]).toMatchObject({
			tab: "later",
			aiReview: { kind: "CHAT", patchedSectionKeys: ["p1:pricing#0"] },
		});
		first.view?.unmount();
	});

	describe("a section revision under review", () => {
		const PRICING_KEY = buildSectionMap(BODY_A).sections.find(
			(section) => section.headingText === "Pricing",
		)?.key as string;
		const REVISED = "A fixed fee covers both phases.";

		async function openRevision(tab: Tab) {
			harness.reviseSection.mockResolvedValue({
				status: "CANDIDATE",
				sectionKey: PRICING_KEY,
				body: REVISED,
				baseVersion: server.version,
				baseContentHash: hashOf(server.content),
				revisionToken: "token-example",
			});
			harness.sectionRevisionRequests.set(tab.name, {
				id: "revision-1",
				runId: "run-1",
				findingId: "finding-1",
			});
			rerender(tab);
			await waitFor(() => {
				expect(editorBody(tab)).toContain(REVISED);
			});
			await settle(50);
		}

		it("holds the other tab and keeps the reviewing editor read-only; Accept saves it with the FINDING descriptor and releases both", async () => {
			const { reviewing, other } = await openRoom();
			await openRevision(reviewing);

			expect(harness.reviseSection).toHaveBeenCalledWith({
				projectId: "proj-1",
				documentId: "doc-1",
				runId: "run-1",
				findingId: "finding-1",
				baseVersion: 7,
				baseContentHash: hashOf(BODY_A),
			});
			expect(mainEditor(reviewing)?.isEditable).toBe(false);
			expect(reviewPublished(reviewing)).toBe(true);
			await expectHeld(other);

			await act(async () => {
				harness.reviewBarProps?.onAcceptAll();
			});
			await waitFor(() => {
				expect(server.content).toContain(REVISED);
			});
			expect(saveCalls).toHaveLength(1);
			expect(saveCalls[0]).toMatchObject({
				tab: "reviewing",
				aiReview: {
					kind: "FINDING",
					runId: "run-1",
					findingId: "finding-1",
					revisionToken: "token-example",
				},
			});
			await expectResumed(other);
			expect(editorBody(other)).toContain(REVISED);
			expect(harness.sectionRevisionOutcomes).toEqual([
				{ tab: "reviewing", id: "revision-1", result: "accepted" },
			]);
		});

		it("rejected: the other tab resumes on the body from before it, and nothing is saved", async () => {
			const { reviewing, other } = await openRoom();
			const before = editorBody(reviewing);
			await openRevision(reviewing);
			await expectHeld(other);

			await act(async () => {
				harness.reviewBarProps?.onRejectAll();
			});
			await expectResumed(other);
			expect(editorBody(reviewing)).toBe(before);
			expect(editorBody(other)).toBe(before);
			await settle(300);
			expect(saveCalls).toEqual([]);
			expect(harness.sectionRevisionOutcomes).toEqual([
				{ tab: "reviewing", id: "revision-1", result: "rejected" },
			]);
		});

		it("left within the app while under review, is rejected on the way out: the other tab resumes on the body from before it", async () => {
			const { reviewing, other } = await openRoom();
			const before = editorBody(reviewing);
			await openRevision(reviewing);
			await expectHeld(other);

			await act(async () => {
				reviewing.view?.unmount();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await expectResumed(other);
			expect(editorBody(other)).toBe(before);
			expect(saveCalls).toEqual([]);
		});
	});
});
