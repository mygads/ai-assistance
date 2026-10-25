// npm run test:capture — L6 capture-API / meeting-compatibility matrix.
// Real part (this script): OS capture-API availability (GraphicsCapture needs
// Win10 1809+), installed meeting/recording tools from the uninstall registry,
// and whether a visible calibration pattern can be shown. Actually rendering
// the pattern inside the running app and verifying its absence in captures is
// T20 work with the native slice; until then those cells are blocked.
import { execFile } from "node:child_process";
import { finish } from "./lib/harness.mjs";

const startedUtc = new Date().toISOString();
const cases = [];
const push = (id, status, replaced_boundaries = [], note) => cases.push({ id, level: "L6", status, replaced_boundaries, ...(note ? { note } : {}) });

function ps(script) {
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 90000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: (stdout ?? "").trim(), stderr: ((stderr ?? "") + (error?.message ?? "")).trim() });
    });
  });
}

const MATRIX_PS = [
  "$os = Get-CimInstance Win32_OperatingSystem;",
  "$build = [int]$os.BuildNumber;",
  "$paths = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
  "  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
  "  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');",
  "$apps = Get-ItemProperty $paths -ErrorAction SilentlyContinue | Select-Object DisplayName,DisplayVersion;",
  "$hits = $apps | Where-Object { $_.DisplayName -match 'Zoom|Teams|Webex|Meet|OBS|Camtasia|Snagit' } | Select-Object DisplayName,DisplayVersion;",
  "@{ build = $build; graphics_capture_supported = ($build -ge 17763); meeting_apps = @($hits) } | ConvertTo-Json -Depth 4 -Compress",
].join(" ");

let matrix = null;
try {
  const r = await ps(MATRIX_PS);
  if (!r.ok) throw new Error(r.stderr.slice(0, 300));
  matrix = JSON.parse(r.stdout || "{}");
  push("L6-capture-api-availability", matrix.graphics_capture_supported ? "pass" : "fail", [],
    `os_build=${matrix.build} graphics_capture_supported=${matrix.graphics_capture_supported}`);
  const apps = matrix.meeting_apps ?? [];
  push("L6-meeting-tools-inventoried", "pass", [],
    apps.length > 0 ? `found: ${apps.map((a) => `${a.DisplayName} ${a.DisplayVersion ?? ""}`.trim()).join("; ")}` : "no Zoom/Teams/Webex/Meet/OBS/Camtasia/Snagit install detected; matrix cells for those stay untested, not passed");
} catch (e) {
  push("L6-capture-api-availability", "fail", [], String(e?.message ?? e).slice(0, 300));
}

push("L6-calibration-absence-in-capture", "blocked",
  ["running app + real meeting capture -> inventory only"],
  "Requires the T04 native slice to show a calibration pattern in-app, then capture it via installed meeting tools (T20). No capture was taken, so absence is unproven.");
push("L6-scaling-focus-matrix", "blocked",
  ["interactive desktop session -> inventory only"],
  "100/125/150% scaling, focus preservation, and scrolled-text stability need the running native app (T20).");

finish({ script: "test:capture", level: "L6", cases, startedUtc, extra: { matrix } });
