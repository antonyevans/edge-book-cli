import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_DIALOUT_HOST, EdgeBookDialoutClient, handleCli } from "./dist/edge-book.js";

function resolveHome(api) {
  const configured = api?.pluginConfig?.home;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return process.env.EDGE_BOOK_HOME || undefined;
}

function resolveHost(api) {
  const configured = api?.pluginConfig?.host;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return process.env.EDGE_BOOK_HOST || DEFAULT_DIALOUT_HOST;
}

function autoDialoutEnabled(api) {
  const configured = api?.pluginConfig?.autoDialout;
  if (configured === false || configured === "false" || configured === "off") return false;
  if (process.env.EDGE_BOOK_DIALOUT === "off" || process.env.EDGE_BOOK_DIALOUT === "false") return false;
  return true;
}

export default definePluginEntry({
  id: "edge-book",
  name: "Edge Book",
  description: "Local-first agent friendship, contact graph, capability grants, and two-agent harness.",
  register(api) {
    let managedClient = null;
    let stoodDown = false;

    async function startManaged() {
      if (managedClient || !autoDialoutEnabled(api) || stoodDown) return;
      const home = resolveHome(api);
      const host = resolveHost(api);
      await handleCli(["init"], { home, defaultHost: host, textOnly: true });
      console.warn(`[edge-book] Enabling hosted dial-out to ${host}. The host can read this agent's Edge Book graph while connected.`);
      managedClient = new EdgeBookDialoutClient({
        home,
        host,
        onStandDown: (frame) => {
          stoodDown = true;
          managedClient = null;
          console.warn(`[edge-book] Hosted dial-out stood down by host (${frame.type || "stand_down"}). Run edge-book pair to reconnect.`);
        }
      });
      await managedClient.start();
    }

    api.registerCommand({
      name: "edge-book",
      description: "Manage Edge Book identity, Agent Card, contacts, friendship, and harness.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim() ? ctx.args.trim().split(/\s+/) : ["help"];
        if (args[0] === "pair") stoodDown = false;
        const result = await handleCli(args, { home: resolveHome(api), defaultHost: resolveHost(api), textOnly: true });
        if (args[0] === "pair") await startManaged();
        return { text: result.text };
      }
    });

    api.registerService({
      id: "edge-book-managed-dialout",
      start: async () => {
        await startManaged();
      },
      stop: async () => {
        if (managedClient) await managedClient.stop();
        managedClient = null;
      }
    });
  }
});
