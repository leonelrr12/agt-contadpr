// Descifra los campos sensibles de la BD (rollback del cifrado en reposo).
// Requiere FIELD_ENC_KEY válida (la misma con la que se cifró).
import fs from 'fs';

const envPath = '/root/apps/agt-contadpr/.env';
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

async function main() {
  const { PrismaClient } = await import('@agt-contador/prisma-schema');
  const { decryptField, encryptionEnabled } = await import('../apps/api/src/services/crypto-fields');

  if (!encryptionEnabled()) {
    console.error('❌ FIELD_ENC_KEY no está definida o es inválida — no se puede descifrar.');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  const dec = (v: unknown) => (v == null ? v : (decryptField(v) as string));

  for (const c of await prisma.company.findMany()) {
    await prisma.company.update({ where: { id: c.id }, data: { taxId: dec(c.taxId)!, email: dec(c.email) as any, phone: dec(c.phone) as any } });
  }
  for (const c of await prisma.client.findMany()) {
    await prisma.client.update({ where: { id: c.id }, data: { taxId: dec(c.taxId) as any, email: dec(c.email) as any, phone: dec(c.phone) as any } });
  }
  for (const s of await prisma.supplier.findMany()) {
    await prisma.supplier.update({ where: { id: s.id }, data: { taxId: dec(s.taxId) as any, email: dec(s.email) as any, phone: dec(s.phone) as any } });
  }
  for (const pr of await prisma.paymentRecord.findMany()) {
    await prisma.paymentRecord.update({ where: { id: pr.id }, data: { reference: dec(pr.reference) as any } });
  }
  console.log('✅ Campos descifrados. Quita FIELD_ENC_KEY del .env para volver a modo sin cifrar.');
  await prisma.$disconnect();
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
