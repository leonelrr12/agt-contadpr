// ayuda.js — la ayuda dentro de la app: un «?» en cada pantalla con los pasos.
//
// Por qué así y no un manual: el manual no se lee, se pregunta por WhatsApp. Acá el
// texto vive pegado a la pantalla donde aparece la duda, y **sumar un tema es agregar
// una entrada al diccionario** (no hay que tocar el HTML de cada panel).
//
// Dos formas de engancharlo:
//   · SPA (`index.html`): los paneles del mapa `AYUDA_POR_PANEL` reciben el botón solos,
//     en la esquina de arriba a la derecha.
//   · Páginas sueltas (`inventario.html`, `planilla.html`) y la conciliación —panel
//     del SPA y página suelta, las dos desde `js/conciliacion.js`—: llaman a
//     `ayudaEnCabecera('#selector', 'tema')` y el botón va al lado del título.
//
// Sin dependencias y sin estado: el diálogo se arma al vuelo y se cierra solo.

const AYUDA = {
  importar: {
    emoji: '📥',
    titulo: 'Importar transacciones',
    para: 'Cargar el histórico de un tirón —el archivo del banco, tu propia plantilla— sin digitar una por una.',
    pasos: [
      'Elige el modo: <strong>Transacciones</strong> es lo normal; <strong>Pagos a facturas</strong> aplica cobros a las facturas que emitiste; <strong>Carga inicial</strong> son los saldos de arranque.',
      'Arrastra el CSV o Excel y mira el <strong>preview</strong>: cada fila dice a qué cuenta va y si el sistema la leyó como cargo o como abono.',
      'Si el archivo no trae ITBMS y quieres que se lo sume, marca <strong>Calcular ITBMS</strong>; si el monto ya lo incluye, déjala sin marcar.',
      'Importa. Los asientos entran <strong>en borrador</strong> para que los revises en Revisión antes de que cuenten.',
    ],
    ojo: 'La columna <strong>Concepto</strong> manda sobre el Detalle para elegir la cuenta, y la columna <strong>Banco/Cuenta</strong> (el código tipo <code>1.1.02.01</code> o el nombre) decide de dónde sale el dinero. Volver a subir el mismo archivo <strong>no duplica nada</strong>: puedes reintentar tranquilo.',
  },
  revision: {
    emoji: '✅',
    titulo: 'Revisión del contador',
    para: 'Aprobar el trabajo del día sin abrir asiento por asiento.',
    pasos: [
      'Entra a <strong>Revisión</strong>: están los borradores con su detalle, el origen y quién los cargó.',
      '<strong>Aprobar</strong> pasa el asiento a confirmado: desde ahí cuenta en los informes, en el 430 y en el cierre.',
      '<strong>Rechazar</strong> pide una nota con el motivo; el asiento queda rechazado con esa nota a la vista.',
      'Un rechazado se puede devolver a borrador para corregirlo y volver a presentarlo.',
    ],
    ojo: 'Solo los <strong>confirmados</strong> entran en los informes y en el cierre del año. Los asientos de cierre no se revisan acá: se anulan desde el panel de administración.',
  },
  conciliacion: {
    emoji: '🏦',
    titulo: 'Conciliación bancaria',
    para: 'Cruzar el estado de cuenta contra el libro y ver qué quedó sin cuadrar.',
    pasos: [
      'Elige la cuenta bancaria y sube el extracto (CSV o Excel del banco).',
      'El sistema cruza solo por <strong>monto</strong> y <strong>fecha del mismo día</strong>.',
      'Lo que queda pendiente se resuelve a mano: vinculas la fila del banco con una o varias partidas del libro, creas el asiento que falta, o marcas la fila como ignorada.',
      'Si elegiste mal la cuenta, <strong>«Volver a conciliar»</strong> recalcula todo el extracto.',
    ],
    ojo: 'Una sola transferencia puede cubrir varias facturas: se vinculan todas a la misma fila del banco. Y si el libro tiene otra fecha que el banco, el sistema no lo adivina — corrige la fecha del asiento.',
  },
  inventario: {
    emoji: '📦',
    titulo: 'Inventario',
    para: 'Saber cuánto hay y cuánto vale, sin planillas aparte.',
    pasos: [
      'Carga los productos a mano o con la <strong>carga inicial</strong> por archivo.',
      'Registra <strong>entradas</strong> (compras), <strong>salidas</strong> (ventas o consumo) y <strong>ajustes</strong> (toma física).',
      'Mira el <strong>kardex</strong> de cada producto y la valoración al costo promedio.',
      'Cierra con el <strong>cuadre contra el mayor</strong>.',
    ],
    ojo: 'Las cantidades las manda el kardex y los montos los manda el libro. Si los dos no coinciden, el cuadre muestra la diferencia en vez de esconderla: eso es lo que hay que ir a arreglar.',
  },
  planilla: {
    emoji: '🧮',
    titulo: 'Planilla',
    para: 'Correr la nómina con el Seguro Social, el Seguro Educativo, el ISR, el décimo y las vacaciones.',
    pasos: [
      'Carga los <strong>empleados</strong> con su salario y su clase de riesgo.',
      'Revisa <strong>Parámetros</strong>: tasas de SS y SE, tabla de ISR, riesgos por clase y las cuentas contables de cada concepto.',
      'Corre la planilla —quincenal, mensual o semanal— y <strong>mira el resultado antes de confirmar</strong>.',
      'Los asientos entran en <strong>borrador</strong>: desde el detalle de la corrida los apruebas o rechazas <strong>en bloque</strong>, o desde Revisión.',
      'Registra el <strong>pago a la CSS</strong> y los pagos a acreedores (préstamos, embargos) desde el mismo módulo.',
    ],
    ojo: 'El pasivo del patrono va a <strong>tres cuentas</strong> (Seguro Social, Seguro Educativo y Riesgos Profesionales) y su gasto a la suya. Si un empleado tiene una clase de riesgo sin tarifa cargada, su fila <strong>se rechaza a propósito</strong>: mejor eso que un cálculo inventado. Y ojo con <strong>Rechazar</strong>: no toca la corrida — los asientos dejan de contar en el mayor, pero la corrida <strong>sigue en los acumulados del mes</strong> y el período sigue ocupado. Si el error es de fondo, <strong>Anular la corrida</strong>: revierte los aprobados con fecha de hoy, anula los borradores sin reverso y libera el período para rehacerla.',
  },
  email: {
    emoji: '📧',
    titulo: 'Facturas por correo',
    para: 'Que las facturas que mandan tus proveedores se carguen solas, sin que hagas nada.',
    pasos: [
      'Activa la tarjeta y elige el buzón: el <strong>de la empresa</strong> (los datos IMAP) o el <strong>buzón central</strong>, al que tus proveedores le escriben a una dirección que te damos.',
      'Si haces compras a tu nombre personal, agrega ese RUC en <strong>«Aceptar facturas a nombre de»</strong> para que no se descarten.',
      'Dejalo trabajar: el barrido corre <strong>de madrugada</strong> y cada factura entra como borrador con su archivo en «Facturas recibidas».',
      '¿No quieres esperar? <strong>«Revisar ahora»</strong> lo corre en el momento.',
    ],
    ojo: 'La tarjeta muestra el último estado y la lista de correos revisados. Si una factura no se pudo cargar, <strong>te avisa por correo y dice por qué</strong>, y el mensaje queda en la lista para reintentarlo.',
  },
  reembolsos: {
    emoji: '🧑‍🔧',
    titulo: 'Viáticos y reembolsos',
    para: 'Que el que compra en la calle no junte papelitos ni discuta a fin de mes qué gastó.',
    pasos: [
      'Crea al <strong>trabajador</strong> con su celular: no necesita usuario ni contraseña, su identidad es el número (tiene que estar vinculado a la empresa por WhatsApp).',
      'El trabajador manda la <strong>foto o el QR</strong> de la factura desde su celular, y queda registrada a su nombre.',
      'En el panel ves <strong>lo que adelantó cada uno</strong> y su saldo pendiente.',
      'Al pagarle, se genera el asiento contra el banco y <strong>se aprueban las facturas que había mandado</strong>.',
    ],
    ojo: 'El que paga es el que aprueba, a propósito: así no quedan borradores sueltos ni reembolsos sin respaldo. Si al trabajador le falta la cuenta <code>2.1.02.02 Reembolsos Empleados por Pagar</code>, la app avisa y se crea en Administración → Cuentas.',
  },
  despacho: {
    emoji: '🏢',
    titulo: 'Mis empresas (despacho)',
    para: 'Ver de un vistazo qué le falta a cada cliente, sin entrar uno por uno.',
    pasos: [
      'La tarjeta de cada empresa muestra: borradores por revisar, el buzón con problemas, por cobrar vencido, obligaciones fiscales y la cuota usada.',
      '<strong>«Entrar»</strong> cambia la empresa activa y recarga la pantalla: no hay que cerrar sesión.',
      'Abajo está el <strong>comparativo</strong>: ventas, gastos y resultado de cada empresa, del mes y del año.',
      'Desde <strong>«+ Crear empresa»</strong> das de alta un cliente nuevo copiando tu propio plan de cuentas y tus conceptos.',
    ],
    ojo: 'La cuota es de la <strong>cuenta que paga</strong>, no de cada empresa: lo que consume un cliente descuenta del cupo de todos (y el contador al lado dice cuántas empresas permite el plan). El comparativo <strong>no es un balance consolidado</strong>: es la cuenta de cada empresa puesta al lado.',
  },
  salud: {
    emoji: '🩺',
    titulo: 'Salud financiera',
    para: 'Entender cómo viene el mes sin leer un balance.',
    pasos: [
      'Elige el horizonte: 3, 6 o 12 meses.',
      'Arriba está el <strong>semáforo</strong> con los ratios: liquidez, rentabilidad, endeudamiento, eficiencia y flujo, más el score global.',
      'Abajo, las <strong>alertas</strong> (reglas fijas sobre tus números) y la explicación en palabras de qué cambió y por qué.',
    ],
    ojo: 'La narrativa la escribe la IA <strong>sobre los números de esa misma pantalla</strong>: no inventa datos que no estén ahí. Y si una empresa no tiene historial de montos, la proyección fiscal <strong>avisa</strong> en vez de estimar.',
  },
  informes: {
    emoji: '📊',
    titulo: 'Informes',
    para: 'El estado del negocio, con el detalle al lado para revisarlo.',
    pasos: [
      '<strong>Balance general</strong>: qué tienes y qué debes, a una fecha.',
      '<strong>Estado de resultados</strong>: cómo te fue en el período (ingresos menos costos y gastos).',
      '<strong>Flujo de caja</strong>: de dónde entró y a dónde salió el dinero.',
      '<strong>Balance de comprobación</strong>: débitos, créditos y saldo por cuenta, con el cuadre.',
      '<strong>Auxiliares</strong>: el movimiento de UNA cuenta o de UN cliente/proveedor, con su asiento de origen.',
    ],
    ojo: 'Si no le pones fechas, el informe usa el <strong>año fiscal activo</strong> (el del último asiento). El formato del balance general se puede cambiar a horizontal desde configuración.',
  },
  facturas: {
    emoji: '🧾',
    titulo: 'Facturas de venta',
    para: 'Emitir la factura y que el asiento salga solo.',
    pasos: [
      'Carga tus datos de emisor una vez: logo, serie autorizada, número de resolución de la DGI y su fecha.',
      'Emite la factura con sus ítems: el ITBMS se desglosa por línea y el número es correlativo por serie.',
      'Descarga el PDF: lleva tus datos, la leyenda de la resolución y el detalle de ítems.',
      'Registra los <strong>cobros</strong> —parciales o totales— y el saldo de cada factura se actualiza.',
    ],
    ojo: 'El asiento de la venta nace <strong>en borrador</strong>, como todo lo que genera movimiento. Si vendes con inventario, la salida de stock se descuenta en el mismo paso.',
  },
  taxcalendar: {
    emoji: '🗓',
    titulo: 'Calendario fiscal',
    para: 'No perder un vencimiento ni enterarte tarde.',
    pasos: [
      'El calendario arma las obligaciones del año: <strong>ITBMS el día 15</strong>, <strong>CSS el día 5</strong> e <strong>ISR el 31 de marzo</strong>.',
      'Cada obligación se marca como cumplida cuando la pagas o la declaras.',
      'Si cargas el monto, la proyección de caja de Salud lo tiene en cuenta para estimar tus salidas.',
    ],
    ojo: 'Las obligaciones sin monto valorado quedan en cero y la proyección <strong>no inventa</strong> esa cifra: si quieres que estime impuestos, carga el monto histórico.',
  },
  recurrentes: {
    emoji: '🔄',
    titulo: 'Transacciones recurrentes',
    para: 'Automatizar lo que se repite todos los meses o todas las semanas.',
    pasos: [
      'Crea la recurrente con su descripción, cuenta, monto y frecuencia.',
      'El sistema la ejecuta sola según la frecuencia y la fecha de la última corrida.',
      'Cada corrida crea un asiento en <strong>BORRADOR</strong>: se revisa y se aprueba como cualquier otro.',
      'Puedes pausarla, editarla o ejecutarla a mano con <strong>«Ejecutar ahora»</strong>.',
    ],
    ojo: 'Si el asiento no se aprueba, no entra a los informes. La recurrente no salta meses: si se pausa, se reanuda desde la fecha que corresponda.',
  },
  terceros: {
    emoji: '👥',
    titulo: 'Terceros (clientes y proveedores)',
    para: 'Tener el maestro limpio para que el Anexo DGI y los estados de cuenta salgan bien.',
    pasos: [
      'Busca por nombre, RUC, DV, teléfono, email o dirección.',
      'Crea o edita el tercero con su identidad fiscal y su contacto.',
      'Abre su <strong>estado de cuenta</strong> para ver saldo, antigüedad y movimientos.',
      'Si hay duplicados, usa <strong>Fusionar</strong>: se conserva el maestro elegido y se mueve el historial.',
    ],
    ojo: 'El DV va en su campo, separado del RUC. En cuentas con Anexo DGI, el tercero es obligatorio para que el asiento sea válido.',
  },
  auxiliares: {
    emoji: '📒',
    titulo: 'Auxiliares',
    para: 'El detalle de una cuenta, de un cliente/proveedor o de una obligación fiscal.',
    pasos: [
      '<strong>Cuenta</strong>: mayor de una cuenta con saldo corrido; toca una fila para abrir el asiento de origen.',
      '<strong>CxC / CxP</strong>: quién debe y a quién se le debe, con la factura y su saldo.',
      '<strong>Anexos-DGI</strong>: por cuenta y por tercero, con subtotales y exportación.',
      '<strong>Retenciones ITBMS</strong>: certificados recibidos, PDF/CSV y salto al Form. 430.',
    ],
    ojo: 'Los auxiliares muestran los <strong>asientos confirmados</strong>. Un borrador no aparece hasta que se aprueba en Revisión.',
  },
  admin: {
    emoji: '⚙️',
    titulo: 'Administración',
    para: 'Los datos maestros y la configuración de la empresa.',
    pasos: [
      '<strong>Cuentas y Conceptos</strong>: el catálogo contable y las reglas de clasificación.',
      '<strong>Configuración</strong>: ITBMS, banco por defecto y facturas por correo.',
      '<strong>Empresa</strong>: perfil fiscal, logo, serie DGI y emisión electrónica (PAC).',
      '<strong>Carga Inicial, Carga de Terceros y Cierres</strong>: procesos de puesta en marcha y cierre de año.',
      '<strong>Usuarios</strong>: quién entra a esta empresa y con qué rol.',
    ],
    ojo: 'Los cambios de configuración afectan a todos los asientos nuevos. La carga inicial se usa una sola vez por empresa: si ya existe, revísala antes de crear otra.',
  },
  whatsapp: {
    emoji: '📱',
    titulo: 'WhatsApp',
    para: 'Registrar transacciones mandando un mensaje, una foto o un PDF.',
    pasos: [
      'Envía <strong>HOLA</strong> al WhatsApp del bot.',
      'Recibes un código de 6 dígitos y lo ingresas en esta pantalla junto a tu número.',
      'Desde ahí, cada mensaje o documento se convierte en un asiento BORRADOR.',
    ],
    ojo: 'Solo los números vinculados pueden registrar. Si cambias de celular, vuelve a vincular el número nuevo.',
  },
};

