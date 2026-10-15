import "dotenv/config";
import cors from "cors";
import express from "express";
import { supabase } from "./supabase.js";

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

// Render + local: permite uno o varios orígenes separados por coma
const allowedOrigins = (process.env.FRONTEND_URL ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins,
  })
);
app.use(express.json());

// ---------- helpers ----------
function makeCode(length = 5): string {
  let code = "";
  for (let i = 0; i < length; i++) code += Math.floor(Math.random() * 10);
  return code;
}

// ---------- health ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "serena-api" });
});

// ---------- CATALOGO (profesor: catalog screen) ----------
// GET /chapters -> con conteo de narrativas
app.get("/chapters", async (_req, res) => {
  const { data, error } = await supabase
    .from("chapters")
    .select("*, narratives(id,order_number,title,subtitle)")
    .order("order_number");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /narratives/:id -> detalle + opciones + preguntas + consecuencias
app.get("/narratives/:id", async (req, res) => {
  const { id } = req.params;
  const { data: narrative, error } = await supabase
    .from("narratives")
    .select("*")
    .eq("id", id)
    .single();
  if (error) return res.status(404).json({ error: "Narrativa no encontrada" });

  const [{ data: options }, { data: questions }, { data: consequences }] =
    await Promise.all([
      supabase.from("decision_options").select("*").eq("narrative_id", id).order("order_number"),
      supabase.from("reflection_questions").select("*").eq("narrative_id", id).order("order_number"),
      supabase.from("consequences").select("*").eq("narrative_id", id),
    ]);

  res.json({ narrative, options, questions, consequences });
});

// ---------- SESIONES (teacher room + student code entry) ----------
// POST /sessions { narrative_id, teacher_id? } -> crea sala con código
app.post("/sessions", async (req, res) => {
  const { narrative_id, teacher_id } = req.body;
  if (!narrative_id) return res.status(400).json({ error: "narrative_id requerido" });

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode(5);
    const { data, error } = await supabase
      .from("sessions")
      .insert({ code, narrative_id, teacher_id: teacher_id ?? null, status: "waiting" })
      .select()
      .single();
    if (!error) return res.status(201).json(data);
    if (!error.message.includes("duplicate")) return res.status(500).json({ error: error.message });
  }
  res.status(500).json({ error: "No se pudo generar código único" });
});

// GET /sessions/code/:code -> alumno entra con código (CodeEntry)
app.get("/sessions/code/:code", async (req, res) => {
  const { data, error } = await supabase
    .from("sessions")
    .select("*, narratives(*)")
    .eq("code", req.params.code)
    .single();
  if (error) return res.status(404).json({ error: "Código inválido" });
  res.json(data);
});

// PATCH /sessions/:id/status { status } -> waiting|playing|decision|reflection|voting|finished
app.patch("/sessions/:id/status", async (req, res) => {
  const { status } = req.body;
  const valid = ["waiting", "playing", "decision", "reflection", "voting", "finished"];
  if (!valid.includes(status)) return res.status(400).json({ error: "status inválido" });

  const { data, error } = await supabase
    .from("sessions")
    .update({ status })
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---------- PARTICIPANTES (NameEntry + WaitingRoom) ----------
// POST /sessions/:id/join { display_name }
app.post("/sessions/:id/join", async (req, res) => {
  const { display_name } = req.body;
  if (!display_name?.trim()) return res.status(400).json({ error: "display_name requerido" });

  const { data, error } = await supabase
    .from("session_participants")
    .insert({ session_id: req.params.id, display_name: display_name.trim() })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// GET /sessions/:id/participants
app.get("/sessions/:id/participants", async (req, res) => {
  const { data, error } = await supabase
    .from("session_participants")
    .select("*")
    .eq("session_id", req.params.id)
    .order("joined_at");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /participants/:id { is_ready, is_connected, emotion }
app.patch("/participants/:id", async (req, res) => {
  const allowed: Record<string, unknown> = {};
  for (const k of ["is_ready", "is_connected", "emotion", "display_name"]) {
    if (req.body[k] !== undefined) allowed[k] = req.body[k];
  }
  const { data, error } = await supabase
    .from("session_participants")
    .update(allowed)
    .eq("id", req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---------- ACTIVIDAD (Decision + Reflect + Vote) ----------
// POST /decisions { session_id, participant_id, narrative_id, decision_option_id }
app.post("/decisions", async (req, res) => {
  const { session_id, participant_id, narrative_id, decision_option_id } = req.body;
  if (!session_id || !participant_id || !narrative_id || !decision_option_id) {
    return res.status(400).json({ error: "Faltan campos" });
  }
  const { data, error } = await supabase
    .from("student_decisions")
    .upsert(
      { session_id, participant_id, narrative_id, decision_option_id },
      { onConflict: "session_id,participant_id,narrative_id" }
    )
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// POST /reflections { session_id, participant_id, answers: [{question_id, answer}] }
app.post("/reflections", async (req, res) => {
  const { session_id, participant_id, answers } = req.body as {
    session_id: string;
    participant_id: string;
    answers: Array<{ question_id: string; answer: string }>;
  };
  if (!session_id || !participant_id || !Array.isArray(answers)) {
    return res.status(400).json({ error: "Faltan campos" });
  }
  const rows = answers.map((a) => ({
    session_id,
    participant_id,
    question_id: a.question_id,
    answer: a.answer,
  }));
  const { data, error } = await supabase
    .from("student_reflections")
    .upsert(rows, { onConflict: "participant_id,question_id" })
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// POST /votes { session_id, participant_id, vote_type: continue|retry }
app.post("/votes", async (req, res) => {
  const { session_id, participant_id, vote_type } = req.body;
  if (!["continue", "retry"].includes(vote_type)) {
    return res.status(400).json({ error: "vote_type debe ser continue|retry" });
  }
  const { data, error } = await supabase
    .from("session_votes")
    .upsert(
      { session_id, participant_id, vote_type },
      { onConflict: "session_id,participant_id" }
    )
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ---------- STATS (teacher: Student Data Panel) ----------
// GET /sessions/:id/stats
app.get("/sessions/:id/stats", async (req, res) => {
  const sessionId = req.params.id;
  const [
    { data: participants },
    { data: decisions },
    { data: reflections },
    { data: votes },
  ] = await Promise.all([
    supabase.from("session_participants").select("*").eq("session_id", sessionId),
    supabase
      .from("student_decisions")
      .select("*, decision_options(title)")
      .eq("session_id", sessionId),
    supabase.from("student_reflections").select("*").eq("session_id", sessionId),
    supabase.from("session_votes").select("*").eq("session_id", sessionId),
  ]);

  const total = participants?.length ?? 0;
  const byEmotion: Record<string, number> = {};
  const byDecision: Record<string, number> = {};
  participants?.forEach((p) => {
    if (p.emotion) byEmotion[p.emotion] = (byEmotion[p.emotion] ?? 0) + 1;
  });
  decisions?.forEach((d: { decision_options?: { title?: string } | null }) => {
    const t = d.decision_options?.title ?? "unknown";
    byDecision[t] = (byDecision[t] ?? 0) + 1;
  });

  const yesCount = reflections?.filter((r) => r.answer === "Yes").length ?? 0;
  const positiveRate = reflections?.length ? Math.round((yesCount / reflections.length) * 100) : 0;

  res.json({
    total,
    byEmotion,
    byDecision,
    positiveRate,
    votes: {
      continue: votes?.filter((v) => v.vote_type === "continue").length ?? 0,
      retry: votes?.filter((v) => v.vote_type === "retry").length ?? 0,
    },
    participants,
    decisions,
  });
});

// ---------- DOCENTES ----------
// POST /teachers/register { email, password, teacher_code, full_name? }
app.post("/teachers/register", async (req, res) => {
  const { email, password, teacher_code, full_name } = req.body;
  if (!email || !password || !teacher_code) {
    return res.status(400).json({ error: "email, password y teacher_code requeridos" });
  }
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  const userId = data.user?.id;
  if (!userId) return res.status(500).json({ error: "No se pudo crear el usuario" });

  const { data: teacher, error: tErr } = await supabase
    .from("teachers")
    .insert({ id: userId, email, teacher_code, full_name: full_name ?? null })
    .select()
    .single();
  if (tErr) return res.status(500).json({ error: tErr.message, user_id: userId });
  res.status(201).json({ user: { id: userId, email }, teacher });
});

// POST /teachers/login { email, password }
app.post("/teachers/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email y password requeridos" });
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  const { data: teacher } = await supabase
    .from("teachers")
    .select("*")
    .eq("id", data.user.id)
    .single();
  res.json({ session: data.session, user: data.user, teacher });
});

// GET /teachers/:id -> perfil docente
app.get("/teachers/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("teachers")
    .select("*")
    .eq("id", req.params.id)
    .single();
  if (error) return res.status(404).json({ error: "Docente no encontrado" });
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`serena-api escuchando en http://localhost:${PORT}`);
});
