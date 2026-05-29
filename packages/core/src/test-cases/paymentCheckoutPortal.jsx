import React from 'react';
import { BuggySharedComponent } from './buggySharedComponent.jsx';

export function PaymentCheckoutPortal() {
  return (
    <div className="payment-checkout">
      <h2>Complete Checkout Process</h2>
      {/* High-risk page importing the buggy component */}
      <BuggySharedComponent userId="user-checkout-101" />
    </div>
  );
}
