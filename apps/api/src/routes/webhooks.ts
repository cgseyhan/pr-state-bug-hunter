import { FastifyInstance } from 'fastify';

export async function webhookRoute(fastify: FastifyInstance) {
  fastify.post('/github/webhook', async (request, reply) => {
    // Stage 8: GitHub App Strategy
    // In a real app, verify `x-hub-signature-256` header using the webhook secret.
    
    const event = request.headers['x-github-event'];
    request.log.info(`Received GitHub webhook event: ${event}`);

    // Here we would handle events:
    // - installation, installation_repositories
    // - pull_request (opened, synchronize)
    // - issue_comment (for slash commands like /bug-hunter fix)

    return reply.status(200).send({ ok: true });
  });
}
