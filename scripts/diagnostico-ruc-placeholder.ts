/**
 * Diagnóstico de RUC placeholder en la metadata de Transactions — SOLO LECTURA.
 *
 * Busca las compras/gastos cuyo `metadata.ruc` quedó como `RUC-1001`, `N/A`,
 * etc. (el backfill de proveedores históricos los descartó y creó el maestro
 * por nombre, sin RUC y sin escribir `supplierId`). Para cada proveedor cruza
 * contra el maestro y dice si se puede vincular, si ya está vinculado, si el
 * maestro sigue sin RUC real, si no hay maestro o si hay ambigüedad.
 *
 * No escribe nada. Uso:
 *   npx tsx scripts/diagnostico-ruc-placeholder.ts
 *   npx tsx scripts/diagnostico-ruc-placeholder.ts --company=<id> --detalle
 *
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
const COMPANY = argValor('--company');
const DETALLE = argv.includes('--detalle');
const LIMITE = DETALLE ? Number.POSITIVE_INFINITY : Number(argValor('--limit') || 50);

/** Nombres que no son un proveedor real: bancos, medios de pago, genéricos. */
const NOISE = /^(pago|ach|transferencia|dep[oó]sito|retiro|compra|venta|tarjeta|pos|cheque|efectivo|sin proveedor|proveedor|gasto|ingreso|banco|caja)\b/i;

/** `RUC-1001`, `N/A`, `CF`… no son identidad fiscal. */
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
const fecha = (d: Date) => d.toLocaleDateString('es-PA');
const rucCorto = (s: string) => (s.length > 28 ? `${s.slice(0, 25)}…` : s);

type Grupo = {
  companyId: string;
  provider: string;
  normProvider: string;
  variantes: Set<string>;
  rucs: Set<string>;
  count: number;
  total: number;
  min: Date | null;
  max: Date | null;
  supplierIds: Set<string>;
  txs: { id: string; amount: number; date: Date; supplierId: string | null }[];
};