/** Panel del SPA → tema de ayuda. Lo que no está acá no tiene botón (todavía). */
const AYUDA_POR_PANEL = {
  'panel-import-content': 'importar',
  'panel-revision-content': 'revision',
  // La tarjeta de «Facturas por correo» vive adentro de Administración, no es un panel.
  'email-facturas-card': 'email',
  'panel-reembolsos-content': 'reembolsos',
  'panel-despacho-content': 'despacho',
  'panel-salud-content': 'salud',
  'panel-informes-content': 'informes',
  'panel-facturas-content': 'facturas',
  'panel-taxcalendar-content': 'taxcalendar',
  'panel-recurring-content': 'recurrentes',
  'panel-terceros-content': 'terceros',
  'panel-auxiliares-content': 'auxiliares',
  'panel-admin-content': 'admin',
  'panel-whatsapp-content': 'whatsapp',
};

/** El CSS va desde acá para que las páginas sueltas no tengan que tocarse. */
function ayudaCSS() {
  if (document.getElementById('ayuda-css')) return;
  const s = document.createElement('style');
  s.id = 'ayuda-css';
  s.textContent = `
    .ayuda-btn {
      width: 26px; height: 26px; border-radius: 50%; border: 1px solid #d1d5db;
      background: #fff; color: #1565c0; font-weight: 800; font-size: 14px; cursor: pointer;
      line-height: 1; padding: 0; flex-shrink: 0;
    }
    .ayuda-btn:hover { background: #eff6ff; border-color: #1565c0; }
    .ayuda-flotante { position: absolute; top: 14px; right: 16px; z-index: 5; }
    .ayuda-overlay {
      position: fixed; inset: 0; background: rgba(15,23,42,0.55); z-index: 9999;
      display: flex; align-items: center; justify-content: center; padding: 20px;
    }
    .ayuda-card {
      background: #fff; border-radius: 14px; max-width: 560px; width: 100%; max-height: 85vh;
      overflow-y: auto; padding: 26px 28px; box-shadow: 0 20px 60px rgba(0,0,0,0.25);
      font-size: 14px; line-height: 1.6; color: #1e293b;
    }
    .ayuda-card h3 { font-size: 19px; margin: 0 0 4px; }
    .ayuda-card .ayuda-para { color: #6b7280; font-size: 13.5px; margin: 0 0 16px; }
    .ayuda-card ol { margin: 0 0 14px; padding-left: 20px; }
    .ayuda-card li { margin-bottom: 8px; }
    .ayuda-card .ayuda-ojo {
      background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px;
      padding: 10px 12px; font-size: 13px; color: #78350f;
    }
    .ayuda-card code { background: #f1f5f9; border-radius: 4px; padding: 1px 5px; font-size: 12.5px; }
    .ayuda-card .ayuda-pie { margin-top: 18px; text-align: right; }
    .ayuda-card .ayuda-cerrar {
      padding: 8px 18px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff;
      font-weight: 600; cursor: pointer; font-size: 13.5px;
    }
    .ayuda-card .ayuda-temas { list-style: none; padding: 0; margin: 0; }
    .ayuda-card .ayuda-temas li { border-bottom: 1px solid #f1f5f9; }
    .ayuda-card .ayuda-temas button {
      width: 100%; text-align: left; background: none; border: none; padding: 10px 2px;
      cursor: pointer; font-size: 14px; font-family: inherit; color: #1e293b;
    }
    .ayuda-card .ayuda-temas button:hover { color: #1565c0; }
    @media print { .ayuda-btn, .ayuda-overlay { display: none !important; } }
  `;
  document.head.appendChild(s);
}

