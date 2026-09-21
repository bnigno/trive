import { describe, expect, it } from "vitest";

import { decodePollVote, encodePollVote, isMentionOfSeller, parseGroupInbound, participantAddress } from "@/core/groups/signals";

const GROUP = "120363019502650977-group";
const OPTS = { sellerName: "Lia", storePhoneDigits: "5591981037536" };

describe("participantAddress", () => {
  it("telefone da Z-API vira E.164 pela régua do webhook; LID fica LID; lixo vira null", () => {
    expect(participantAddress("5591999991528")).toBe("+5591999991528");
    expect(participantAddress("559181037536")).toBe("+5591981037536");
    expect(participantAddress("220839349862480@lid")).toBe("220839349862480@lid");
    expect(participantAddress("")).toBeNull();
    expect(participantAddress("grupo")).toBeNull();
    expect(participantAddress(undefined)).toBeNull();
  });
});

describe("voto codificado", () => {
  it("lista → JSON; vazio → '' (voto retirado); decode tolera lixo", () => {
    expect(encodePollVote(["Vinho"])).toBe('["Vinho"]');
    expect(encodePollVote([])).toBe("");
    expect(decodePollVote('["Vinho","Verde"]')).toEqual(["Vinho", "Verde"]);
    expect(decodePollVote("")).toEqual([]);
    expect(decodePollVote("não é json")).toEqual([]);
    expect(decodePollVote('{"a":1}')).toEqual([]);
    expect(decodePollVote('["ok", 3, null]')).toEqual(["ok"]);
  });
});

describe("isMentionOfSeller", () => {
  it("@Lia (sem acento/caixa, no começo ou no meio) e @número da loja; 'Lia' sem @ ou @Liana não", () => {
    expect(isMentionOfSeller("@Lia tem em M?", OPTS)).toBe(true);
    expect(isMentionOfSeller("meninas, @lia sabe se tem em M?", OPTS)).toBe(true);
    expect(isMentionOfSeller("@LÍA?", OPTS)).toBe(true);
    expect(isMentionOfSeller("@5591981037536 tem em M?", OPTS)).toBe(true);
    expect(isMentionOfSeller("a Lia falou que tem", OPTS)).toBe(false);
    expect(isMentionOfSeller("@Liana, viu isso?", OPTS)).toBe(false);
    expect(isMentionOfSeller("email@lia.com", OPTS)).toBe(false);
    expect(isMentionOfSeller("@Lia", { sellerName: "  " })).toBe(false);
  });
});

describe("parseGroupInbound", () => {
  const base = { messageId: "M-1", chatId: GROUP, participantPhone: "5591999991528", participantLid: "220839349862480@lid" };

  it("voto: opções marcadas como JSON, enquete referida, participante em E.164 e LID à parte", () => {
    expect(
      parseGroupInbound({ ...base, pollVote: { pollMessageId: "POLL-1", options: [{ name: "Vinho" }, { name: " Verde " }, { name: "" }] } }, OPTS),
    ).toEqual({
      kind: "poll_vote",
      groupId: GROUP,
      participant: "+5591999991528",
      participantLid: "220839349862480@lid",
      providerMessageId: "M-1",
      referencedMessageId: "POLL-1",
      value: '["Vinho","Verde"]',
    });
    expect(parseGroupInbound({ ...base, pollVote: { pollMessageId: "POLL-1", options: [] } }, OPTS)?.value).toBe("");
  });

  it("reação: emoji e mensagem referida; removida vem vazia; participante pelo reactionBy quando o webhook não traz participantPhone", () => {
    const signal = parseGroupInbound(
      { messageId: "R-1", chatId: GROUP, reaction: { value: "❤️", reactionBy: "5591999991528", referencedMessage: { messageId: "POST-1" } } },
      OPTS,
    );
    expect(signal).toMatchObject({ kind: "reaction", participant: "+5591999991528", participantLid: null, referencedMessageId: "POST-1", value: "❤️" });
    expect(parseGroupInbound({ ...base, reaction: { value: "", referencedMessage: { messageId: "POST-1" } } }, OPTS)?.value).toBe("");
  });

  it("menção guarda o texto; mensagem comum guarda só o fato (value vazio) — LGPD", () => {
    expect(parseGroupInbound({ ...base, text: "@Lia tem a Terracota em M?" }, OPTS)).toMatchObject({ kind: "mention", value: "@Lia tem a Terracota em M?" });
    expect(parseGroupInbound({ ...base, text: "meninas, alguém foi na loja?" }, OPTS)).toMatchObject({ kind: "message", value: "", referencedMessageId: null });
    expect(parseGroupInbound({ ...base, text: "   " }, OPTS)).toMatchObject({ kind: "message", value: "" });
  });

  it("só LID: o participante É o LID; JID '@g.us' do chat é normalizado", () => {
    const signal = parseGroupInbound({ messageId: "M-2", chatId: "120363019502650977@g.us", participantLid: "220839349862480@lid", text: "oi" }, OPTS);
    expect(signal).toMatchObject({ groupId: GROUP, participant: "220839349862480@lid", participantLid: null });
  });

  it("ignora eco das nossas mensagens, chat que não é grupo, sem participante e sem id", () => {
    expect(parseGroupInbound({ ...base, fromMe: true, text: "@Lia" }, OPTS)).toBeNull();
    expect(parseGroupInbound({ ...base, chatId: "5591999991528", text: "oi" }, OPTS)).toBeNull();
    expect(parseGroupInbound({ messageId: "M-3", chatId: GROUP, text: "oi" }, OPTS)).toBeNull();
    expect(parseGroupInbound({ ...base, messageId: " ", text: "oi" }, OPTS)).toBeNull();
  });
});
