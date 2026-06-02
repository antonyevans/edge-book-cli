import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { handleCli } from "./src/cli.ts";

function resolveHome(api) {
  const configured = api?.pluginConfig?.home;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return process.env.EDGE_BOOK_HOME || undefined;
}

export default definePluginEntry({
  id: "edge-book",
  name: "Edge Book",
  description: "Local-first agent friendship, contact graph, capability grants, and two-agent harness.",
  register(api) {
    api.registerCommand({
      name: "edge-book",
      description: "Manage Edge Book identity, Agent Card, contacts, friendship, and harness.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim() ? ctx.args.trim().split(/\s+/) : ["help"];
        const result = await handleCli(args, { home: resolveHome(api), textOnly: true });
        return { text: result.text };
      }
    });
  }
});