function cerrarAyuda() {
  document.querySelector('.ayuda-overlay')?.remove();
}

/** El diálogo. Sin clave, muestra el índice de todos los temas (el mini manual). */
function abrirAyuda(clave) {
  ayudaCSS();
  cerrarAyuda();
  const t = clave ? AYUDA[clave] : null;

  const cuerpo = t
    ? `<h3>${t.emoji} ${t.titulo}</h3>
       <p class="ayuda-para">${t.para}</p>
       <ol>${t.pasos.map((p) => `<li>${p}</li>`).join('')}</ol>
       <div class="ayuda-ojo">💡 ${t.ojo}</div>`
    : `<h3>❓ Ayuda</h3>
       <p class="ayuda-para">Cada pantalla tiene su «?» arriba a la derecha. Estos son todos los temas:</p>
       <ul class="ayuda-temas">
         ${Object.entries(AYUDA).map(([k, v]) => `<li><button onclick="abrirAyuda('${k}')">${v.emoji} ${v.titulo}</button></li>`).join('')}
       </ul>`;

  const overlay = document.createElement('div');
  overlay.className = 'ayuda-overlay';
  overlay.innerHTML = `<div class="ayuda-card">
      <button class="close" onclick="cerrarAyuda()" style="float:right;background:none;border:none;font-size:22px;cursor:pointer;color:#6b7280;line-height:1">×</button>
      ${cuerpo}
      <div class="ayuda-pie">
        ${t ? '<button class="ayuda-cerrar" onclick="abrirAyuda()">Ver todos los temas</button>' : ''}
        <button class="ayuda-cerrar" onclick="cerrarAyuda()">Cerrar</button>
      </div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrarAyuda(); });
  document.body.appendChild(overlay);
}

/** El botón, para meterlo donde haga falta. */
function botonAyudaHTML(clave, clases = '') {
  const t = AYUDA[clave];
  const titulo = t ? `¿Cómo funciona ${t.titulo}?` : 'Ayuda';
  return `<button class="ayuda-btn ${clases}" onclick="abrirAyuda('${clave}')" title="${titulo}" aria-label="${titulo}">?</button>`;
}

/**
 * SPA: un «?» en la esquina de cada panel del mapa. Se llama solo al cargar el script,
 * que va al final del body (el DOM ya está).
 */
function pintarAyudas() {
  if (typeof document === 'undefined') return;
  ayudaCSS();
  for (const [panelId, clave] of Object.entries(AYUDA_POR_PANEL)) {
    const panel = document.getElementById(panelId);
    if (!panel || panel.querySelector('.ayuda-btn')) continue;
    // El panel no siempre es `position: relative`; el botón va absoluto adentro.
    if (window.getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
    panel.insertAdjacentHTML('afterbegin', botonAyudaHTML(clave, 'ayuda-flotante'));
  }
}

/** Páginas sueltas: el botón al lado del título, con una llamada. */
function ayudaEnCabecera(selector, clave) {
  const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
  if (!el) return;
  ayudaCSS();
  el.insertAdjacentHTML('afterend', botonAyudaHTML(clave, 'ayuda-en-linea'));
  const btn = el.nextElementSibling;
  if (btn) { btn.style.position = 'static'; btn.style.marginLeft = '8px'; btn.style.verticalAlign = 'middle'; }
}

// En el SPA los paneles ya están en el DOM cuando corre esto.
pintarAyudas();
