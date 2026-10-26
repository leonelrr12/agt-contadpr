/**
 * Importación masiva de terceros desde CSV/XLSX.
 *
 * El parser es deliberadamente tolerante con encabezados (tildes, mayúsculas y
 * el typo `TIPO INDENTIFICACION` del formato original) y estricto con los datos
 * fiscales: RUC/DV, ubicación y email se validan antes de escribir. El plan
 * separa lo que se crea, completa o actualiza de los conflictos, para que la
 * pantalla muestre exactamente qué va a pasar antes de tocar la BD.
 *
 * Mapeo del archivo:
 *   RAZÓN SOCIAL -> name (nombre legal; clave de dedupe y facturas)
 *   NOMBRE       -> tradeName (nombre comercial; si no hay razón social, pasa a name)
 *   RUC          -> taxId base (sin DV)
 *   DV           -> dv
 *   TIPO IDENTIFICACION -> taxIdType
 *   UBICACIÓN    -> location (PP-DD-CC)
 *
 * Modos:
 *   completar  (default): crea lo que falta y completa campos vacíos; no pisa.
 *   actualizar: sobrescribe con los valores NO VACÍOS del archivo; una celda
 *               vacía nunca borra un dato existente.
 */
import { leerTabla } from './tabular-utils';
import ExcelJS from 'exceljs';
import { normalizarNombreTercero, normalizarRucBase, separarRucDv } from '@agt-contador/shared';

export type TipoTercero = 'Cliente' | 'Proveedor';
export type ModoImport = 'completar' | 'actualizar';
export type EstadoFila = 'nuevo' | 'actualiza' | 'sin_cambios' | 'conflicto' | 'error' | 'repetida' | 'aplicado';

export interface FilaTercero {
  fila: number;
  tipo?: TipoTercero;
  name?: string;
  tradeName?: string | null;
  taxId?: string | null;
  dv?: string | null;
  taxIdType?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  location?: string | null;
  notes?: string | null;
  paymentTerms?: string | null;
  error?: string;
}

export interface FilaPlan {
  fila: number;
  tipo: TipoTercero;
  name: string;
  taxId: string | null;
  dv: string | null;
  estado: EstadoFila;
  detalle: string;
  cambios: string[];
  data?: Record<string, any>;
  existingId?: string;
}

export interface ResumenImport {
  total: number;
  nuevo: number;
  actualiza: number;
  sin_cambios: number;
  conflicto: number;
  error: number;
  repetida: number;
  aplicado: number;
}

const norm = (s: unknown) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Palabras significativas del nombre, para detectar posibles duplicados. */
function tokensNombre(nombre: string): string[] {
  return normalizarNombreTercero(nombre)
    .split(' ')
    .filter((t) => t.length >= 2 && !['de', 'del', 'la', 'el', 'los', 'las', 'y', 's'].includes(t));
}

const ALIAS = {
  tipo: ['tipo', 'clasificacion', 'clase'],
  razon: ['razon social', 'razon'],
  nombre: ['nombre comercial', 'nombre'],
  ruc: ['ruc', 'cedula', 'ruc/cedula', 'identificacion', 'tax id', 'documento'],
  dv: ['dv', 'digito verificador', 'd v'],
  tipoId: ['tipo identificacion', 'tipo indentificacion', 'tipo de identificacion', 'tipo documento'],
  telefono: ['telefono', 'tel', 'celular', 'phone'],
  email: ['email', 'correo', 'correo electronico'],
  direccion: ['direccion', 'address'],
  ubicacion: ['ubicacion', 'ubicacion dgi', 'location'],
  notas: ['notas', 'notes', 'observaciones'],
  plazo: ['plazo de pago', 'plazo', 'payment terms', 'dias credito', 'dias de credito'],
};

function indice(headers: string[], alias: string[]): number {
  const normalizados = headers.map(norm);
  for (const a of alias) {
    const i = normalizados.indexOf(a);
    if (i >= 0) return i;
  }
  return -1;
}

