/**
 * Limpieza de proveedores creados por la regla vieja “proveedor en todo gasto”.
 *
 * Con la regla B, fuera de Anexo/CxP un proveedor solo se justifica si es una
 * EMPRESA (RUC/NT) o si tiene una cuenta de trabajador (reembolso). Este script
 * busca los que NO cumplen y los elimina:
 *   · no tienen Bills ni WorkerAccount;
 *   · ninguna transacción suya debita una cuenta con Anexo;
 *   · su identificación no es de empresa (cédula/pasaporte/sin RUC).
 *
 * Si el proveedor no tiene ninguna transacción ni factura recibida, se deja
 * (puede ser un contacto cargado a mano). Solo borra los que tienen evidencia
 * de haber nacido de un gasto sin Anexo, como Carlos Ortiz Pineda en 6.01.16.
 *
 * DRY-RUN por defecto. Para aplicar hay que nombrar la empresa:
 *   npx tsx scripts/limpiar-proveedores-no-empresa.ts --company=<id>
 *   npx tsx scripts/limpiar-proveedores-no-empresa.ts --apply --company=<id>
 *
 * Para borrar proveedores puntuales aunque tengan Anexo (p. ej. maestros sin
 * RUC que el dueño prefiere eliminar hasta tener la factura correcta):
 *   ... --forzar="PANANDAMIOS S.A,Fumi Services DYC"
 * Nunca borra uno con Bills o cuenta de trabajador (esos son historia real).
 *
 * Opciones: --detalle, --limit=N, --forzar="Nombre 1,Nombre 2".
 * Requiere FIELD_ENC_KEY (taxId del maestro cifrado).
 */
import fs from 'fs';

const envPath = '/root/apps/agt-contadpr/.env';
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

const argv = process.argv.slice(2);
function argValor(nombre: string): string | null {
  const eq = argv.find((a) => a.startsWith(`${nombre}=`));
  if (eq) return eq.slice(nombre.length + 1);
  const i = argv.indexOf(nombre);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}
const APLICAR = argv.includes('--apply');
const COMPANY = argValor('--company');
const DETALLE = argv.includes('--detalle');
const LIMITE = DETALLE ? Number.POSITIVE_INFINITY : Number(argValor('--limit') || 50);

const TIPOS_COMPRA = ['GASTO', 'COMPRA', 'PAGO_PROVEEDOR'];
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

type Tx = { id: string; type: string; amount: number; date: Date; metadata: any; anexo: boolean; lineas: any[] };

