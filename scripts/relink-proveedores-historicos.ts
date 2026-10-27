/**
 * Relink de Transactions históricas al Supplier maestro.
 *
 * Para las compras/gastos cuya `metadata.ruc` quedó como placeholder
 * (`RUC-1001`, `N/A`, etc.) —o sin RUC, con --incluir-sin-ruc— busca el
 * proveedor por nombre normalizado y:
 *   · escribe `metadata.supplierId` si falta;
 *   · reemplaza el `ruc` placeholder por el RUC real del maestro;
 *   · guarda el placeholder viejo en `metadata.rucPlaceholder` y `relinkedAt`.
 *
 * NO corrige el maestro: eso se hace en Terceros/Excel primero. Si el maestro
 * sigue sin RUC real, lo salta (salvo --permitir-maestro-sin-ruc, que solo
 * vincula por id).
 *
 * DRY-RUN por defecto. Para escribir hay que nombrar el destino:
 *   npx tsx scripts/relink-proveedores-historicos.ts --company=<id>
 *   npx tsx scripts/relink-proveedores-historicos.ts --apply --company=<id>
 *   npx tsx scripts/relink-proveedores-historicos.ts --apply --all   # todas
 *
 * Opciones: --incluir-sin-ruc, --permitir-maestro-sin-ruc, --detalle,
 *           --limit=N, --company=<id>,
 *           --solo="Nombre 1,Nombre 2" (solo esos proveedores).
 * Requiere FIELD_ENC_KEY (el taxId del maestro está cifrado).
 */
import fs from 'fs';

// Cargar .env raíz antes de importar crypto-fields (lee FIELD_ENC_KEY al cargar).
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
const ALL = argv.includes('--all');
const INCLUIR_SIN_RUC = argv.includes('--incluir-sin-ruc');
const PERMITIR_MAESTRO_SIN_RUC = argv.includes('--permitir-maestro-sin-ruc');
const DETALLE = argv.includes('--detalle');
const LIMITE = DETALLE ? Number.POSITIVE_INFINITY : Number(argValor('--limit') || 50);

/** Nombres que no son un proveedor real: bancos, medios de pago, genéricos. */
const NOISE = /^(pago|ach|transferencia|dep[oó]sito|retiro|compra|venta|tarjeta|pos|cheque|efectivo|sin proveedor|proveedor|gasto|ingreso|banco|caja)\b/i;

function esPlaceholderRuc(raw: unknown): boolean {
  const r = String(raw ?? '').trim();
  if (!r) return false;
  if (/^RUC[-\s]?\d+$/i.test(r)) return true;
  if (/^(n\/?a|cf|consumidor final|sin ruc|s\/n|no aplica)$/i.test(r)) return true;
  if (/^SIN-RUC-/i.test(r)) return true;
  return false;
}

function estadoRuc(raw: unknown, tipo?: string | null): 'real' | 'vacio' | 'placeholder' {
  const r = String(raw ?? '').trim();
  if (!r) return 'vacio';
  if (esPlaceholderRuc(r)) return 'placeholder';
  const t = String(tipo || '').toUpperCase();
  if (t === 'PASAPORTE' || t === 'NT') return r.length >= 4 ? 'real' : 'placeholder';
  const digitos = r.replace(/\D/g, '');
  if (t === 'CEDULA' || t === 'RUC') return digitos.length >= 5 ? 'real' : 'placeholder';
  if (digitos.length >= 5 || (/[A-Za-z]/.test(r) && r.length >= 5)) return 'real';
  return 'placeholder';
}

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const rucCorto = (s: string) => (s.length > 28 ? `${s.slice(0, 25)}…` : s);

type Plan = {
  txId: string;
  companyId: string;
  provider: string;
  oldRuc: string;
  master: any;
  action: 'vincular' | 'limpiar' | 'vincular_sin_ruc';
  metadata: Record<string, any>;
  nuevoRuc: string | null;
  nuevoDv: string | null;
};

type Grupo = {
  companyId: string;
  provider: string;
  master: any;
  action: Plan['action'];
  count: number;
  total: number;
  rucs: Set<string>;
  txs: Plan[];
};

