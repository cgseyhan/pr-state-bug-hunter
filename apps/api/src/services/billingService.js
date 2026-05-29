import Stripe from 'stripe';
import prisma from '../db/prisma.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'dummy_key');

/**
 * Müşteri için ödeme linki oluşturur.
 */
export async function createCheckoutSession(userId, email, priceId) {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: "subscription",
      customer_email: email,
      client_reference_id: userId,
      success_url: `${process.env.DASHBOARD_URL}/settings?session_id={CHECKOUT_SESSION_ID}&success=true`,
      cancel_url: `${process.env.DASHBOARD_URL}/settings?canceled=true`,
    });

    return session.url;
  } catch (error) {
    console.error("Stripe Checkout Error:", error);
    throw new Error("Ödeme sayfası oluşturulamadı.");
  }
}

/**
 * Webhook üzerinden gelen başarılı ödemeyi yakalar ve DB günceller.
 */
export async function handleStripeWebhook(event) {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.client_reference_id;
    const stripeCustomerId = session.customer;

    console.log(`User ${userId} successfully subscribed! Stripe ID: ${stripeCustomerId}`);
    
    if (userId) {
      await prisma.user.update({
        where: { id: userId },
        data: { subscriptionTier: "PRO", stripeCustomerId }
      });
    }
    return true;
  }
  
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const stripeCustomerId = subscription.customer;

    console.log(`Subscription cancelled for Stripe ID: ${stripeCustomerId}`);
    
    if (stripeCustomerId) {
      // Find user first or updateMany to avoid error if missing
      await prisma.user.updateMany({
        where: { stripeCustomerId },
        data: { subscriptionTier: "FREE" }
      });
    }
    return true;
  }

  return false;
}
