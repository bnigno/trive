-- Fecha o acesso público ao banco (alerta `rls_disabled_in_public` do Supabase).
--
-- Por que isto não afeta a loja nem o painel: o app NÃO usa a API REST do
-- Supabase (PostgREST). Ele fala com o banco por Drizzle sobre DATABASE_URL,
-- como `postgres`, que é dono das 62 tabelas e tem BYPASSRLS. Quem esta
-- migração corta é quem chega pela chave anônima — a mesma que vai no
-- navegador de qualquer visitante da loja e que hoje lê, altera e apaga tudo.
--
-- São duas camadas de propósito, e cada uma cobre a falha da outra: RLS sem
-- política (não existe linha visível) E revogação dos privilégios (não se
-- chega na tabela). Se um dia alguém criar uma política por engano, a
-- revogação segura; se alguém reconceder um GRANT, o RLS segura.
--
-- Os comandos que citam anon/authenticated ficam dentro de um IF porque os
-- testes rodam em PGlite, que não tem esses papéis — sem a guarda, a suíte
-- inteira quebra na primeira migração.

-- 1) RLS em toda tabela de `public`. Sem nenhuma política: o padrão do
--    Postgres é negar, então anon/authenticated passam a ver zero linhas.
--    Varredura em vez de 62 linhas fixas para que nenhuma tabela escape.
DO $$
DECLARE tabela record;
BEGIN
  FOR tabela IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tabela.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

-- 2) Tirar os privilégios dos papéis públicos do Supabase.
--    `service_role` fica intacto de propósito: é chave de servidor, nunca vai
--    ao navegador, e scripts/check-client-secrets.mjs já barra o vazamento.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon, authenticated;

    -- Sem as três linhas abaixo, a PRÓXIMA migração nasce exposta: o Supabase
    -- deixa privilégios padrão (pg_default_acl) dando `arwdDxtm` a anon e
    -- authenticated em tudo que `postgres` cria no schema public.
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon, authenticated;
  END IF;
END $$;
