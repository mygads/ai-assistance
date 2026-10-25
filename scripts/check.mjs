// npm run check — static gate: typecheck, schema validation, Rust fmt/clippy.
// Exit 0 = pass; 1 = fail (real defect); 2 = blocked (toolchain missing).
// Blocked sections are reported, never silently skipped.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { finish } from "./lib/harness.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const startedUtc = new Date().toISOString();
const failures = [];
const blocked = [];
const passed = [];

function section(name, fn) {
  try {
    const r = fn();
    if (r === "blocked") blocked.push(name);
    else passed.push(name);
  } catch (e) {
    failures.push(`${name}: ${String(e?.message ?? e).slice(0, 500)}`);
  }
}

// 1. TypeScript strict typecheck (no emit).
section("tsc --noEmit", () => {
  const tsc = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const r = spawnSync(`"${tsc}" --noEmit`, { cwd: rootDir, encoding: "utf8", timeout: 240000, shell: true });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0) throw new Error(out.slice(0, 2000) || `tsc exit ${r.status}`);
});

// 2b. Contract freeze: frozen IPC surface matches Rust handlers,
// generated TS matches the frozen contract (drift fails the gate).
section("contract freeze (ipc-commands.json <-> commands.rs <-> ipc.ts)", () => {
  const frozen = JSON.parse(readFileSync(path.join(rootDir, ".agent", "schemas", "ipc-commands.json"), "utf8"));
  const rs = readFileSync(path.join(rootDir, "src-tauri", "src", "commands.rs"), "utf8");
  const missing = frozen.commands
    .map((c) => c.name)
    .filter((name) => !new RegExp(`pub fn ${name}\\s*\\(`).test(rs));
  if (missing.length > 0) throw new Error(`handlers missing in commands.rs: ${missing.join(", ")}`);
  const lib = readFileSync(path.join(rootDir, "src-tauri", "src", "lib.rs"), "utf8");
  const registered = (lib.match(/generate_handler!\s*\[([\s\S]*?)\]/)?.[1] ?? "")
    .split(",").map((s) => s.trim().replace(/^commands::/, "")).filter(Boolean);
  const unregistered = frozen.commands.map((c) => c.name).filter((n) => !registered.includes(n));
  if (unregistered.length > 0) throw new Error(`commands not in generate_handler!: ${unregistered.join(", ")}`);
  // ipc.ts freshness: regenerate and compare with the committed file.
  const ipcPath = path.join(rootDir, "src", "ui", "ipc.ts");
  const before = readFileSync(ipcPath, "utf8");
  execFileSync(process.execPath, [path.join(rootDir, "scripts", "gen-ipc-types.mjs")], { cwd: rootDir, encoding: "utf8" });
  const after = readFileSync(ipcPath, "utf8");
  if (before !== after) throw new Error("src/ui/ipc.ts is stale: run npm run gen:ipc and commit the result");
  const hashes = {};
  for (const f of ["state.schema.json", "transcript-event.schema.json", "generation-event.schema.json", "run-report.schema.json", "ipc-commands.json"]) {
    hashes[f] = createHash("sha256").update(readFileSync(path.join(rootDir, ".agent", "schemas", f))).digest("hex").slice(0, 16);
  }
  console.log(`  freeze hashes: ${JSON.stringify(hashes)}`);
});section("schemas (ajv draft 2020-12)", () => {
  // strictRequired disabled: it rejects spec-valid if/then/required patterns
  // used by the pack's generation-event schema. Spec validity is the gate.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const load = (p) => JSON.parse(readFileSync(path.join(rootDir, p), "utf8"));
  const schemas = {
    state: load(".agent/schemas/state.schema.json"),
    transcript: load(".agent/schemas/transcript-event.schema.json"),
    generation: load(".agent/schemas/generation-event.schema.json"),
    report: load(".agent/schemas/run-report.schema.json"),
  };
  for (const [name, s] of Object.entries(schemas)) ajv.compile(s);
  const check = (schema, data, label) => {
    const v = ajv.compile(schema);
    if (!v(data)) throw new Error(`${label}: ${ajv.errorsText(v.errors)}`);
  };
  check(schemas.state, load(".agent/state.json"), "state.json");
  const fixture = load("tests/fixtures/replay/partial-and-overlap.json");
  for (const [i, row] of fixture.events.entries()) {
    const v = ajv.compile(schemas.transcript);
    if (!v(row.transcript)) throw new Error(`fixture event ${i}: ${ajv.errorsText(v.errors)}`);
    if (!(0 <= row.transcript.start_ms && row.transcript.start_ms <= row.transcript.end_ms && row.transcript.end_ms <= row.at_ms)) {
      throw new Error(`fixture event ${i}: timeline violates 0 <= start <= end <= at_ms`);
    }
  }
});

// 3. Rust formatting + lints (requires cargo; clippy needs the MSVC linker on Windows).
function cargoEnv() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const bin = path.join(home, ".cargo", "bin");
  const sep = process.platform === "win32" ? ";" : ":";
  return { ...process.env, PATH: `${bin}${sep}${process.env.PATH ?? ""}` };
}

section("cargo fmt --check", () => {
  if (!existsSync(path.join(rootDir, "src-tauri", "Cargo.toml"))) return "blocked";
  const r = spawnSync("cargo fmt --check", { cwd: path.join(rootDir, "src-tauri"), encoding: "utf8", timeout: 120000, shell: true, env: cargoEnv() });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (/not recognized|not found|No such file/i.test(out) && r.status !== 0) return "blocked";
  if (r.status !== 0) throw new Error(out.slice(0, 2000));
});

section("cargo clippy", () => {
  if (!existsSync(path.join(rootDir, "src-tauri", "Cargo.toml"))) return "blocked";
  const r = spawnSync("cargo clippy --all-targets -- -D warnings", {
    cwd: path.join(rootDir, "src-tauri"),
    encoding: "utf8",
    timeout: 600000,
    shell: true,
    env: cargoEnv(),
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (/not recognized|not found|No such file/i.test(out) && r.status !== 0) return "blocked";
  if (/linker|link\.exe|msvc|Visual Studio/i.test(out) && r.status !== 0) return "blocked";
  if (r.status !== 0) throw new Error(out.slice(0, 2000));
});

console.log(JSON.stringify({ passed, blocked, failures }, null, 2));
const cases = [
  ...passed.map((name) => ({ id: name, level: "L0", status: "pass", replaced_boundaries: [] })),
  ...blocked.map((name) => ({ id: name, level: "L0", status: "blocked", replaced_boundaries: [], note: "toolchain prerequisite missing" })),
  ...failures.map((f) => {
    const name = f.split(":")[0];
    return { id: name, level: "L0", status: "fail", replaced_boundaries: [], note: f.slice(0, 300) };
  }),
];
finish({ script: "check", level: "L0", cases, startedUtc });