async function main() {
  const { PrismaClient } = await import('@agt-contador/prisma-schema');
  const { decryptField, encryptionEnabled } = await import('../apps/api/src/services/crypto-fields');
  const { normalizarNombreTercero } = await import('@agt-contador/shared');

  if (!encryptionEnabled()) {
    console.error('❌ FIELD_ENC_KEY no está definida o no es base64 de 32 bytes: no se puede leer el RUC del maestro.');
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

  const grupos = new Map<string, Grupo>();
  const gruposSinRuc = new Map<string, { companyId: string; provider: string; count: number; total: number }>();
  let conPlaceholder = 0;
  let sinRuc = 0;
  let conRucReal = 0;
  let metadataInvalida = 0;
  let sinProvider = 0;

  for (const tx of txs) {
    let m: any = {};
    try { m = JSON.parse(tx.metadata || '{}'); } catch { metadataInvalida++; continue; }
    if (!m || typeof m !== 'object') { metadataInvalida++; continue; }
    const provider = String(m.provider || m.nombre || '').trim();
    const ruc = String(m.ruc ?? '').trim();
    const supplierId = m.supplierId ? String(m.supplierId) : null;

    if (esPlaceholderRuc(ruc)) {
      conPlaceholder++;
      const norm = normalizarNombreTercero(provider);
      const key = `${tx.companyId}|${norm || '(sin nombre)'}`;
      const g = grupos.get(key) || {
        companyId: tx.companyId,
        provider,
        normProvider: norm,
        variantes: new Set<string>(),
        rucs: new Set<string>(),
        count: 0,
        total: 0,
        min: null,
        max: null,
        supplierIds: new Set<string>(),
        txs: [],
      };
      if (!g.provider && provider) g.provider = provider;
      if (provider) g.variantes.add(provider);
      g.rucs.add(ruc);
      g.count++;
      g.total = r2(g.total + (Number(tx.amount) || 0));
      if (!g.min || tx.date < g.min) g.min = tx.date;
      if (!g.max || tx.date > g.max) g.max = tx.date;
      if (supplierId) g.supplierIds.add(supplierId);
      g.txs.push({ id: tx.id, amount: Number(tx.amount) || 0, date: tx.date, supplierId });
      grupos.set(key, g);
      if (!provider) sinProvider++;
    } else if (!ruc) {
      sinRuc++;
      const norm = normalizarNombreTercero(provider);
      const key = `${tx.companyId}|${norm || '(sin nombre)'}`;
      const g = gruposSinRuc.get(key) || { companyId: tx.companyId, provider, count: 0, total: 0 };
      g.count++;
      g.total = r2(g.total + (Number(tx.amount) || 0));
      gruposSinRuc.set(key, g);
    } else {
      conRucReal++;
    }
  }

  const totalSinRuc = r2([...gruposSinRuc.values()].reduce((s, g) => s + g.total, 0));
  console.log('\n=== Diagnóstico de RUC placeholder en Transactions (solo lectura) ===');
  console.log(`Empresas: ${companies.map((c) => `${c.name} (${c.id})`).join(' · ')}`);
  console.log(`Transactions GASTO/COMPRA: ${txs.length} · con placeholder: ${conPlaceholder} · sin RUC: ${sinRuc} ($${totalSinRuc.toFixed(2)}) · con RUC real: ${conRucReal}`);
  console.log(`Metadata inválida: ${metadataInvalida}\n`);

  const maestrosSinRuc = suppliers
    .map((s) => ({ ...s, taxId: dec(s.taxId), dv: s.dv || null }))
    .filter((s) => estadoRuc(s.taxId, s.taxIdType) !== 'real');

  if (!conPlaceholder) {
    console.log('✅ No hay Transactions con RUC placeholder.');
  }

  const prioridad: Record<string, number> = {
    sin_maestro: 0,
    ambiguo: 1,
    maestro_sin_ruc: 2,
    vinculado_otro: 3,
    limpiar: 4,
    vincular: 5,
    ya_ok_por_id: 6,
    ruido: 7,
    sin_provider: 8,
  };

  const filas: {
    g: Grupo;
    accion: string;
    master: any | null;
    candidatos: any[];
    linkedSame: number;
    linkedOther: number;
    huerfanos: number;
  }[] = [];

  for (const g of grupos.values()) {
    const candidatos = [...new Map<string, any>(
      (suppliersByName.get(`${g.companyId}|${g.normProvider}`) || []).map((s) => [s.id, s] as [string, any]),
    ).values()];
    const master = candidatos.length === 1 ? candidatos[0] : null;
    const linkedSame = master ? g.txs.filter((t) => t.supplierId === master.id).length : 0;
    const linkedOther = master
      ? g.txs.filter((t) => t.supplierId && t.supplierId !== master.id && supplierById.has(t.supplierId)).length
      : 0;
    const huerfanos = [...g.supplierIds].filter((id) => !supplierById.has(id)).length;
    const linkedRows = g.txs
      .map((t) => (t.supplierId ? supplierById.get(t.supplierId) : null))
      .filter(Boolean);
    const linkedConocidos = linkedRows.length;
    const linkedTodosReales = linkedConocidos === g.count
      && linkedRows.every((s) => estadoRuc(s.taxId, s.taxIdType) === 'real');

    let accion: string;
    if (!g.provider) accion = 'sin_provider';
    else if (NOISE.test(g.provider)) accion = 'ruido';
    else if (candidatos.length === 0) {
      accion = linkedConocidos === g.count
        ? (linkedTodosReales ? 'ya_ok_por_id' : 'maestro_sin_ruc')
        : 'sin_maestro';
    } else if (candidatos.length > 1) accion = 'ambiguo';
    else if (estadoRuc(master.taxId, master.taxIdType) !== 'real') accion = 'maestro_sin_ruc';
    else if (linkedOther > 0) accion = 'vinculado_otro';
    else if (linkedSame === g.count) accion = 'limpiar';
    else accion = 'vincular';

    filas.push({ g, accion, master, candidatos, linkedSame, linkedOther, huerfanos });
  }

  filas.sort((a, b) => {
    const p = (prioridad[a.accion] ?? 9) - (prioridad[b.accion] ?? 9);
    return p !== 0 ? p : b.g.total - a.g.total;
  });

  const porAccion = new Map<string, { tx: number; total: number; grupos: number }>();
  for (const f of filas) {
    const x = porAccion.get(f.accion) || { tx: 0, total: 0, grupos: 0 };
    x.tx += f.g.count;
    x.total = r2(x.total + f.g.total);
    x.grupos++;
    porAccion.set(f.accion, x);
  }

  for (const [accion, x] of porAccion) {
    console.log(`  ${accion.padEnd(16)} ${String(x.grupos).padStart(4)} proveedor(es) · ${String(x.tx).padStart(5)} tx · $${x.total.toFixed(2)}`);
  }
  console.log('');

  let impresos = 0;
  for (const f of filas) {
    if (impresos >= LIMITE) { console.log(`  … ${filas.length - impresos} grupo(s) más. Usá --detalle para verlos todos.`); break; }
    impresos++;
    const g = f.g;
    const rucs = [...g.rucs].slice(0, 6).join(', ') + (g.rucs.size > 6 ? ` (+${g.rucs.size - 6})` : '');
    const variantes = g.variantes.size > 1 ? ` (+${g.variantes.size - 1} variante(s))` : '';
    const fechas = g.min && g.max ? ` · ${fecha(g.min)} a ${fecha(g.max)}` : '';
    const linked = ` · ids: ${g.txs.filter((t) => t.supplierId).length}/${g.count}`;
    let detalle = '';
    if (f.accion === 'sin_maestro') detalle = ' · NO hay Supplier con ese nombre';
    else if (f.accion === 'ambiguo') detalle = ` · ${f.candidatos.length} maestros: ${f.candidatos.map((s) => s.name).join(' / ')}`;
    else if (f.accion === 'maestro_sin_ruc') detalle = ` · maestro "${f.master?.name || '?'}" con RUC ${f.master?.taxId ? rucCorto(f.master.taxId) : 'vacío'}`;
    else if (f.accion === 'vinculado_otro') detalle = ` · ${f.linkedOther} tx ya apuntan a otro supplierId`;
    else if (f.accion === 'limpiar') detalle = ` · maestro "${f.master?.name}" (RUC real); solo falta limpiar el ruc de la metadata`;
    else if (f.accion === 'vincular') detalle = ` · maestro "${f.master?.name}" (RUC ${rucCorto(f.master?.taxId || '')}${f.master?.dv ? `-${f.master.dv}` : ''})`;
    else if (f.accion === 'ya_ok_por_id') detalle = ' · ya vinculado por supplierId; el nombre no coincide con el maestro';
    else if (f.accion === 'ruido') detalle = ' · nombre que no parece proveedor';
    else if (f.accion === 'sin_provider') detalle = ' · metadata sin provider/nombre';

    console.log(`  [${f.accion}] ${nombreEmpresa.get(g.companyId)} · "${g.provider || '(sin nombre)'}"${variantes}`);
    console.log(`      RUC: ${rucs} · ${g.count} tx · $${g.total.toFixed(2)}${fechas}${linked}${detalle}`);
    if (f.huerfanos) console.log(`      ⚠️ ${f.huerfanos} supplierId(s) apuntan a un maestro inexistente.`);
  }

  console.log(`\nResumen: ${conPlaceholder} tx con placeholder en ${grupos.size} proveedor(es); ${sinRuc} sin RUC; ${conRucReal} con RUC real.`);
  console.log(`Maestros con RUC vacío/placeholder: ${maestrosSinRuc.length}`);
  if (maestrosSinRuc.length && DETALLE) {
    const porEmpresa = new Map<string, any[]>();
    for (const s of maestrosSinRuc) porEmpresa.set(s.companyId, [...(porEmpresa.get(s.companyId) || []), s]);
    for (const [companyId, ss] of porEmpresa) {
      console.log(`— ${nombreEmpresa.get(companyId)} (${ss.length})`);
      for (const s of ss) {
        console.log(`  · ${s.name} (${s.id}) — RUC ${estadoRuc(s.taxId, s.taxIdType)}${s.taxId ? `: ${rucCorto(s.taxId)}` : ''}`);
      }
    }
  } else if (maestrosSinRuc.length) {
    console.log('  Usá --detalle para listarlos.');
  }

  if (gruposSinRuc.size) {
    console.log(`\nSin RUC en metadata (fuera del relink por defecto; usá --incluir-sin-ruc): ${sinRuc} tx en ${gruposSinRuc.size} proveedor(es).`);
    if (DETALLE) {
      for (const g of gruposSinRuc.values()) {
        console.log(`  · ${nombreEmpresa.get(g.companyId)} · "${g.provider || '(sin nombre)'}" — ${g.count} tx · $${g.total.toFixed(2)}`);
      }
    }
  }

  console.log('\nℹ️ Solo lectura: no se escribió nada.');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Error en el diagnóstico:', err?.message || err);
  process.exit(1);
});
