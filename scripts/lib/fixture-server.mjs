// Local loopback fixture servers for L1/L3: canned STT + LLM endpoints.
// These replace provider boundaries in tests and are NEVER bundled with the
// production app. Binds 127.0.0.1 on an ephemeral port.
import http from "node:http";

// startFixtureServer() -> Promise<{ url: string, close: () => Promise<void> }>

const SONIOX_SCENARIOS = {
  "partial-and-overlap": [
    { segments: [{ text: "Mengapa memilih", start_ms: 0, end_ms: 500 }], final: false },
    { segments: [{ text: "Mengapa memilih arsitektur ini?", start_ms: 0, end_ms: 900 }], final: true },
  ],
};

const DEEPGRAM_SCENARIOS = {
  "partial-and-overlap": [
    {
      is_final: false,
      channel: { alternatives: [{ transcript: "How do you keep", words: [{ word: "How", start: 1.45, end: 1.6 }] }] },
    },
    {
      is_final: true,
      channel: {
        alternatives: [
          {
            transcript: "How do you keep context across sessions?",
            words: [{ word: "How", start: 1.45, end: 1.6 }, { word: "sessions?", start: 1.9, end: 2.0 }],
          },
        ],
      },
    },
  ],
};

const LLM_SCRIPT = [
  "Saya menyimpan profil dan memori secara terpisah.",
  "Dokumen menjadi sumber bukti, sedangkan skill mengatur cara menyusun jawaban.",
];

export function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && u.pathname === "/health") return json(200, { ok: true });
    if (req.method === "GET" && u.pathname === "/stt/soniox") {
      const scenario = u.searchParams.get("scenario") ?? "partial-and-overlap";
      const events = SONIOX_SCENARIOS[scenario];
      if (!events) return json(404, { error: "unknown scenario" });
      return json(200, { events });
    }
    if (req.method === "GET" && u.pathname === "/stt/deepgram") {
      const scenario = u.searchParams.get("scenario") ?? "partial-and-overlap";
      const events = DEEPGRAM_SCENARIOS[scenario];
      if (!events) return json(404, { error: "unknown scenario" });
      return json(200, { events });
    }
    if (req.method === "POST" && u.pathname === "/llm/complete") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let prompt = "";
        try { prompt = JSON.parse(body).prompt ?? ""; } catch { /* keep empty */ }
        if (!prompt) return json(400, { error: "prompt required" });
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const delta of LLM_SCRIPT) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        res.end(`data: ${JSON.stringify({ done: true, usage: { prompt_tokens: 120, completion_tokens: 32 } })}\n\n`);
      });
      return;
    }
    return json(404, { error: "unknown fixture route" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
