import type { ClassificationResult } from '@agt-contador/shared';

// Palabras clave que mapean a nombres de conceptos en BD.
// La clave es la palabra que puede aparecer en una descripción,
// el valor es un array de posibles nombres de concepto (se busca el primero que exista en BD).
const KEYWORD_MAP: Record<string, string[]> = {
  // Refrigerios / alimentación
  café: ['Refrigerios', 'Alimentación', 'Alimentacion', 'Cafetería', 'Cafeteria'],
  cafe: ['Refrigerios', 'Alimentación', 'Alimentacion', 'Cafetería', 'Cafeteria'],
  té: ['Refrigerios', 'Alimentación', 'Alimentacion', 'Cafetería', 'Cafeteria'],
  te: ['Refrigerios', 'Alimentación', 'Alimentacion', 'Cafetería', 'Cafeteria'],
  break: ['Refrigerios', 'Alimentación', 'Alimentacion'],
  galletas: ['Refrigerios', 'Alimentación', 'Alimentacion'],
  snacks: ['Refrigerios', 'Alimentación', 'Alimentacion'],
  refrigerio: ['Refrigerios', 'Alimentación', 'Alimentacion'],
  bebidas: ['Refrigerios', 'Alimentación', 'Alimentacion'],
  azúcar: ['Refrigerios', 'Alimentación', 'Alimentacion'],
  azucar: ['Refrigerios', 'Alimentación', 'Alimentacion'],
  crema: ['Refrigerios', 'Alimentación', 'Alimentacion'],
  merienda: ['Refrigerios', 'Alimentación', 'Alimentacion'],
  descanso: ['Refrigerios', 'Alimentación', 'Alimentacion'],
  // Combustible
  gasolina: ['Combustible', 'Gastos de Combustible', 'Gasolina'],
  gas: ['Combustible', 'Gastos de Combustible', 'Gasolina'],
  diésel: ['Combustible', 'Gastos de Combustible', 'Gasolina'],
  diesel: ['Combustible', 'Gastos de Combustible', 'Gasolina'],
  tanque: ['Combustible', 'Gastos de Combustible', 'Gasolina'],
  petro: ['Combustible', 'Gastos de Combustible', 'Gasolina'],
  terpel: ['Combustible', 'Gastos de Combustible', 'Gasolina'],
  delta: ['Combustible', 'Gastos de Combustible', 'Gasolina'],
  // Electricidad
  luz: ['Electricidad', 'Electricidad', 'Luz'],
  ensa: ['Electricidad', 'Electricidad', 'Luz'],
  naturgy: ['Electricidad', 'Electricidad', 'Luz'],
  edemet: ['Electricidad', 'Electricidad', 'Luz'],
  edeche: ['Electricidad', 'Electricidad', 'Luz'],
  eléctrica: ['Electricidad', 'Electricidad', 'Luz'],
  electrica: ['Electricidad', 'Electricidad', 'Luz'],
  // Internet / comunicaciones
  internet: ['Internet y Comunicaciones', 'Internet', 'Internet y comunicaciones'],
  wifi: ['Internet y Comunicaciones', 'Internet', 'Internet y comunicaciones'],
  fibra: ['Internet y Comunicaciones', 'Internet', 'Internet y comunicaciones'],
  tigo: ['Internet y Comunicaciones', 'Internet', 'Internet y comunicaciones', 'Teléfono', 'Telefono'],
  'cable': ['Internet y Comunicaciones', 'Internet', 'Internet y comunicaciones'],
  'más móvil': ['Internet y Comunicaciones', 'Internet', 'Teléfono', 'Telefono'],
  'mas movil': ['Internet y Comunicaciones', 'Internet', 'Teléfono', 'Telefono'],
  // Agua
  agua: ['Agua', 'Agua'],
  idaan: ['Agua', 'Agua'],
  acueducto: ['Agua', 'Agua'],
  // Alquiler
  alquiler: ['Alquiler', 'Alquiler', 'Renta'],
  renta: ['Alquiler', 'Alquiler', 'Renta'],
  arriendo: ['Alquiler', 'Alquiler', 'Renta'],
  arrendamiento: ['Alquiler', 'Alquiler', 'Renta'],
  local: ['Alquiler', 'Alquiler', 'Renta'],
  // Teléfono
  teléfono: ['Teléfono', 'Telefono', 'Teléfono'],
  telefono: ['Teléfono', 'Telefono', 'Teléfono'],
  celular: ['Teléfono', 'Telefono', 'Teléfono'],
  móvil: ['Teléfono', 'Telefono', 'Teléfono'],
  movil: ['Teléfono', 'Telefono', 'Teléfono'],
  claro: ['Teléfono', 'Telefono', 'Teléfono'],
  digicel: ['Teléfono', 'Telefono', 'Teléfono'],
  // Papelería
  papel: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  papelería: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  papeleria: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  útiles: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  utiles: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  oficina: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  lapicero: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  lápiz: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  lapiz: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  tinta: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  toner: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  tóner: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  impresora: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  cuaderno: ['Papelería y Útiles', 'Papeleria y Utiles', 'Papelería', 'Papeleria'],
  // Comida / alimentación
  comida: ['Alimentación', 'Alimentacion', 'Alimentación', 'Refrigerios'],
  alimento: ['Alimentación', 'Alimentacion', 'Alimentación', 'Refrigerios'],
  almuerzo: ['Alimentación', 'Alimentacion', 'Alimentación', 'Refrigerios'],
  desayuno: ['Alimentación', 'Alimentacion', 'Alimentación', 'Refrigerios'],
  cena: ['Alimentación', 'Alimentacion', 'Alimentación', 'Refrigerios'],
  restaurant: ['Alimentación', 'Alimentacion', 'Alimentación'],
  restaurante: ['Alimentación', 'Alimentacion', 'Alimentación'],
  supermercado: ['Alimentación', 'Alimentacion', 'Alimentación'],
  super: ['Alimentación', 'Alimentacion', 'Alimentación'],
  // Seguros
  seguro: ['Seguros', 'Seguros', 'Seguro'],
  póliza: ['Seguros', 'Seguros', 'Seguro'],
  poliza: ['Seguros', 'Seguros', 'Seguro'],
  aseguradora: ['Seguros', 'Seguros', 'Seguro'],
  // Publicidad
  publicidad: ['Publicidad y Marketing', 'Publicidad y Marketing', 'Publicidad'],
  marketing: ['Publicidad y Marketing', 'Publicidad y Marketing', 'Publicidad'],
  anuncio: ['Publicidad y Marketing', 'Publicidad y Marketing', 'Publicidad'],
  facebook: ['Publicidad y Marketing', 'Publicidad y Marketing', 'Publicidad'],
  instagram: ['Publicidad y Marketing', 'Publicidad y Marketing', 'Publicidad'],
  promoción: ['Publicidad y Marketing', 'Publicidad y Marketing', 'Publicidad'],
  promocion: ['Publicidad y Marketing', 'Publicidad y Marketing', 'Publicidad'],
  // Mantenimiento
  mantenimiento: ['Mantenimiento y Reparaciones', 'Mantenimiento y Reparaciones', 'Mantenimiento'],
  reparación: ['Mantenimiento y Reparaciones', 'Mantenimiento y Reparaciones', 'Mantenimiento'],
  reparacion: ['Mantenimiento y Reparaciones', 'Mantenimiento y Reparaciones', 'Mantenimiento'],
  taller: ['Mantenimiento y Reparaciones', 'Mantenimiento y Reparaciones', 'Mantenimiento'],
  mecánico: ['Mantenimiento y Reparaciones', 'Mantenimiento y Reparaciones', 'Mantenimiento'],
  mecanico: ['Mantenimiento y Reparaciones', 'Mantenimiento y Reparaciones', 'Mantenimiento'],
  plomero: ['Mantenimiento y Reparaciones', 'Mantenimiento y Reparaciones', 'Mantenimiento'],
  electricista: ['Mantenimiento y Reparaciones', 'Mantenimiento y Reparaciones', 'Mantenimiento'],
  // Transporte
  transporte: ['Transporte', 'Transporte', 'Transporte'],
  taxi: ['Transporte', 'Transporte', 'Transporte'],
  uber: ['Transporte', 'Transporte', 'Transporte'],
  bus: ['Transporte', 'Transporte', 'Transporte'],
  pasaje: ['Transporte', 'Transporte', 'Transporte', 'Gastos de Viaje'],
  flete: ['Transporte', 'Transporte', 'Transporte'],
  envío: ['Transporte', 'Transporte', 'Transporte'],
  envio: ['Transporte', 'Transporte', 'Transporte'],
  mensajería: ['Transporte', 'Transporte', 'Transporte'],
  mensajeria: ['Transporte', 'Transporte', 'Transporte'],
  // Honorarios
  honorario: ['Honorarios Profesionales', 'Honorarios Profesionales', 'Honorarios'],
  abogado: ['Honorarios Profesionales', 'Honorarios Profesionales', 'Honorarios', 'Gastos Legales'],
  contador: ['Honorarios Profesionales', 'Honorarios Profesionales', 'Honorarios'],
  consultor: ['Honorarios Profesionales', 'Honorarios Profesionales', 'Honorarios'],
  asesor: ['Honorarios Profesionales', 'Honorarios Profesionales', 'Honorarios'],
  auditor: ['Honorarios Profesionales', 'Honorarios Profesionales', 'Honorarios'],
  // Viajes
  viaje: ['Gastos de Viaje', 'Gastos de Viaje', 'Transporte'],
  hotel: ['Gastos de Viaje', 'Gastos de Viaje', 'Hospedaje'],
  hospedaje: ['Gastos de Viaje', 'Gastos de Viaje', 'Hospedaje'],
  viático: ['Gastos de Viaje', 'Gastos de Viaje'],
  viatico: ['Gastos de Viaje', 'Gastos de Viaje'],
  boleto: ['Gastos de Viaje', 'Gastos de Viaje', 'Transporte'],
  avión: ['Gastos de Viaje', 'Gastos de Viaje', 'Transporte'],
  avion: ['Gastos de Viaje', 'Gastos de Viaje', 'Transporte'],
  // Salarios
  salario: ['Salarios', 'Salarios'],
  sueldo: ['Salarios', 'Salarios'],
  nómina: ['Salarios', 'Salarios'],
  nomina: ['Salarios', 'Salarios'],
  planilla: ['Salarios', 'Salarios'],
  // Legales
  legal: ['Gastos Legales', 'Gastos Legales', 'Honorarios Profesionales'],
  notario: ['Gastos Legales', 'Gastos Legales'],
  escritura: ['Gastos Legales', 'Gastos Legales'],
  contrato: ['Gastos Legales', 'Gastos Legales', 'Honorarios Profesionales'],
  tribunal: ['Gastos Legales', 'Gastos Legales'],
  // Representación
  representación: ['Gastos de Representación', 'Gastos de Representacion'],
  representacion: ['Gastos de Representación', 'Gastos de Representacion'],
  regalo: ['Gastos de Representación', 'Gastos de Representacion'],
  cortesía: ['Gastos de Representación', 'Gastos de Representacion'],
  cortesia: ['Gastos de Representación', 'Gastos de Representacion'],
  // Comisiones
  comisión: ['Comisiones Bancarias', 'Comisiones Bancarias', 'Comisiones'],
  comision: ['Comisiones Bancarias', 'Comisiones Bancarias', 'Comisiones'],
  transferencia: ['Comisiones Bancarias', 'Comisiones Bancarias'],
  ach: ['Comisiones Bancarias', 'Comisiones Bancarias'],
  // ITBMS / impuestos
  itbms: ['ITBMS', 'ITBMS Gastado'],
  impuesto: ['ITBMS Gastado', 'Gastos de Impuestos', 'ITBMS'],
  timbre: ['Timbres y Otros Impuestos', 'Gastos de Impuestos'],
  // Depreciación
  depreciación: ['Depreciaciones', 'Depreciación'],
  depreciacion: ['Depreciaciones', 'Depreciación'],
};

