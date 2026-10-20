import "dotenv/config";
import cors from "cors";
import express from "express";
import { supabase } from "./supabase.js";

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

// Render + local: permite uno o varios orígenes separados por coma.
// Sin FRONTEND_URL (o con "*") acepta todos. En desarrollo acepta cualquier
// puerto de localhost/127.0.0.1 para que no importe desde dónde se abra.
const allowedOrigins = (process.env.FRONTEND_URL ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const allowAll = allowedOrigins.length === 0 || allowedOrigins.includes("*");
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowAll) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
      return cb(null, false);
    },
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
    .select("*, narratives(id,order_number,title,subtitle,image_url,video_url)")
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

// POST /narratives -> crea narrativa con su contenido jugable
app.post("/narratives", async (req, res) => {
  const {
    chapter_id,
    title,
    subtitle,
    image_url,
    video_url,
    duration_seconds,
    order_number,
    options,
    questions,
    consequence,
  } = req.body;

  if (!chapter_id || !title?.trim()) {
    return res.status(400).json({ error: "chapter_id y title son requeridos" });
  }

  let order = Number(order_number);
  if (!Number.isFinite(order) || order <= 0) {
    const { data: last } = await supabase
      .from("narratives")
      .select("order_number")
      .eq("chapter_id", chapter_id)
      .order("order_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    order = (last?.order_number ?? 0) + 1;
  }

  const { data: narrative, error } = await supabase
    .from("narratives")
    .insert({
      chapter_id,
      order_number: order,
      title: title.trim(),
      subtitle: subtitle?.trim() || null,
      image_url: image_url?.trim() || null,
      video_url: video_url?.trim() || null,
      duration_seconds: Number(duration_seconds) || 600,
    })
    .select()
    .single();

  if (error) {
    if (error.message.includes("row-level security")) {
      return res.status(403).json({
        error:
          "Falta permiso de escritura en Supabase. Ejecuta las políticas SQL de creación de narrativas.",
      });
    }
    return res.status(500).json({ error: error.message });
  }

  const optionRows = (Array.isArray(options) ? options : []).map(
    (o: { title?: string; description?: string; emoji?: string; tone?: string }, i: number) => ({
      narrative_id: narrative.id,
      title: String(o.title ?? "").trim(),
      description: String(o.description ?? "").trim(),
      emoji: o.emoji ?? null,
      tone: o.tone ?? null,
      order_number: i + 1,
    })
  ).filter((o) => o.title && o.description);

  const questionRows = (Array.isArray(questions) ? questions : [])
    .map((q: string, i: number) => ({
      narrative_id: narrative.id,
      question_text: String(q ?? "").trim(),
      order_number: i + 1,
    }))
    .filter((q) => q.question_text);

  const errors: string[] = [];
  if (optionRows.length) {
    const { error: oErr } = await supabase.from("decision_options").insert(optionRows);
    if (oErr) errors.push(`opciones: ${oErr.message}`);
  }
  if (questionRows.length) {
    const { error: qErr } = await supabase.from("reflection_questions").insert(questionRows);
    if (qErr) errors.push(`preguntas: ${qErr.message}`);
  }
  if (consequence?.text?.trim()) {
    const { error: cErr } = await supabase
      .from("consequences")
      .insert({ narrative_id: narrative.id, text: consequence.text.trim() });
    if (cErr) errors.push(`consecuencia: ${cErr.message}`);
  }

  if (errors.length) {
    const rls = errors.some((e) => e.includes("row-level security"));
    return res.status(rls ? 403 : 500).json({
      error: rls
        ? "Falta permiso de escritura en Supabase para opciones/preguntas/consecuencia."
        : errors.join(" | "),
      narrative_id: narrative.id,
    });
  }
  res.status(201).json({ narrative, options: optionRows.length, questions: questionRows.length });
});

// PUT /narratives/:id -> actualiza narrativa y su contenido
app.put("/narratives/:id", async (req, res) => {
  const { id } = req.params;
  const {
    chapter_id,
    title,
    subtitle,
    image_url,
    video_url,
    duration_seconds,
    order_number,
    options,
    questions,
    consequence,
  } = req.body;

  const patch: Record<string, unknown> = {};
  if (chapter_id !== undefined) patch.chapter_id = chapter_id;
  if (title !== undefined) patch.title = String(title).trim();
  if (subtitle !== undefined) patch.subtitle = String(subtitle).trim() || null;
  if (image_url !== undefined) patch.image_url = String(image_url).trim() || null;
  if (video_url !== undefined) patch.video_url = String(video_url).trim() || null;
  if (duration_seconds !== undefined) patch.duration_seconds = Number(duration_seconds) || 600;
  if (order_number !== undefined) patch.order_number = Number(order_number) || 1;

  if (!Object.keys(patch).length) return res.status(400).json({ error: "Nada que actualizar" });

  const { data: narrative, error } = await supabase
    .from("narratives")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    if (error.message.includes("row-level security")) {
      return res.status(403).json({
        error: "Falta permiso de actualización en Supabase. Ejecuta las políticas SQL de edición.",
      });
    }
    return res.status(404).json({ error: "Narrativa no encontrada" });
  }

  const errors: string[] = [];

  const optionList = Array.isArray(options) ? options : [];
  for (let i = 0; i < optionList.length; i++) {
    const o = optionList[i] as {
      id?: string;
      title?: string;
      description?: string;
      emoji?: string;
      tone?: string;
    };
    const optionTitle = String(o.title ?? "").trim();
    const description = String(o.description ?? "").trim();
    if (!optionTitle || !description) continue;
    const row = {
      narrative_id: id,
      title: optionTitle,
      description,
      emoji: o.emoji ?? null,
      tone: o.tone ?? null,
      order_number: i + 1,
    };
    const { error: oErr } = o.id
      ? await supabase.from("decision_options").update(row).eq("id", o.id)
      : await supabase.from("decision_options").insert(row);
    if (oErr) errors.push(`opciones: ${oErr.message}`);
  }

  const questionList = Array.isArray(questions) ? questions : [];
  for (let i = 0; i < questionList.length; i++) {
    const q = questionList[i] as { id?: string; question_text?: string };
    const text = String(q.question_text ?? "").trim();
    if (!text) continue;
    const row = { narrative_id: id, question_text: text, order_number: i + 1 };
    const { error: qErr } = q.id
      ? await supabase.from("reflection_questions").update(row).eq("id", q.id)
      : await supabase.from("reflection_questions").insert(row);
    if (qErr) errors.push(`preguntas: ${qErr.message}`);
  }

  if (consequence && String(consequence.text ?? "").trim()) {
    const row = { narrative_id: id, text: String(consequence.text).trim() };
    const { error: cErr } = consequence.id
      ? await supabase.from("consequences").update(row).eq("id", consequence.id)
      : await supabase.from("consequences").insert(row);
    if (cErr) errors.push(`consecuencia: ${cErr.message}`);
  }

  if (errors.length) {
    const rls = errors.some((e) => e.includes("row-level security"));
    return res.status(rls ? 403 : 500).json({
      error: rls
        ? "Falta permiso de escritura en Supabase para opciones/preguntas/consecuencia."
        : errors.join(" | "),
    });
  }

  res.json({ narrative });
});

// ---------- SESIONES (teacher room + student code entry) ----------
// POST /sessions { narrative_id, teacher_id? } -> crea sala con código
app.post("/sessions", async (req, res) => {
  const { narrative_id, teacher_id } = req.body;
  if (!narrative_id) return res.status(400).json({ error: "narrative_id requerido" });

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode(6);
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
    supabase
      .from("student_reflections")
      .select("*, reflection_questions(question_text)")
      .eq("session_id", sessionId),
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
    reflections: reflections ?? [],
    voteDetails: votes ?? [],
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

// POST /teachers/login-simple { email, teacher_code } -> valida contra la tabla (sin Auth)
app.post("/teachers/login-simple", async (req, res) => {
  const { email, teacher_code } = req.body;
  if (!email || !teacher_code) {
    return res.status(400).json({ error: "email y teacher_code requeridos" });
  }
  const { data, error } = await supabase
    .from("teachers")
    .select("*")
    .ilike("email", String(email).trim())
    .eq("teacher_code", String(teacher_code).trim())
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(401).json({ error: "Docente no encontrado" });
  res.json({ teacher: data });
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
