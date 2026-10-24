// npm run check — static gate: typecheck, schema validation, Rust fmt/clippy.
// Exit 0 = pass; 1 = fail (real defect); 2 = blocked (toolchain missing).
// Blocked sections are reported, never silently skipped.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

// 2. JSON Schema: Draft 2020-12 validity + fixture/state conformance.
section("schemas (ajv draft 2020-12)", () => {
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
if (failures.length > 0) {
  console.error(`check FAIL: ${failures.length} failing section(s)`);
  process.exit(1);
}
if (blocked.length > 0) {
  console.log(`check BLOCKED: ${blocked.join(", ")} (toolchain prerequisite missing)`);
  process.exit(2);
}
console.log("check PASS");
