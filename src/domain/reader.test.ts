// T08: stable lexical voice-follow. The already-read (committed) text is
// frozen: streaming chunks and new suggestion versions rebuild the token
// array, but the cursor survives whenever the committed prefix does.
// Remote speech never moves the cursor; repeats never regress committed;
// ambiguous repeats resolve at the earliest position until longer context
// disambiguates; partials retract tentative only.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildScript, ReaderSession } from "./reader.ts";

const V1 = "Kita mulai dari arsitektur. Terima kasih banyak.";
const V1_TAIL = " Sampai jumpa lagi.";

function sessionWithV1Committed(): ReaderSession {
  const s = new ReaderSession();
  // Simulate chunked streaming: first chunk is the first sentence only.
  s.ingestScript(buildScript("Kita mulai dari arsitektur."), 1);
  s.update(["kita", "mulai", "dari"], true, "self");
  // Rest of the version streams in; committed progress must survive.
  s.ingestScript(buildScript(V1), 1);
  return s;
}

describe("reader session versioning", () => {
  it("survives chunked streaming growth without losing committed progress", () => {
    const s = sessionWithV1Committed();
    assert.equal(s.state.committed, 3);
    const adv = s.update(["arsitektur", "terima", "kasih"], true, "self");
    assert.equal(adv.committed, 6);
  });

  it("a new version keeps the frozen committed prefix and extends the tail", () => {
    const s = sessionWithV1Committed();
    s.update(["arsitektur", "terima", "kasih"], true, "self");
    assert.equal(s.state.committed, 6);
    s.ingestScript(buildScript(V1 + V1_TAIL), 2);
    assert.equal(s.scriptVersion, 2);
    assert.equal(s.state.committed, 6);
    const adv = s.update(["sampai", "jumpa", "lagi"], true, "self");
    assert.equal(adv.committed, 10);
  });

  it("a wholly new answer restarts reading, visibly uncertain", () => {
    const s = sessionWithV1Committed();
    s.ingestScript(buildScript("Cuaca hari ini cerah."), 2);
    assert.equal(s.state.committed, 0);
    assert.equal(s.state.confidence, "uncertain");
  });

  it("rescript clamps instead of remapping when the array shrinks", () => {
    const s = sessionWithV1Committed();
    s.update(["arsitektur", "terima", "kasih"], true, "self");
    assert.equal(s.state.committed, 6);
    s.ingestScript(buildScript("Kita mulai."), 1);
    assert.equal(s.state.committed, 2);
  });
});

describe("reader ambiguity, skips and repeats", () => {
  const REPEAT = "kita mulai dari arsitektur. terima kasih banyak. kita mulai dari arsitektur.";

  it("an ambiguous repeated phrase resolves at the earliest position", () => {
    const s = new ReaderSession();
    s.ingestScript(buildScript(REPEAT), 1);
    const st = s.update(["mulai", "dari", "arsitektur"], true, "self");
    // Both occurrences match equally; the cursor must not leap to the later one.
    assert.equal(st.committed, 4);
    const full = s.update(["terima", "kasih", "banyak", "kita", "mulai", "dari", "arsitektur"], true, "self");
    assert.equal(full.committed, 11);
  });

  it("a skipped sentence commits forward on anchor evidence", () => {
    const s = new ReaderSession();
    s.ingestScript(buildScript("satu dua tiga. empat lima enam. tujuh delapan sembilan."), 1);
    const st = s.update(["tujuh", "delapan", "sembilan"], true, "self");
    assert.equal(st.committed, 9);
  });

  it("rereading an earlier paragraph moves nothing visible", () => {
    const s = new ReaderSession();
    s.ingestScript(buildScript("satu dua tiga. empat lima enam. tujuh delapan sembilan."), 1);
    s.update(["tujuh", "delapan", "sembilan"], true, "self");
    assert.equal(s.state.committed, 9);
    // A confirmed repeat of paragraph one reconciles backward, but the
    // display must not jump: finals snap tentative back to committed.
    const st = s.update(["satu", "dua", "tiga"], true, "self");
    assert.equal(st.committed, 9);
    assert.equal(st.tentative, 9);
  });

  it("a contradicting partial retracts tentative but never committed", () => {
    const s = sessionWithV1Committed();
    s.update(["arsitektur", "terima", "kasih"], true, "self");
    assert.equal(s.state.committed, 6);
    const st = s.update(["mulai", "dari", "arsitektur"], false, "self");
    assert.equal(st.committed, 6);
    assert.equal(st.tentative, 4);
    assert.equal(st.confidence, "uncertain");
  });

  it("goes off-script on unrelated speech and reacquires on anchor", () => {
    const s = sessionWithV1Committed();
    for (let i = 0; i < 3; i++) s.update(["membahas", "cuaca", "liburan"], true, "self");
    assert.equal(s.state.confidence, "off_script");
    const back = s.update(["terima", "kasih", "banyak"], true, "self");
    assert.equal(back.committed, 7);
    assert.equal(back.confidence, "tracking");
  });

  it("remote speech never moves the cursor", () => {
    const s = sessionWithV1Committed();
    const before = s.state.committed;
    s.update(["kita", "mulai", "dari", "arsitektur"], true, "remote");
    assert.equal(s.state.committed, before);
  });

  it("a single common word cannot commit", () => {
    const s = new ReaderSession();
    s.ingestScript(buildScript(V1), 1);
    const st = s.update(["dari"], true, "self");
    assert.equal(st.committed, 0);
  });

  it("manual seek sets both cursors and stays tracking", () => {
    const s = sessionWithV1Committed();
    const st = s.seek(5);
    assert.equal(st.committed, 5);
    assert.equal(st.tentative, 5);
    assert.equal(st.confidence, "tracking");
  });
});
