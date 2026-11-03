---
title: "A CopilotKit frontend tool keeps its first description until it remounts"
date: 2026-11-02
category: integration-issues
module: document editor repository tools
problem_type: integration_issue
component: assistant
severity: medium
symptoms:
  - "After the project's repository changed on an open document page, the assistant's GitHub/GitLab tools still named the old repository"
  - "The tool handlers already worked on the new repository, so the model asked for one repository and got the other"
  - "An editor test passed because its useFrontendTool mock recorded the tool on every render"
root_cause: wrong_api
resolution_type: code_fix
related_components: [web-editor, agents]
tags: [copilotkit, use-frontend-tool, tool-registration, remount, mock-hides-contract, fizzy-2946]
audience: engineers registering CopilotKit frontend tools whose definition depends on data that can change while the page is open
owner: web app team
---

# A CopilotKit frontend tool keeps its first description until it remounts

## Problem

The document editor offers the assistant eight repository tools whose descriptions name the project's repository (`owner/repo`). When the repository changed while the page was open, the model kept reading the old name until the page was reloaded, although the tool handlers already used the new repository (Fizzy #2946).

## Why

In `@copilotkit/react-core` 1.80 the root `useFrontendTool(tool, dependencies)` is the deprecated v1 wrapper. It keeps the handler and render fresh through refs, which is why the handlers were right, but it calls the v2 hook without passing `dependencies`. The v2 hook registers the tool in a `useLayoutEffect` whose dependencies are the tool's `name`, its `available` state and the client. A change to the description alone never registers the tool again, so `dependencies` cannot help.

## Fix

Register the tools from a small component that renders nothing, and mount it with a `key` that changes whenever the definition must change (here `owner/repo`). A new key remounts the component: the old registrations are removed on unmount and the new ones carry the new description. See `apps/web/modules/saas/projects/components/RepositoryFrontendTools.tsx` and where `DocumentEditor.tsx` mounts it.

A move to the v2 `useFrontendTools(tools, deps)` with the repository in `deps` would also work; it means moving the tools to the v2 parameter and render contract.

## The test that hid it

The editor test mocked `useFrontendTool` as "record the tool on every render", so a rerender with a new description updated the record and the test passed while the real library did not. The mock now follows the library: it registers in a layout effect keyed on `name` and `available` and deletes on cleanup. With that mock the repository-change test fails without the keyed component. Before relying on a library's update behaviour, confirm it once against the installed version (a throwaway test against the real provider showed un-keyed: alpha then alpha; keyed: alpha then beta).

## Related

- `docs/solutions/conventions/a-test-double-must-mirror-the-contract-not-the-convenience.md`
- `docs/solutions/integration-issues/copilotkit-runtime-properties-never-reach-the-agent.md`
