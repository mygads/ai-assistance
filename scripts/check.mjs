// npm run check — static gate: typecheck, schema validation, Rust fmt/clippy.
// Exit 0 = pass; 1 = fail (real defect); 2 = blocked (toolchain missing).
// Blocked sections are reported, never silently skipped.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  // Bare-scalar commands must opt into snake_case arg keys: the Tauri command
  // macro defaults top-level arg keys to camelCase, so `session_id: String`
  // would arrive as `sessionId` and fail at runtime (T17 caught
  // pause/resume/stop/list_sources/cancel_answer this way). Struct inputs are
  // matched by serde exactly and need no attribute.
  const scalarCmdRe = /#\[tauri::command([^\]]*)\]\s*pub fn (\w+)\s*\(([^)]*)\)/g;
  const scalarMissing = [];
  for (const m of rs.matchAll(scalarCmdRe)) {
    const [, attr, name, params] = m;
    const firstType = (params.split(",")[0] ?? "").split(":")[1] ?? "";
    if (/\b(String|u32|u64|i32|i64|bool|f64)\b/.test(firstType) && !/rename_all\s*=\s*"snake_case"/.test(attr)) {
      scalarMissing.push(name);
    }
  }
  if (scalarMissing.length > 0) throw new Error(`bare-scalar commands missing rename_all snake_case: ${scalarMissing.join(", ")}`);
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

// 2c. Production isolation, A20 L0 slice (C30): privileged test hooks must
// be absent from production code paths and no secret values may be checked
// in. L3 (built binary) and L6 (installer) negatives ride on test:native and
// test:installer in P05/P06; this gate holds the static half.
section("production isolation (A20 L0)", () => {
  const rsFiles = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (["target", "node_modules"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".rs") || e.name.endsWith(".ts") || e.name.endsWith(".tsx") || e.name.endsWith(".mjs")) rsFiles.push(p);
    }
  };
  walk(path.join(rootDir, "src-tauri", "src"));
  walk(path.join(rootDir, "src"));
  walk(path.join(rootDir, "scripts"));
  const violations = [];
  for (const f of rsFiles) {
    const text = readFileSync(f, "utf8");
    if (/cfg\(\s*feature\s*=\s*"test-harness"\s*\)/.test(text)) {
      violations.push(`${path.relative(rootDir, f)}: feature-gated test hook in shipped source`);
    }
  }
  // No test-harness cfg anywhere in shipped source: every #[cfg(test)] block
  // compiles out of the binary, and no feature flag can smuggle one back in.
  const secretRe = /sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[bpas]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY/;
  for (const f of rsFiles) {
    if (/\.agent|evidence/.test(f)) continue;
    if (secretRe.test(readFileSync(f, "utf8"))) violations.push(`${path.relative(rootDir, f)}: secret-shaped literal`);
  }
  const fixtureSrv = readFileSync(path.join(rootDir, "scripts", "lib", "fixture-server.mjs"), "utf8");
  if (!fixtureSrv.includes("127.0.0.1")) throw new Error("fixture server lost its loopback bind marker");
  if (fixtureSrv.includes("0.0.0.0")) throw new Error("fixture server binds a non-loopback interface");
  const bridge = readFileSync(path.join(rootDir, "src", "ui", "bridge.ts"), "utf8");
  if (!bridge.includes("__TAURI_INTERNALS__")) throw new Error("bridge lost its native-mode detection");
  if (!/"native" : "fixture"/.test(bridge) && !/\? "native" : "fixture"/.test(bridge)) {
    throw new Error("bridge must prefer native IPC under Tauri and fixture only outside it");
  }
  if (violations.length > 0) throw new Error(violations.slice(0, 8).join("; "));
});
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
