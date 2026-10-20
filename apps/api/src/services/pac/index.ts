/**
 * Punto de entrada del módulo de facturación electrónica.
 *
 * `createPacProvider` es la factory: la app pide un proveedor por id y recibe
 * algo que cumple `PacProvider`. Sumar otro PAC = nuevo archivo adaptador +
 * un case acá. Ni las rutas ni la UI conocen al proveedor.
 */
import { PacError } from './types';
import type { PacProvider, PacProviderConfig } from './types';
import { FacturaFacilProvider, FACTURA_FACIL, FACTURA_FACIL_ENDPOINTS } from './facturafacil';

export * from './types';
export { loadPacConfigFromEnv } from './config';
export { FacturaFacilProvider, FACTURA_FACIL, FACTURA_FACIL_ENDPOINTS };

export function createPacProvider(config: PacProviderConfig): PacProvider {
  switch (config.provider) {
    case FACTURA_FACIL:
      return new FacturaFacilProvider(config);
    default:
      throw new PacError(
        `Proveedor PAC no soportado: "${config.provider}". Implementá la interfaz PacProvider y registralo en services/pac/index.ts.`,
        'CONFIG',
      );
  }
}
