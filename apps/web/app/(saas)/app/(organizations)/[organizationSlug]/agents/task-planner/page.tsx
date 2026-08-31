"use client";
import "@copilotkit/react-ui/styles.css";
// The stylesheet lives beside the sibling agent route in the personal tree;
// both routes render the same workspace, so both declare the same page CSS.
import "../document-generator/style.css";
import "@saas/projects/components/DocumentEditor.css";

import { TaskPlannerWorkspace } from "@saas/agents/components/TaskPlannerWorkspace";

export default function OrganizationTaskPlannerPage() {
	return <TaskPlannerWorkspace />;
}
