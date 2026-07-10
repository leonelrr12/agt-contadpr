import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@agt-contador/prisma-schema';
import { accountsRouter } from './routes/accounts';
import { journalRouter } from './routes/journal';
import { reportsRouter } from './routes/reports';
import { conceptsRouter } from './routes/concepts';
import { transactionsRouter } from './routes/transactions';
import { orchestrateRouter } from './routes/orchestrate';

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

app.use((req, _res, next) => {
  req.prisma = prisma;
  next();
});

app.use('/api/accounts', accountsRouter);
app.use('/api/journal', journalRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/concepts', conceptsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/orchestrate', orchestrateRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});

export { app, prisma };
