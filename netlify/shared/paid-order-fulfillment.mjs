import { createDocument, getDocument, patchDocument } from './firebase-orders.mjs';

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY']);

export function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanEmail(value) {
  const raw = cleanText(value, 254);
  const email = raw.match(/<([^<>]+)>/)?.[1]?.trim() || raw;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 100).map(item => ({
    name: cleanText(item?.name, 180),
    quantity: Math.max(1, Math.min(99, Math.floor(Number(item?.quantity) || 1))),
    image: cleanText(item?.image, 1000),
    priceUSD: Number.isFinite(Number(item?.priceUSD)) ? Number(item.priceUSD) : null
  })).filter(item => item.name);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));
}

function displayAmount(amountMinor, currency) {
  if (!Number.isSafeInteger(Number(amountMinor))) return '';
  return ZERO_DECIMAL_CURRENCIES.has(currency)
    ? String(amountMinor)
    : (Number(amountMinor) / 100).toFixed(2);
}

export function orderNumberForSession(session) {
  const createdAt = Number(session?.created) > 0 ? new Date(Number(session.created) * 1000) : new Date();
  const date = createdAt.toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = cleanText(session?.id, 180).replace(/[^A-Za-z0-9]/g, '').slice(-12).toUpperCase();
  if (!suffix) throw new Error('Stripe Checkout session ID is missing.');
  return `GR-${date}-${suffix}`;
}

function validatePaidSession(session) {
  if (session?.mode !== 'payment' || session?.metadata?.store !== 'global_rani') {
    throw new Error('This Stripe Checkout session does not belong to The Global Rani.');
  }
  if (session?.status !== 'complete' || session?.payment_status !== 'paid') {
    throw new Error('Stripe has not confirmed a paid Checkout Session.');
  }
  const reference = cleanText(session?.metadata?.checkout_reference || session?.client_reference_id, 180);
  if (!reference) throw new Error('Stripe Checkout reference is missing.');
  return reference;
}

function buildOrderData(session, pending, stripeEventId) {
  const reference = validatePaidSession(session);
  if (reference !== cleanText(pending?.reference, 180)) throw new Error('Stripe and Firebase checkout references do not match.');
  const amountMinor = Number(session?.amount_total);
  const currency = cleanText(session?.currency, 10).toUpperCase();
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Stripe payment amount is invalid.');
  if (amountMinor !== Number(pending?.amountMinor)) throw new Error('Stripe payment amount does not match the pending Firebase order.');
  if (currency !== cleanText(pending?.currency, 10).toUpperCase()) throw new Error('Stripe currency does not match the pending Firebase order.');

  const orderNumber = orderNumberForSession(session);
  const shipping = pending?.shippingAddress || {};
  return {
    orderNumber,
    checkoutReference: reference,
    stripeCheckoutSessionId: cleanText(session.id, 180),
    stripePaymentIntentId: cleanText(typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id, 180),
    stripeEventId: cleanText(stripeEventId, 180),
    paymentStatus: 'PAID',
    amountMinor,
    amount: displayAmount(amountMinor, currency),
    currency,
    createdAt: new Date().toISOString(),
    paidAt: Number(session.created) > 0 ? new Date(Number(session.created) * 1000).toISOString() : new Date().toISOString(),
    fulfillmentStatus: 'NEW',
    emailStatus: 'PENDING',
    adminEmailStatus: 'PENDING',
    customerEmailStatus: 'PENDING',
    firebaseUserId: cleanText(pending?.firebaseUserId, 180),
    checkoutMode: cleanText(pending?.checkoutMode, 30),
    customerName: cleanText(pending?.customerName, 180),
    customerEmail: cleanEmail(pending?.customerEmail),
    customerEmailNormalized: cleanEmail(pending?.customerEmail).toLowerCase(),
    customerPhone: cleanText(pending?.customerPhone, 60),
    shippingAddress: {
      line1: cleanText(shipping?.line1, 240),
      line2: cleanText(shipping?.line2, 240),
      city: cleanText(shipping?.city, 120),
      state: cleanText(shipping?.state, 120),
      postalCode: cleanText(shipping?.postalCode, 40),
      country: cleanText(shipping?.country, 120)
    },
    deliveryNotes: cleanText(pending?.deliveryNotes, 1000),
    notes: cleanText(pending?.notes, 1000),
    items: cleanItems(pending?.items),
    tipUSD: Number(pending?.tipUSD) || 0,
    payerEmail: cleanEmail(session?.customer_details?.email || session?.customer_email),
    payerEmailNormalized: cleanEmail(session?.customer_details?.email || session?.customer_email).toLowerCase()
  };
}

