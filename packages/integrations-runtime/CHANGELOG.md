# @fabricorg/integrations-runtime

## 0.1.4

### Patch Changes

- 706772d: The CLI, SDK, MCP SDK and integration packages now ship READMEs covering installation, authentication and their public interfaces.

## 0.1.3

### Patch Changes

- e8fb586: Published SDK and integration declaration files now retain entry documentation comments.

## 0.1.2

### Patch Changes

- 3949a81: The type declaration files of the Fabric SDK, SDK MCP server and integration packages no longer end with a `sourceMappingURL` comment that points at a declaration map the packages do not ship.

## 0.1.1

### Patch Changes

- 436db8c: The Fabric SDK, SDK MCP server and integration packages are now built with tsdown instead of tsup, with the same entry points, exports and ES2015 output; `@fabricorg/sdk-mcp` also exports its `FabricLike` client type.
