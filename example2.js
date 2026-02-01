import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

/** -----------------------------
 * DEMO: harjoite-katalogi (sinulla olisi tämä DB:ssä/API:ssa)
 * ----------------------------- */
const EXERCISES = [
  { id: 101, key: "bench_press", name: "Penkkipunnerrus", group: "upper_push", knee_friendly: true },
  { id: 102, key: "ohp", name: "Pystypunnerrus", group: "upper_push", knee_friendly: true },
  { id: 103, key: "barbell_row", name: "Kulmasoutu", group: "upper_pull", knee_friendly: true },
  { id: 104, key: "pull_up", name: "Leuanveto", group: "upper_pull", knee_friendly: true },

  { id: 201, key: "back_squat", name: "Takakyykky", group: "lower_squat", knee_friendly: false },
  { id: 202, key: "box_squat", name: "Box-kyykky", group: "lower_squat", knee_friendly: true },
  { id: 203, key: "trap_bar_deadlift", name: "Trap bar -maastaveto", group: "lower_hinge", knee_friendly: true },
  { id: 204, key: "rdl", name: "RDL", group: "lower_hinge", knee_friendly: true },
  { id: 205, key: "leg_curl", name: "Reisikoukistuslaite", group: "lower_accessory", knee_friendly: true },
  { id: 206, key: "split_squat", name: "Bulgarialainen askelkyykky", group: "lower_accessory", knee_friendly: true },
];

/** -----------------------------
 * DEMO: RM-data (tämä tulisi sun API:sta)
 * Käytännössä: GET /users/:id/rm?exercise_ids=101,201...
 * ----------------------------- */
const USER_RM = {
  demo_user: {
    101: { rm_1: 120 }, // bench
    102: { rm_1: 72 },  // ohp
    201: { rm_1: 165 }, // back squat (mut polvelle ei välttämättä)
    202: { rm_1: 155 }, // box squat
    203: { rm_1: 190 }, // trap bar deadlift
    204: { rm_1: 150 }, // rdl
    103: { rm_1: 130 }, // row
    104: { rm_1: 0 },   // bodyweight -> 0 tarkoittaa: käytä RPE/assisted
  },
};

const USERS = {
  demo_user: { user_id: "demo_user", name: "Demo Treenaaja" },
};

function getUserId(req) {
  const auth = req.headers.authorization || "";
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  return m && USERS[m[1]] ? m[1] : "demo_user";
}

/** -----------------------------
 * Pieni apu: pyöristä paino 2.5kg välein (tyypillinen)
 * ----------------------------- */
function roundTo2p5(x) {
  if (!Number.isFinite(x)) return null;
  return Math.round(x / 2.5) * 2.5;
}

/** -----------------------------
 * Ohjelmageneraattori (simppeli mutta “oikea”)
 * - käyttää %1RM pääliikkeisiin
 * - accessoryt RPE:llä / kiinteillä toistoilla
 * - huomioi polvi: valitsee knee_friendly squat-variantin
 * ----------------------------- */
