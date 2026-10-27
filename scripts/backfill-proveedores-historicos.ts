/**
 * Backfill del maestro de PROVEEDORES con las compras/gastos históricos.
 *
 * Lee las Transactions GASTO/COMPRA (metadata.provider/ruc…) y los
 * ExpenseClaim (proveedor/rucEmisor) y crea/complete el Supplier que hoy no
 * existe para las compras anteriores a la Fase 2. Es idempotente y no pisa
 * datos: si el proveedor ya existe por RUC canónico o nombre, lo reutiliza.
 *
 * DRY-RUN por defecto. Con `--apply` escribe (requiere autorización explícita
 * para la BD de producción). Usa el Prisma crudo y cifra a mano taxId/phone/
 * email, igual que la extensión de main.ts.
 *
 * Uso: npx tsx scripts/backfill-proveedores-historicos.ts [--apply]
 */
import fs from 'fs';

const envPath = '/root/apps/agt-contadpr/.env';
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

const APLICAR = process.argv.includes('--apply');
const MUESTRA = process.argv.includes('--muestra');

/** Nombres que no son un proveedor real: bancos, medios de pago, genéricos. */
const NOISE = /^(pago|ach|transferencia|dep[oó]sito|retiro|compra|venta|tarjeta|pos|cheque|efectivo|sin proveedor|proveedor|gasto|ingreso|banco|caja)\b/i;

/** `RUC-1001`, `N/A` y demás placeholders de archivos viejos no son un RUC:
 *  se crea el proveedor por nombre, sin inventarle identidad fiscal. */
function rucValido(raw: unknown): boolean {
  const r = String(raw ?? '').trim();
  if (!r) return false;
  if (/^RUC[-\s]?\d+$/i.test(r)) return false;
  if (!/^[\d\s\-./]+$/.test(r)) return false;
  return /\d{5,}/.test(r.replace(/\D/g, ''));
}

