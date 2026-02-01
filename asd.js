import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

/** -----------------------------
 * Demo-data (sama kuin aiemmin, lyhennetty tähän)
 * ----------------------------- */

const USERS = {
  demo_user: {
    user_id: "demo_user",
    name: "Demo Treenaaja",
    training_level: "intermediate",
    goal: { primary: "strength", secondary: "hypertrophy" },
    constraints: { session_minutes: 60, injuries: ["knee_sensitivity"] },
  },
  user_123: {
    user_id: "user_123",
    name: "Käyttäjä 123",
    training_level: "beginner",
    goal: { primary: "fat_loss", secondary: "fitness" },
    constraints: { session_minutes: 45, injuries: [] },
  },
};

const WORKOUTS = {
  demo_user: [
    { session_id: "s_2026_01_26", date: "2026-01-26", title: "Upper A", duration_min: 62, perceived_exertion_rpe: 8, exercises: [] },
    { session_id: "s_2026_01_24", date: "2026-01-24", title: "Lower A", duration_min: 58, perceived_exertion_rpe: 8, exercises: [] },
    { session_id: "s_2026_01-22", date: "2026-01-22", title: "Upper B", duration_min: 55, perceived_exertion_rpe: 7.5, exercises: [] },
  ],
  user_123: [
    { session_id: "s_2026_01_25", date: "2026-01-25", title: "Full Body", duration_min: 44, perceived_exertion_rpe: 7, exercises: [] },
  ],
};

function getUserIdFromReq(req) {
  const auth = req.headers["authorization"] || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return "demo_user";
  const token = m[1].trim();
  return USERS[token] ? token : "demo_user";
}

function toDateNum(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  return Number(m[1] + m[2] + m[3]);
}

function summarizeSessions(sessions) {
  let totalMinutes = 0;
  let avgRpeSum = 0;
  let avgRpeCount = 0;
  for (const s of sessions) {
    totalMinutes += s.duration_min || 0;
    if (typeof s.perceived_exertion_rpe === "number") {
      avgRpeSum += s.perceived_exertion_rpe;
      avgRpeCount += 1;
    }
  }
  return {
    sessions_count: sessions.length,
    total_minutes: totalMinutes,
    avg_session_rpe: avgRpeCount ? Math.round((avgRpeSum / avgRpeCount) * 10) / 10 : null,
  };
}

/** -----------------------------
 * MCP server & tools
 * ----------------------------- */

const mcp = new McpServer({ name: "training-mcp-demo", version: "1.0.1" });

// Per-connection state (DEMO): yksi aktiivinen transport kerrallaan.
// Tuotannossa pidä map: sessionId -> transport.
let activeTransport = null;
let activeUserId = "demo_user";

mcp.tool(
  "get_user_profile",
  "Get the current user's training profile (read-only).",
  { type: "object", properties: {}, additionalProperties: false },
  async () => {
    const user = USERS[activeUserId] ?? USERS.demo_user;
    return {
      content: [{ type: "text", text: JSON.stringify(user, null, 2) }],
    };
  }
);

mcp.tool(
  "get_week_summary",
  "Return a compact weekly summary for the user (read-only).",
  {
    type: "object",
    properties: {
      start_date: { type: "string", description: "YYYY-MM-DD" },
      end_date: { type: "string", description: "YYYY-MM-DD" },
    },
    required: ["start_date", "end_date"],
    additionalProperties: false,
  },
  async ({ start_date, end_date }) => {
    const sessionsAll = WORKOUTS[activeUserId] || [];
    const sNum = toDateNum(start_date);
    const eNum = toDateNum(end_date);
    const sessions = sessionsAll.filter((s) => {
      const d = toDateNum(s.date);
      return !Number.isNaN(d) && d >= sNum && d <= eNum;
    }).sort((a, b) => toDateNum(b.date) - toDateNum(a.date));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              user_id: activeUserId,
              start_date,
              end_date,
              summary: summarizeSessions(sessions),
              sessions: sessions.map((s) => ({ date: s.date, title: s.title, rpe: s.perceived_exertion_rpe, duration_min: s.duration_min })),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

/** -----------------------------
 * Routes
 * ----------------------------- */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "training-mcp-demo",
    hint: "Use GET /sse to open stream and POST /message for MCP messages.",
  });
});

// 1) Open SSE stream
app.get("/sse", async (req, res) => {
  activeUserId = getUserIdFromReq(req);

  // SSE transport expects: a “message endpoint” path where client POSTs requests
  activeTransport = new SSEServerTransport("/message", res);

  // Connect MCP server to this transport
  await mcp.connect(activeTransport);
});

// 2) Receive MCP messages (tools/list, tools/call, etc.)
app.post("/message", async (req, res) => {
  if (!activeTransport) {
    res.status(400).json({ error: "No active SSE transport. Open GET /sse first." });
    return;
  }
  await activeTransport.handlePostMessage(req, res);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`training-mcp-demo listening on :${port}`));
