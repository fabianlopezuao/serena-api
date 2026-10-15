# Serena API

Backend Express + TypeScript para el frontend `happy-page-maker-264`, usando Supabase como DB.

## Estructura
```
pf/
  happy-page-maker-264/  <- frontend
  serena-api/            <- esta API
```

## Setup
```sh
cd serena-api
npm install
cp .env.example .env
# edita .env con SUPABASE_URL y SUPABASE_SERVICE_KEY
npm run dev
```

API en `http://localhost:4000`.

## Endpoints
- `GET /health`
- `GET /chapters`
- `GET /narratives/:id`
- `POST /sessions` { narrative_id, teacher_id? } -> { id, code }
- `GET /sessions/code/:code` (alumno entra con código)
- `PATCH /sessions/:id/status` { status }
- `POST /sessions/:id/join` { display_name }
- `GET /sessions/:id/participants`
- `PATCH /participants/:id` { is_ready, emotion... }
- `POST /decisions`
- `POST /reflections`
- `POST /votes`
- `GET /sessions/:id/stats` (panel profesor)
