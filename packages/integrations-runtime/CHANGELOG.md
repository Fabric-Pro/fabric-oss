# @fabricorg/integrations-runtime

## 0.1.2

### Patch Changes

- 64e1431: The type declaration files of the Fabric SDK, SDK MCP server and integration packages no longer end with a `sourceMappingURL` comment that points at a declaration map the packages do not ship.

## 0.1.1

### Patch Changes

- 436db8c: The Fabric SDK, SDK MCP server and integration packages are now built with tsdown instead of tsup, with the same entry points, exports and ES2015 output; `@fabricorg/sdk-mcp` also exports its `FabricLike` client type.
