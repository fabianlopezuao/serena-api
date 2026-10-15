import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
// Acepta cualquiera de estas: service_role (ideal), secret sb_secret_*, anon o publishable.
// Como tus RLS son abiertas (políticas using(true)), la API funciona con la que veas.
const key =
  process.env.SUPABASE_SERVICE_KEY ??
  process.env.SUPABASE_SECRET_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  console.error(
    "Falta SUPABASE_URL y una clave en .env (SERVICE_KEY, SECRET_KEY, ANON_KEY o PUBLISHABLE_KEY)"
  );
  process.exit(1);
}

export const supabase = createClient(url, key);
