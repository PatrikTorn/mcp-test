import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

/** -----------------------------
 * Request logging (DEBUG)
 * ----------------------------- */
app.use((req, res, next) => {
  const auth = req.headers.authorization ? "yes" : "no";
  const ua = req.headers["user-agent"] || "-";
  const accept = req.headers["accept"] || "-";
  const ctype = req.headers["content-type"] || "-";
  const sid = req.headers["mcp-session-id"] || "-";
  console.log(
    `[REQ] ${req.method} ${req.url} auth=${auth} mcp-session-id=${sid} ua="${ua}" accept="${accept}" ctype="${ctype}"`
  );
  res.on("finish", () => console.log(`[RES] ${req.method} ${req.url} -> ${res.statusCode}`));
  next();
});

/** -----------------------------
 * Demo-data
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
    { session_id: "s_2026_01_22", date: "2026-01-22", title: "Upper B", duration_min: 55, perceived_exertion_rpe: 7.5, exercises: [] },
  ],
  user_123: [
    { session_id: "s_2026_01_25", date: "2026-01-25", title: "Full Body", duration_min: 44, perceived_exertion_rpe: 7, exercises: [] },
  ],
};

function getUserIdFromReq(req) {
  const auth = req.headers["authorization"] || "";
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
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
 * MCP server factory (per-session)
 * ----------------------------- */
function createMcpServer(getUserIdForThisSession) {
  const server = new McpServer({ name: "training-mcp-demo", version: "2.2.0" });

  server.tool(
    "get_user_profile",
    "Get the current user's training profile (read-only).",
    { type: "object", properties: {}, additionalProperties: false },
    async () => {
      const userId = getUserIdForThisSession();
      const user = USERS[userId] ?? USERS.demo_user;
      return { content: [{ type: "text", text: JSON.stringify(user, null, 2) }] };
    }
  );

  server.tool(
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
      const userId = getUserIdForThisSession();
      const sessionsAll = WORKOUTS[userId] || [];
      const sNum = toDateNum(start_date);
      const eNum = toDateNum(end_date);

      const sessionsInRange = sessionsAll
        .filter((s) => {
          const d = toDateNum(s.date);
          return !Number.isNaN(d) && d >= sNum && d <= eNum;
        })
        .sort((a, b) => toDateNum(b.date) - toDateNum(a.date));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                user_id: userId,
                start_date,
                end_date,
                summary: summarizeSessions(sessionsInRange),
                sessions: sessionsInRange.map((s) => ({
                  date: s.date,
                  title: s.title,
                  rpe: s.perceived_exertion_rpe,
                  duration_min: s.duration_min,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

/** -----------------------------
 * Streamable HTTP: session state
 * ----------------------------- */
const transports = new Map(); // sessionId -> transport
const servers = new Map();    // sessionId -> mcp server
const sessionUser = new Map(); // sessionId -> userId

async function getOrCreateSession(req, res) {
  const incomingSid = req.headers["mcp-session-id"];
  const sid = typeof incomingSid === "string" ? incomingSid : "";

  // Existing session
  if (sid && transports.has(sid) && servers.has(sid)) {
    return { sessionId: sid, transport: transports.get(sid), server: servers.get(sid) };
  }

  // Create new session
  const newSid = randomUUID();

  // Create transport that will use this session id
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSid,
  });

  // Bind user to this session now
  const userId = getUserIdFromReq(req);
  sessionUser.set(newSid, userId);

  // Create server for this session
  const server = createMcpServer(() => sessionUser.get(newSid) || "demo_user");
  await server.connect(transport);

  transports.set(newSid, transport);
  servers.set(newSid, server);

  console.log(`[MCP] created sessionId=${newSid} user=${userId}`);

  // NOTE: transport will emit the session id back to the client through protocol/headers as needed.
  // We do NOT manually set mcp-session-id header here (transport handles it).
  return { sessionId: newSid, transport, server };
}

/** -----------------------------
 * Routes
 * ----------------------------- */
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "training-mcp-demo",
    transport: "streamable-http",
    hint: "Use /mcp. Pass Authorization: Bearer demo_user (or user_123).",
  });
});

// Main MCP endpoint
app.all("/mcp", async (req, res) => {
  try {
    const { sessionId, transport } = await getOrCreateSession(req, res);

    // If OpenAI changes Authorization between calls, you can update binding:
    // (optional, but handy for testing)
    const userId = getUserIdFromReq(req);
    if (userId && sessionUser.get(sessionId) !== userId) {
      sessionUser.set(sessionId, userId);
      console.log(`[MCP] updated sessionId=${sessionId} user=${userId}`);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[MCP] error:", e);
    if (!res.headersSent) {
      res.status(500).json({ error: "mcp failed", details: String(e?.message || e) });
    } else {
      res.end();
    }
  }
});

// Optional: session cleanup
app.delete("/mcp", (req, res) => {
  const sid = req.headers["mcp-session-id"];
  if (typeof sid !== "string" || !sid) return res.status(400).json({ error: "Missing mcp-session-id" });

  transports.delete(sid);
  servers.delete(sid);
  sessionUser.delete(sid);
  console.log(`[MCP] deleted sessionId=${sid}`);
  res.status(204).end();
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`training-mcp-demo (streamable-http) listening on :${port}`));
