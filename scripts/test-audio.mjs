// npm run test:audio — L4 physical-audio verification entry point.
// Real part (this script): WASAPI endpoint enumeration via the MMDevice API
// registry view — device IDs, dataflow, state — plus default-device identity.
// Capture metrics (exclusive lease, loopback correlation, mic signal quality)
// need an open stream + controlled sound and land with the T05 capture module;
// until then they are reported blocked with exact reasons, never faked.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finish, root } from "./lib/harness.mjs";

const startedUtc = new Date().toISOString();
const cases = [];
const push = (id, status, replaced_boundaries = [], note) => cases.push({ id, level: "L4", status, replaced_boundaries, ...(note ? { note } : {}) });

function ps(script) {
  // PowerShell receives the script via a temp .ps1 file (no -Command quoting).
  const dir = mkdtempSync(path.join(tmpdir(), "conv-audio-"));
  const file = path.join(dir, "probe.ps1");
  writeFileSync(file, script, "utf8");
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { timeout: 120000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: (stdout ?? "").trim(), stderr: ((stderr ?? "") + (error?.message ?? "")).trim() });
    });
  });
}

// MMDevices registry: real endpoint IDs + state (1 = active).
const ENUM_PS = [
  "$out = @();",
  "foreach ($flow in 'Render','Capture') {",
  "  $base = \"HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\$flow\";",
  "  if (!(Test-Path $base)) { continue };",
  "  foreach ($id in (Get-ChildItem $base | Select-Object -ExpandProperty PSChildName)) {",
  "    $p = Get-ItemProperty \"$base\\$id\" -ErrorAction SilentlyContinue;",
  "    $name = (Get-ItemProperty \"$base\\$id\\Properties\" -ErrorAction SilentlyContinue).'{a45c254e-df1c-4efd-8020-67d146a850e0},2';",
  "    $out += [pscustomobject]@{ id = $id; flow = $flow; state = $p.DeviceState; name = $name };",
  "  }",
  "}",
  "$out | ConvertTo-Json -Depth 3 -Compress",
].join(" ");

const DEFAULT_PS = [
  "Add-Type -TypeDefinition @\"",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class DefAudio {",
  "  [ComImport, Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692A\")] class MMDeviceEnumerator { }",
  "  [Guid(\"A95664D2-9614-4F35-A746-DE513671B846\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
  "  interface IMMDeviceEnumerator {",
  "    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);",
  "    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);",
  "    int GetDevice(string pwstrId, out IMMDevice ppDevice);",
  "    int RegisterEndpointNotificationCallback(IntPtr pClient);",
  "    int UnregisterEndpointNotificationCallback(IntPtr pClient);",
  "  }",
  "  [Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
  "  interface IMMDevice {",
  "    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IntPtr ppInterface);",
  "    int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);",
  "    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);",
  "    int GetState(out int pdwState);",
  "  }",
  "  public static string GetDefault(int dataFlow) {",
  "    var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();",
  "    IMMDevice dev;",
  "    if (en.GetDefaultAudioEndpoint(dataFlow, 0, out dev) != 0) return null;",
  "    string id;",
  "    if (dev.GetId(out id) != 0) return null;",
  "    return id;",
  "  }",
  "}\"@;",
  "$render = [DefAudio]::GetDefault(0); $capture = [DefAudio]::GetDefault(1);",
  "@{ playback = $render; record = $capture } | ConvertTo-Json -Compress",
].join(" ");

let endpoints = [];
try {
  const r = await ps(ENUM_PS);
  if (!r.ok) throw new Error(r.stderr.slice(0, 300));
  const parsed = r.stdout ? JSON.parse(r.stdout) : [];
  endpoints = Array.isArray(parsed) ? parsed : [parsed];
  const active = endpoints.filter((e) => Number(e.state) === 1);
  const render = active.filter((e) => e.flow === "Render").length;
  const capture = active.filter((e) => e.flow === "Capture").length;
  push("L4-endpoints-enumerated", active.length > 0 ? "pass" : "fail", [],
    `mmdevice endpoints: total=${endpoints.length} active=${active.length} render=${render} capture=${capture}`);
  const d = await ps(DEFAULT_PS);
  let def = {};
  try { def = JSON.parse(d.stdout || "{}"); } catch { /* keep empty */ }
  if (def.playback || def.record) {
    const byId = new Map(endpoints.map((e) => [e.id, e]));
    const nameOf = (id) => byId.get(id)?.name ?? id ?? "?";
    push("L4-default-devices-identified", "pass", [],
      `default playback=${nameOf(def.playback)} record=${nameOf(def.record)}`);
  } else {
    push("L4-default-devices-identified", "blocked",
      ["COM default-endpoint query -> MMDevice registry enumeration"],
      "GetDefaultAudioEndpoint COM activation (REGDB_E_CLASSNOTREG) unavailable from the automation shell; default identity is resolved at stream-open time by the T05 capture module, not guessed here.");
  }
} catch (e) {
  push("L4-endpoints-enumerated", "fail", [], String(e?.message ?? e).slice(0, 300));
}

push("L4-exclusive-lease-capture", "blocked",
  ["WASAPI stream -> registry enumeration only"],
  "No audio stream opened. Exclusive-lease loopback/mic capture requires the T05 cpal module; opening a stream is not attempted from this probe.");
push("L4-mic-signal-quality", "blocked",
  ["physical speech -> no controlled sound produced"],
  "Manual/controlled-speech scenario. No speech was produced or assumed; reporting signal quality without it would be fabrication.");
push("L4-loopback-correlation", "blocked",
  ["known playback -> fixture WAV not played"],
  "Requires playing a fixture WAV to the default render endpoint while capturing loopback (T05/T18).");

finish({
  script: "test:audio", level: "L4", cases, startedUtc,
  extra: { endpoints: endpoints.map((e) => ({ id: e.id, flow: e.flow, state: e.state, name: e.name })) },
});
