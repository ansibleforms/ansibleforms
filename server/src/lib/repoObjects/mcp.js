'use strict';
// The MCP type of the repository-backed objects (lib/repoObjects/envType.js) : what Settings >
// Connections > MCP saves - the MCP server's switch and its options (ENABLE_MCP, MCP_READ_ONLY,
// MCP_CHAT_FORMS_ONLY ...) - under the mcp: key of a repository's file, keyed by their environment variable
// names, each with its value (its documented default when never saved). Applied as the page saves
// them (the switch at once, without a restart). The config seed's mcp section holds its variables
// per field, as its Appearance sections (defaults, links ...) do.
import { envType } from "./envType.js";

export default envType({
  key: "mcp",
  title: "MCP",
  noun: "MCP settings",
  page: "Settings > Connections > MCP",
  all: true,
  seedHeld: true,
});
