import { describe, it, expect, vi, beforeEach } from 'vitest';

// Set env var before importing services
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_key';

import { createCheckoutSession, handleStripeWebhook } from '../src/services/billingService.js';
import prisma from '../src/db/prisma.js';

// Mock Stripe
vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      checkout = {
        sessions: {
          create: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_test_123' })
        }
      }
    }
  };
});

// Mock Prisma
vi.mock('../src/db/prisma.js', () => ({
  default: {
    user: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({})
    }
  }
}));

describe('Billing Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a checkout session URL', async () => {
    const url = await createCheckoutSession('user_123', 'test@example.com', 'price_H5ggYwtDq4fbrJ');
    expect(url).toBe('https://checkout.stripe.com/pay/cs_test_123');
  });

  it('should handle checkout.session.completed event and update user to PRO', async () => {
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'user_123',
          customer: 'cus_xyz123'
        }
      }
    };

    const result = await handleStripeWebhook(event);
    expect(result).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user_123' },
      data: { subscriptionTier: 'PRO', stripeCustomerId: 'cus_xyz123' }
    });
  });

  it('should handle customer.subscription.deleted event and downgrade user to FREE', async () => {
    const event = {
      type: 'customer.subscription.deleted',
      data: {
        object: {
          customer: 'cus_xyz123'
        }
      }
    };

    const result = await handleStripeWebhook(event);
    expect(result).toBe(true);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { stripeCustomerId: 'cus_xyz123' },
      data: { subscriptionTier: 'FREE' }
    });
  });

  it('should return false for unhandled events', async () => {
    const event = { type: 'payment_intent.succeeded' };
    const result = await handleStripeWebhook(event);
    expect(result).toBe(false);
  });
});
