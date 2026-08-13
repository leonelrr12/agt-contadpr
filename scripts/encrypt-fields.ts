// Cifra los campos sensibles existentes en la BD (idempotente).
// Usa FIELD_ENC_KEY de /root/apps/agt-contadpr/.env.
// Orden de ejecución:
//   1. Backfill de taxIdHash: npx tsx scripts/encrypt-fields.ts --hashes-only
//   2. Cifrado de datos:     npx tsx scripts/encrypt-fields.ts
// Rollback: npx tsx scripts/decrypt-fields.ts
import fs from 'fs';
import path from 'path';

// Cargar .env raíz manualmente (sin dotenv para no depender de cwd)
const envPath = '/root/apps/agt-contadpr/.env';
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

async function main() {
  // Importar después de setear el env (crypto-fields lee FIELD_ENC_KEY al cargar)
  const { PrismaClient } = await import('@agt-contador/prisma-schema');
  const { encryptField, hashField, isEncrypted, encryptionEnabled } = await import('../apps/api/src/services/crypto-fields');

  if (!encryptionEnabled()) {
    console.error('❌ FIELD_ENC_KEY no está definida en .env o no es base64 de 32 bytes.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const hashesOnly = process.argv.includes('--hashes-only');

  // 1. Backfill taxIdHash de empresas (desde taxId en claro o ya cifrado — nunca se puede
  //    derivar el hash desde ciphertext, por eso DEBE correr antes de cifrar taxId)
  const companies = await prisma.company.findMany({ select: { id: true, taxId: true, taxIdHash: true } });
  for (const c of companies) {
    if (c.taxIdHash || !c.taxId) continue;
    if (isEncrypted(c.taxId)) {
      console.warn(`⚠️ Company ${c.id} ya tiene taxId cifrado sin hash — omitida (no derivable)`);
      continue;
    }
    await prisma.company.update({ where: { id: c.id }, data: { taxIdHash: hashField(c.taxId) } });
    console.log(`hash: Company ${c.id} (${c.taxId.slice(0, 8)}...)`);
  }
  if (hashesOnly) { console.log('✅ Hashes listos.'); return; }

  // 2. Cifrar datos existentes (idempotente por prefijo v1:)
  const enc = (v: string | null | undefined) => (v && !isEncrypted(v) ? encryptField(v) : v);

  for (const c of await prisma.company.findMany()) {
    await prisma.company.update({
      where: { id: c.id },
      data: { taxId: enc(c.taxId)!, email: enc(c.email), phone: enc(c.phone) },
    });
  }
  console.log('✅ Company cifradas.');

  for (const c of await prisma.client.findMany()) {
    await prisma.client.update({
      where: { id: c.id },
      data: { taxId: enc(c.taxId), email: enc(c.email), phone: enc(c.phone) },
    });
  }
  console.log('✅ Clients cifrados.');

  for (const s of await prisma.supplier.findMany()) {
    await prisma.supplier.update({
      where: { id: s.id },
      data: { taxId: enc(s.taxId), email: enc(s.email), phone: enc(s.phone) },
    });
  }
  console.log('✅ Suppliers cifrados.');

  for (const pr of await prisma.paymentRecord.findMany()) {
    await prisma.paymentRecord.update({
      where: { id: pr.id },
      data: { reference: enc(pr.reference) },
    });
  }
  console.log('✅ PaymentRecords cifrados.');

  console.log('🎉 Cifrado completado. Reinicia la API para activar el modo cifrado (si no estaba activo).');
  await prisma.$disconnect();
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
