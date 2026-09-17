/**
 * `InstructionsEmptyState`'s "Connect your agent" button, in the "Developers
 * stay current" card. It reuses the exact contract `ConnectCliDialog.test.tsx`
 * already pins for the dialog itself (scopes, gateway endpoint, mint timing),
 * so this suite only has to prove the button renders in the right state, opens
 * the dialog with `purpose="coding-instructions"` and the project name, and
 * fails closed the same way `InstructionsPublishedView`'s own button does —
 * there is nothing to mint a key against without an organization id.
 *
 * `t.rich` is not part of the repo's global `next-intl` mock (`vitest.setup.ts`
 * only echoes `t`/`t.raw`), and this component calls it unconditionally for the
 * upload-instructions and history cards, so this suite resolves the REAL
 * `en.json` copy the same way `UploadFolderDialog.test.tsx` does for its own
 * `t.rich` calls.
 */
import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fragment, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const emptyStateCopy = en.projects.codingInstructions.emptyState as Record<
	string,
	string
>;

/** Minimal `t.rich` stand-in: replaces `<tag>inner</tag>` with `tags[tag](inner)`. */
function richRender(
	template: string,
	tags: Record<string, (chunks: string) => ReactNode>,
): ReactNode[] {
	const nodes: ReactNode[] = [];
	const re = /<(\w+)>(.*?)<\/\1>/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	let key = 0;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
	while ((match = re.exec(template))) {
		if (match.index > lastIndex) {
			nodes.push(
				<Fragment key={key++}>
					{template.slice(lastIndex, match.index)}
				</Fragment>,
			);
		}
		const renderTag = tags[match[1]];
		nodes.push(
			<Fragment key={key++}>
				{renderTag ? renderTag(match[2]) : match[2]}
			</Fragment>,
		);
		lastIndex = re.lastIndex;
	}
	if (lastIndex < template.length) {
		nodes.push(
			<Fragment key={key++}>{template.slice(lastIndex)}</Fragment>,
		);
	}
	return nodes;
}

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string) => emptyStateCopy[key] ?? key;
		t.rich = (
			key: string,
			tags: Record<string, (chunks: string) => ReactNode>,
		) => richRender(emptyStateCopy[key] ?? key, tags);
		t.raw = (key: string) => emptyStateCopy[key] ?? key;
		return t;
	},
}));

/**
 * Controllable per test, mirroring `InstructionsPublishedView.test.tsx`: the
 * button fails closed on `organizationId`, so both the present and absent
 * case need to be driven from here rather than a fixed mock.
 */
const orgContextState = vi.hoisted(() => ({
	organizationId: "org-hosting-the-project" as string | null,
	organizationSlug: "example-org" as string | null,
	isGuest: false,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: orgContextState.organizationId,
		organizationSlug: orgContextState.organizationSlug,
		isGuest: orgContextState.isGuest,
	}),
}));

const connectCliDialogProps: Array<Record<string, unknown>> = [];
vi.mock("@saas/projects/components/cli-connection/ConnectCliDialog", () => ({
	ConnectCliDialog: (props: Record<string, unknown>) => {
		connectCliDialogProps.push(props);
		if (!props.open) {
			return null;
		}
		return <div data-testid="connect-cli-dialog-stub" />;
	},
}));

import { InstructionsEmptyState } from "../InstructionsEmptyState";

beforeEach(() => {
	orgContextState.organizationId = "org-hosting-the-project";
	orgContextState.organizationSlug = "example-org";
	orgContextState.isGuest = false;
	connectCliDialogProps.length = 0;
});

describe("InstructionsEmptyState — connect your agent", () => {
	it("renders the button when an organization id is present and opens the dialog with the coding-instructions purpose and project name", async () => {
		const user = userEvent.setup();
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
			/>,
		);

		const button = screen.getByRole("button", {
			name: "Connect your agent",
		});
		expect(
			screen.queryByTestId("connect-cli-dialog-stub"),
		).not.toBeInTheDocument();

		await user.click(button);

		expect(
			screen.getByTestId("connect-cli-dialog-stub"),
		).toBeInTheDocument();
		const lastProps =
			connectCliDialogProps[connectCliDialogProps.length - 1];
		expect(lastProps).toMatchObject({
			open: true,
			organizationId: "org-hosting-the-project",
			organizationSlug: "example-org",
			projectName: "Checkout Rewrite",
			purpose: "coding-instructions",
		});
	});

	it("does not render the button when there is no organization id", () => {
		orgContextState.organizationId = null;
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "Connect your agent" }),
		).not.toBeInTheDocument();
	});

	it("describes agents reading over the Fabric MCP server in the developers card", () => {
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
			/>,
		);

		expect(screen.getByText(/Fabric MCP server/i)).toBeInTheDocument();
	});

	// An invited cross-organization project guest views this project under
	// the HOST organization's thin record, so `organizationId` is truthy but
	// there is no membership row for the guest in that organization — the
	// create procedure's host-membership check would refuse them.
	it("does not render the button or mount the dialog for an invited guest", () => {
		orgContextState.isGuest = true;
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "Connect your agent" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("connect-cli-dialog-stub"),
		).not.toBeInTheDocument();
	});
});