function resendSettings() {
  const apiKey = cleanText(process.env.RESEND_API_KEY || process.env.RESEND_KEY, 500);
  const from = cleanText(
    process.env.ORDER_FROM_EMAIL ||
    process.env.RESEND_FROM_EMAIL ||
    'Global Rani <onboarding@resend.dev>',
    254
  );
  if (!apiKey) {
    throw new Error('RESEND_API_KEY must be configured.');
  }
  return { apiKey, from };
}

async function sendResendEmail({ apiKey, from, to, replyTo, subject, html, idempotencyKey }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: replyTo || undefined,
      subject,
      html
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.message || `Resend email failed (${response.status}).`);
  return result;
}

export async function sendGlobalRaniOrderEmail(order) {
  const { apiKey, from } = resendSettings();
  const to = cleanEmail(
    process.env.ORDER_NOTIFICATION_EMAIL ||
    process.env.MERCHANT_NOTIFICATION_EMAIL ||
    process.env.MERCHANT_EMAIL ||
    process.env.RESEND_TO_EMAIL
  );
  if (!to) throw new Error('ORDER_NOTIFICATION_EMAIL must be configured.');

  const items = order.items.map(item => `<li>${escapeHtml(item.name)} × ${item.quantity}</li>`).join('');
  const address = order.shippingAddress;
  return sendResendEmail({
    apiKey,
    from,
    to,
    replyTo: cleanEmail(order.customerEmail || order.payerEmail),
    subject: `Paid Global Rani order ${order.orderNumber}`,
    idempotencyKey: `global-rani-order-${order.orderNumber}`,
    html: `
        <div style="font-family:Arial,sans-serif;color:#34210e;line-height:1.55">
          <h1 style="color:#9e1533">New paid Global Rani order</h1>
          <p><strong>Order:</strong> ${escapeHtml(order.orderNumber)}</p>
          <p><strong>Stripe session:</strong> ${escapeHtml(order.stripeCheckoutSessionId)}</p>
          <p><strong>Stripe payment:</strong> ${escapeHtml(order.stripePaymentIntentId)}</p>
          <p><strong>Paid:</strong> ${escapeHtml(order.amount)} ${escapeHtml(order.currency)}</p>
          <h2>Customer</h2>
          <p>${escapeHtml(order.customerName)}<br>${escapeHtml(order.customerEmail)}<br>${escapeHtml(order.customerPhone)}</p>
          <h2>Shipping address</h2>
          <p>${escapeHtml(address.line1)}<br>${escapeHtml(address.line2)}<br>${escapeHtml(address.city)}, ${escapeHtml(address.state)} ${escapeHtml(address.postalCode)}<br>${escapeHtml(address.country)}</p>
          <h2>Items</h2><ul>${items}</ul>
          <p><strong>Delivery notes:</strong> ${escapeHtml(order.deliveryNotes)}</p>
          <p><strong>Profile notes:</strong> ${escapeHtml(order.notes)}</p>
        </div>`
  });
}

