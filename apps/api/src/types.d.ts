import { PrismaClient } from '@agt-contador/prisma-schema';
import type { AuthUser } from './middleware/auth';

declare global {
  namespace Express {
    interface Request {
      prisma: PrismaClient;
      user?: AuthUser;
    }
  }
}
