/**
 * diagnóstico de terceros — SOLO LECTURA.
 *
 * Responde, antes de tocar el esquema: ¿cuántos clientes/proveedores hay,
 * cuántos tienen cada dato fiscal, cuántos RUC traen el DV pegado y cuántos
 * duplicados existen por RUC canónico o por nombre? No imprime nombres por
 * defecto (solo agregados); con --detalle lista los grupos duplicados.
 *
 * Uso: npx tsx scripts/diagnostico-terceros.ts [--detalle]
 *
 * No escribe nada en la base. La autorización de producción es solo para esta
 * lectura; la migración y el backfill se autorizan aparte.
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

const DETALLE = process.argv.includes('--detalle');
const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 100)}%` : '—');

async function main() {
  const { PrismaClient } = await import('@agt-contador/prisma-schema');
  const { decryptField } = await import('../apps/api/src/services/crypto-fields');
  const { separarRucDv, normalizarRucBase, normalizarNombreTercero } = await import('@agt-contador/shared');

  const prisma = new PrismaClient();
  const dec = (v: unknown) => (v == null ? '' : String(decryptField(v) ?? '').trim());

  const [companies, clients, suppliers] = await Promise.all([
    prisma.company.findMany({ select: { id: true, name: true } }),
    prisma.client.findMany({
      select: {
        id: true, companyId: true, name: true, taxId: true, dv: true, phone: true, email: true,
        address: true, location: true, _count: { select: { invoices: true } },
      },
    }),
    prisma.supplier.findMany({
      select: {
        id: true, companyId: true, name: true, taxId: true, phone: true, email: true,
        _count: { select: { bills: true } },
      },
    }),
  ]);

  console.log(`\n=== Diagnóstico de terceros (solo lectura) ===`);
  console.log(`Empresas: ${companies.length} · Clientes: ${clients.length} · Proveedores: ${suppliers.length}\n`);

  for (const company of companies) {
    const cs = clients.filter((c) => c.companyId === company.id);
    const ss = suppliers.filter((s) => s.companyId === company.id);
    if (!cs.length && !ss.length) continue;

    const cRuc = cs.map((c) => {
      const taxId = dec(c.taxId);
      const partes = separarRucDv(taxId);
      return { ...c, taxId, base: normalizarRucBase(taxId), dvEfectivo: (c.dv || partes.dv || '').trim() };
    });
    const sRuc = ss.map((s) => {
      const taxId = dec(s.taxId);
      const partes = separarRucDv(taxId);
      return { ...s, taxId, base: normalizarRucBase(taxId), dvEfectivo: partes.dv || '' };
    });

    const conDvPegado = [...cRuc, ...sRuc].filter((r) => r.taxId && separarRucDv(r.taxId).dv).length;
    const dupRuc = new Map<string, string[]>();
    for (const r of [...cRuc, ...sRuc]) {
      if (!r.base) continue;
      const key = `${r.companyId}|${r.base}`;
      dupRuc.set(key, [...(dupRuc.get(key) || []), r.id]);
    }
    const dupNombre = new Map<string, string[]>();
    for (const r of [...cRuc, ...sRuc]) {
      const key = `${r.companyId}|${normalizarNombreTercero(r.name)}`;
      if (!normalizarNombreTercero(r.name)) continue;
      dupNombre.set(key, [...(dupNombre.get(key) || []), r.id]);
    }
    const gruposRuc = [...dupRuc.values()].filter((ids) => ids.length > 1);
    const gruposNombre = [...dupNombre.values()].filter((ids) => ids.length > 1);
    const clientesConFacturas = cRuc.filter((c) => c._count.invoices > 0);
    const clientesSinPerfil = clientesConFacturas.filter(
      (c) => !c.taxId || !c.dvEfectivo || !c.address || !c.location,
    );
    const proveedoresConBills = sRuc.filter((s) => s._count.bills > 0);
    const proveedoresSinContacto = proveedoresConBills.filter((s) => !dec(s.phone) && !dec(s.email));

    console.log(`— ${company.name} (${company.id})`);
    console.log(`  Clientes: ${cs.length} · RUC ${pct(cRuc.filter((c) => c.taxId).length, cs.length)} · DV ${pct(cRuc.filter((c) => c.dvEfectivo).length, cs.length)} · Tel ${pct(cRuc.filter((c) => dec(c.phone)).length, cs.length)} · Email ${pct(cRuc.filter((c) => dec(c.email)).length, cs.length)} · Dirección ${pct(cRuc.filter((c) => c.address).length, cs.length)} · Ubicación ${pct(cRuc.filter((c) => c.location).length, cs.length)}`);
    console.log(`  Proveedores: ${ss.length} · RUC ${pct(sRuc.filter((s) => s.taxId).length, ss.length)} · Tel ${pct(sRuc.filter((s) => dec(s.phone)).length, ss.length)} · Email ${pct(sRuc.filter((s) => dec(s.email)).length, ss.length)} · Dirección: campo no existe todavía`);
    console.log(`  RUC con DV pegado (se separará): ${conDvPegado}`);
    console.log(`  Duplicados por RUC canónico: ${gruposRuc.length} grupo(s) / ${gruposRuc.reduce((a, g) => a + g.length, 0)} registro(s)`);
    console.log(`  Duplicados por nombre normalizado: ${gruposNombre.length} grupo(s) / ${gruposNombre.reduce((a, g) => a + g.length, 0)} registro(s)`);
    console.log(`  Clientes con facturas sin perfil fiscal completo: ${clientesSinPerfil.length} de ${clientesConFacturas.length}`);
    console.log(`  Proveedores con facturas sin teléfono ni email: ${proveedoresSinContacto.length} de ${proveedoresConBills.length}`);

    if (DETALLE) {
      for (const ids of gruposRuc) console.log(`    RUC duplicado (${ids.length}): ${ids.join(', ')}`);
      for (const ids of gruposNombre) console.log(`    Nombre duplicado (${ids.length}): ${ids.join(', ')}`);
    }
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Error en el diagnóstico:', err?.message || err);
  process.exit(1);
});
