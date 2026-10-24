// npm run doctor — capability report for this host.
// Exit 0 when the report itself is produced. Blocked capabilities are data,
// not failures: they gate later test levels but never fail this command.
// Never prints secret values; key presence is reported as booleans only.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, { timeout = 30000, shell = false, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, shell, env }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, stdout: stdout?.trim() ?? "", stderr: (stderr ?? error.message).trim() });
      } else {
        resolve({ ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

async function toolVersion(cmd, args = ["--version"]) {
  // Version probes run through the shell: on Windows npm is an npm.cmd
  // shim that execFile cannot spawn directly (EINVAL without a shell).
  // The command line is assembled here from fixed literals only — no
  // caller input ever reaches the shell — so no escaping hazard exists.
  // Cargo lives in the user profile, not on PATH, so expose it explicitly.
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const env = { ...process.env, PATH: `${path.join(home, ".cargo", "bin")}${sep}${process.env.PATH ?? ""}` };
  const line = [cmd, ...args].join(" ");
  const r = await run(line, [], { shell: true, env });
  return { available: r.ok, version: r.ok ? r.stdout.split("\n")[0] : null };
}

async function windowsFacts() {
  // Single PowerShell call: OS build, interactive session, sound devices, WebView2.
  const ps = [
    "$os = Get-CimInstance Win32_OperatingSystem;",
    "$snd = Get-CimInstance Win32_SoundDevice | Select-Object Name,Status;",
    "$wv = (Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -Name pv -ErrorAction SilentlyContinue).pv;",
    "$gui = [bool](Get-Process explorer -ErrorAction SilentlyContinue);",
    "@{ os_caption = $os.Caption; os_build = $os.BuildNumber; os_version = $os.Version;",
    "   interactive_gui = $gui; webview2_pv = $wv;",
    "   sound_devices = @($snd | ForEach-Object { @{ name = $_.Name; status = $_.Status } }) }",
    "| ConvertTo-Json -Depth 4 -Compress",
  ].join(" ");
  const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 60000 });
  if (!r.ok) return { probe_ok: false, error: r.stderr.slice(0, 300) };
  try {
    return { probe_ok: true, ...JSON.parse(r.stdout) };
  } catch (e) {
    return { probe_ok: false, error: `unparseable powershell output: ${String(e).slice(0, 200)}` };
  }
}

const report = {
  kind: "doctor",
  generated_utc: new Date().toISOString(),
  host: {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpus: os.cpus().length,
    total_mem_mb: Math.round(os.totalmem() / 1048576),
  },
  windows: await windowsFacts(),
  toolchains: {
    node: { available: true, version: process.version },
    npm: await toolVersion("npm", ["--version"]),
    git: await toolVersion("git", ["--version"]),
    cargo: await toolVersion("cargo", ["--version"]),
    rustc: await toolVersion("rustc", ["--version"]),
    rustup: await toolVersion("rustup", ["--version"]),
    python: await toolVersion("py", ["--version"]),
  },
  native_build_ready: null, // derived below
  audio: null, // derived below
  provider_keys: {
    SONIOX_API_KEY: Boolean(process.env.SONIOX_API_KEY),
    DEEPGRAM_API_KEY: Boolean(process.env.DEEPGRAM_API_KEY),
    LLM_API_KEY: Boolean(process.env.LLM_API_KEY),
    LIVE_TESTS_ENABLED: process.env.LIVE_TESTS_ENABLED === "true",
  },
  live_budget: null, // derived below
};

report.native_build_ready =
  report.toolchains.cargo.available &&
  report.toolchains.rustc.available &&
  Boolean(report.windows?.webview2_pv);

const devices = report.windows?.sound_devices ?? [];
report.audio = {
  sound_devices_found: devices.length,
  devices: devices.map((d) => d.name),
  note: "Win32_SoundDevice enumeration only; WASAPI endpoint routing/capture is verified by test:audio on a real endpoint lease, not by this probe.",
};

report.live_budget = report.provider_keys.LIVE_TESTS_ENABLED
  ? "enabled-flag-set: verify caps and billing units before any live call"
  : "unknown_or_disabled: live gates stay blocked until keys + caps are supplied";

const capable = {
  desktop_interactive: Boolean(report.windows?.interactive_gui),
  os_windows: report.host.platform === "win32",
  webview2: Boolean(report.windows?.webview2_pv),
  rust: report.toolchains.cargo.available && report.toolchains.rustc.available,
  audio_devices: devices.length > 0,
  provider_keys_present: Object.entries(report.provider_keys)
    .filter(([k]) => k !== "LIVE_TESTS_ENABLED")
    .some(([, v]) => v),
};
report.capabilities = capable;

// Persist evidence (no secrets inside: presence booleans only).
const stamp = report.generated_utc.replace(/[:.]/g, "-");
const outDir = path.join(rootDir, ".agent", "evidence");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `doctor-${stamp}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");

console.log(JSON.stringify({ ...report, evidence_ref: path.relative(rootDir, outPath) }, null, 2));
