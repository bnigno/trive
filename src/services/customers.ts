// Serviço de clientes: cadastro, endereços e consultas.
import { and, desc, eq, ilike, isNull, like, or } from "drizzle-orm";
import { z } from "zod";

import {
  auditLog,
  customerAddresses,
  customers,
  orders,
} from "@/db/schema";
import { normalizeDocument } from "@/lib/document";
import { toE164BR } from "@/lib/phone";
import { ServiceError, type ServiceDb } from "./catalog";

// ---------------------------------------------------------------------------
// Erros e helpers
// ---------------------------------------------------------------------------

function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join("\n");
}

function mapCustomerUniqueViolation(error: unknown): ServiceError | null {
  const text = errorChainText(error);
  if (text.includes("customers_email_unique_idx")) {
    return new ServiceError(
      "email_duplicado",
      "Já existe um cliente com este e-mail.",
    );
  }
  if (text.includes("customers_phone_e164_unique_idx")) {
    return new ServiceError(
      "telefone_duplicado",
      "Já existe um cliente com este telefone.",
    );
  }
  if (text.includes("customers_document_number_unique_idx")) {
    return new ServiceError(
      "documento_duplicado",
      "Já existe um cliente com este CPF/CNPJ.",
    );
  }
  return null;
}

function normalizePhoneOrThrow(phone: string): string {
  const normalized = toE164BR(phone);
  if (!normalized) {
    throw new ServiceError(
      "telefone_invalido",
      "Telefone inválido. Informe DDD + número, ex.: (11) 99999-8888.",
    );
  }
  return normalized;
}

function normalizeDocumentOrThrow(document: string): {
  type: "cpf" | "cnpj";
  digits: string;
} {
  const normalized = normalizeDocument(document);
  if (!normalized) {
    throw new ServiceError(
      "documento_invalido",
      "CPF/CNPJ inválido. Confira os dígitos informados.",
    );
  }
  return normalized;
}

type AuditEntry = {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
};

async function writeAudit(db: ServiceDb, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
  });
}

async function requireCustomer(db: ServiceDb, customerId: string) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
    .limit(1);
  if (!customer) {
    throw new ServiceError("nao_encontrado", "Cliente não encontrado.");
  }
  return customer;
}

// ---------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------

const addressFieldsSchema = z.object({
  label: z.string().trim().min(1).optional(),
  postalCode: z.string().trim().min(1).optional(),
  street: z.string().trim().min(1).optional(),
  number: z.string().trim().min(1).optional(),
  complement: z.string().trim().min(1).optional(),
  district: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  state: z
    .string()
    .trim()
    .length(2, "UF deve ter 2 letras.")
    .transform((value) => value.toUpperCase())
    .optional(),
  isDefault: z.boolean().optional(),
});

const createCustomerSchema = z.object({
  fullName: z.string().trim().min(1, "Informe o nome do cliente."),
  email: z.email("E-mail inválido.").optional(),
  phone: z.string().trim().min(1).optional(),
  document: z.string().trim().min(1).optional(),
  notes: z.string().optional(),
  marketingOptIn: z.boolean().default(false),
  address: addressFieldsSchema.optional(),
  userId: z.uuid(),
});

export type CreateCustomerInput = z.input<typeof createCustomerSchema>;

export async function createCustomer(db: ServiceDb, input: CreateCustomerInput) {
  const parsed = createCustomerSchema.parse(input);

  const phoneE164 = parsed.phone ? normalizePhoneOrThrow(parsed.phone) : null;
  const document = parsed.document
    ? normalizeDocumentOrThrow(parsed.document)
    : null;

  try {
    return await db.transaction(async (tx) => {
      const [customer] = await tx
        .insert(customers)
        .values({
          fullName: parsed.fullName,
          email: parsed.email?.toLowerCase() ?? null,
          phoneE164,
          documentType: document?.type ?? null,
          documentNumber: document?.digits ?? null,
          notes: parsed.notes ?? null,
          marketingOptIn: parsed.marketingOptIn,
        })
        .returning();

      if (parsed.address) {
        await tx.insert(customerAddresses).values({
          customerId: customer.id,
          label: parsed.address.label ?? null,
          postalCode: parsed.address.postalCode ?? null,
          street: parsed.address.street ?? null,
          number: parsed.address.number ?? null,
          complement: parsed.address.complement ?? null,
          district: parsed.address.district ?? null,
          city: parsed.address.city ?? null,
          state: parsed.address.state ?? null,
          // Primeiro endereço do cliente é sempre o padrão.
          isDefault: parsed.address.isDefault ?? true,
        });
      }

      await writeAudit(tx, {
        actorId: parsed.userId,
        action: "customer.create",
        entityType: "customer",
        entityId: customer.id,
        after: {
          fullName: customer.fullName,
          email: customer.email,
          phoneE164: customer.phoneE164,
          documentType: customer.documentType,
        },
      });

      return customer;
    });
  } catch (error) {
    throw mapCustomerUniqueViolation(error) ?? error;
  }
}

const updateCustomerSchema = z.object({
  customerId: z.uuid(),
  userId: z.uuid(),
  fullName: z.string().trim().min(1).optional(),
  email: z.email("E-mail inválido.").nullable().optional(),
  phone: z.string().trim().min(1).nullable().optional(),
  document: z.string().trim().min(1).nullable().optional(),
  notes: z.string().nullable().optional(),
  marketingOptIn: z.boolean().optional(),
});