export interface ClassificationAgentConfig {
  prisma: any;
  companyId: string;
  deepseekApiKey?: string;
}

export class ClassificationAgent {
  private prisma: any;
  private companyId: string;

  constructor(config: ClassificationAgentConfig) {
    this.prisma = config.prisma;
    this.companyId = config.companyId;
  }

  private async loadAccounts(): Promise<any[]> {
    return this.prisma.account.findMany({
      where: { companyId: this.companyId, isActive: true },
    });
  }

  async classify(conceptName: string, transactionType?: string): Promise<ClassificationResult> {
    const allConcepts = await this.prisma.concept.findMany({
      where: { companyId: this.companyId, isActive: true },
      include: { account: true },
    });

    if (allConcepts.length === 0) {
      // Sin conceptos en BD, usar cuenta genérica por tipo
      const accounts = await this.loadAccounts();
      const typeToGeneric: Record<string, string> = {
        INGRESO: 'Otros Ingresos',
        GASTO: 'Gastos Varios',
        COMPRA: 'Compra de mercancía',
        VENTA: 'Ventas',
        PAGO_PROVEEDOR: 'Proveedores',
        COBRO_CLIENTE: 'Clientes',
        PRESTAMO: 'Préstamos Bancarios LP',
      };
      const genericName = typeToGeneric[transactionType || ''] || 'Gastos Varios';
      const genericAccount = accounts.find((a: any) => a.name === genericName);
      return {
        concept: conceptName,
        accountId: genericAccount?.id || '',
        confidence: genericAccount ? 0.5 : 0,
      };
    }

    // Construir índice de nombres de concepto para búsqueda rápida
    const conceptNames = new Set(allConcepts.map((c: any) => c.name.toLowerCase()));

    const lowerName = conceptName.toLowerCase().trim();

    // 1. Match exacto (case-insensitive)
    const exactMatch = allConcepts.find((c: any) => c.name.toLowerCase() === lowerName);
    if (exactMatch) {
      return {
        concept: exactMatch.name,
        accountId: exactMatch.accountId,
        confidence: exactMatch.confidence,
      };
    }

    // 2. Concepto de BD como substring en el texto de entrada
    //    Ej: input="Factura de electricidad ENSA julio" → matchea concepto "Electricidad"
    const substringMatch = allConcepts
      .filter((c: any) => lowerName.includes(c.name.toLowerCase()))
      .sort((a: any, b: any) => b.name.length - a.name.length)[0];
    if (substringMatch) {
      return {
        concept: substringMatch.name,
        accountId: substringMatch.accountId,
        confidence: Math.max(substringMatch.confidence, 0.85),
      };
    }

    // 3. Palabras significativas del input que aparecen en nombres de conceptos
    const stopWords = new Set([
      'de', 'la', 'el', 'los', 'las', 'del', 'para', 'por', 'con', 'sin',
      'una', 'un', 'y', 'e', 'o', 'a', 'en', 'al', 'su', 'que', 'es',
      'pago', 'pagar', 'pague', 'compra', 'comprar', 'comprado',
      'factura', 'facturado', 'recibo', 'mes', 'julio', 'junio', 'enero',
      'febrero', 'marzo', 'abril', 'mayo', 'agosto', 'septiembre', 'octubre',
      'noviembre', 'diciembre', '2024', '2025', '2026', '2027',
    ]);
    const inputWords = lowerName.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));

    if (inputWords.length > 0) {
      // 3a. Buscar conceptos que contengan alguna de las palabras del input
      const wordMatches = allConcepts
        .map((c: any) => {
          const conceptLower = c.name.toLowerCase();
          const matchedWords = inputWords.filter(w => conceptLower.includes(w));
          return { concept: c, matchedWords };
        })
        .filter((m: { concept: any; matchedWords: string[] }) => m.matchedWords.length > 0)
        .sort((a: { concept: any; matchedWords: string[] }, b: { concept: any; matchedWords: string[] }) => {
          if (b.matchedWords.length !== a.matchedWords.length) return b.matchedWords.length - a.matchedWords.length;
          return b.concept.name.length - a.concept.name.length;
        });

      if (wordMatches.length > 0) {
        const best = wordMatches[0];
        const confidence = Math.max(best.concept.confidence * 0.85, 0.7);
        return {
          concept: best.concept.name,
          accountId: best.concept.accountId,
          confidence,
        };
      }

      // 3b. Keyword matching: buscar palabras clave → concepto en BD
      for (const word of inputWords) {
        const candidates = KEYWORD_MAP[word];
        if (candidates) {
          for (const candidateName of candidates) {
            const concept = allConcepts.find((c: any) => c.name.toLowerCase() === candidateName.toLowerCase());
            if (concept) {
              return {
                concept: concept.name,
                accountId: concept.accountId,
                confidence: Math.max(concept.confidence * 0.85, 0.75),
              };
            }
          }
        }
      }
    }

    // 4. Match por prefijo (4 caracteres) — solo si el input es corto (probablemente un nombre de concepto)
    //    Si es una descripción larga (>20 chars), es poco probable que el prefijo sea útil
    if (lowerName.length <= 20) {
      const prefix = conceptName.substring(0, 4).toLowerCase();
      const partialMatch = allConcepts
        .filter((c: any) => c.name.toLowerCase().includes(prefix))
        .sort((a: any, b: any) => b.confidence - a.confidence)[0];

      if (partialMatch) {
        return {
          concept: partialMatch.name,
          accountId: partialMatch.accountId,
          confidence: partialMatch.confidence * 0.7,
        };
      }
    }

    // 5. Fallback a cuenta genérica por tipo de transacción
    const accounts = await this.loadAccounts();
    const typeToGeneric: Record<string, string> = {
      INGRESO: 'Otros Ingresos',
      GASTO: 'Gastos Varios',
      COMPRA: 'Compra de mercancía',
      VENTA: 'Ventas',
      PAGO_PROVEEDOR: 'Proveedores',
      COBRO_CLIENTE: 'Clientes',
      PRESTAMO: 'Préstamos Bancarios LP',
    };
    const genericName = typeToGeneric[transactionType || ''] || 'Gastos Varios';
    const genericAccount = accounts.find((a: any) => a.name === genericName);

    if (genericAccount) {
      return {
        concept: conceptName,
        accountId: genericAccount.id,
        confidence: 0.5,
      };
    }

    return {
      concept: conceptName,
      accountId: '',
      confidence: 0,
    };
  }

  async learn(conceptName: string, accountId: string): Promise<void> {
    await this.prisma.concept.upsert({
      where: { name_companyId: { name: conceptName, companyId: this.companyId } },
      update: { accountId, confidence: 0.95 },
      create: { name: conceptName, accountId, companyId: this.companyId, confidence: 0.95 },
    });
  }
}