function buildProgram({ userId, days_per_week, session_minutes, goal, constraints, preferred_exercise_ids }) {
  const kneeSensitive = !!constraints?.knee_sensitive;

  const pickByKey = (key) => EXERCISES.find((e) => e.key === key);
  const pickById = (id) => EXERCISES.find((e) => e.id === id);

  // Valitse pääliikkeet: jos user antaa preferred ids, käytä niitä ensisijaisesti
  const preferred = (preferred_exercise_ids || []).map(pickById).filter(Boolean);

  // Squat: jos polvi herkkä -> box squat, muuten back squat jos löytyy
  const squat = kneeSensitive ? pickByKey("box_squat") : (pickByKey("back_squat") ?? pickByKey("box_squat"));
  const bench = pickByKey("bench_press");
  const ohp = pickByKey("ohp");
  const dead = pickByKey("trap_bar_deadlift");

  // Pulls & accessories
  const row = pickByKey("barbell_row");
  const pullUp = pickByKey("pull_up");
  const rdl = pickByKey("rdl");
  const legCurl = pickByKey("leg_curl");
  const splitSquat = pickByKey("split_squat");

  // RM map
  const rms = USER_RM[userId] || {};
  const rm1 = (exId) => rms[exId]?.rm_1 || null;

  const mainSet = (exercise, sets, reps, pct) => {
    const oneRm = rm1(exercise.id);
    const target = oneRm ? roundTo2p5(oneRm * pct) : null;
    return {
      exercise_id: exercise.id,
      name: exercise.name,
      type: "main",
      prescription: oneRm
        ? { sets, reps, intensity: { type: "percent_1rm", value: pct }, target_weight_kg: target }
        : { sets, reps, intensity: { type: "rpe", value: 7.5 }, target_weight_kg: null },
    };
  };

  const accessory = (exercise, sets, repsRange, rpe) => ({
    exercise_id: exercise.id,
    name: exercise.name,
    type: "accessory",
    prescription: { sets, reps: repsRange, intensity: { type: "rpe", value: rpe } },
  });

  // Tavoite vaikuttaa hieman rep-alueisiin / prosentteihin
  const isStrength = goal?.primary === "strength";
  const benchPct = isStrength ? 0.82 : 0.75;
  const squatPct = isStrength ? 0.80 : 0.72;
  const deadPct = isStrength ? 0.80 : 0.70;
  const ohpPct = isStrength ? 0.78 : 0.70;

  // Rakennetaan 4 päivän ULUL (jos days != 4, skaalataan simppelisti)
  const template = [
    {
      day_name: "Upper A",
      estimated_minutes: session_minutes,
      items: [
        mainSet(bench, 5, isStrength ? 3 : 6, benchPct),
        mainSet(ohp, 3, 6, ohpPct),
        accessory(row, 4, "8-10", 8),
        accessory(pullUp, 3, "6-10", 8),
      ],
    },
    {
      day_name: "Lower A",
      estimated_minutes: session_minutes,
      items: [
        mainSet(squat, 5, isStrength ? 4 : 6, squatPct),
        accessory(rdl, 4, "6-10", 8),
        accessory(legCurl, 3, "10-15", 8),
        accessory(splitSquat, 3, "8-12/puoli", 7.5),
      ],
    },
    {
      day_name: "Upper B",
      estimated_minutes: session_minutes,
      items: [
        mainSet(bench, 4, isStrength ? 4 : 8, isStrength ? 0.78 : 0.70),
        accessory(row, 4, "8-12", 8),
        accessory(pullUp, 4, "6-10", 8),
        accessory(ohp, 2, "8-10", 7.5),
      ],
    },
    {
      day_name: "Lower B",
      estimated_minutes: session_minutes,
      items: [
        mainSet(dead, 4, isStrength ? 3 : 5, deadPct),
        accessory(rdl, 3, "8-10", 8),
        accessory(legCurl, 3, "10-15", 8),
        accessory(splitSquat, 2, "10-12/puoli", 7.5),
      ],
    },
  ];

  const days = Math.max(1, Math.min(7, Number(days_per_week || 4)));
  const programDays = template.slice(0, days);

  // “machine” JSON tallennukseen
  const program_json = {
    program_id: `prog_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}_${Math.floor(Math.random() * 10000)}`,
    user_id: userId,
    meta: {
      days_per_week: days,
      session_minutes,
      goal,
      constraints,
      created_at: new Date().toISOString(),
    },
    days: programDays,
  };

  // Selkokielinen tiivistelmä (näytettäväksi)
  const lines = [];
  lines.push(`Ohjelma: ${days} treeniä/viikko, ${session_minutes} min, tavoite ${goal?.primary ?? "—"} + ${goal?.secondary ?? "—"}.`);
  if (kneeSensitive) lines.push(`Polvi: käytössä polviystävällinen kyykkyvariantti (${squat.name}).`);

  for (const d of programDays) {
    const main = d.items.filter((x) => x.type === "main");
    const acc = d.items.filter((x) => x.type === "accessory");
    lines.push(`- ${d.day_name}: pääliikkeet ${main.map((m) => m.name).join(", ")}; oheiset ${acc.length} kpl`);
  }

  // Avainluvut (faktat)
  const mainPrescriptions = programDays.flatMap((d) => d.items.filter((x) => x.type === "main"));
  const weights = mainPrescriptions
    .map((x) => x.prescription?.target_weight_kg)
    .filter((w) => typeof w === "number");
  lines.push(`Pääliikkeiden tavoitepainot (kg): ${weights.length ? weights.join(", ") : "RPE-pohjainen (ei RM-dataa joillekin liikkeille)"}`);

  return { program_json, summary_text: lines.join("\n") };
}

