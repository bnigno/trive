import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GroupMetadata, MessagingProvider } from "@/adapters/zapi";
import { ZapiMessagingProvider } from "@/adapters/zapi/client";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { isWaGroupId, toWaGroupId, waAddressForZapi } from "@/lib/phone";

type RecordedCall = { url: string; method: string | undefined; body: unknown };

/** Fetch fake injetável: grava as chamadas e responde o payload configurado. */
function createFakeFetch(payload: unknown, status = 200) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const GROUP = "120363019502650977-group";

describe("id de grupo (lib/phone)", () => {
  it("reconhece o formato atual ('…-group') e o legado ('telefone-timestamp'); telefone e LID nunca são grupo", () => {
    expect(isWaGroupId(GROUP)).toBe(true);
    expect(isWaGroupId("5511999999999-1623281429")).toBe(true);
    expect(isWaGroupId("+5591999991528")).toBe(false);
    expect(isWaGroupId("5591999991528")).toBe(false);
    expect(isWaGroupId("220839349862480@lid")).toBe(false);
    expect(isWaGroupId("")).toBe(false);
  });

  it("toWaGroupId normaliza o JID do WhatsApp Web ('@g.us'), espaços e caixa; devolve null para o resto", () => {
    expect(toWaGroupId("120363019502650977@g.us")).toBe(GROUP);
    expect(toWaGroupId("5511999999999-1623281429@g.us")).toBe("5511999999999-1623281429");
    expect(toWaGroupId(`  ${GROUP.toUpperCase()} `)).toBe(GROUP);
    expect(toWaGroupId("5591999991528")).toBeNull();
    expect(toWaGroupId("5591999991528@s.whatsapp.net")).toBeNull();
    expect(toWaGroupId(null)).toBeNull();
    expect(toWaGroupId(undefined)).toBeNull();
  });

  it("waAddressForZapi deixa o id de grupo intacto (só o E.164 perde o '+')", () => {
    expect(waAddressForZapi(GROUP)).toBe(GROUP);
    expect(waAddressForZapi("+5591999991528")).toBe("5591999991528");
  });
});