async function main() {
  const { PrismaClient } = await import('@agt-contador/prisma-schema');
  const { encryptField, decryptField, encryptionEnabled } = await import('../apps/api/src/services/crypto-fields');
  const { separarRucDv, normalizarRucBase, normalizarNombreTercero, hashField, esIdentificacionEmpresa } = await import('@agt-contador/shared');

  if (!encryptionEnabled()) {
    console.error('❌ FIELD_ENC_KEY no está definida: no se puede cifrar el RUC/teléfono/email de los proveedores.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const dec = (v: unknown) => (v == null ? '' : String(decryptField(v) ?? '').trim());

  const [txs, claims, existentes] = await Promise.all([
    prisma.transaction.findMany({
      where: { type: { in: ['GASTO', 'COMPRA'] } },
      select: {
        id: true, companyId: true, metadata: true,
        journalEntry: {
          select: {
            lines: {
              select: {
                debit: true, credit: true,
                account: { select: { code: true, requiresAnexo: true } },
              },
            },
          },
        },
      },
    }),
    prisma.expenseClaim.findMany({
      where: { proveedor: { not: null } },
      select: {
        id: true, companyId: true, proveedor: true, rucEmisor: true,
        dgiUrl: true, origen: true, workerId: true,
      },
    }),
    prisma.supplier.findMany({
      select: { id: true, companyId: true, name: true, taxId: true, dv: true, phone: true, email: true, address: true },
    }),
  ]);

  const porRuc = new Map<string, any>();
  const porNombre = new Map<string, any>();
  for (const s of existentes) {
    const base = normalizarRucBase(dec(s.taxId));
    if (base) porRuc.set(`${s.companyId}|${base}`, s);
    const nombre = normalizarNombreTercero(s.name);
    if (nombre) porNombre.set(`${s.companyId}|${nombre}`, s);
  }

  type Candidato = {
    companyId: string; name: string; taxId: string | null; dv: string | null;
    phone: string | null; email: string | null; address: string | null; location: string | null;
    taxIdType: string | null; fiscalSource: string | null;
    /** Regla B: el candidato entra al maestro solo por Anexo, CxP, RUC o reembolso. */
    tieneAnexo?: boolean; tieneCxP?: boolean; esEmpresa?: boolean; worker?: boolean;
  };
  const candidatos = new Map<string, Candidato>();
  const stats = { tx: txs.length, claims: claims.length, sinNombre: 0, ruido: 0, conflictoNombre: 0, sinRegla: 0 };

  const agregar = (c: Candidato) => {
    const name = String(c.name || '').trim();
    if (!name) { stats.sinNombre++; return; }
    if (NOISE.test(name) || !/[a-zA-Záéíóúñ]{3}/i.test(name)) { stats.ruido++; return; }
    const ruc = rucValido(c.taxId) ? c.taxId : null;
    const partes = separarRucDv(ruc);
    const base = normalizarRucBase(ruc);
    const esEmpresa = esIdentificacionEmpresa({ taxIdType: c.taxIdType, taxId: c.taxId, dv: c.dv });
    // La clave es el nombre normalizado: el schema tiene unique (companyId,name),
    // así que dos variantes con RUC y sin RUC son el MISMO proveedor.
    const key = `N|${c.companyId}|${normalizarNombreTercero(name)}`;
    const prev = candidatos.get(key);
    if (!prev) {
      candidatos.set(key, {
        companyId: c.companyId,
        name,
        taxId: partes.base || null,
        dv: c.dv || partes.dv || null,
        phone: c.phone || null,
        email: c.email || null,
        address: c.address || null,
        location: c.location || null,
        taxIdType: c.taxIdType || null,
        fiscalSource: c.fiscalSource || null,
        tieneAnexo: !!c.tieneAnexo,
        tieneCxP: !!c.tieneCxP,
        esEmpresa,
        worker: !!c.worker,
      });
      return;
    }
    // Mismo nombre: se conserva el primer RUC válido. Si aparecen dos RUC
    // distintos se anota el conflicto (se resuelve a mano en la Fase 4).
    if (!prev.taxId && partes.base) {
      prev.taxId = partes.base;
      prev.dv = c.dv || partes.dv || prev.dv;
    } else if (prev.taxId && base && normalizarRucBase(prev.taxId) !== base) {
      stats.conflictoNombre++;
    }
    prev.dv ||= c.dv || partes.dv || null;
    prev.phone ||= c.phone || null;
    prev.email ||= c.email || null;
    prev.address ||= c.address || null;
    prev.location ||= c.location || null;
    prev.taxIdType ||= c.taxIdType || null;
    prev.fiscalSource ||= c.fiscalSource || null;
    prev.tieneAnexo ||= !!c.tieneAnexo;
    prev.tieneCxP ||= !!c.tieneCxP;
    prev.esEmpresa ||= esEmpresa;
    prev.worker ||= !!c.worker;
  };

  for (const tx of txs) {
    let m: any = {};
    try { m = JSON.parse(tx.metadata || '{}'); } catch { /* metadata rota */ }
    const lineas = (tx as any).journalEntry?.lines || [];
    const tieneAnexo = lineas.some((l: any) => (l.debit || 0) > 0 && l.account?.requiresAnexo);
    const tieneCxP = lineas.some((l: any) => (l.credit || 0) > 0 && l.account?.code === '2.1.01');
    agregar({
      companyId: tx.companyId,
      name: m.provider || '',
      taxId: m.ruc || null,
      dv: m.dv || null,
      phone: m.phone || null,
      email: m.email || null,
      address: m.address || null,
      location: m.location || null,
      taxIdType: m.taxIdType || null,
      fiscalSource: m.fiscalSource || 'IMPORT',
      tieneAnexo,
      tieneCxP,
    });
  }
  for (const c of claims) {
    agregar({
      companyId: c.companyId,
      name: c.proveedor || '',
      taxId: c.rucEmisor || null,
      dv: null, phone: null, email: null, address: null, location: null, taxIdType: null,
      fiscalSource: (c.dgiUrl ? 'PDF' : 'MANUAL'),
      worker: !!c.workerId,
    });
  }

  let nuevos = 0;
  let existentesMatch = 0;
  let fusionados = 0;
  const simRuc = new Map(porRuc);
  const simNombre = new Map(porNombre);
  const porEmpresa = new Map<string, { nuevos: number; existentes: number }>();
  for (const c of candidatos.values()) {
    // Regla B: sin Anexo, CxP, RUC ni reembolso no se crea proveedor.
    if (!c.tieneAnexo && !c.tieneCxP && !c.esEmpresa && !c.worker) {
      stats.sinRegla++;
      continue;
    }
    const base = normalizarRucBase(c.taxId);
    const nombre = normalizarNombreTercero(c.name);
    const match = (base && simRuc.get(`${c.companyId}|${base}`))
      || simNombre.get(`${c.companyId}|${nombre}`);
    const st = porEmpresa.get(c.companyId) || { nuevos: 0, existentes: 0 };
    if (match) {
      // Ya estaba en la BD o lo crea/absorbe otro candidato del mismo RUC/nombre.
      if (porRuc.get(`${c.companyId}|${base}`) || porNombre.get(`${c.companyId}|${nombre}`)) existentesMatch++;
      else fusionados++;
      st.existentes++;
    } else {
      nuevos++;
      st.nuevos++;
      if (base) simRuc.set(`${c.companyId}|${base}`, c);
      simNombre.set(`${c.companyId}|${nombre}`, c);
    }
    porEmpresa.set(c.companyId, st);
  }

  console.log(`\n=== Backfill de proveedores históricos ${APLICAR ? '(APLICANDO)' : '(dry-run)'} ===`);
  console.log(`Transactions GASTO/COMPRA: ${stats.tx} · ExpenseClaim: ${stats.claims}`);
  console.log(`Sin nombre: ${stats.sinNombre} · Descartados como ruido: ${stats.ruido} · Sin regla B (sin Anexo/CxP/RUC/worker): ${stats.sinRegla}`);
  if (stats.conflictoNombre) console.log(`⚠️ Nombres normalizados con RUC distinto (se conserva el primero): ${stats.conflictoNombre}`);
  console.log(`Proveedores únicos (RUC/nombre): ${candidatos.size}`);
  console.log(`Ya existen: ${existentesMatch} · Se fusionan por RUC/nombre repetido: ${fusionados} · A crear: ${nuevos}`);
  for (const [companyId, s] of porEmpresa) {
    console.log(`  · ${companyId}: ${s.nuevos} nuevo(s), ${s.existentes} existente(s)`);
  }
  if (MUESTRA) {
    const lista = [...candidatos.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    console.log(`\nMuestra (${Math.min(30, lista.length)} de ${lista.length}):`);
    for (const c of lista.slice(0, 30)) console.log(`  · ${c.name}${c.taxId ? ` — ${c.taxId}` : ''}`);
  }

  if (!APLICAR) {
    console.log('ℹ️ Dry-run: no se escribió nada. Usa --apply para crear los proveedores.');
    await prisma.$disconnect();
    return;
  }

  let creados = 0;
  for (const c of candidatos.values()) {
    if (!c.tieneAnexo && !c.tieneCxP && !c.esEmpresa && !c.worker) continue;
    const base = normalizarRucBase(c.taxId);
    const ya = (base && porRuc.get(`${c.companyId}|${base}`))
      || porNombre.get(`${c.companyId}|${normalizarNombreTercero(c.name)}`);
    if (ya) continue;
    try {
      const creado = await prisma.supplier.create({
        data: {
          companyId: c.companyId,
          name: c.name,
          taxId: c.taxId ? encryptField(c.taxId) : null,
          dv: c.dv || null,
          phone: c.phone ? encryptField(c.phone) : null,
          email: c.email ? encryptField(c.email) : null,
          address: c.address || null,
          location: c.location || null,
          taxIdType: c.taxIdType || null,
          taxIdHash: base ? (hashField(base) || null) : null,
          fiscalSource: c.fiscalSource || 'IMPORT',
          fiscalUpdatedAt: new Date(),
        },
      });
      creados++;
      // Evita que otra variante del mismo lote intente crearlo de nuevo.
      if (base) porRuc.set(`${c.companyId}|${base}`, creado);
      porNombre.set(`${c.companyId}|${normalizarNombreTercero(c.name)}`, creado);
    } catch (e: any) {
      if (e?.code !== 'P2002') console.error(`  ⚠️ ${c.name}: ${e?.message || e}`);
    }
  }
  console.log(`✅ Proveedores creados: ${creados}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Error en el backfill de proveedores:', err?.message || err);
  process.exit(1);
});
