/**
 * A project viewer gets a read-only document editor with no write control,
 * also with the collaborative room flag off. Before, only the room froze the
 * editor for a viewer: without it the viewer could type, and Save,
 * Regenerate and Update using context stayed enabled while the server
 * refused every write.
 */
import {
	BODY_A,
	beforeEach,
	describe,
	expect,
	harness,
	it,
	mainEditor,
	openTab,
	persistRoom,
	saveButton,
	saveCalls,
	settle,
	type Tab,
	type,
	within,
} from "./DocumentEditor.room-convergence.harness";

function toolbarButton(tab: Tab, name: string): HTMLElement {
	const view = tab.view;
	if (!view) {
		throw new Error(`${tab.name} is not rendered`);
	}
	const [button] = within(view.container).getAllByRole("button", { name });
	if (!button) {
		throw new Error(`${tab.name} shows no ${name} button`);
	}
	return button;
}

describe("a project viewer with the room flag off", () => {
	beforeEach(async () => {
		harness.flags = { DOCUMENT_ROOM_CONVERGENCE: false };
		await persistRoom(BODY_A, null);
	});

	it("gets a read-only editor and no Save, Regenerate or Update using context", async () => {
		const tab = await openTab("viewer", { role: "viewer" });
		await settle(100);

		expect(mainEditor(tab)?.isEditable).toBe(false);
		expect(saveButton(tab)).toBeDisabled();
		expect(toolbarButton(tab, "Regenerate")).toBeDisabled();
		expect(toolbarButton(tab, "Update using context")).toBeDisabled();
	});

	it("sends no save for text that reaches the editor", async () => {
		const tab = await openTab("viewer", { role: "viewer" });
		await type(tab, " Typed by a viewer.");
		await settle(300);

		expect(saveButton(tab)).toBeDisabled();
		expect(saveCalls).toHaveLength(0);
	});

	it("leaves an editor's controls as they were", async () => {
		const tab = await openTab("editor", { role: "editor" });
		await settle(100);

		expect(mainEditor(tab)?.isEditable).toBe(true);
		expect(toolbarButton(tab, "Regenerate")).not.toBeDisabled();
		expect(toolbarButton(tab, "Update using context")).not.toBeDisabled();
	});
});

describe("an organization admin with no project role", () => {
	it.each([false, true])(
		"edits as the server allows (room flag on: %s)",
		async (roomOn) => {
			harness.flags = { DOCUMENT_ROOM_CONVERGENCE: roomOn };
			await persistRoom(BODY_A, null);
			const tab = await openTab("org-admin", { role: "orgAdmin" });
			await settle(100);

			expect(mainEditor(tab)?.isEditable).toBe(true);
			expect(toolbarButton(tab, "Regenerate")).not.toBeDisabled();
		},
	);
});
