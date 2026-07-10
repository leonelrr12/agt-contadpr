import { PrismaClient } from '@agt-contador/prisma-schema';

declare global {
  namespace Express {
    interface Request {
      prisma: PrismaClient;
    }
  }
}