export type UpdateCustomerInput = z.input<typeof updateCustomerSchema>;

export async function updateCustomer(db: ServiceDb, input: UpdateCustomerInput) {
  const parsed = updateCustomerSchema.parse(input);

  try {
    return await db.transaction(async (tx) => {
      const current = await requireCustomer(tx, parsed.customerId);

      const patch: Partial<typeof current> = {};
      if (parsed.fullName !== undefined) patch.fullName = parsed.fullName;
      if (parsed.email !== undefined) {
        patch.email = parsed.email?.toLowerCase() ?? null;
      }
      if (parsed.phone !== undefined) {
        patch.phoneE164 =
          parsed.phone === null ? null : normalizePhoneOrThrow(parsed.phone);
      }
      if (parsed.document !== undefined) {
        if (parsed.document === null) {
          patch.documentType = null;
          patch.documentNumber = null;
        } else {
          const document = normalizeDocumentOrThrow(parsed.document);
          patch.documentType = document.type;
          patch.documentNumber = document.digits;
        }
      }
      if (parsed.notes !== undefined) patch.notes = parsed.notes;
      if (parsed.marketingOptIn !== undefined) {
        patch.marketingOptIn = parsed.marketingOptIn;
      }
      if (Object.keys(patch).length === 0) return current;

      const [updated] = await tx
        .update(customers)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(customers.id, parsed.customerId))
        .returning();

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
        before[key] = current[key];
        after[key] = updated[key];
      }
      await writeAudit(tx, {
        actorId: parsed.userId,
        action: "customer.update",
        entityType: "customer",
        entityId: updated.id,
        before,
        after,
      });

      return updated;
    });
  } catch (error) {
    throw mapCustomerUniqueViolation(error) ?? error;
  }
}

// ---------------------------------------------------------------------------
// Endereços
// ---------------------------------------------------------------------------

const addAddressSchema = addressFieldsSchema.extend({
  customerId: z.uuid(),
  userId: z.uuid(),
});

export type AddAddressInput = z.input<typeof addAddressSchema>;

export async function addAddress(db: ServiceDb, input: AddAddressInput) {
  const parsed = addAddressSchema.parse(input);

  return db.transaction(async (tx) => {
    await requireCustomer(tx, parsed.customerId);

    const existing = await tx
      .select({ id: customerAddresses.id })
      .from(customerAddresses)
      .where(eq(customerAddresses.customerId, parsed.customerId))
      .limit(1);
    // Primeiro endereço vira padrão; nos demais respeita o pedido.
    const isDefault = parsed.isDefault ?? existing.length === 0;

    if (isDefault) {
      await tx
        .update(customerAddresses)
        .set({ isDefault: false })
        .where(
          and(
            eq(customerAddresses.customerId, parsed.customerId),
            eq(customerAddresses.isDefault, true),
          ),
        );
    }

    const [address] = await tx
      .insert(customerAddresses)
      .values({
        customerId: parsed.customerId,
        label: parsed.label ?? null,
        postalCode: parsed.postalCode ?? null,
        street: parsed.street ?? null,
        number: parsed.number ?? null,
        complement: parsed.complement ?? null,
        district: parsed.district ?? null,
        city: parsed.city ?? null,
        state: parsed.state ?? null,
        isDefault,
      })
      .returning();

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "customer_address.create",
      entityType: "customer_address",
      entityId: address.id,
      after: { customerId: parsed.customerId, city: address.city, isDefault },
    });

    return address;
  });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

const listCustomersSchema = z.object({
  search: z.string().trim().min(1).optional(),
});

export type ListCustomersInput = z.input<typeof listCustomersSchema>;

export async function listCustomers(
  db: ServiceDb,
  input: ListCustomersInput = {},
) {
  const parsed = listCustomersSchema.parse(input);

  const filters = [isNull(customers.deletedAt)];
  if (parsed.search) {
    const pattern = `%${parsed.search}%`;
    const conditions = [
      ilike(customers.fullName, pattern),
      ilike(customers.email, pattern),
    ];
    const digits = parsed.search.replace(/\D/g, "");
    if (digits.length >= 4) {
      conditions.push(like(customers.phoneE164, `%${digits}%`));
      conditions.push(like(customers.documentNumber, `%${digits}%`));
    }
    filters.push(or(...conditions)!);
  }

  return db
    .select({
      id: customers.id,
      fullName: customers.fullName,
      email: customers.email,
      phoneE164: customers.phoneE164,
      documentType: customers.documentType,
      marketingOptIn: customers.marketingOptIn,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .where(and(...filters))
    .orderBy(customers.fullName);
}

export async function getCustomerDetail(db: ServiceDb, customerId: string) {
  const parsedId = z.uuid().parse(customerId);
  const customer = await requireCustomer(db, parsedId);

  const addresses = await db
    .select()
    .from(customerAddresses)
    .where(eq(customerAddresses.customerId, parsedId))
    .orderBy(desc(customerAddresses.isDefault), customerAddresses.createdAt);

  const recentOrders = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalCents: orders.totalCents,
      paymentMethod: orders.paymentMethod,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(eq(orders.customerId, parsedId))
    .orderBy(desc(orders.createdAt))
    .limit(10);

  return { ...customer, addresses, recentOrders };
}