async function main() {
  const { PrismaClient } = await import('@agt-contador/prisma-schema');
  const { decryptField, encryptionEnabled } = await import('../apps/api/src/services/crypto-fields');
  const { normalizarNombreTercero, normalizarRucBase, esIdentificacionEmpresa } = await import('@agt-contador/shared');
  const forzados = new Set(
    (argValor('--forzar') || '')
      .split(',')
      .map((n) => normalizarNombreTercero(n))
      .filter(Boolean),
  );

  if (!encryptionEnabled()) {
    console.error('❌ FIELD_ENC_KEY no está definida o no es base64 de 32 bytes: no se puede leer el RUC del maestro.');
    process.exit(1);
  }
  if (!COMPANY) {
    console.error('❌ Falta --company=<id>.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const dec = (v: unknown) => (v == null ? '' : String(decryptField(v) ?? '').trim());

  const company = await prisma.company.findFirst({ where: { id: COMPANY }, select: { id: true, name: true } });
  if (!company) {
    console.error(`❌ No existe la empresa ${COMPANY}.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const [suppliers, txs, claims] = await Promise.all([
    prisma.supplier.findMany({
      where: { companyId: COMPANY },
      include: { _count: { select: { bills: true, workerAccounts: true } } },
    }),
    prisma.transaction.findMany({
      where: { companyId: COMPANY, type: { in: TIPOS_COMPRA } },
      select: {
        id: true, type: true, amount: true, date: true, metadata: true,
        journalEntry: {
          select: {
            lines: {
              select: { debit: true, credit: true, account: { select: { code: true, requiresAnexo: true } } },
            },
          },
        },
      },
      orderBy: { date: 'asc' },
    }),
    prisma.expenseClaim.findMany({
      where: { companyId: COMPANY, proveedor: { not: null } },
      select: { id: true, proveedor: true, rucEmisor: true, workerId: true, total: true, status: true },
    }),
  ]);

  const supplierById = new Map<string, any>();
  const porNombre = new Map<string, any[]>();
  const porRuc = new Map<string, any[]>();
  for (const s of suppliers) {
    const row = { ...s, taxId: dec(s.taxId), dv: s.dv || null };
    supplierById.set(row.id, row);
    const nombre = normalizarNombreTercero(row.name);
    if (nombre) porNombre.set(nombre, [...(porNombre.get(nombre) || []), row]);
    const base = normalizarRucBase(row.taxId);
    if (base) porRuc.set(base, [...(porRuc.get(base) || []), row]);
  }

  const txDe = new Map<string, Tx[]>();
  const claimsDe = new Map<string, any[]>();
  const sinMatch: any[] = [];

  for (const t of txs) {
    let m: any = {};
    try { m = JSON.parse(t.metadata || '{}'); } catch { continue; }
    if (!m || typeof m !== 'object') continue;
    const provider = String(m.provider || m.nombre || '').trim();
    const ruc = String(m.ruc ?? '').trim();

    let match: any = null;
    if (m.supplierId) match = supplierById.get(String(m.supplierId)) || null;
    if (!match && provider) {
      const arr = porNombre.get(normalizarNombreTercero(provider)) || [];
      if (arr.length === 1) match = arr[0];
      else if (arr.length > 1) { sinMatch.push({ tipo: 'ambiguo_nombre', provider, ruc, id: t.id }); continue; }
    }
    if (!match && ruc) {
      const arr = porRuc.get(normalizarRucBase(ruc)) || [];
      if (arr.length === 1) match = arr[0];
      else if (arr.length > 1) { sinMatch.push({ tipo: 'ambiguo_ruc', provider, ruc, id: t.id }); continue; }
    }
    if (!match) { sinMatch.push({ tipo: 'sin_maestro', provider, ruc, id: t.id }); continue; }

    const lineas = (t as any).journalEntry?.lines || [];
    const anexo = lineas.some((l: any) => (l.debit || 0) > 0 && l.account?.requiresAnexo);
    const row: Tx = {
      id: t.id, type: t.type, amount: Number(t.amount) || 0, date: t.date, metadata: m,
      anexo, lineas,
    };
    txDe.set(match.id, [...(txDe.get(match.id) || []), row]);
  }

  for (const c of claims) {
    const provider = String(c.proveedor || '').trim();
    let match: any = null;
    if (provider) {
      const arr = porNombre.get(normalizarNombreTercero(provider)) || [];
      if (arr.length === 1) match = arr[0];
      else if (arr.length > 1) { sinMatch.push({ tipo: 'claim_ambiguo_nombre', provider, id: c.id }); continue; }
    }
    if (!match && c.rucEmisor) {
      const arr = porRuc.get(normalizarRucBase(c.rucEmisor)) || [];
      if (arr.length === 1) match = arr[0];
      else if (arr.length > 1) { sinMatch.push({ tipo: 'claim_ambiguo_ruc', provider, ruc: c.rucEmisor, id: c.id }); continue; }
    }
    if (!match) { sinMatch.push({ tipo: 'claim_sin_maestro', provider, ruc: c.rucEmisor, id: c.id }); continue; }
    claimsDe.set(match.id, [...(claimsDe.get(match.id) || []), c]);
  }

  const eliminar: any[] = [];
  const forzadosUsados = new Set<string>();
  const mantener = new Map<string, { count: number; total: number }>();
  const sumarMantener = (motivo: string, tx: Tx[]) => {
    const x = mantener.get(motivo) || { count: 0, total: 0 };
    x.count++;
    x.total = r2(x.total + tx.reduce((s, t) => s + t.amount, 0));
    mantener.set(motivo, x);
  };

  for (const s of suppliers) {
    const row = supplierById.get(s.id);
    const list = txDe.get(s.id) || [];
    const cs = claimsDe.get(s.id) || [];
    const total = r2(list.reduce((sum, t) => sum + t.amount, 0));
    const tieneAnexo = list.some((t) => t.anexo);
    const esEmpresa = esIdentificacionEmpresa({ taxIdType: row.taxIdType, taxId: row.taxId, dv: row.dv });
    const tieneBills = s._count.bills > 0;
    const tieneWorker = s._count.workerAccounts > 0;
    const tieneClaims = cs.length > 0;
    const evidencias = list.length + cs.length;
    const nombreNorm = normalizarNombreTercero(row.name);
    const forzado = forzados.has(nombreNorm);
    if (forzado) forzadosUsados.add(nombreNorm);

    if (tieneBills) {
      if (forzado) console.warn(`  ⚠️ "${row.name}" no se borra: tiene facturas de proveedor (Bills).`);
      sumarMantener('cx_p', list); continue;
    }
    if (tieneWorker) {
      if (forzado) console.warn(`  ⚠️ "${row.name}" no se borra: tiene cuenta de trabajador.`);
      sumarMantener('worker', list); continue;
    }
    if (!forzado) {
      if (tieneAnexo) { sumarMantener('anexo', list); continue; }
      if (esEmpresa) { sumarMantener('empresa_ruc', list); continue; }
      if (!evidencias) { sumarMantener('sin_evidencia', list); continue; }
    }

    eliminar.push({
      id: s.id, name: s.name, taxId: row.taxId, dv: row.dv, taxIdType: row.taxIdType,
      fiscalSource: s.fiscalSource, createdAt: s.createdAt,
      tx: list, claims: cs, total, tieneClaims, forzado,
      motivos: [
        forzado ? 'forzado por nombre' : null,
        list.length ? `${list.length} tx de gasto sin Anexo` : null,
        cs.length ? `${cs.length} factura(s) recibida(s)` : null,
        'persona/sin RUC',
      ].filter(Boolean),
    });
  }

  const forzadosSinMatch = [...forzados].filter((n) => !forzadosUsados.has(n));
  for (const n of forzadosSinMatch) console.warn(`  ⚠️ No se encontró el proveedor forzado "${n}".`);

  console.log(`\n=== Limpieza de proveedores sin regla B (${APLICAR ? 'APLICANDO' : 'dry-run'}) ===`);
  console.log(`Empresa: ${company.name} (${company.id})`);
  console.log(`Proveedores: ${suppliers.length} · Transactions de compra: ${txs.length} · Facturas recibidas: ${claims.length}`);
  console.log(`A eliminar: ${eliminar.length} · A mantener: ${[...mantener.values()].reduce((a, x) => a + x.count, 0)}`);
  for (const [motivo, x] of mantener) console.log(`  mantener ${motivo.padEnd(16)} ${String(x.count).padStart(4)}`);
  console.log('');

  let impresos = 0;
  for (const e of eliminar.sort((a, b) => b.total - a.total)) {
    if (impresos >= LIMITE) { console.log(`  … ${eliminar.length - impresos} más. Usá --detalle.`); break; }
    impresos++;
    console.log(`  [ELIMINAR] "${e.name}" (${e.id}) · RUC ${e.taxId || '—'}${e.dv ? `-${e.dv}` : ''} · ${e.motivos.join(' · ')}`);
    console.log(`      ${e.tx.length} tx · $${e.total.toFixed(2)} · ${e.claims.length} claim(s) · ${e.fiscalSource || '—'} · ${new Date(e.createdAt).toLocaleDateString('es-PA')}`);
    if (DETALLE) {
      for (const t of e.tx) console.log(`        · ${t.date.toLocaleDateString('es-PA')} · ${t.type} · $${t.amount.toFixed(2)} · ${t.metadata.provider || '—'}`);
      for (const c of e.claims) console.log(`        · claim ${c.id} · $${c.total} · ${c.proveedor} · ${c.status}`);
    }
  }

  if (sinMatch.length) {
    console.log(`\nSin match (no se toca): ${sinMatch.length}`);
    if (DETALLE) for (const x of sinMatch) console.log(`  · ${x.tipo} · ${x.provider || '—'} · ${x.ruc || '—'} · ${x.id}`);
  }

  if (!APLICAR) {
    console.log('\nℹ️ Dry-run: no se escribió nada.');
    console.log(`Para aplicar: npx tsx scripts/limpiar-proveedores-no-empresa.ts --apply --company=${COMPANY}`);
    await prisma.$disconnect();
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const e of eliminar) {
    try {
      await prisma.$transaction(async (tx: any) => {
        // La Transaction conserva provider/ruc (es el movimiento), pero se
        // desvincula del maestro que se elimina.
        for (const t of e.tx) {
          const m = { ...t.metadata };
          delete m.supplierId;
          await tx.transaction.update({ where: { id: t.id }, data: { metadata: JSON.stringify(m) } });
        }
        await tx.supplier.delete({ where: { id: e.id } });
      });
      ok++;
    } catch (err: any) {
      fail++;
      console.error(`  ⚠️ "${e.name}" (${e.id}): ${err?.message || err}`);
    }
  }

  console.log(`\n✅ Eliminados: ${ok} · fallidos: ${fail}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Error en la limpieza:', err?.message || err);
  process.exit(1);
});
