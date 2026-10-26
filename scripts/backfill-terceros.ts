/**
 * Backfill de identidad de terceros (Fase 1): separa el DV del RUC y
 * recomputa `taxIdHash` sobre el RUC BASE canónico.
 *
 * DRY-RUN por defecto: no escribe nada, solo reporta. Con `--apply` actualiza
 * Client/Supplier/Company. Requiere la migración 0049 aplicada (para `dv` de
 * Supplier) y `FIELD_ENC_KEY` (el `taxId` está cifrado; sin la clave no se
 * puede leer ni re-hashear).
 *
 * Uso:
 *   npx tsx scripts/backfill-terceros.ts            # reporte
 *   npx tsx scripts/backfill-terceros.ts --apply    # escribe
 *
 * NO fusiona duplicados: los detecta y los salta. El merge es la Fase 4.
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

async function main() {
  const { PrismaClient } = await import('@agt-contador/prisma-schema');
  const { encryptField, decryptField, encryptionEnabled } = await import('../apps/api/src/services/crypto-fields');
  const { separarRucDv, normalizarRucBase, normalizarNombreTercero, hashField } = await import('@agt-contador/shared');

  if (!encryptionEnabled()) {
    console.error('❌ FIELD_ENC_KEY no está definida o no es base64 de 32 bytes: no se puede leer ni recalcular el RUC.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const tieneColumna = async (tabla: string, columna: string): Promise<boolean> => {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      tabla,
      columna,
    );
    return rows.length > 0;
  };
  const supplierDv = await tieneColumna('supplier', 'dv');
  if (!supplierDv && APLICAR) {
    console.error('❌ La migración 0049 no está aplicada (falta supplier.dv). Aplícala antes de --apply.');
    await prisma.$disconnect();
    process.exit(1);
  }

  const dec = (v: unknown) => (v == null ? '' : String(decryptField(v) ?? '').trim());

  const [companies, clients, suppliers] = await Promise.all([
    prisma.company.findMany({ select: { id: true, name: true, taxId: true, dv: true, taxIdHash: true } }),
    prisma.client.findMany({ select: { id: true, companyId: true, name: true, taxId: true, dv: true, taxIdHash: true } }),
    prisma.supplier.findMany({
      select: { id: true, companyId: true, name: true, taxId: true, taxIdHash: true, ...(supplierDv ? { dv: true } : {}) },
    }),
  ]);

  type Fila = { id: string; companyId: string; name: string; taxId: string; dv: string | null; taxIdHash: string | null; modelo: 'client' | 'supplier' | 'company' };
  const filas: Fila[] = [
    ...clients.map((r) => ({ ...r, taxId: dec(r.taxId), dv: r.dv || null, modelo: 'client' as const })),
    ...suppliers.map((r) => ({ ...r, taxId: dec(r.taxId), dv: (r as any).dv || null, modelo: 'supplier' as const })),
    ...companies.map((r) => ({ ...r, taxId: dec(r.taxId), dv: r.dv || null, modelo: 'company' as const })),
  ];

  const porModelo = new Map<string, Fila[]>();
  for (const f of filas) {
    const key = `${f.modelo}:${f.companyId}`;
    porModelo.set(key, [...(porModelo.get(key) || []), f]);
  }

  let actualizables = 0;
  let conDvPegado = 0;
  let sinClaveHash = 0;
  const conflictos: string[] = [];

  for (const grupo of porModelo.values()) {
    // Duplicados por RUC base canónico: si el hash canónico choca, no se toca
    // ninguno; se resuelve en el merge de la Fase 4.
    const porBase = new Map<string, Fila[]>();
    for (const f of grupo) {
      if (!f.taxId) continue;
      const base = normalizarRucBase(f.taxId);
      if (!base) continue;
      porBase.set(base, [...(porBase.get(base) || []), f]);
    }
    const basesDuplicadas = new Set([...porBase.entries()].filter(([, v]) => v.length > 1).map(([b]) => b));

    for (const f of grupo) {
      if (!f.taxId) continue;
      const partes = separarRucDv(f.taxId);
      const base = normalizarRucBase(f.taxId);
      if (!base) continue;
      const dv = f.dv || partes.dv;
      const hash = hashField(base);
      if (!hash) { sinClaveHash++; continue; }
      if (partes.dv) conDvPegado++;
      const cambiaTaxId = partes.base !== f.taxId;
      const cambiaDv = !!dv && f.dv !== dv;
      const cambiaHash = f.taxIdHash !== hash;
      if (!cambiaTaxId && !cambiaDv && !cambiaHash) continue;
      if (basesDuplicadas.has(base)) {
        conflictos.push(`${f.modelo} ${f.id} (${f.name}) — RUC base ${base} duplicado`);
        continue;
      }
      actualizables++;
      if (APLICAR) {
        const data: any = {};
        if (cambiaTaxId) data.taxId = encryptField(partes.base);
        if (cambiaDv && (f.modelo !== 'supplier' || supplierDv)) data.dv = dv;
        if (cambiaHash) data.taxIdHash = hash;
        const modelo = f.modelo === 'client' ? prisma.client : f.modelo === 'supplier' ? prisma.supplier : prisma.company;
        await (modelo as any).update({ where: { id: f.id }, data });
      }
    }
  }

  // Duplicados por nombre normalizado (informativo; no bloquea el backfill de RUC).
  const nombres = new Map<string, Fila[]>();
  for (const f of filas) {
    const key = `${f.modelo}:${f.companyId}:${normalizarNombreTercero(f.name)}`;
    if (!normalizarNombreTercero(f.name)) continue;
    nombres.set(key, [...(nombres.get(key) || []), f]);
  }
  const gruposNombre = [...nombres.values()].filter((g) => g.length > 1);

  console.log(`\n=== Backfill de terceros ${APLICAR ? '(APLICANDO)' : '(dry-run)'} ===`);
  console.log(`Registros: ${filas.length} (clientes ${clients.length}, proveedores ${suppliers.length}, empresas ${companies.length})`);
  console.log(`RUC con DV pegado: ${conDvPegado}`);
  console.log(`Actualizables (taxId/dv/hash): ${actualizables}`);
  console.log(`Omitidos por RUC base duplicado: ${conflictos.length}`);
  if (sinClaveHash) console.log(`⚠️ Sin FIELD_ENC_KEY: ${sinClaveHash} registro(s) con RUC no se pueden re-hashear`);
  if (conflictos.length) {
    console.log('Conflictos (no se tocaron):');
    for (const c of conflictos.slice(0, 50)) console.log(`  · ${c}`);
    if (conflictos.length > 50) console.log(`  … y ${conflictos.length - 50} más`);
  }
  console.log(`Grupos de nombre normalizado duplicado: ${gruposNombre.length} (se resuelven en la Fase 4)`);
  console.log(APLICAR ? '✅ Backfill aplicado.' : 'ℹ️ Dry-run: no se escribió nada. Usa --apply para aplicar.');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Error en el backfill:', err?.message || err);
  process.exit(1);
});