describe("ZapiMessagingProvider — grupos (client real com fetch fake)", () => {
  beforeEach(() => {
    vi.stubEnv("ZAPI_INSTANCE_ID", "inst-test");
    vi.stubEnv("ZAPI_INSTANCE_TOKEN", "token-test");
    vi.stubEnv("ZAPI_CLIENT_TOKEN", "client-token-test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sendText para grupo manda o id como está; citar vira messageId e menção vira mentioned sem '+'", async () => {
    const { calls, fetchFn } = createFakeFetch({ messageId: "mid-1" });
    const provider = new ZapiMessagingProvider(fetchFn);
    await provider.sendText({
      toE164: GROUP,
      body: "@5591999991528 tem sim: 2 em M.",
      quotedProviderMessageId: "orig-1",
      mentionedPhones: ["+5591999991528"],
    });
    expect(calls[0]?.url).toContain("/send-text");
    expect(calls[0]?.body).toEqual({
      phone: GROUP,
      message: "@5591999991528 tem sim: 2 em M.",
      messageId: "orig-1",
      mentioned: ["5591999991528"],
    });
  });

  it("sendText sem citação nem menção não manda messageId nem mentioned (lista vazia também não)", async () => {
    const { calls, fetchFn } = createFakeFetch({ messageId: "mid-2" });
    const provider = new ZapiMessagingProvider(fetchFn);
    await provider.sendText({ toE164: "+5591999991528", body: "oi", mentionedPhones: [] });
    expect(calls[0]?.body).toEqual({ phone: "5591999991528", message: "oi" });
  });

  it("sendPoll faz POST /send-poll com poll [{name}], pollMaxOptions (padrão 1) e delayMessage 1", async () => {
    const { calls, fetchFn } = createFakeFetch({ zaapId: "z-1", messageId: "poll-1" });
    const provider = new ZapiMessagingProvider(fetchFn);
    const sent = await provider.sendPoll({
      toGroupId: GROUP,
      question: "Qual cor?",
      options: ["Verde-oliva", "Vinho", "Azul-noite"],
    });
    expect(sent).toEqual({ providerMessageId: "poll-1" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/send-poll");
    expect(calls[0]?.body).toEqual({
      phone: GROUP,
      message: "Qual cor?",
      poll: [{ name: "Verde-oliva" }, { name: "Vinho" }, { name: "Azul-noite" }],
      pollMaxOptions: 1,
      delayMessage: 1,
    });
  });

  it("sendPoll respeita maxOptions e lança sem id na resposta", async () => {
    const { calls, fetchFn } = createFakeFetch({ messageId: "poll-2" });
    const provider = new ZapiMessagingProvider(fetchFn);
    await provider.sendPoll({ toGroupId: GROUP, question: "Duas?", options: ["A", "B", "C"], maxOptions: 2 });
    expect(calls[0]?.body).toMatchObject({ pollMaxOptions: 2 });

    const empty = createFakeFetch({});
    await expect(
      new ZapiMessagingProvider(empty.fetchFn).sendPoll({ toGroupId: GROUP, question: "?", options: ["A", "B"] }),
    ).rejects.toThrow("/send-poll");
  });

  it("sendReaction faz POST /send-reaction {phone, reaction, messageId}; pinMessage faz POST /pin-message", async () => {
    const { calls, fetchFn } = createFakeFetch({});
    const provider = new ZapiMessagingProvider(fetchFn);
    await provider.sendReaction({ to: GROUP, providerMessageId: "m-1", emoji: "❤️" });
    await provider.pinMessage({ to: GROUP, providerMessageId: "m-2", duration: "30_days" });
    expect(calls[0]?.url).toContain("/send-reaction");
    expect(calls[0]?.body).toEqual({ phone: GROUP, reaction: "❤️", messageId: "m-1" });
    expect(calls[1]?.url).toContain("/pin-message");
    expect(calls[1]?.body).toEqual({
      phone: GROUP,
      messageId: "m-2",
      messageAction: "pin",
      pinMessageDuration: "30_days",
    });
  });

  it("listGroups lê GET /groups (formato do /chats) e ignora item sem id de grupo", async () => {
    const { calls, fetchFn } = createFakeFetch([
      { isGroup: true, name: "Provador TRIVÉ", phone: GROUP, unread: "0", lastMessageTime: "1730918668000" },
      { isGroup: true, name: "sem id" },
      { isGroup: false, name: "Cliente", phone: "5591999991528" },
    ]);
    const provider = new ZapiMessagingProvider(fetchFn);
    const groups = await provider.listGroups();
    expect(calls[0]?.url).toMatch(/\/groups$/);
    expect(groups).toEqual([{ groupId: GROUP, name: "Provador TRIVÉ" }]);
  });

  it("getGroupMetadata lê o formato real: subject, owner, link, flags e participantes com telefone OU LID", async () => {
    const { calls, fetchFn } = createFakeFetch({
      phone: GROUP,
      description: "As peças passam aqui antes da vitrine.",
      owner: "5591981037536",
      subject: "Provador TRIVÉ",
      creation: 1588721491000,
      invitationLink: "https://chat.whatsapp.com/40Aasd6af1",
      communityId: null,
      adminOnlyMessage: false,
      adminOnlySettings: true,
      requireAdminApproval: false,
      isGroupAnnouncement: false,
      participants: [
        { phone: "5511888888888", isAdmin: false, isSuperAdmin: false },
        { phone: "5591981037536", isAdmin: false, isSuperAdmin: true, short: "Fabi", name: "Fabiano" },
        { phone: "220839349862480@lid", isAdmin: false },
        { phone: "5511777777777", lid: "99988877766655@lid", isAdmin: true },
        { name: "sem telefone" },
      ],
      subjectTime: 1617805323000,
    });
    const provider = new ZapiMessagingProvider(fetchFn);
    const meta = await provider.getGroupMetadata(GROUP);
    expect(calls[0]?.url).toContain(`/group-metadata/${GROUP}`);
    expect(meta).toEqual({
      groupId: GROUP,
      name: "Provador TRIVÉ",
      description: "As peças passam aqui antes da vitrine.",
      ownerE164: "+5591981037536",
      invitationLink: "https://chat.whatsapp.com/40Aasd6af1",
      adminOnlyMessage: false,
      adminOnlySettings: true,
      requireAdminApproval: false,
      participants: [
        { phoneE164: "+5511888888888", lid: null, isAdmin: false },
        { phoneE164: "+5591981037536", lid: null, isAdmin: true },
        { phoneE164: null, lid: "220839349862480@lid", isAdmin: false },
        { phoneE164: "+5511777777777", lid: "99988877766655@lid", isAdmin: true },
      ],
    });
  });

  it("getGroupMetadata tolera resposta mínima (sem participantes, sem link) e usa o id pedido", async () => {
    const { fetchFn } = createFakeFetch({ subject: "  " });
    const provider = new ZapiMessagingProvider(fetchFn);
    const meta = await provider.getGroupMetadata(GROUP);
    expect(meta).toMatchObject({ groupId: GROUP, name: null, invitationLink: null, participants: [] });
  });

  it("getGroupInvitationLink lê GET /group-invitation-link/{id}; sem link (sessão não é admin) devolve null", async () => {
    const { calls, fetchFn } = createFakeFetch({ phone: GROUP, invitationLink: "https://chat.whatsapp.com/C1adgkd" });
    const provider = new ZapiMessagingProvider(fetchFn);
    expect(await provider.getGroupInvitationLink(GROUP)).toBe("https://chat.whatsapp.com/C1adgkd");
    expect(calls[0]?.url).toContain(`/group-invitation-link/${GROUP}`);

    const none = createFakeFetch({ phone: GROUP });
    expect(await new ZapiMessagingProvider(none.fetchFn).getGroupInvitationLink(GROUP)).toBeNull();
  });

  it("updateGroupSettings manda as quatro flags obrigatórias; removeGroupParticipants manda groupId + phones sem '+' e pula lista vazia", async () => {
    const { calls, fetchFn } = createFakeFetch({ value: true });
    const provider = new ZapiMessagingProvider(fetchFn);
    await provider.updateGroupSettings(GROUP, {
      adminOnlyMessage: false,
      adminOnlySettings: true,
      requireAdminApproval: false,
      adminOnlyAddMember: true,
    });
    await provider.removeGroupParticipants(GROUP, []);
    await provider.removeGroupParticipants(GROUP, ["+5511888888888", "+5511777777777"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/update-group-settings");
    expect(calls[0]?.body).toEqual({
      phone: GROUP,
      adminOnlyMessage: false,
      adminOnlySettings: true,
      requireAdminApproval: false,
      adminOnlyAddMember: true,
    });
    expect(calls[1]?.url).toContain("/remove-participant");
    expect(calls[1]?.body).toEqual({ groupId: GROUP, phones: ["5511888888888", "5511777777777"] });
  });

  it("HTTP >= 400 nos endpoints de grupo lança sem expor a URL com tokens", async () => {
    const { fetchFn } = createFakeFetch({ error: "not admin" }, 403);
    const provider = new ZapiMessagingProvider(fetchFn);
    await expect(provider.getGroupMetadata(GROUP)).rejects.toThrow(/HTTP 403 em \/group-metadata/);
    await expect(provider.getGroupMetadata(GROUP)).rejects.not.toThrow(/token-test/);
  });
});

const FAKE_GROUP: GroupMetadata = {
  groupId: GROUP,
  name: "Provador TRIVÉ",
  description: null,
  ownerE164: "+5591981037536",
  invitationLink: "https://chat.whatsapp.com/fake",
  adminOnlyMessage: false,
  adminOnlySettings: true,
  requireAdminApproval: false,
  participants: [
    { phoneE164: "+5591981037536", lid: null, isAdmin: true },
    { phoneE164: "+5511888888888", lid: null, isAdmin: false },
    { phoneE164: null, lid: "220839349862480@lid", isAdmin: false },
  ],
};

describe("FakeMessagingProvider — grupos", () => {
  it("implementa os métodos de grupo do contrato", () => {
    const provider: MessagingProvider = new FakeMessagingProvider();
    for (const method of [
      "sendPoll",
      "sendReaction",
      "pinMessage",
      "listGroups",
      "getGroupMetadata",
      "getGroupInvitationLink",
      "updateGroupSettings",
      "removeGroupParticipants",
    ] as const) {
      expect(provider[method]).toBeTypeOf("function");
    }
  });

  it("sendPoll registra a enquete com o mesmo contador de ids e recusa destino que não é grupo (paridade com a Z-API)", async () => {
    const provider = new FakeMessagingProvider();
    const text = await provider.sendText({ toE164: GROUP, body: "Passou pelo Provador hoje" });
    const poll = await provider.sendPoll({ toGroupId: GROUP, question: "Qual cor?", options: ["A", "B"] });
    expect(poll.providerMessageId).not.toBe(text.providerMessageId);
    expect(provider.sentPolls).toEqual([
      { toGroupId: GROUP, question: "Qual cor?", options: ["A", "B"], providerMessageId: poll.providerMessageId },
    ]);
    await expect(
      provider.sendPoll({ toGroupId: "+5591999991528", question: "?", options: ["A", "B"] }),
    ).rejects.toThrow("/send-poll");
  });

  it("sendText guarda citação e menção inspecionáveis", async () => {
    const provider = new FakeMessagingProvider();
    await provider.sendText({
      toE164: GROUP,
      body: "@5511888888888 tem sim",
      quotedProviderMessageId: "q-1",
      mentionedPhones: ["5511888888888"],
    });
    expect(provider.sentMessages[0]).toMatchObject({
      toE164: GROUP,
      quotedProviderMessageId: "q-1",
      mentionedPhones: ["5511888888888"],
    });
  });

  it("grupos semeados: listGroups, metadata (cópia), link, configurações e remoção refletem no estado", async () => {
    const provider = new FakeMessagingProvider();
    provider.setGroup(FAKE_GROUP);
    expect(await provider.listGroups()).toEqual([{ groupId: GROUP, name: "Provador TRIVÉ" }]);
    expect(await provider.getGroupInvitationLink(GROUP)).toBe("https://chat.whatsapp.com/fake");

    const meta = await provider.getGroupMetadata(GROUP);
    meta.participants.length = 0;
    expect((await provider.getGroupMetadata(GROUP)).participants).toHaveLength(3);

    await provider.updateGroupSettings(GROUP, {
      adminOnlyMessage: true,
      adminOnlySettings: true,
      requireAdminApproval: true,
      adminOnlyAddMember: true,
    });
    expect((await provider.getGroupMetadata(GROUP)).adminOnlyMessage).toBe(true);
    expect(provider.groupSettingsUpdates).toHaveLength(1);

    await provider.removeGroupParticipants(GROUP, ["+5511888888888"]);
    expect((await provider.getGroupMetadata(GROUP)).participants.map((p) => p.phoneE164 ?? p.lid)).toEqual([
      "+5591981037536",
      "220839349862480@lid",
    ]);
    expect(provider.removedParticipants).toEqual([{ groupId: GROUP, phonesE164: ["+5511888888888"] }]);
  });

  it("grupo desconhecido responde como a Z-API (4xx); reação e fixar registram; desconectado lança; reset limpa tudo", async () => {
    const provider = new FakeMessagingProvider();
    await expect(provider.getGroupMetadata(GROUP)).rejects.toThrow("404");
    await expect(provider.getGroupInvitationLink(GROUP)).rejects.toThrow("404");

    provider.setGroup(FAKE_GROUP);
    await provider.sendReaction({ to: GROUP, providerMessageId: "m-1", emoji: "❤️" });
    await provider.pinMessage({ to: GROUP, providerMessageId: "m-1", duration: "7_days" });
    expect(provider.sentReactions).toEqual([{ to: GROUP, providerMessageId: "m-1", emoji: "❤️" }]);
    expect(provider.pinnedMessages).toEqual([{ to: GROUP, providerMessageId: "m-1", duration: "7_days" }]);

    provider.simulateDisconnect();
    await expect(provider.sendReaction({ to: GROUP, providerMessageId: "m-2", emoji: "👍" })).rejects.toThrow();
    await expect(provider.sendPoll({ toGroupId: GROUP, question: "?", options: ["A", "B"] })).rejects.toThrow();
    await expect(provider.listGroups()).rejects.toThrow();

    provider.reset();
    expect(provider.sentReactions).toEqual([]);
    expect(provider.pinnedMessages).toEqual([]);
    expect(provider.sentPolls).toEqual([]);
    expect(await provider.listGroups()).toEqual([]);
  });
});