export async function sendCustomerOrderEmail(order) {
  const { apiKey, from } = resendSettings();
  const to = cleanEmail(order.customerEmail || order.payerEmail);
  if (!to) throw new Error('Customer email is missing from the paid checkout.');

  const replyTo = cleanEmail(
    process.env.ORDER_NOTIFICATION_EMAIL ||
    process.env.MERCHANT_NOTIFICATION_EMAIL ||
    process.env.MERCHANT_EMAIL ||
    process.env.RESEND_TO_EMAIL
  );
  const customerName = cleanText(order.customerName, 180);
  const greetingName = customerName.split(/\s+/)[0] || 'Rani';
  const items = order.items.map(item => `<li style="margin-bottom:6px">${escapeHtml(item.name)} × ${item.quantity}</li>`).join('');
  const address = order.shippingAddress;
  return sendResendEmail({
    apiKey,
    from,
    to,
    replyTo,
    subject: `Your Global Rani order ${order.orderNumber} is confirmed`,
    idempotencyKey: `global-rani-customer-order-${order.orderNumber}`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#34210e;line-height:1.6;max-width:640px;margin:0 auto">
        <div style="padding:28px;border:1px solid #ead7b1;border-radius:20px;background:#fffaf2">
          <p style="margin-top:0;color:#9e1533;font-weight:700">THE GLOBAL RANI</p>
          <h1 style="color:#9e1533;margin-bottom:8px">Thank you for your order!</h1>
          <p>Hi ${escapeHtml(greetingName)},</p>
          <p>Your payment was successful and we have received your order. We will begin preparing it with care.</p>
          <p><strong>Order number:</strong> ${escapeHtml(order.orderNumber)}<br>
          <strong>Amount paid:</strong> ${escapeHtml(order.amount)} ${escapeHtml(order.currency)}</p>
          <h2 style="font-size:18px;color:#7a5420">Your items</h2>
          <ul>${items}</ul>
          <h2 style="font-size:18px;color:#7a5420">Shipping to</h2>
          <p>${escapeHtml(customerName)}<br>
          ${escapeHtml(address.line1)}<br>
          ${address.line2 ? `${escapeHtml(address.line2)}<br>` : ''}
          ${escapeHtml(address.city)}, ${escapeHtml(address.state)} ${escapeHtml(address.postalCode)}<br>
          ${escapeHtml(address.country)}</p>
          <p>Keep this email for your records. If you have a question, reply to this message and include your order number.</p>
          <p style="margin-bottom:0">With love,<br><strong>The Global Rani</strong></p>
        </div>
      </div>`
  });
}

export async function fulfillPaidCheckout(session, stripeEventId = '') {
  const reference = validatePaidSession(session);
  const pending = await getDocument('checkout_intents', reference);
  if (!pending) throw new Error(`Pending Firebase checkout ${reference} was not found.`);
  const order = buildOrderData(session, pending, stripeEventId);
  const created = await createDocument('orders', order.orderNumber, order);
  const existing = created.document || {};

  await patchDocument('checkout_intents', reference, {
    status: 'PAYMENT_CONFIRMED',
    orderNumber: order.orderNumber,
    stripeCheckoutSessionId: order.stripeCheckoutSessionId,
    paymentConfirmedAt: new Date().toISOString()
  });

  if (existing.notificationSuppressed === true) {
    await patchDocument('checkout_intents', reference, {
      status: 'FULFILLED',
      notificationEmailStatus: 'SKIPPED',
      customerEmailStatus: 'SKIPPED',
      fulfilledAt: new Date().toISOString()
    });
    return { orderNumber: order.orderNumber, alreadyProcessed: true, emailed: false, customerEmailed: false };
  }

  const legacyAdminEmailSent = !existing.adminEmailStatus && existing.emailStatus === 'SENT';
  let adminEmailSent = existing.adminEmailStatus === 'SENT' || legacyAdminEmailSent;
  let customerEmailSent = existing.customerEmailStatus === 'SENT';

  if (legacyAdminEmailSent) {
    await patchDocument('orders', order.orderNumber, {
      adminEmailStatus: 'SENT',
      adminEmailId: cleanText(existing.emailId, 180),
      adminEmailSentAt: cleanText(existing.emailSentAt, 80)
    });
  }

  if (adminEmailSent && customerEmailSent) {
    await patchDocument('checkout_intents', reference, {
      status: 'FULFILLED',
      notificationEmailStatus: 'SENT',
      customerEmailStatus: 'SENT',
      fulfilledAt: new Date().toISOString()
    });
    return { orderNumber: order.orderNumber, alreadyProcessed: true, emailed: true, customerEmailed: true };
  }

  const failures = [];
  if (!adminEmailSent) {
    try {
      const email = await sendGlobalRaniOrderEmail(order);
      const sentAt = new Date().toISOString();
      await patchDocument('orders', order.orderNumber, {
        adminEmailStatus: 'SENT',
        adminEmailId: cleanText(email?.id, 180),
        adminEmailSentAt: sentAt,
        emailId: cleanText(email?.id, 180),
        emailSentAt: sentAt,
        adminEmailError: ''
      });
      adminEmailSent = true;
    } catch (error) {
      const message = cleanText(error?.message || error, 500);
      failures.push(`Store email: ${message}`);
      await patchDocument('orders', order.orderNumber, { adminEmailStatus: 'FAILED', adminEmailError: message });
    }
  }

  if (!customerEmailSent) {
    try {
      const email = await sendCustomerOrderEmail(order);
      const sentAt = new Date().toISOString();
      await patchDocument('orders', order.orderNumber, {
        customerEmailStatus: 'SENT',
        customerEmailId: cleanText(email?.id, 180),
        customerEmailSentAt: sentAt,
        customerEmailRecipient: cleanEmail(order.customerEmail || order.payerEmail),
        customerEmailError: ''
      });
      customerEmailSent = true;
    } catch (error) {
      const message = cleanText(error?.message || error, 500);
      failures.push(`Customer email: ${message}`);
      await patchDocument('orders', order.orderNumber, { customerEmailStatus: 'FAILED', customerEmailError: message });
    }
  }

  if (failures.length) {
    const message = cleanText(failures.join(' | '), 500);
    await patchDocument('orders', order.orderNumber, { emailStatus: 'FAILED', emailError: message });
    await patchDocument('checkout_intents', reference, {
      notificationEmailStatus: adminEmailSent ? 'SENT' : 'FAILED',
      customerEmailStatus: customerEmailSent ? 'SENT' : 'FAILED',
      emailError: message
    });
    throw new Error(message);
  }

  const allEmailsSentAt = new Date().toISOString();
  await patchDocument('orders', order.orderNumber, {
    emailStatus: 'SENT',
    allEmailsSentAt,
    emailError: ''
  });
  await patchDocument('checkout_intents', reference, {
    status: 'FULFILLED',
    notificationEmailStatus: 'SENT',
    customerEmailStatus: 'SENT',
    fulfilledAt: allEmailsSentAt,
    emailError: ''
  });
  return {
    orderNumber: order.orderNumber,
    alreadyProcessed: !created.created,
    emailed: true,
    customerEmailed: true
  };
}

export async function orderStatusForSession(session) {
  const reference = validatePaidSession(session);
  const pending = await getDocument('checkout_intents', reference);
  const orderNumber = cleanText(pending?.orderNumber, 180) || orderNumberForSession(session);
  const order = await getDocument('orders', orderNumber);
  const currency = cleanText(session.currency, 10).toUpperCase();
  return {
    paid: true,
    processing: !order || order.emailStatus !== 'SENT',
    orderNumber: order?.orderNumber || orderNumber,
    customerName: cleanText(order?.customerName || pending?.customerName, 180),
    amountMinor: Number(session.amount_total) || 0,
    amount: displayAmount(Number(session.amount_total), currency),
    currency,
    emailStatus: cleanText(order?.emailStatus || pending?.notificationEmailStatus || 'PENDING', 30),
    adminEmailStatus: cleanText(order?.adminEmailStatus || pending?.notificationEmailStatus || 'PENDING', 30),
    customerEmailStatus: cleanText(order?.customerEmailStatus || pending?.customerEmailStatus || 'PENDING', 30),
    fulfillmentStatus: cleanText(order?.fulfillmentStatus || 'NEW', 30)
  };
}
