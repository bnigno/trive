import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import {
  addAddress,
  createCustomer,
  getCustomerDetail,
  listCustomers,
  updateCustomer,
} from "@/services/customers";
import { createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

describe("createCustomer", () => {
  it("normalizes phone to E.164 and document to bare digits", async () => {
    const customer = await createCustomer(db, {
      fullName: "Maria Silva",
      email: "Maria@Exemplo.com",
      phone: "(11) 99999-8888",
      document: "529.982.247-25",
      userId: FIXED_USER_ID,
    });

    expect(customer.phoneE164).toBe("+5511999998888");
    expect(customer.email).toBe("maria@exemplo.com");
    expect(customer.documentType).toBe("cpf");
    expect(customer.documentNumber).toBe("52998224725");
  });

  it("accepts CNPJ documents", async () => {
    const customer = await createCustomer(db, {
      fullName: "Loja Parceira LTDA",
      document: "11.222.333/0001-81",
      userId: FIXED_USER_ID,
    });
    expect(customer.documentType).toBe("cnpj");
    expect(customer.documentNumber).toBe("11222333000181");
  });

  it("rejects invalid phone with pt-BR message", async () => {
    await expect(
      createCustomer(db, {
        fullName: "João",
        phone: "99999-8888",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("Telefone inválido");
  });

  it("rejects invalid CPF with pt-BR message", async () => {
    await expect(
      createCustomer(db, {
        fullName: "João",
        document: "529.982.247-26",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("CPF/CNPJ inválido");
  });

  it("maps duplicated phone to a friendly message", async () => {
    await createCustomer(db, {
      fullName: "Ana",
      phone: "11 98888-7777",
      userId: FIXED_USER_ID,
    });
    await expect(
      createCustomer(db, {
        fullName: "Ana Clone",
        phone: "(11) 98888-7777",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("Já existe um cliente com este telefone.");
  });

  it("maps duplicated email to a friendly message", async () => {
    await createCustomer(db, {
      fullName: "Bia",
      email: "bia@exemplo.com",
      userId: FIXED_USER_ID,
    });
    await expect(
      createCustomer(db, {
        fullName: "Bia 2",
        email: "BIA@exemplo.com",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("Já existe um cliente com este e-mail.");
  });

  it("creates the first address as default", async () => {
    const customer = await createCustomer(db, {
      fullName: "Carla",
      address: { street: "Rua das Flores", number: "10", city: "São Paulo", state: "sp" },
      userId: FIXED_USER_ID,
    });
    const addresses = await db
      .select()
      .from(schema.customerAddresses)
      .where(eq(schema.customerAddresses.customerId, customer.id));
    expect(addresses).toHaveLength(1);
    expect(addresses[0].isDefault).toBe(true);
    expect(addresses[0].state).toBe("SP");
  });
});

describe("updateCustomer", () => {
  it("re-normalizes phone and audits before/after", async () => {
    const customer = await createCustomer(db, {
      fullName: "Duda",
      phone: "11 97777-1111",
      userId: FIXED_USER_ID,
    });
    const updated = await updateCustomer(db, {
      customerId: customer.id,
      phone: "(21) 96666-2222",
      userId: FIXED_USER_ID,
    });
    expect(updated.phoneE164).toBe("+5521966662222");

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "customer.update"));
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toEqual({ phoneE164: "+5511977771111" });
    expect(audits[0].after).toEqual({ phoneE164: "+5521966662222" });
  });
});

describe("addAddress", () => {
  it("switches the default address, keeping one default per customer", async () => {
    const customer = await createCustomer(db, {
      fullName: "Elisa",
      address: { label: "Casa", city: "São Paulo" },
      userId: FIXED_USER_ID,
    });

    const second = await addAddress(db, {
      customerId: customer.id,
      label: "Trabalho",
      city: "Campinas",
      isDefault: true,
      userId: FIXED_USER_ID,
    });
    expect(second.isDefault).toBe(true);

    const addresses = await db
      .select()
      .from(schema.customerAddresses)
      .where(eq(schema.customerAddresses.customerId, customer.id));
    expect(addresses).toHaveLength(2);
    const defaults = addresses.filter((address) => address.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].label).toBe("Trabalho");
  });

  it("keeps existing default when the new address is not default", async () => {
    const customer = await createCustomer(db, {
      fullName: "Fabi",
      address: { label: "Casa" },
      userId: FIXED_USER_ID,
    });
    const extra = await addAddress(db, {
      customerId: customer.id,
      label: "Praia",
      isDefault: false,
      userId: FIXED_USER_ID,
    });
    expect(extra.isDefault).toBe(false);

    const addresses = await db
      .select()
      .from(schema.customerAddresses)
      .where(eq(schema.customerAddresses.customerId, customer.id));
    const defaults = addresses.filter((address) => address.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].label).toBe("Casa");
  });
});

describe("listCustomers / getCustomerDetail", () => {
  it("searches by name, email and phone digits", async () => {
    await createCustomer(db, {
      fullName: "Gustavo Prado",
      email: "gus@exemplo.com",
      phone: "11 95555-3333",
      userId: FIXED_USER_ID,
    });
    await createCustomer(db, {
      fullName: "Helena Costa",
      userId: FIXED_USER_ID,
    });

    expect(await listCustomers(db, { search: "gustavo" })).toHaveLength(1);
    expect(await listCustomers(db, { search: "gus@exemplo" })).toHaveLength(1);
    expect(await listCustomers(db, { search: "95555-3333" })).toHaveLength(1);
    expect(await listCustomers(db, { search: "inexistente" })).toHaveLength(0);
    expect(await listCustomers(db)).toHaveLength(2);
  });

  it("returns addresses and recent orders", async () => {
    const customer = await createCustomer(db, {
      fullName: "Iara Lima",
      address: { label: "Casa", city: "Santos" },
      userId: FIXED_USER_ID,
    });
    await db.insert(schema.orders).values({
      customerId: customer.id,
      status: "draft",
      channel: "manual",
    });

    const detail = await getCustomerDetail(db, customer.id);
    expect(detail.fullName).toBe("Iara Lima");
    expect(detail.addresses).toHaveLength(1);
    expect(detail.recentOrders).toHaveLength(1);
    expect(detail.recentOrders[0].status).toBe("draft");
  });

  it("throws a friendly error for unknown customer", async () => {
    await expect(
      getCustomerDetail(db, "00000000-0000-4000-8000-0000000000ff"),
    ).rejects.toThrow("Cliente não encontrado.");
  });
});
