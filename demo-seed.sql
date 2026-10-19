-- ============================================
-- Serena - Seed de demo (idempotente)
-- Pega en Supabase > SQL Editor > Run.
-- Reparte opciones de decisión, preguntas de reflexión y
-- una consecuencia a TODAS las narrativas que aún no las tengan,
-- para que cualquier narrativa abra con datos en la demo.
-- No borra ni modifica datos existentes.
-- ============================================

-- 1. Opciones de decisión (4 por narrativa)
insert into public.decision_options (narrative_id, title, description, emoji, tone, order_number)
select n.id, v.title, v.descr, v.emoji, v.tone, v.ord
from public.narratives n
cross join (values
  ('Direct Dialogue','Address it openly and honestly','🤝','choice-green',1),
  ('Avoid Involvement','Walk away and ignore the situation','🙅','choice-amber',2),
  ('Spread the Rumor','Share what you heard with others','💬','choice-red',3),
  ('Change the Topic','Redirect the conversation positively','🛡️','choice-blue',4)
) as v(title, descr, emoji, tone, ord)
where not exists (
  select 1 from public.decision_options d where d.narrative_id = n.id
);

-- 2. Preguntas de reflexión (4 por narrativa)
insert into public.reflection_questions (narrative_id, question_text, order_number)
select n.id, v.q, v.ord
from public.narratives n
cross join (values
  ('Did this decision align with your values?',1),
  ('Would you make the same choice in real life?',2),
  ('Did you consider the impact on others?',3),
  ('Do you feel satisfied with this outcome?',4)
) as v(q, ord)
where not exists (
  select 1 from public.reflection_questions r where r.narrative_id = n.id
);

-- 3. Consecuencia colectiva (1 por narrativa)
insert into public.consequences (narrative_id, is_collective, text)
select n.id, true,
  'The collective decision caused the rumor to spread even further, causing distress to the person being talked about. The situation worsened, and trust within the group was damaged.'
from public.narratives n
where not exists (
  select 1 from public.consequences c where c.narrative_id = n.id
);

-- Verificación: deben dar 96 y 96 y 24
select
  (select count(*) from public.decision_options)   as opciones,
  (select count(*) from public.reflection_questions) as preguntas,
  (select count(*) from public.consequences)        as consecuencias;