function tipoIdentificacion(raw: string): { value: string | null; error?: string } {
  const n = norm(raw);
  if (!n) return { value: null };
  if (n === 'ruc') return { value: 'RUC' };
  if (n.startsWith('ced') || n === 'ci') return { value: 'CEDULA' };
  if (n.startsWith('pas')) return { value: 'PASAPORTE' };
  return { value: null, error: `Tipo de identificación no válido: "${raw}"` };
}

/** Valida el identificador sin inventar el DV ni aceptar placeholders de Excel. */
function validarTaxId(raw: string, tipoId: string | null): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^(ruc[-\s]?\d+|n\/?a|cf|consumidor final)$/i.test(v)) {
    throw new Error(`Identificación inválida: "${v}" (parece un placeholder, no un RUC/cédula)`);
  }
  if (tipoId === 'PASAPORTE') {
    if (!/^[A-Za-z0-9-]{4,30}$/.test(v)) throw new Error(`Pasaporte inválido: "${v}"`);
    return v;
  }
  if (!/^[\d\s./-]+$/.test(v)) {
    throw new Error(`RUC/Cédula inválido: "${v}". Si es pasaporte, indica TIPO IDENTIFICACION=PASAPORTE.`);
  }
  if (v.replace(/\D/g, '').length < 5) throw new Error(`RUC/Cédula demasiado corto: "${v}"`);
  return v;
}

