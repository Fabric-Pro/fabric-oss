import { screen } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";

type User = ReturnType<typeof userEvent.setup>;

/**
 * Opens the File actions menu of the file header, where Rename and Delete file
 * live. They are menu items, not buttons beside Edit.
 */
export async function openFileActions(user: User) {
	await user.click(
		await screen.findByRole("button", { name: "File actions" }),
	);
}

/** Opens the File actions menu and chooses `name` in it. */
export async function chooseFileAction(
	user: User,
	name: "Rename" | "Delete file",
) {
	await openFileActions(user);
	await user.click(await screen.findByRole("menuitem", { name }));
}
