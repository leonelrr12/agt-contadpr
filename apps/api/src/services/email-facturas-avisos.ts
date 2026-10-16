/**
 * Los avisos por correo del buzón de facturas.
 *
 * El barrido ya deja todo anotado —el ledger de la tarjeta, `ultimoEstado`, el
 * log `[EmailFacturas]`— pero eso hay que ir a mirarlo, y una factura que no se
 * cargó no se nota hasta que alguien la busca. Este aviso es para eso: **una sola
 * vez por corrida**, y solo cuando hay algo que una persona puede arreglar.
 *
 * Qué NO avisa, a propósito: `SIN_ADJUNTOS` y `SIN_FACTURA` (un boletín o una
 * alerta del banco son el caso normal de cualquier buzón) y `DUPLICADA` (que la
 * misma factura llegue dos veces es información, no un problema). Lo que avisa
 * son los estados donde alguien tiene que hacer algo: el buzón que no se pudo
 * leer, la factura de otro cliente, la que quedó sin cuenta de contrapartida o
 * sin concepto, y el error.
 *
 * Va a los usuarios **admin y superadmin activos** de la empresa: son los que
 * pueden tocar la configuración del buzón y las cuentas, que es lo que el aviso
 * pide hacer. Nunca lanza: un aviso que no sale no puede tumbar el barrido que
 * acaba de terminar bien.
 */

import { sendEmail, APP_URL } from './mailer';

/**
 * Estados que ameritan que alguien mire: los mismos que «Reprocesar» puede
 * reintentar (`ESTADOS_REPROCESABLES` en `email-inbox.ts`), o sea los que se
 * arreglan con una acción y por eso justifican un correo.
 *
 * Se escriben acá en vez de importarlos para no armar un ciclo (`email-inbox`
 * importa este módulo para avisar). Un test compara las dos listas: si alguien
 * agrega un estado reprocesable y se olvida de avisar, el test lo dice.
 */
export const ESTADOS_QUE_AVISAN = ['INTERRUMPIDO', 'ERROR', 'SIN_CUENTA', 'SIN_CONCEPTO', 'SIN_DATOS', 'OTRO_CLIENTE'];

export interface ProblemaFactura {
  proveedor?: string | null;
  numeroFactura?: string | null;
  via?: string | null;
  estado: string;
  detalle?: string | null;
}

export interface AvisoBarrido {
  problemas: ProblemaFactura[];
  /** El barrido entero falló (credenciales, conexión, cuota): `codigo` + `detalle`. */
  fallo?: { codigo?: string; detalle?: string | null; revisados?: number } | null;
}

/** ¿Hay algo que avisar? (lo que decide si se manda correo o no) */
export function mereceAviso(aviso: AvisoBarrido): boolean {
  if (aviso.fallo) return true;
  return aviso.problemas.some((p) => ESTADOS_QUE_AVISAN.includes(p.estado));
}

/** Cuántos avisos ya se mandaron hoy por empresa (para no repetir en cada pasada). */
const avisadosHoy = new Map<string, string>();

/**
 * Arma el asunto y el cuerpo. Devuelve texto plano y HTML: el cliente de correo
 * que sea muestra algo legible, y el texto sirve para reenviarlo o buscarlo.
 */