/** Lee el archivo y devuelve filas normalizadas (sin tocar la BD). */
export async function parseTercerosFile(buffer: Buffer, fileName: string): Promise<FilaTercero[]> {
  const { headers, rawRows } = await leerTabla(buffer, fileName);
  const ix = {
    tipo: indice(headers, ALIAS.tipo),
    razon: indice(headers, ALIAS.razon),
    nombre: indice(headers, ALIAS.nombre),
    ruc: indice(headers, ALIAS.ruc),
    dv: indice(headers, ALIAS.dv),
    tipoId: indice(headers, ALIAS.tipoId),
    telefono: indice(headers, ALIAS.telefono),
    email: indice(headers, ALIAS.email),
    direccion: indice(headers, ALIAS.direccion),
    ubicacion: indice(headers, ALIAS.ubicacion),
    notas: indice(headers, ALIAS.notas),
    plazo: indice(headers, ALIAS.plazo),
  };
  if (ix.tipo < 0) throw new Error('Falta la columna TIPO (Cliente/Proveedor).');
  if (ix.razon < 0 && ix.nombre < 0) throw new Error('Falta la columna NOMBRE o RAZON SOCIAL.');
  if (rawRows.length > 2000) throw new Error('El archivo supera las 2,000 filas. Divídelo en partes.');

  const cell = (row: string[], i: number) => (i >= 0 ? String(row[i] ?? '').trim() : '');

  const filasUtiles = rawRows.filter((row) => row.some((v) => String(v ?? '').trim() !== ''));

  return filasUtiles.map((row, idx) => {
    const fila = idx + 2; // la fila 1 es el encabezado
    const out: FilaTercero = { fila };
    try {
      const t = norm(cell(row, ix.tipo));
      if (t.startsWith('client') || t === 'c') out.tipo = 'Cliente';
      else if (t.startsWith('prove') || t === 'p') out.tipo = 'Proveedor';
      else throw new Error(`TIPO inválido: "${cell(row, ix.tipo)}" (usa Cliente o Proveedor)`);

      const razon = cell(row, ix.razon);
      const nombre = cell(row, ix.nombre);
      out.name = razon || nombre;
      out.tradeName = razon && nombre && normalizarNombreTercero(nombre) !== normalizarNombreTercero(razon)
        ? nombre
        : null;
      if (!out.name) throw new Error('Falta el nombre (RAZON SOCIAL o NOMBRE).');

      const tid = tipoIdentificacion(cell(row, ix.tipoId));
      if (tid.error) throw new Error(tid.error);
      out.taxIdType = tid.value;

      const identificacion = validarTaxId(cell(row, ix.ruc), out.taxIdType);
      if (identificacion) {
        const partes = separarRucDv(identificacion);
        const dvCol = cell(row, ix.dv).replace(/[^\d]/g, '');
        if (dvCol && dvCol.length > 2) throw new Error(`DV inválido: "${cell(row, ix.dv)}"`);
        if (partes.dv && dvCol && partes.dv !== dvCol) {
          throw new Error(`El DV del RUC (${partes.dv}) no coincide con la columna DV (${dvCol}).`);
        }
        out.taxId = partes.base;
        out.dv = dvCol || partes.dv || null;
      } else if (cell(row, ix.dv)) {
        throw new Error('Hay DV pero falta RUC/Cédula.');
      }

      out.phone = cell(row, ix.telefono) || null;
      const email = cell(row, ix.email);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Email inválido: "${email}"`);
      out.email = email || null;
      out.address = cell(row, ix.direccion) || null;

      const location = cell(row, ix.ubicacion);
      if (location && !/^\d{1,2}-\d{1,2}-\d{1,2}$/.test(location)) {
        throw new Error(`Ubicación inválida: "${location}" (formato PP-DD-CC, ej. 8-8-8).`);
      }
      out.location = location || null;
      out.notes = cell(row, ix.notas) || null;
      out.paymentTerms = out.tipo === 'Proveedor' ? (cell(row, ix.plazo) || null) : null;
    } catch (e: any) {
      out.error = e?.message || 'Fila inválida';
    }
    return out;
  });
}

/** Índice de los registros existentes por RUC base, nombre y alias comercial. */
function indexar(rows: any[]) {
  const porRuc = new Map<string, any>();
  const porNombre = new Map<string, any>();
  const porAlias = new Map<string, any>();
  const aliasTokens: { row: any; nombre: string; tokens: string[] }[] = [];
  for (const r of rows) {
    const base = normalizarRucBase(r.taxId);
    if (base) porRuc.set(base, r);
    const n = normalizarNombreTercero(r.name);
    if (n) {
      porNombre.set(n, r);
      if (!porAlias.has(n)) porAlias.set(n, r);
      aliasTokens.push({ row: r, nombre: r.name, tokens: tokensNombre(r.name) });
    }
    const t = normalizarNombreTercero(r.tradeName);
    if (t && t !== n) {
      if (!porAlias.has(t)) porAlias.set(t, r);
      aliasTokens.push({ row: r, nombre: r.tradeName, tokens: tokensNombre(r.tradeName) });
    }
  }
  return { porRuc, porNombre, porAlias, aliasTokens };
}

const CAMPOS: { key: keyof FilaTercero; label: string; field: string }[] = [
  { key: 'tradeName', label: 'Nombre comercial', field: 'tradeName' },
  { key: 'taxId', label: 'RUC/Cédula', field: 'taxId' },
  { key: 'dv', label: 'DV', field: 'dv' },
  { key: 'taxIdType', label: 'Tipo identificación', field: 'taxIdType' },
  { key: 'phone', label: 'Teléfono', field: 'phone' },
  { key: 'email', label: 'Email', field: 'email' },
  { key: 'address', label: 'Dirección', field: 'address' },
  { key: 'location', label: 'Ubicación', field: 'location' },
  { key: 'notes', label: 'Notas', field: 'notes' },
];

/**
 * Compara un archivo contra los terceros existentes y devuelve el plan.
 * Es puro: no escribe ni consulta la BD (recibe los arrays ya cargados).
 */
export function planificarTerceros(
  filas: FilaTercero[],
  existentes: { client: any[]; supplier: any[] },
  modo: ModoImport,
): { filas: FilaPlan[]; resumen: ResumenImport } {
  const indices = {
    Cliente: indexar(existentes.client),
    Proveedor: indexar(existentes.supplier),
  };
  const firma = (f: FilaTercero) => JSON.stringify({
    tipo: f.tipo, name: f.name, tradeName: f.tradeName, taxId: f.taxId, dv: f.dv,
    taxIdType: f.taxIdType, phone: f.phone, email: f.email, address: f.address,
    location: f.location, notes: f.notes, paymentTerms: f.paymentTerms,
  });
  const vistos = new Map<string, { plan: FilaPlan; firma: string }>();
  const plan: FilaPlan[] = [];

  for (const f of filas) {
    const tipo = f.tipo || 'Cliente';
    const baseKey = f.taxId ? normalizarRucBase(f.taxId) : '';
    const nombreKey = normalizarNombreTercero(f.name);
    const key = `${tipo}|${baseKey || `N:${nombreKey}`}`;
    const item: FilaPlan = {
      fila: f.fila,
      tipo,
      name: f.name || '',
      taxId: f.taxId || null,
      dv: f.dv || null,
      estado: 'error',
      detalle: '',
      cambios: [],
    };

    if (f.error) {
      item.detalle = f.error;
      plan.push(item);
      continue;
    }

    const previo = vistos.get(key);
    if (previo) {
      if (previo.firma === firma(f)) {
        item.estado = 'repetida';
        item.detalle = `Repetida: misma clave y datos que la fila ${previo.plan.fila}.`;
      } else {
        item.estado = 'conflicto';
        item.detalle = `Fila repetida con datos distintos a la fila ${previo.plan.fila}.`;
        if (previo.plan.estado === 'nuevo' || previo.plan.estado === 'actualiza') {
          previo.plan.estado = 'conflicto';
          previo.plan.detalle = `Datos distintos a la fila ${f.fila} para el mismo RUC/nombre.`;
        }
      }
      plan.push(item);
      continue;
    }
    vistos.set(key, { plan: item, firma: firma(f) });

    const idx = indices[tipo];
    const byRuc = baseKey ? idx.porRuc.get(baseKey) : null;
    const byName = nombreKey ? idx.porNombre.get(nombreKey) : null;
    const aliasKeys = [f.name, f.tradeName].filter(Boolean).map((n) => normalizarNombreTercero(n)).filter(Boolean);
    const byAlias = aliasKeys.map((a) => idx.porAlias.get(a)).find(Boolean) || null;

    if (byRuc && byAlias && byRuc.id !== byAlias.id) {
      item.estado = 'conflicto';
      item.detalle = 'El RUC y el nombre comercial pertenecen a dos terceros distintos en la BD.';
      plan.push(item);
      continue;
    }
    if (byName && byAlias && byName.id !== byAlias.id) {
      item.estado = 'conflicto';
      item.detalle = 'El nombre y el nombre comercial apuntan a dos terceros distintos en la BD.';
      plan.push(item);
      continue;
    }

    const existing = byRuc || byAlias || byName;
    if (existing && existing.taxId && baseKey && normalizarRucBase(existing.taxId) !== baseKey) {
      item.estado = 'conflicto';
      item.detalle = 'Ya existe un tercero con ese nombre y OTRO RUC. Corrige el archivo o edítalo en Terceros.';
      plan.push(item);
      continue;
    }

    if (!existing) {
      // Última red: un nombre con las mismas palabras (una contiene a la otra)
      // puede ser el mismo tercero escrito distinto ("Alejandro Acevedo" vs
      // "Alejandro Rodríguez Acevedo"). No se crea: se avisa para revisar.
      const rowTokens = tokensNombre(f.name || '');
      const subset = (a: string[], b: string[]) => a.length >= 2 && a.every((t) => b.includes(t));
      const posible = idx.aliasTokens.find((e) =>
        e.tokens.length >= 2 && rowTokens.length >= 2
        && e.tokens.length !== rowTokens.length
        && (subset(e.tokens, rowTokens) || subset(rowTokens, e.tokens)),
      );
      if (posible) {
        item.estado = 'conflicto';
        item.detalle = `Posible duplicado de «${posible.nombre}» (nombre parecido). Revisa Terceros o ajusta el archivo.`;
        plan.push(item);
        continue;
      }

      item.estado = 'nuevo';
      item.detalle = 'Se creará.';
      item.data = {
        name: f.name,
        ...Object.fromEntries(CAMPOS.filter((c) => f[c.key] != null).map((c) => [c.field, f[c.key]])),
        ...(f.paymentTerms ? { paymentTerms: f.paymentTerms } : {}),
        fiscalSource: 'IMPORT',
        fiscalUpdatedAt: new Date(),
      };
      plan.push(item);
      continue;
    }

    item.existingId = existing.id;
    const data: Record<string, any> = {};
    const cambios: string[] = [];

    // El registro pudo nacer con el nombre comercial (p. ej. «+Movil Panama»)
    // y el archivo trae la razón social. En modo completar se promueve la
    // razón social a `name` y el comercial se conserva en `tradeName`; no se
    // pierde ninguno de los dos.
    const existingNorm = normalizarNombreTercero(existing.name);
    const rowTradeNorm = normalizarNombreTercero(f.tradeName);
    if (
      modo === 'completar'
      && rowTradeNorm && rowTradeNorm === existingNorm
      && normalizarNombreTercero(f.name) !== existingNorm
      && !existing.tradeName
    ) {
      data.name = f.name;
      data.tradeName = existing.name;
      cambios.push('Nombre (razón social)');
    }
    // El nombre solo se toca además en modo actualizar (completar jamás renombra).
    if (modo === 'actualizar' && f.name && f.name !== existing.name) {
      data.name = f.name;
      cambios.push('Nombre');
    }
    for (const c of CAMPOS) {
      const incoming = f[c.key];
      if (incoming == null || incoming === '') continue;
      const actual = existing[c.field];
      const vacio = actual == null || actual === '';
      const distinto = String(actual ?? '') !== String(incoming ?? '');
      if ((vacio || modo === 'actualizar') && distinto) {
        data[c.field] = incoming;
        cambios.push(c.label);
      }
    }
    if (tipo === 'Proveedor' && f.paymentTerms && (existing.paymentTerms == null || existing.paymentTerms === '' || modo === 'actualizar')) {
      if (existing.paymentTerms !== f.paymentTerms) {
        data.paymentTerms = f.paymentTerms;
        cambios.push('Plazo de pago');
      }
    }

    if (!cambios.length) {
      item.estado = 'sin_cambios';
      item.detalle = 'Ya está igual en la BD.';
    } else {
      item.estado = 'actualiza';
      item.detalle = `Se ${modo === 'actualizar' ? 'actualiza' : 'completa'}: ${cambios.join(', ')}.`;
      item.cambios = cambios;
      item.data = { ...data, fiscalSource: 'IMPORT', fiscalUpdatedAt: new Date() };
    }
    plan.push(item);
  }

  return { filas: plan, resumen: resumir(plan) };
}

export function resumir(filas: FilaPlan[]): ResumenImport {
  const r: ResumenImport = { total: filas.length, nuevo: 0, actualiza: 0, sin_cambios: 0, conflicto: 0, error: 0, repetida: 0, aplicado: 0 };
  for (const f of filas) r[f.estado]++;
  return r;
}

/** Aplica un plan ya calculado. Cada fila es independiente: un error no aborta el resto. */
export async function aplicarPlanTerceros(
  prisma: any,
  companyId: string,
  filas: FilaPlan[],
): Promise<{ aplicadas: number; filas: FilaPlan[]; resumen: ResumenImport }> {
  let aplicadas = 0;
  for (const f of filas) {
    if ((f.estado !== 'nuevo' && f.estado !== 'actualiza') || !f.data) continue;
    const model = f.tipo === 'Cliente' ? prisma.client : prisma.supplier;
    try {
      if (f.estado === 'nuevo') {
        const creado = await model.create({ data: { companyId, ...f.data } });
        f.existingId = creado.id;
      } else {
        await model.update({ where: { id: f.existingId }, data: f.data });
      }
      f.estado = 'aplicado';
      f.detalle = '✅ Aplicado.';
      delete f.data;
      aplicadas++;
    } catch (e: any) {
      f.estado = e?.code === 'P2002' ? 'conflicto' : 'error';
      f.detalle = e?.code === 'P2002'
        ? 'Nombre o RUC ya usado por otro tercero.'
        : String(e?.message || 'Error al guardar');
      delete f.data;
    }
  }
  return { aplicadas, filas, resumen: resumir(filas) };
}

/** Columnas del formato, en el orden del template. */
export const COLUMNAS_TEMPLATE = [
  'TIPO', 'RUC', 'DV', 'NOMBRE', 'RAZON SOCIAL', 'TIPO IDENTIFICACION',
  'TELEFONO', 'EMAIL', 'DIRECCION', 'UBICACION', 'NOTAS', 'PLAZO DE PAGO',
];

/** Genera el XLSX de la plantilla (misma fuente que usa la ruta de descarga). */
export async function construirPlantillaTerceros(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Terceros');
  ws.addRow(COLUMNAS_TEMPLATE);
  ws.getRow(1).font = { bold: true };
  ws.columns = COLUMNAS_TEMPLATE.map((h) => ({
    width: ['TIPO', 'DV', 'TIPO IDENTIFICACION'].includes(h) ? 20 : ['NOMBRE', 'RAZON SOCIAL', 'DIRECCION'].includes(h) ? 30 : 18,
  }));
  ws.addRow(['Proveedor', '46004-187-302083', '96', '+Movil Panama', 'CABLES & WIRELESS', 'RUC', '', '', '', '', '', '30']);
  ws.addRow(['Proveedor', '8-786-1842', '89', 'ALEJANDRO RODRIGUEZ ACEVEDO', '', 'CEDULA', '', '', '', '', '', '']);
  ws.addRow(['Cliente', '8-733-2267', '88', 'Ferretería El Tornillo', 'FERRETERÍA EL TORNILLO, S.A.', 'RUC', '+507 6000-0000', 'compras@tornillo.com', 'Calle 1, Ciudad', '8-8-8', 'Ejemplo de cliente', '']);

  const inst = wb.addWorksheet('Instrucciones');
  inst.addRows([
    ['Columna', 'Qué poner'],
    ['TIPO', 'Cliente o Proveedor (obligatorio)'],
    ['RAZON SOCIAL', 'Nombre legal. Es el nombre principal; si falta, se usa NOMBRE.'],
    ['NOMBRE', 'Nombre comercial (opcional).'],
    ['RUC', 'RUC o cédula SIN el dígito verificador.'],
    ['DV', 'Dígito verificador (1-2 dígitos). Si el RUC ya lo trae, no lo repitas.'],
    ['TIPO IDENTIFICACION', 'RUC, CEDULA o PASAPORTE.'],
    ['UBICACION', 'Código PP-DD-CC (ej. 8-8-8). Necesario para facturar a contribuyentes.'],
    ['PLAZO DE PAGO', 'Solo proveedores; días de crédito (ej. 30).'],
    ['', ''],
    ['Modo completar', 'Crea lo que falta y completa campos vacíos; NO pisa datos existentes.'],
    ['Modo actualizar', 'Sobrescribe con las celdas NO vacías del archivo; una celda vacía no borra.'],
  ]);
  inst.getRow(1).font = { bold: true };
  inst.columns = [{ width: 24 }, { width: 95 }];

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
