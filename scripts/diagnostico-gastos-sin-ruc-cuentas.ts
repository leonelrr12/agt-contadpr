/**
 * Gastos sin RUC real, agrupados por CUENTA contable — SOLO LECTURA.
 *
 * Responde si vale la pena perseguir el RUC de los gastos históricos: las
 * cuentas con `requiresAnexo` sí lo necesitan; viáticos/alimentación y demás
 * cuentas sin Anexo no. Toma las Transactions GASTO/COMPRA cuyo
 * `metadata.ruc` está vacío o es placeholder (`RUC-1001`, `N/A`…) y atribuye
 * cada una a la línea de débito de gasto/costo (5.x/6.x o con requiresAnexo;
 * si no hay, el mayor débito del asiento).
 *
 * Uso:
 *   npx tsx scripts/diagnostico-gastos-sin-ruc-cuentas.ts --company=<id>
 *   npx tsx scripts/diagnostico-gastos-sin-ruc-cuentas.ts --company=<id> --detalle
 *   npx tsx scripts/diagnostico-gastos-sin-ruc-cuentas.ts --company=<id> --solo-anexo --detalle
 *
 * Opciones: --detalle (proveedores por cuenta), --limit=N (cuentas, def. 40),
 *           --solo-anexo (solo las cuentas que exigen RUC).
 * No requiere FIELD_ENC_KEY: solo lee metadata y líneas del asiento.
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
const COMPANY = argValor('--company');
const DETALLE = argv.includes('--detalle');
const SOLO_ANEXO = argv.includes('--solo-anexo');
const LIMITE = Number(argValor('--limit') || 40);

/** `RUC-1001`, `N/A`, `CF`… no son identidad fiscal. */
function esPlaceholderRuc(raw: unknown): boolean {
  const r = String(raw ?? '').trim();
  if (!r) return false;
  if (/^RUC[-\s]?\d+$/i.test(r)) return true;
  if (/^(n\/?a|cf|consumidor final|sin ruc|s\/n|no aplica)$/i.test(r)) return true;
  if (/^SIN-RUC-/i.test(r)) return true;
  return false;
}

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

type Cuenta = {
  code: string;
  name: string;
  anexo: boolean;
  count: number;
  total: number;
  placeholder: number;
  vacio: number;
  proveedores: Map<string, { count: number; total: number }>;
};

