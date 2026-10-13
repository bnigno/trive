-- Boletim da Lia: as contagens por ação (turnos sem resposta, promessa de
-- humano sem transferência, afirmação sem ferramenta) filtram audit_log por
-- action numa janela de dias. Sem índice, cada abertura da Central varria a
-- tabela inteira. Não apaga nem altera dado.

CREATE INDEX "audit_log_action_created_at_idx" ON "audit_log" USING btree ("action","created_at");