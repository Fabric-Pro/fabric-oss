import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";
import { NewWorkflowRedirect } from "./redirect";

export default async function NewWorkflowPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	// This page creates a workflow and redirects to the canvas
	return <NewWorkflowRedirect />;
}