async function main() {
  const { PrismaClient } = await import('@agt-contador/prisma-schema');
  if (!COMPANY) {
    console.error('❌ Falta --company=<id>.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const company = await prisma.company.findFirst({ where: { id: COMPANY }, select: { id: true, name: true } });
  if (!company) {
    console.error(`❌ No existe la empresa ${COMPANY}.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const txs = await prisma.transaction.findMany({
    where: { companyId: COMPANY, type: { in: ['GASTO', 'COMPRA'] } },
    select: {
      id: true, type: true, amount: true, date: true, metadata: true,
      journalEntry: {
        select: {
          lines: {
            select: {
              debit: true, credit: true,
              account: { select: { code: true, name: true, requiresAnexo: true } },
            },
          },
        },
      },
    },
    orderBy: { date: 'asc' },
  });

  const cuentas = new Map<string, Cuenta>();
  let conRucReal = 0;
  let sinRucReal = 0;
  let placeholder = 0;
  let vacio = 0;
  let montoSinRuc = 0;
  let sinAsiento = 0;

  for (const tx of txs) {
    let m: any = {};
    try { m = JSON.parse(tx.metadata || '{}'); } catch { m = {}; }
    const ruc = String(m?.ruc ?? '').trim();
    const esPlaceholder = esPlaceholderRuc(ruc);
    if (ruc && !esPlaceholder) { conRucReal++; continue; }

    sinRucReal++;
    if (esPlaceholder) placeholder++; else vacio++;
    const monto = Number(tx.amount) || 0;
    montoSinRuc = r2(montoSinRuc + monto);

    const lineas: any[] = (tx as any).journalEntry?.lines || [];
    const debitos = lineas.filter((l) => (Number(l.debit) || 0) > 0);
    const preferida = debitos
      .filter((l) => /^[56]\./.test(String(l.account?.code || '')) || l.account?.requiresAnexo)
      .sort((a, b) => (Number(b.debit) || 0) - (Number(a.debit) || 0))[0]
      || debitos.sort((a, b) => (Number(b.debit) || 0) - (Number(a.debit) || 0))[0]
      || null;
    if (!preferida) sinAsiento++;

    const acc = preferida?.account || null;
    const key = acc ? `${acc.code}|${acc.name}|${acc.requiresAnexo ? 1 : 0}` : '(sin asiento)';
    const c = cuentas.get(key) || {
      code: acc?.code || '—',
      name: acc?.name || '(sin asiento o sin débito)',
      anexo: !!acc?.requiresAnexo,
      count: 0,
      total: 0,
      placeholder: 0,
      vacio: 0,
      proveedores: new Map(),
    };
    c.count++;
    c.total = r2(c.total + monto);
    if (esPlaceholder) c.placeholder++; else c.vacio++;
    const provider = String(m?.provider || m?.nombre || '(sin nombre)').trim() || '(sin nombre)';
    const p = c.proveedores.get(provider) || { count: 0, total: 0 };
    p.count++;
    p.total = r2(p.total + monto);
    c.proveedores.set(provider, p);
    cuentas.set(key, c);
  }

  const orden = [...cuentas.values()].sort((a, b) => b.total - a.total);
  const conAnexo = orden.filter((c) => c.anexo);
  const sinAnexo = orden.filter((c) => !c.anexo && c.code !== '—');
  const sinCuenta = orden.filter((c) => c.code === '—');
  const suma = (xs: Cuenta[]) => r2(xs.reduce((s, c) => s + c.total, 0));
  const cuentaTx = (xs: Cuenta[]) => xs.reduce((s, c) => s + c.count, 0);

  console.log('\n=== Gastos sin RUC real por cuenta contable (solo lectura) ===');
  console.log(`Empresa: ${company.name} (${company.id})`);
  console.log(
    `Transactions GASTO/COMPRA: ${txs.length} · con RUC real: ${conRucReal} · `
    + `sin RUC real: ${sinRucReal} (placeholder: ${placeholder} · vacío: ${vacio}) · $${montoSinRuc.toFixed(2)}`,
  );
  console.log('');

  const fila = (c: Cuenta) => {
    const marca = c.anexo ? '[ANEXO]' : '[sin Anexo]';
    console.log(
      `  ${marca.padEnd(11)} ${`${c.code} ${c.name}`.padEnd(52).slice(0, 52)} `
      + `${String(c.count).padStart(4)} tx · $${c.total.toFixed(2).padStart(12)}`
      + ` · placeholder ${String(c.placeholder).padStart(3)} · vacío ${String(c.vacio).padStart(3)}`,
    );
    if (DETALLE) {
      const ps = [...c.proveedores.entries()].sort((a, b) => b[1].total - a[1].total);
      for (const [nombre, x] of ps) {
        console.log(`      · ${nombre} — ${x.count} tx · $${x.total.toFixed(2)}`);
      }
    }
  };

  console.log('Cuentas con Anexo (el RUC es obligatorio):');
  if (!conAnexo.length) console.log('  (ninguna)');
  for (const c of conAnexo.slice(0, LIMITE)) fila(c);
  if (conAnexo.length > LIMITE) console.log(`  … ${conAnexo.length - LIMITE} cuenta(s) más.`);

  if (!SOLO_ANEXO) {
    console.log('\nCuentas sin Anexo (no hace falta RUC):');
    if (!sinAnexo.length) console.log('  (ninguna)');
    for (const c of sinAnexo.slice(0, LIMITE)) fila(c);
    if (sinAnexo.length > LIMITE) console.log(`  … ${sinAnexo.length - LIMITE} cuenta(s) más.`);

    if (sinCuenta.length) {
      console.log('\nSin asiento/línea de débito:');
      for (const c of sinCuenta) fila(c);
    }
  }

  console.log('\nResumen:');
  console.log(`  Con Anexo:  ${String(cuentaTx(conAnexo)).padStart(5)} tx · $${suma(conAnexo).toFixed(2)}  → RUC obligatorio`);
  console.log(`  Sin Anexo:  ${String(cuentaTx(sinAnexo)).padStart(5)} tx · $${suma(sinAnexo).toFixed(2)}  → RUC no necesario`);
  if (sinCuenta.length) {
    console.log(`  Sin asiento: ${String(cuentaTx(sinCuenta)).padStart(4)} tx · $${suma(sinCuenta).toFixed(2)}`);
  }
  console.log(`\nℹ️ Solo lectura: no se escribió nada.${sinAsiento ? ` (${sinAsiento} tx sin línea de débito)` : ''}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Error en el diagnóstico:', err?.message || err);
  process.exit(1);
});