export function componerAviso(
  empresa: string,
  aviso: AvisoBarrido,
): { subject: string; text: string; html: string } {
  const problemas = aviso.problemas.filter((p) => ESTADOS_QUE_AVISAN.includes(p.estado));
  const cuenta = problemas.length;

  const subject = aviso.fallo
    ? `[Contador507] El buzón de facturas de ${empresa} no se pudo leer`
    : `[Contador507] ${cuenta} factura${cuenta === 1 ? '' : 's'} de ${empresa} sin cargar`;

  const lineas: string[] = [];
  if (aviso.fallo) {
    lineas.push(
      `El buzón de facturas por correo de ${empresa} no se pudo revisar${aviso.fallo.codigo ? ` (${aviso.fallo.codigo})` : ''}.`,
      '',
      aviso.fallo.detalle || 'Sin detalle.',
      '',
      'Mientras esto siga así no se está cargando ninguna factura nueva de ese buzón.',
    );
  } else {
    lineas.push(`${cuenta === 1 ? 'Una factura' : `${cuenta} facturas`} del buzón de ${empresa} no se pudieron cargar:`);
    for (const p of problemas) {
      const quien = p.proveedor || 'Sin proveedor';
      const numero = p.numeroFactura ? ` Nº ${p.numeroFactura}` : '';
      lineas.push(`  · ${quien}${numero} — ${p.estado}${p.detalle ? `: ${p.detalle}` : ''}`);
    }
  }

  lineas.push(
    '',
    'Qué hacer: entrá a Administración → Configuración → «Facturas por correo», corregí lo que falte',
    '(la cuenta de contrapartida, el RUC aceptado, las credenciales) y dale «↻ Reprocesar» al correo',
    'en la lista de «Últimos correos revisados».',
    '',
    APP_URL,
    '',
    '— Contador507',
  );

  const text = lineas.join('\n');
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;color:#1a1a2e;line-height:1.5">
  <p>${aviso.fallo ? `El buzón de facturas por correo de <strong>${esc(empresa)}</strong> no se pudo revisar.` : `${cuenta === 1 ? 'Una factura' : `<strong>${cuenta}</strong> facturas`} del buzón de <strong>${esc(empresa)}</strong> no se pudieron cargar:`}</p>
  ${aviso.fallo
    ? `<p style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 12px;color:#991b1b">${esc(aviso.fallo.detalle || 'Sin detalle.')}</p>
       <p>Mientras esto siga así no se está cargando ninguna factura nueva de ese buzón.</p>`
    : `<ul style="padding-left:18px">${problemas
        .map((p) => `<li><strong>${esc(p.proveedor || 'Sin proveedor')}</strong>${p.numeroFactura ? ` Nº ${esc(p.numeroFactura)}` : ''} — ${esc(p.estado)}${p.detalle ? `: ${esc(p.detalle)}` : ''}</li>`)
        .join('')}</ul>`}
  <p>Entrá a <strong>Administración → Configuración → «Facturas por correo»</strong>, corregí lo que falte
  (la cuenta de contrapartida, el RUC aceptado, las credenciales) y dale <strong>«↻ Reprocesar»</strong> al
  correo en la lista de «Últimos correos revisados».</p>
  <p><a href="${esc(APP_URL)}" style="color:#1565c0">${esc(APP_URL)}</a></p>
  <p style="color:#6b7280;font-size:12px">— Contador507</p>
</div>`;

  return { subject, text, html };
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/**
 * Manda el aviso, si corresponde. Devuelve si salió algo (para el log).
 *
 * Deja de insistir con el mismo problema el mismo día: si el buzón lleva todo el
 * día caído, el dueño recibe un correo, no uno cada media hora. Al día siguiente
 * vuelve a avisar (si sigue roto, sigue siendo noticia).
 */
export async function avisarProblemas(prisma: any, companyId: string, aviso: AvisoBarrido): Promise<boolean> {
  try {
    if (process.env.EMAIL_FACTURAS_AVISOS === 'false') return false;
    if (!mereceAviso(aviso)) return false;

    const empresa = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } });
    const nombre = empresa?.name || companyId;

    // La huella del aviso: mismo día + mismos problemas = ya se avisó.
    const hoy = new Date().toISOString().slice(0, 10);
    const huella = `${hoy}|${aviso.fallo?.codigo || ''}|${aviso.problemas.map((p) => p.estado + (p.numeroFactura || '')).join(',')}`;
    if (avisadosHoy.get(companyId) === huella) return false;

    const destinatarios = await prisma.user.findMany({
      where: { companyId, isActive: true, role: { in: ['admin', 'superadmin'] } },
      select: { email: true },
    });
    if (!destinatarios.length) {
      console.warn(`[EmailFacturas] Aviso para ${companyId}: la empresa no tiene admin activo con correo.`);
      return false;
    }

    const { subject, text, html } = componerAviso(nombre, aviso);
    let enviados = 0;
    for (const u of destinatarios) {
      if (u.email && (await sendEmail(u.email, subject, text, html))) enviados++;
    }
    if (enviados) {
      avisadosHoy.set(companyId, huella);
      console.log(`[EmailFacturas] Aviso enviado a ${enviados} destinatario(s) de ${companyId}: ${subject}`);
    }
    return enviados > 0;
  } catch (err: any) {
    console.error('[EmailFacturas] No se pudo mandar el aviso:', err?.message);
    return false;
  }
}
