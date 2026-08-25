import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    requiredEnv(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot write cookies; Server Actions and
            // Route Handlers can, so failing here is safe to ignore.
          }
        },
      },
    },
  );
}
