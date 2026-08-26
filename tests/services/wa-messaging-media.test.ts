import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import type { DbOrTx } from "@/queue/enqueue";
import {
  sendMediaMessage,
  type SendMediaMessageInput,
} from "@/services/wa-messaging";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
// PGlite (testes) e node-postgres (produção) divergem apenas no retorno de
// execute(); a API drizzle usada pelos serviços é idêntica.
let sdb: DbOrTx;
let provider: FakeMessagingProvider;

const CLIENT_PHONE = "+5511999998888";
const IMAGE_URL = "https://cdn.example.com/produtos/colar-lua.jpg";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
});

afterEach(async () => {
  await close();
});

async function enableWa(): Promise<void> {
  await db.insert(schema.settings).values({ key: "wa_enabled", value: true });
}

async function getMessages() {
  return db.select().from(schema.waMessages);
}

// O cast permite montar inputs INVÁLIDOS nos testes de validação — em
// runtime quem rejeita é o Zod da fronteira, exatamente o que testamos.
function imageInput(over: Record<string, unknown> = {}): SendMediaMessageInput {
  return {
    kind: "image",
    phoneE164: CLIENT_PHONE,
    body: "Olha o colar Lua que você pediu 😍",
    imageUrl: IMAGE_URL,
    dedupeKey: "wa.media_test:image:1",
    ...over,
  } as SendMediaMessageInput;
}

function optionListInput(over: Record<string, unknown> = {}): SendMediaMessageInput {
  return {
    kind: "option_list",
    phoneE164: CLIENT_PHONE,
    body: "Como prefere pagar?",
    optionList: {
      title: "Formas de pagamento",
      buttonLabel: "Escolher",
      options: [
        { id: "pix", title: "Pix", description: "5% de desconto" },
        { id: "cartao", title: "Cartão", description: "Até 3x sem juros" },
        { id: "boleto", title: "Boleto" },
      ],
    },
    dedupeKey: "wa.media_test:list:1",
    ...over,
  } as SendMediaMessageInput;
}

describe("sendMediaMessage — imagem", () => {
  it("grava wa_messages com kind image + media_url + legenda e chama provider.sendImage", async () => {
    await enableWa();

    const result = await sendMediaMessage(sdb, provider, imageInput());
    expect(result).toMatchObject({ sent: true });

    const messages = await getMessages();
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message.kind).toBe("image");
    expect(message.mediaUrl).toBe(IMAGE_URL);
    expect(message.body).toBe("Olha o colar Lua que você pediu 😍");
    expect(message.status).toBe("sent");
    expect(message.direction).toBe("outbound");
    expect(message.zapiMessageId).toBeTruthy();
    expect(message.sentAt).toBeInstanceOf(Date);

    expect(provider.sentImages).toHaveLength(1);
    expect(provider.sentImages[0]).toMatchObject({
      toE164: CLIENT_PHONE,
      imageUrl: IMAGE_URL,
      caption: "Olha o colar Lua que você pediu 😍",
    });
    expect(provider.sentMessages).toHaveLength(0);

    // Conversa criada/atualizada igual ao envio de texto.
    const [conversation] = await db.select().from(schema.waConversations);
    expect(conversation.phoneE164).toBe(CLIENT_PHONE);
    expect(conversation.lastOutboundAt).toBeInstanceOf(Date);
  });
});

describe("sendMediaMessage — option_list", () => {
  it("persiste body com as linhas das opções e envia ao provider a mensagem crua + opções estruturadas", async () => {
    await enableWa();

    const result = await sendMediaMessage(sdb, provider, optionListInput());
    expect(result).toMatchObject({ sent: true });

    const messages = await getMessages();
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message.kind).toBe("option_list");
    expect(message.mediaUrl).toBeNull();
    // body persistido = mensagem + linhas '• título — descrição' (o histórico
    // do bot e a thread do admin leem body).
    expect(message.body).toBe(
      [
        "Como prefere pagar?",
        "• Pix — 5% de desconto",
        "• Cartão — Até 3x sem juros",
        "• Boleto",
      ].join("\n"),
    );

    expect(provider.sentOptionLists).toHaveLength(1);
    expect(provider.sentOptionLists[0]).toMatchObject({
      toE164: CLIENT_PHONE,
      // Ao provedor vai a mensagem CRUA, sem as linhas renderizadas.
      message: "Como prefere pagar?",
      title: "Formas de pagamento",
      buttonLabel: "Escolher",
      options: [
        { id: "pix", title: "Pix", description: "5% de desconto" },
        { id: "cartao", title: "Cartão", description: "Até 3x sem juros" },
        { id: "boleto", title: "Boleto" },
      ],
    });
    expect(provider.sentMessages).toHaveLength(0);
  });
});

