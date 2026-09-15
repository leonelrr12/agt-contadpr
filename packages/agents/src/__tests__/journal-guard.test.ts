import { describe, it, expect } from 'vitest';
import { loadAccountFlags, blockedMessage, blockedAccounts, checkNotBlocked } from '../journal-guard';

function makePrismaStub() {
  return {
    account: {
      findMany: async ({ where }: any) => {
        const all = [
          { id: 'caja', code: '1.1.01', name: 'Caja', isBlocked: false },
          { id: 'banco', code: '1.1.02.01', name: 'Banco General', isBlocked: true },
          { id: 'otra-empresa', code: '1.1.99', name: 'Ajena', isBlocked: true },
        ];
        return all.filter(a => a.id !== 'otra-empresa' || where?.companyId !== 'emp-1')
          .filter((a: any) => !where?.id?.in || where.id.in.includes(a.id));
      },
    },
  };
}

describe('journal-guard', () => {
  it('loadAccountFlags indexa por id', async () => {
    const flags = await loadAccountFlags(makePrismaStub(), 'emp-1');
    expect(flags.get('banco')?.isBlocked).toBe(true);
    expect(flags.get('caja')?.name).toBe('Caja');
  });

  it('blockedMessage: null cuando ninguna cuenta está bloqueada', () => {
    const flags = new Map([['caja', { code: '1.1.01', name: 'Caja', isBlocked: false }]]);
    expect(blockedMessage(flags, ['caja', null, undefined])).toBeNull();
  });

  it('blockedMessage: nombra la cuenta bloqueada', async () => {
    const flags = await loadAccountFlags(makePrismaStub(), 'emp-1');
    const msg = blockedMessage(flags, ['caja', 'banco']);
    expect(msg).toContain('1.1.02.01');
    expect(msg).toContain('Banco General');
    expect(msg).toContain('no admite asientos');
  });

  it('blockedMessage: ignora ids desconocidos (los valida cada flujo)', async () => {
    const flags = await loadAccountFlags(makePrismaStub(), 'emp-1');
    expect(blockedMessage(flags, ['no-existe'])).toBeNull();
    // ...y no filtra cuentas de otra empresa aunque estén bloqueadas
    expect(blockedMessage(flags, ['otra-empresa'])).toBeNull();
  });

  it('blockedAccounts: lista las cuentas bloqueadas sin repetir', async () => {
    const flags = await loadAccountFlags(makePrismaStub(), 'emp-1');
    const blocked = blockedAccounts(flags, ['banco', 'banco', 'caja', null]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].code).toBe('1.1.02.01');
  });

  it('checkNotBlocked: sin ids no consulta y devuelve null', async () => {
    expect(await checkNotBlocked(makePrismaStub(), 'emp-1', [null, undefined])).toBeNull();
    expect(await checkNotBlocked(makePrismaStub(), 'emp-1', ['banco'])).toContain('bloqueada');
  });
});