/** -----------------------------
 * MCP: per-session Streamable HTTP (kuten sulla toimi)
 * ----------------------------- */
const transports = new Map();
const servers = new Map();
const sessionUser = new Map();

function createMcpServerForSession(sessionId) {
  const server = new McpServer({ name: "training-program-mcp", version: "1.0.0" });

  server.tool(
    "list_exercises",
    "List available exercises (id, name, key, knee_friendly).",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional filter, e.g. 'squat' or 'upper'." },
      },
      additionalProperties: false,
    },
    async ({ query }) => {
      const q = (query || "").toLowerCase().trim();
      const filtered = q
        ? EXERCISES.filter((e) => `${e.key} ${e.name} ${e.group}`.toLowerCase().includes(q))
        : EXERCISES;
      return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
    }
  );

  server.tool(
    "get_rm_maxes",
    "Get 1RM values for exercise IDs for the current user.",
    {
      type: "object",
      properties: {
        exercise_ids: { type: "array", items: { type: "number" } },
      },
      required: ["exercise_ids"],
      additionalProperties: false,
    },
    async ({ exercise_ids }) => {
      const userId = sessionUser.get(sessionId) || "demo_user";
      const rms = USER_RM[userId] || {};
      const out = {};
      for (const id of exercise_ids) out[id] = rms[id] || null;
      return { content: [{ type: "text", text: JSON.stringify({ user_id: userId, rms: out }, null, 2) }] };
    }
  );

  server.tool(
    "create_program",
    "Create a weekly program from user input using exercise IDs and RM data. Returns program JSON + short summary text.",
    {
      type: "object",
      properties: {
        days_per_week: { type: "number", minimum: 1, maximum: 7 },
        session_minutes: { type: "number", minimum: 20, maximum: 120 },
        goal: {
          type: "object",
          properties: {
            primary: { type: "string", enum: ["strength", "hypertrophy", "fat_loss", "fitness"] },
            secondary: { type: "string" },
          },
          required: ["primary"],
        },
        constraints: {
          type: "object",
          properties: {
            knee_sensitive: { type: "boolean" },
          },
          additionalProperties: true,
        },
        preferred_exercise_ids: { type: "array", items: { type: "number" }, description: "Optional: user-selected main lifts." },
      },
      required: ["days_per_week", "session_minutes", "goal"],
      additionalProperties: false,
    },
    async (args) => {
      const userId = sessionUser.get(sessionId) || "demo_user";
      const { program_json, summary_text } = buildProgram({
        userId,
        days_per_week: args.days_per_week,
        session_minutes: args.session_minutes,
        goal: args.goal,
        constraints: args.constraints || {},
        preferred_exercise_ids: args.preferred_exercise_ids || [],
      });

      // Palauta sekä selkokieli että konekieli
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                user_id: userId,
                summary_text,
                program_json, // tämä on tarkoitettu tallennukseen sun järjestelmään
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

async function getOrCreateSession(req) {
  const incoming = req.headers["mcp-session-id"];
  const sid = typeof incoming === "string" ? incoming : "";

  if (sid && transports.has(sid) && servers.has(sid)) return { sid, transport: transports.get(sid) };

  const newSid = randomUUID();
  const userId = getUserId(req);
  sessionUser.set(newSid, userId);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => newSid });
  const server = createMcpServerForSession(newSid);
  await server.connect(transport);

  transports.set(newSid, transport);
  servers.set(newSid, server);

  console.log(`[MCP] created sessionId=${newSid} user=${userId}`);
  return { sid: newSid, transport };
}

app.get("/", (_req, res) => res.json({ ok: true, name: "training-program-mcp", endpoint: "/mcp" }));

app.all("/mcp", async (req, res) => {
  try {
    const { transport } = await getOrCreateSession(req);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[MCP] error:", e);
    if (!res.headersSent) res.status(500).json({ error: "MCP failed", details: String(e?.message || e) });
    else res.end();
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`training-program-mcp listening on :${port}`));
