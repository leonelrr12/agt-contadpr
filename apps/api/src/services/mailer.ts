// Envío de correos vía MailerApi local (VPS, nodemailer+Gmail).
// Fallback: si no hay MAILER_API_KEY, simula el envío logueando el contenido (modo dev).
const MAILER_URL = process.env.MAILER_API_URL || 'http://localhost:3004';
const MAILER_KEY = process.env.MAILER_API_KEY || '';
export const APP_URL = process.env.APP_URL || 'https://contador507.com';

export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  if (!MAILER_KEY) {
    console.log(`[Mailer] Sin MAILER_API_KEY — envío simulado a ${to}: "${subject}"\n${text}`);
    return true;
  }
  try {
    const res = await fetch(`${MAILER_URL}/api/send-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MAILER_KEY}`,
      },
      body: JSON.stringify({ to, subject, text, html }),
    });
    if (!res.ok) {
      console.error('[Mailer] Error del MailerApi:', res.status);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error('[Mailer] Error de conexión:', e?.message);
    return false;
  }
}
