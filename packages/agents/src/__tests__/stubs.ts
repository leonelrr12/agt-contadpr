// Base de stubs de Prisma para tests — satisface PrismaLike con no-ops.
import type { PrismaLike } from '../types';

export function basePrismaStub(): PrismaLike {
  const list = async () => [];
  const one = async () => null;
  const create = async (args: any) => ({ id: 'stub-id', ...(args?.data || {}) });
  const update = async (args: any) => ({ id: 'stub-id', ...(args?.data || {}) });
  return {
    account: { findMany: list },
    concept: { findMany: list, upsert: create },
    company: { findUnique: one },
    client: { findMany: list, findFirst: one, create },
    supplier: { findMany: list, findFirst: one, create },
    invoice: { findMany: list, create, update },
    bill: { findMany: list, create, update },
    journalEntry: { create },
    transaction: { create },
  };
}
