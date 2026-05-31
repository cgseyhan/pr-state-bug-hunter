import fastify from 'fastify';
import cors from '@fastify/cors';
import { analyzeRoute } from './routes/analyze.js';
import { webhookRoute } from './routes/webhooks.js';

const app = fastify({ logger: true });

app.register(cors, {
  origin: '*'
});

app.get('/health', async (request, reply) => {
  return { status: 'ok', version: '2.1.0' };
});

app.register(analyzeRoute, { prefix: '/v1' });
app.register(webhookRoute, { prefix: '/v1' });

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`Server is running on port ${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