async function main() {
  const { PrismaClient } = await import('@agt-contador/prisma-schema');
  const { decryptField, encryptionEnabled } = await import('../apps/api/src/services/crypto-fields');
  const { normalizarNombreTercero, separarRucDv } = await import('@agt-contador/shared');
  const solo = new Set(
    (argValor('--solo') || '')
      .split(',')
      .map((n) => normalizarNombreTercero(n))
      .filter(Boolean),
  );

  if (!encryptionEnabled()) {
    console.error('❌ FIELD_ENC_KEY no está definida o no es base64 de 32 bytes: no se puede leer el RUC del maestro.');
    process.exit(1);
  }
  if (APLICAR && !COMPANY && !ALL) {
    console.error('❌ Para --apply hay que nombrar el destino: --company=<id> o --all.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const dec = (v: unknown) => (v == null ? '' : String(decryptField(v) ?? '').trim());

  const companies = await prisma.company.findMany({
    where: COMPANY ? { id: COMPANY } : undefined,
    select: { id: true, name: true },
  });
  if (!companies.length) {
    console.error(COMPANY ? `❌ No existe la empresa ${COMPANY}` : '❌ No hay empresas.');
    await prisma.$disconnect();
    process.exit(1);
  }
  const idsEmpresas = companies.map((c) => c.id);
  const nombreEmpresa = new Map(companies.map((c) => [c.id, c.name]));

  const [suppliers, txs] = await Promise.all([
    prisma.supplier.findMany({
      where: { companyId: { in: idsEmpresas } },
      select: { id: true, companyId: true, name: true, tradeName: true, taxId: true, dv: true, taxIdType: true },
    }),
    prisma.transaction.findMany({
      where: { companyId: { in: idsEmpresas }, type: { in: ['GASTO', 'COMPRA'] } },
      select: { id: true, companyId: true, type: true, amount: true, date: true, metadata: true },
    }),
  ]);

  const supplierById = new Map<string, any>();
  const suppliersByName = new Map<string, any[]>();
  for (const s of suppliers) {
    const row = { ...s, taxId: dec(s.taxId), dv: s.dv || null };
    supplierById.set(row.id, row);
    const claves = new Set(
      [row.name, row.tradeName].map((n) => normalizarNombreTercero(n)).filter(Boolean),
    );
    for (const clave of claves) {
      const key = `${row.companyId}|${clave}`;
      suppliersByName.set(key, [...(suppliersByName.get(key) || []), row]);
    }
  }

  const planes: Plan[] = [];
  const grupos = new Map<string, Grupo>();
  const omitidas = new Map<string, { count: number; total: number }>();
  let metadataInvalida = 0;
  let conPlaceholder = 0;
  let sinRuc = 0;
  let conRucReal = 0;
  let huerfanos = 0;

  const omitir = (motivo: string, monto: number) => {
    const x = omitidas.get(motivo) || { count: 0, total: 0 };
    x.count++;
    x.total = r2(x.total + (Number(monto) || 0));
    omitidas.set(motivo, x);
  };

  for (const tx of txs) {
    let m: Record<string, any> = {};
    try { m = JSON.parse(tx.metadata || '{}'); } catch { metadataInvalida++; continue; }
    if (!m || typeof m !== 'object') { metadataInvalida++; continue; }

    const provider = String(m.provider || m.nombre || '').trim();
    const ruc = String(m.ruc ?? '').trim();
    const supplierId = m.supplierId ? String(m.supplierId) : null;
    const placeholder = esPlaceholderRuc(ruc);
    const sinRucTx = !ruc;

    if (placeholder) conPlaceholder++;
    else if (sinRucTx) sinRuc++;
    else { conRucReal++; continue; }

    if (!placeholder && !(INCLUIR_SIN_RUC && sinRucTx)) {
      omitir('sin_ruc_metadata', tx.amount);
      continue;
    }
    if (!provider) { omitir('sin_provider', tx.amount); continue; }
    if (NOISE.test(provider)) { omitir('ruido', tx.amount); continue; }

    const norm = normalizarNombreTercero(provider);
    if (solo.size && !solo.has(norm)) { omitir('fuera_de_solo', tx.amount); continue; }
    const candidatos = [...new Map<string, any>(
      (suppliersByName.get(`${tx.companyId}|${norm}`) || []).map((s) => [s.id, s] as [string, any]),
    ).values()];
    const linked = supplierId ? supplierById.get(supplierId) : null;
    const linkedOtro = linked && candidatos.length === 1 && candidatos[0].id !== linked.id;
    const huerfano = supplierId && !linked;
    if (huerfano) huerfanos++;

    let master: any = null;
    let action: Plan['action'] | null = null;

    if (linked) {
      if (linkedOtro) { omitir('vinculado_otro', tx.amount); continue; }
      master = linked;
      action = 'limpiar';
    } else {
      if (candidatos.length === 0) { omitir('sin_maestro', tx.amount); continue; }
      if (candidatos.length > 1) { omitir('ambiguo', tx.amount); continue; }
      master = candidatos[0];
      action = 'vincular';
    }

    const estado = estadoRuc(master.taxId, master.taxIdType);
    if (estado !== 'real' && !PERMITIR_MAESTRO_SIN_RUC) {
      omitir('maestro_sin_ruc', tx.amount);
      continue;
    }

    // El maestro guarda la base en taxId y el DV aparte. Si el DV está, la base
    // se usa TAL CUAL: volver a partirla perdería `8-819-43` → `8-819`.
    // Si el DV no está (registro viejo con el RUC completo), se separa.
    let nuevoRuc: string | null = null;
    let nuevoDv: string | null = null;
    if (estado === 'real') {
      if (master.dv) {
        nuevoRuc = master.taxId || null;
        nuevoDv = master.dv;
      } else {
        const partes = separarRucDv(master.taxId);
        nuevoRuc = partes.base || master.taxId || null;
        nuevoDv = partes.dv || null;
      }
    }

    // Ya vinculado y sin RUC real: no hay nada que corregir en la metadata.
    if (linked && estado !== 'real') {
      omitir('ya_vinculado_sin_ruc', tx.amount);
      continue;
    }

    const data: Record<string, any> = { ...m };
    data.supplierId = master.id;
    if (nuevoRuc) {
      if (ruc && ruc !== nuevoRuc && !data.rucPlaceholder) data.rucPlaceholder = ruc;
      data.ruc = nuevoRuc;
      if (nuevoDv) data.dv = nuevoDv;
      else delete data.dv;
    }
    data.relinkedAt = new Date().toISOString();

    const plan: Plan = {
      txId: tx.id,
      companyId: tx.companyId,
      provider,
      oldRuc: ruc,
      master,
      action: nuevoRuc ? action : 'vincular_sin_ruc',
      metadata: data,
      nuevoRuc,
      nuevoDv,
    };
    planes.push(plan);

    const key = `${tx.companyId}|${norm}|${plan.action}|${master.id}`;
    const g = grupos.get(key) || {
      companyId: tx.companyId,
      provider,
      master,
      action: plan.action,
      count: 0,
      total: 0,
      rucs: new Set<string>(),
      txs: [],
    };
    g.count++;
    g.total = r2(g.total + (Number(tx.amount) || 0));
    if (ruc) g.rucs.add(ruc);
    g.txs.push(plan);
    grupos.set(key, g);
  }

  const modo = APLICAR ? 'APLICANDO' : 'dry-run';
  console.log(`\n=== Relink de proveedores históricos (${modo}) ===`);
  console.log(`Empresas: ${companies.map((c) => `${c.name} (${c.id})`).join(' · ')}`);
  console.log(`Transactions GASTO/COMPRA: ${txs.length} · con placeholder: ${conPlaceholder} · sin RUC: ${sinRuc}${INCLUIR_SIN_RUC ? ' (incluidas)' : ''} · con RUC real: ${conRucReal}`);
  console.log(`Metadata inválida: ${metadataInvalida}`);
  if (huerfanos > 0) {
    console.log(`⚠️ ${huerfanos} tx tienen un supplierId inexistente; se intentan re-vincular por nombre.`);
  }
  console.log('');

  // El monto no se guarda en el plan; se calcula desde los grupos para el resumen.
  const totalPlan = r2([...grupos.values()].reduce((s, g) => s + g.total, 0));

  if (!planes.length) {
    console.log('✅ No hay Transactions para re-vincular con las opciones actuales.');
  } else {
    console.log(`Se ${APLICAR ? 'actualizarán' : 'actualizarían'} ${planes.length} tx por $${totalPlan.toFixed(2)} en ${grupos.size} grupo(s):\n`);
    let impresos = 0;
    for (const g of [...grupos.values()].sort((a, b) => b.total - a.total)) {
      if (impresos >= LIMITE) { console.log(`  … ${grupos.size - impresos} grupo(s) más. Usá --detalle.`); break; }
      impresos++;
      const rucs = [...g.rucs].slice(0, 6).join(', ') + (g.rucs.size > 6 ? ` (+${g.rucs.size - 6})` : '');
      const dv = g.master.dv ? `-${g.master.dv}` : '';
      console.log(`  [${g.action}] ${nombreEmpresa.get(g.companyId)} · "${g.provider}"`);
      console.log(`      ${g.count} tx · $${g.total.toFixed(2)} · placeholder ${rucs || '—'} → maestro "${g.master.name}" RUC ${rucCorto(g.master.taxId)}${dv}`);
      if (DETALLE) {
        for (const p of g.txs) {
          console.log(`        · ${p.txId} · ruc metadata → ${p.nuevoRuc || '—'}${p.nuevoDv ? `-${p.nuevoDv}` : ''} (antes: ${p.oldRuc || '—'})`);
        }
      }
    }
  }

  if (omitidas.size) {
    console.log('\nOmitidas:');
    for (const [motivo, x] of omitidas) {
      console.log(`  ${motivo.padEnd(24)} ${String(x.count).padStart(5)} tx · $${x.total.toFixed(2)}`);
    }
  }

  if (!APLICAR) {
    console.log('\nℹ️ Dry-run: no se escribió nada.');
    console.log(`Para aplicar: npx tsx scripts/relink-proveedores-historicos.ts --apply --company=${COMPANY || '<id>'}`);
    await prisma.$disconnect();
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const p of planes) {
    try {
      await prisma.transaction.update({
        where: { id: p.txId },
        data: { metadata: JSON.stringify(p.metadata) },
      });
      ok++;
    } catch (e: any) {
      fail++;
      if (fail <= 10) console.error(`  ⚠️ ${p.txId} (${p.provider}): ${e?.message || e}`);
    }
  }

  console.log(`\n✅ Actualizadas: ${ok} · fallidas: ${fail}`);
  console.log('El maestro no se modificó: eso se corrige en Terceros/Excel.');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Error en el relink:', err?.message || err);
  process.exit(1);
});
