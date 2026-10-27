/**
 * Reasigna las Transactions de un proveedor (por nombre de metadata) a un
 * maestro distinto, creándolo o completando su RUC si hace falta.
 *
 * Pensado para links equivocados: una transacción quedó con `supplierId` de
 * otro maestro y el relink normal no la mueve porque solo limpia/crea links.
 * Ejemplo ZAZ: las compras de "zaz la pesa" estaban apuntando a S/M Rey.
 *
 * DRY-RUN por defecto. Requiere nombrar la empresa:
 *   npx tsx scripts/reasignar-proveedor.ts \
 *     --company=<id> --provider="zaz la pesa" \
 *     --master="ZAZ La Pesa" --ruc=1480780-1-643575 --dv=52
 *
 * Con `--apply` crea/actualiza el maestro y reasigna las Transactions.
 * Solo toca Transactions GASTO/COMPRA cuyo `metadata.provider` normalizado sea
 * el indicado. No toca las demás compras del maestro viejo.
 *
 * Requiere FIELD_ENC_KEY (el taxId del maestro está cifrado).
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
const FORZAR = argv.includes('--forzar');
const COMPANY = argValor('--company');
const PROVIDER = argValor('--provider');
const MASTER_ARG = argValor('--master');
const MASTER = (MASTER_ARG || PROVIDER || '').trim();
const MASTER_EXPLICITO = !!MASTER_ARG;
const TRADE = argValor('--trade');
const RUC_ARG = argValor('--ruc');
const DV_ARG = argValor('--dv');

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

async function main() {
  const { PrismaClient } = await import('@agt-contador/prisma-schema');
  const {
    encryptField, decryptField, encryptionEnabled, hashField,
  } = await import('../apps/api/src/services/crypto-fields');
  const { normalizarNombreTercero, normalizarRucBase, separarRucDv } = await import('@agt-contador/shared');

  if (!encryptionEnabled()) {
    console.error('❌ FIELD_ENC_KEY no está definida o no es base64 de 32 bytes: no se puede leer/escribir el RUC.');
    process.exit(1);
  }
  if (!COMPANY || !PROVIDER || !RUC_ARG) {
    console.error('❌ Faltan --company, --provider o --ruc.');
    process.exit(1);
  }
  if (APLICAR && !COMPANY) {
    console.error('❌ --apply requiere --company=<id>.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const dec = (v: unknown) => (v == null ? '' : String(decryptField(v) ?? '').trim());

  const partes = separarRucDv(RUC_ARG);
  const base = (partes.base || RUC_ARG).trim();
  const dv = String(DV_ARG || partes.dv || '').trim() || null;
  const hash = hashField(normalizarRucBase(base));
  if (!base || !hash) {
    console.error('❌ RUC inválido para el maestro.');
    process.exit(1);
  }

  const empresa = await prisma.company.findFirst({ where: { id: COMPANY }, select: { id: true, name: true } });
  if (!empresa) {
    console.error(`❌ No existe la empresa ${COMPANY}.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const proveedorNorm = normalizarNombreTercero(PROVIDER);
  const [byHash, byName, byTrade] = await Promise.all([
    prisma.supplier.findFirst({ where: { companyId: COMPANY, taxIdHash: hash } }),
    prisma.supplier.findFirst({
      where: { companyId: COMPANY, name: { equals: MASTER, mode: 'insensitive' } },
    }),
    TRADE
      ? prisma.supplier.findFirst({
          where: { companyId: COMPANY, tradeName: { equals: TRADE, mode: 'insensitive' } },
        })
      : null,
  ]);

  let target = byHash || byName || byTrade || null;
  let accionMaestro: 'usar' | 'crear' | 'actualizar_ruc' | 'completar_dv' | 'actualizar_identidad' = 'usar';
  let conflicto: string | null = null;
  let actualizarNombre = false;
  let actualizarTrade = false;

  if (byHash) {
    target = byHash;
    const dvActual = String(byHash.dv || '').trim();
    if (dv && !dvActual) accionMaestro = 'completar_dv';
    if (byName && byName.id !== byHash.id) {
      conflicto = `Ya existe otro maestro con el nombre "${MASTER}" (${byName.id}) y RUC ${dec(byName.taxId) || 'vacío'}; revisá si hay que fusionarlo.`;
    } else if (byTrade && byTrade.id !== byHash.id) {
      conflicto = `Ya existe otro maestro con el nombre comercial "${TRADE}" (${byTrade.id}); revisá si hay que fusionarlo.`;
    } else if (MASTER_EXPLICITO && byHash.name !== MASTER) {
      actualizarNombre = true;
    }
    if (TRADE && byHash.tradeName !== TRADE) actualizarTrade = true;
  } else if (byName || byTrade) {
    target = byName || byTrade;
    const rucActual = dec(target!.taxId);
    const baseActual = normalizarRucBase(rucActual);
    if (baseActual && baseActual !== normalizarRucBase(base)) {
      if (!FORZAR) {
        console.error(`❌ El maestro "${target!.name}" tiene RUC ${rucActual} distinto de ${base}. Usá --forzar si el correcto es el nuevo.`);
        await prisma.$disconnect();
        process.exit(1);
      }
      accionMaestro = 'actualizar_ruc';
    } else if (!baseActual) {
      accionMaestro = 'actualizar_ruc';
    } else if (dv && !String(target!.dv || '').trim()) {
      accionMaestro = 'completar_dv';
    }
    if (MASTER_EXPLICITO && target!.name !== MASTER) actualizarNombre = true;
    if (TRADE && target!.tradeName !== TRADE) actualizarTrade = true;
    if (byName && byTrade && byName.id !== byTrade.id) {
      conflicto = `Hay dos maestros: nombre "${byName.name}" (${byName.id}) y tradeName "${byTrade.name}" (${byTrade.id}); revisá si hay que fusionarlos.`;
    }
  } else {
    accionMaestro = 'crear';
  }

  if (accionMaestro === 'usar' && (actualizarNombre || actualizarTrade)) {
    accionMaestro = 'actualizar_identidad';
  }

  const txs = await prisma.transaction.findMany({
    where: { companyId: COMPANY, type: { in: ['GASTO', 'COMPRA'] } },
    select: { id: true, amount: true, date: true, type: true, description: true, metadata: true },
  });

  const plan: { txId: string; amount: number; date: Date; oldSupplierId: string | null; oldRuc: string; metadata: Record<string, any> }[] = [];
  const yaOk: string[] = [];
  let sinProvider = 0;

  for (const tx of txs) {
    let m: Record<string, any> = {};
    try { m = JSON.parse(tx.metadata || '{}'); } catch { continue; }
    if (!m || typeof m !== 'object') continue;
    const provider = String(m.provider || m.nombre || '').trim();
    if (!provider) { sinProvider++; continue; }
    if (normalizarNombreTercero(provider) !== proveedorNorm) continue;

    const oldSupplierId = m.supplierId ? String(m.supplierId) : null;
    const oldRuc = String(m.ruc ?? '').trim();
    if (target && oldSupplierId === target.id && oldRuc === base) {
      yaOk.push(tx.id);
      continue;
    }

    const data: Record<string, any> = { ...m };
    data.supplierId = target ? target.id : undefined;
    if (oldRuc && oldRuc !== base && !data.rucPlaceholder) data.rucPlaceholder = oldRuc;
    data.ruc = base;
    if (dv) data.dv = dv;
    else delete data.dv;
    data.relinkedAt = new Date().toISOString();
    if (oldSupplierId && (!target || oldSupplierId !== target.id)) data.reassignedFrom = oldSupplierId;

    plan.push({ txId: tx.id, amount: Number(tx.amount) || 0, date: tx.date, oldSupplierId, oldRuc, metadata: data });
  }

  const total = r2(plan.reduce((s, p) => s + p.amount, 0));
  console.log('\n=== Reasignar proveedor ===');
  console.log(`Empresa: ${empresa.name} (${empresa.id})`);
  console.log(`Metadata provider: "${PROVIDER}" (normalizado "${proveedorNorm}")`);
  if (accionMaestro === 'crear') {
    console.log(`Maestro: CREAR "${MASTER}"${TRADE ? ` (${TRADE})` : ''} — RUC ${base}${dv ? `-${dv}` : ''}`);
  } else if (target) {
    const rucActual = dec(target.taxId);
    console.log(`Maestro: "${target.name}"${target.tradeName ? ` (${target.tradeName})` : ''} (${target.id}) — RUC ${rucActual || 'vacío'}${target.dv ? `-${target.dv}` : ''}`);
    if (accionMaestro === 'actualizar_ruc') console.log(`  → se ${APLICAR ? 'actualizará' : 'actualizaría'} el RUC a ${base}${dv ? `-${dv}` : ''}`);
    if (accionMaestro === 'completar_dv') console.log(`  → se ${APLICAR ? 'completará' : 'completaría'} el DV ${dv}`);
    if (actualizarNombre) console.log(`  → se ${APLICAR ? 'actualizará' : 'actualizaría'} el nombre a "${MASTER}"`);
    if (actualizarTrade) console.log(`  → se ${APLICAR ? 'actualizará' : 'actualizaría'} el nombre comercial a "${TRADE}"`);
    if (accionMaestro === 'usar') console.log('  → se usa tal cual');
  }
  if (conflicto) console.log(`  ⚠️ ${conflicto}`);
  console.log(`\nTransactions a reasignar: ${plan.length} · $${total.toFixed(2)} · ya OK: ${yaOk.length} · sin provider: ${sinProvider}`);
  for (const p of plan) {
    console.log(`  · ${p.txId} · ${p.date.toLocaleDateString('es-PA')} · $${p.amount.toFixed(2)} · ${p.oldSupplierId ? `supplierId ${p.oldSupplierId}` : 'sin supplierId'} · ruc "${p.oldRuc || '—'}" → ${MASTER}`);
  }

  if (!plan.length && accionMaestro === 'usar') {
    console.log('\n✅ No hay nada que reasignar ni corregir.');
    await prisma.$disconnect();
    return;
  }

  if (!APLICAR) {
    console.log('\nℹ️ Dry-run: no se escribió nada.');
    console.log(`Para aplicar: npx tsx scripts/reasignar-proveedor.ts --apply --company=${COMPANY} --provider="${PROVIDER}" --master="${MASTER}"${TRADE ? ` --trade="${TRADE}"` : ''} --ruc=${base}${dv ? ` --dv=${dv}` : ''}`);
    await prisma.$disconnect();
    return;
  }

  const resultado = await prisma.$transaction(async (tx: any) => {
    let maestro: any = target;
    if (accionMaestro === 'crear') {
      maestro = await tx.supplier.create({
        data: {
          companyId: COMPANY,
          name: MASTER,
          ...(TRADE ? { tradeName: TRADE } : {}),
          taxId: encryptField(base),
          taxIdHash: hash,
          dv,
          taxIdType: 'RUC',
          fiscalSource: 'MANUAL',
          fiscalUpdatedAt: new Date(),
        },
      });
    } else if (accionMaestro === 'actualizar_ruc') {
      maestro = await tx.supplier.update({
        where: { id: target!.id },
        data: {
          ...(actualizarNombre ? { name: MASTER } : {}),
          ...(actualizarTrade ? { tradeName: TRADE } : {}),
          taxId: encryptField(base),
          taxIdHash: hash,
          dv,
          taxIdType: 'RUC',
          fiscalSource: 'MANUAL',
          fiscalUpdatedAt: new Date(),
        },
      });
    } else if (accionMaestro === 'completar_dv') {
      maestro = await tx.supplier.update({
        where: { id: target!.id },
        data: {
          ...(actualizarNombre ? { name: MASTER } : {}),
          ...(actualizarTrade ? { tradeName: TRADE } : {}),
          dv,
          fiscalSource: target!.fiscalSource || 'MANUAL',
          fiscalUpdatedAt: new Date(),
        },
      });
    } else if (accionMaestro === 'actualizar_identidad') {
      maestro = await tx.supplier.update({
        where: { id: target!.id },
        data: {
          ...(actualizarNombre ? { name: MASTER } : {}),
          ...(actualizarTrade ? { tradeName: TRADE } : {}),
          fiscalSource: target!.fiscalSource || 'MANUAL',
          fiscalUpdatedAt: new Date(),
        },
      });
    }

    let ok = 0;
    for (const p of plan) {
      try {
        await tx.transaction.update({
          where: { id: p.txId },
          data: { metadata: JSON.stringify({ ...p.metadata, supplierId: maestro!.id }) },
        });
        ok++;
      } catch (e: any) {
        console.error(`  ⚠️ ${p.txId}: ${e?.message || e}`);
      }
    }
    return { maestro, ok };
  });

  console.log(`\n✅ Maestro "${resultado.maestro?.name}" (${resultado.maestro?.id}) · Transactions reasignadas: ${resultado.ok}/${plan.length}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Error en la reasignación:', err?.message || err);
  process.exit(1);
});