describe("sendMediaMessage — idempotência e regras compartilhadas", () => {
  it("2ª chamada com o mesmo dedupeKey → ja_enviado, uma linha só, um envio só", async () => {
    await enableWa();

    const first = await sendMediaMessage(sdb, provider, imageInput());
    expect(first).toMatchObject({ sent: true });

    const repeat = await sendMediaMessage(sdb, provider, imageInput());
    expect(repeat).toEqual({ skipped: "ja_enviado" });

    expect(await getMessages()).toHaveLength(1);
    expect(provider.sentImages).toHaveLength(1);
  });

  it("falha do provedor: lança, linha failed com error_detail; retentativa RETOMA a mesma linha", async () => {
    await enableWa();

    provider.simulateDisconnect();
    await expect(sendMediaMessage(sdb, provider, imageInput())).rejects.toThrow(
      /desconectad/i,
    );

    const afterFail = await getMessages();
    expect(afterFail).toHaveLength(1);
    expect(afterFail[0].status).toBe("failed");
    expect(afterFail[0].errorDetail).toMatch(/desconectad/i);
    expect(afterFail[0].kind).toBe("image");

    provider.simulateReconnect();
    const retry = await sendMediaMessage(sdb, provider, imageInput());
    expect(retry).toMatchObject({ sent: true });

    const messages = await getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("sent");
    expect(messages[0].errorDetail).toBeNull();
    expect(messages[0].mediaUrl).toBe(IMAGE_URL);
    expect(provider.sentImages).toHaveLength(1);
  });

  it("número sem WhatsApp → skipped numero_sem_whatsapp, linha failed, nada enviado", async () => {
    await enableWa();
    provider.setPhoneExists(CLIENT_PHONE, false);

    const result = await sendMediaMessage(sdb, provider, imageInput());

    expect(result).toEqual({ skipped: "numero_sem_whatsapp" });
    expect(provider.sentImages).toHaveLength(0);
    const [message] = await getMessages();
    expect(message.status).toBe("failed");
    expect(message.errorDetail).toContain("sem WhatsApp");
  });

  it("wa desligado → { skipped: 'desabilitado' } e NADA gravado", async () => {
    const result = await sendMediaMessage(sdb, provider, optionListInput());

    expect(result).toEqual({ skipped: "desabilitado" });
    expect(await getMessages()).toHaveLength(0);
    expect(provider.sentOptionLists).toHaveLength(0);
  });

  it("valida a fronteira com Zod: imageUrl obrigatório, máx 10 opções, title ≤ 24", async () => {
    await enableWa();

    await expect(
      sendMediaMessage(sdb, provider, imageInput({ imageUrl: undefined })),
    ).rejects.toThrow();

    const tooManyOptions = Array.from({ length: 11 }, (_, index) => ({
      id: `opcao-${index}`,
      title: `Opção ${index}`,
    }));
    await expect(
      sendMediaMessage(
        sdb,
        provider,
        optionListInput({
          optionList: {
            title: "Menu",
            buttonLabel: "Escolher",
            options: tooManyOptions,
          },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      sendMediaMessage(
        sdb,
        provider,
        optionListInput({
          optionList: {
            title: "Menu",
            buttonLabel: "Escolher",
            options: [
              { id: "x", title: "Título comprido demais para caber" },
            ],
          },
        }),
      ),
    ).rejects.toThrow();

    expect(await getMessages()).toHaveLength(0);
  });
});
