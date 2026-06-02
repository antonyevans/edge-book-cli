#!/usr/bin/env node
import { runCli } from "../src/cli.ts";

runCli(process.argv.slice(2)).catch((error) => {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
});
