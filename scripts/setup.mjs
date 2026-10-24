// npm run setup — idempotent dependency install within existing permissions.
// Preserves user configuration; never upgrades toolchains on its own.
import { spawnSync } from "node:child_process";

const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
  stdio: "inherit",
  shell: true,
  timeout: 600000,
});
process.exit(r.status ?? 1);
