// El guard vive en @agt-contador/agents porque el OrchestratorAgent (paquete agents)
// también lo necesita y ese paquete no puede importar desde apps/api. Este archivo
// mantiene la ruta que usan las rutas de la API para no dispersar el import.
export {
  loadAccountFlags,
  blockedMessage,
  blockedAccounts,
  checkNotBlocked,
  type AccountFlags,
} from '@agt-contador/agents';
