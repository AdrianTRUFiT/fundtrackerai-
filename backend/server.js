// -----------------------------------------------
// FundTrackerAI Backend — Donations + Identities + Orders
// -----------------------------------------------

import express from "express";
import Stripe from "stripe";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { fileURLToPath } from "url";

dotenv.config();

// ---------- 0. APP + ENV SETUP ----------
const app = express();
app.use(express.json());
app.use(cors());

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL; // e.g. https://fundtrackerai.vercel.app
const SOULMARK_SECRET =
  process.env.SOULMARK_SECRET || "CHANGE_ME_SOULMARK_SECRET";

if (!STRIPE_SECRET_KEY || !FRONTEND_URL) {
  console.warn(
    "⚠️ Missing STRIPE_SECRET_KEY or FRONTEND_URL env vars. Backend will not function correctly until these are set."
  );
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

// Resolve __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// registry.json lives beside server.js
const registryFile = path.join(__dirname, "registry.json");

function ensureRegistry() {
  try {
    if (!fs.existsSync(registryFile)) {
      console.log("🆕 Creating registry.json");
      const initial = { donations: [], identities: [], orders: [] };
      fs.writeFileSync(registryFile, JSON.stringify(initial, null, 2), "utf8");
      return;
    }

    const raw = fs.readFileSync(registryFile, "utf8") || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("⚠️ registry.json invalid JSON, backing up and resetting.");
      fs.writeFileSync(registryFile + ".backup-" + Date.now(), raw, "utf8");
      const reset = { donations: [], identities: [], orders: [] };
      fs.writeFileSync(registryFile, JSON.stringify(reset, null, 2), "utf8");
      return;
    }

    let changed = false;
    if (!Array.isArray(parsed.donations)) {
      parsed.donations = [];
      changed = true;
    }
    if (!Array.isArray(parsed.identities)) {
      parsed.identities = [];
      changed = true;
    }
    if (!Array.isArray(parsed.orders)) {
      parsed.orders = [];
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(registryFile, JSON.stringify(parsed, null, 2), "utf8");
    }
  } catch (err) {
    console.error("ensureRegistry error:", err);
  }
}

function readRegistry() {
  ensureRegistry();
  try {
    const raw = fs.readFileSync(registryFile, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("READ registry error:", err);
    return { donations: [], identities: [], orders: [] };
  }
}

function writeRegistry(data) {
  try {
    fs.writeFileSync(registryFile, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("WRITE registry error:", err);
  }
}

// Simple helper for order IDs
function createOrderId() {
  return "ord-" + crypto.randomUUID();
}

// ---------- 1. ROOT PING ----------
app.get("/", (req, res) => {
  res.send("FundTrackerAI backend is running.");
});

// --------------------------------------------------
// 2. DONATION CHECKOUT (EXISTING FLOW — UNCHANGED)
// --------------------------------------------------
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { name, email, amount } = req.body;

    if (!email || !amount || amount < 1) {
      return res
        .status(400)
        .json({ error: "Missing or invalid amount/email." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "FundTrackerAI Donation",
              metadata: { donorName: name || "" }
            },
            unit_amount: amount * 100
          },
          quantity: 1
        }
      ],
      success_url: `${FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/index.html`,
      metadata: {
        donorName: name || ""
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("SESSION ERROR:", err);
    res.status(500).json({ error: "Session creation failed" });
  }
});

// --------------------------------------------------
// 3. UNIVERSAL ORDER ENGINE (NEW)
// --------------------------------------------------

/**
 * POST /create-order
 * Create an internal order FIRST (our cart), before Stripe.
 *
 * Body:
 * {
 *   "app": "LawAidAI" | "TravelFlowAI" | ...,
 *   "email": "user@example.com",
 *   "items": [
 *     {
 *       "sku": "lawaid_basic_monthly",
 *       "label": "LawAidAI Basic",
 *       "type": "subscription" | "one_time",
 *       "interval": "month" | "year" | null,
 *       "amount_cents": 999
 *     }
 *   ],
 *   "billing_mode": "one_time" | "subscription"
 * }
 */
app.post("/create-order", (req, res) => {
  try {
    const { app: appName, email, items, billing_mode } = req.body || {};

    if (!email || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Missing email or items for order."
      });
    }

    const billingMode = billing_mode || "one_time";

    // Compute total in cents (allow amount_cents or amount in dollars)
    const totalAmountCents = items.reduce((sum, item) => {
      if (!item) return sum;
      if (typeof item.amount_cents === "number") {
        return sum + item.amount_cents;
      }
      if (typeof item.amount === "number") {
        return sum + Math.round(item.amount * 100);
      }
      return sum;
    }, 0);

    if (totalAmountCents <= 0) {
      return res.status(400).json({
        success: false,
        message: "Order total must be greater than zero."
      });
    }

    const registry = readRegistry();
    const orders = registry.orders || [];

    const order_id = createOrderId();
    const now = new Date().toISOString();

    const order = {
      order_id,
      app: appName || "generic",
      email,
      items,
      billing_mode: billingMode,
      total_amount_cents: totalAmountCents,
      status: "pending_payment",
      created_at: now,
      stripe_session_id: null,
      stripe_subscription_id: null,
      soulmark: null
    };

    orders.push(order);
    registry.orders = orders;
    writeRegistry(registry);

    return res.json({
      success: true,
      order: {
        order_id: order.order_id,
        app: order.app,
        email: order.email,
        items: order.items,
        billing_mode: order.billing_mode,
        total_amount_cents: order.total_amount_cents,
        status: order.status
      }
    });
  } catch (err) {
    console.error("CREATE ORDER ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to create order."
    });
  }
});

/**
 * POST /create-checkout-session-from-order
 * Turn an internal order into a Stripe Checkout session.
 *
 * Body:
 * { "order_id": "ord-..." }
 */
app.post("/create-checkout-session-from-order", async (req, res) => {
  try {
    const { order_id } = req.body || {};
    if (!order_id) {
      return res
        .status(400)
        .json({ success: false, message: "Missing order_id." });
    }

    const registry = readRegistry();
    const orders = registry.orders || [];
    const order = orders.find(o => o.order_id === order_id);

    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found." });
    }

    if (order.status === "paid") {
      return res.status(400).json({
        success: false,
        message: "Order is already paid."
      });
    }

    const amountCents = order.total_amount_cents || 0;
    if (amountCents <= 0) {
      return res.status(400).json({
        success: false,
        message: "Order total is invalid."
      });
    }

    // Phase 1: treat everything as a one_time payment.
    // Later we can branch on order.billing_mode for true subscriptions.
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: order.email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${order.app} Order`,
              metadata: {
                order_id: order.order_id
              }
            },
            unit_amount: amountCents
          },
          quantity: 1
        }
      ],
      success_url: `${FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/index.html`,
      metadata: {
        order_id: order.order_id,
        app: order.app
      }
    });

    // Store the Stripe session ID so we can link it on verification
    order.stripe_session_id = session.id;
    registry.orders = orders;
    writeRegistry(registry);

    return res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("CHECKOUT FROM ORDER ERROR:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create checkout session." });
  }
});

// --------------------------------------------------
// 4. VERIFY PAYMENT + MINT SOULMARKⓈ
// --------------------------------------------------
app.get("/verify-donation/:id", async (req, res) => {
  const id = req.params.id;

  try {
    ensureRegistry();
    const session = await stripe.checkout.sessions.retrieve(id);

    if (!session || session.payment_status !== "paid") {
      return res.json({ verified: false, reason: "unpaid_or_missing" });
    }

    const email =
      session.customer_details?.email ||
      session.customer_email ||
      "unknown@example.com";

    const donorName =
      session.customer_details?.name ||
      session.metadata?.donorName ||
      "";

    const amount = session.amount_total || 0;
    const now = new Date().toISOString();

    const registry = readRegistry();
    const donations = registry.donations || [];
    const orders = registry.orders || [];

    let donation = donations.find(d => d.id === session.id);

    // Try to see if this session was linked to an order
    const linkedOrderId = session.metadata?.order_id || null;
    let linkedOrder = null;
    if (linkedOrderId) {
      linkedOrder = orders.find(o => o.order_id === linkedOrderId);
    }

    if (!donation) {
      // Mint new SoulMarkⓈ
      const nonce = crypto.randomUUID();
      const soulmark = crypto
        .createHash("sha256")
        .update(email + now + SOULMARK_SECRET + nonce)
        .digest("hex");

      donation = {
        id: session.id,
        name: donorName || "Donor",
        email,
        amount,
        timestamp: now,
        soulmark,
        username_created: false,
        identity_username: null,
        order_id: linkedOrderId || null
      };

      donations.push(donation);
      registry.donations = donations;
    } else {
      // Backfill any missing fields on older entries
      donation.name = donation.name || donorName || "Donor";
      donation.email = donation.email || email;
      donation.amount = donation.amount || amount;
      donation.timestamp = donation.timestamp || now;
      if (!donation.soulmark) {
        const nonce = crypto.randomUUID();
        donation.soulmark = crypto
          .createHash("sha256")
          .update(email + now + SOULMARK_SECRET + nonce)
          .digest("hex");
      }
      if (linkedOrderId && !donation.order_id) {
        donation.order_id = linkedOrderId;
      }
      registry.donations = donations;
    }

    // If there is a linked order, mark it paid and attach the SoulMarkⓈ
    if (linkedOrder) {
      linkedOrder.status = "paid";
      linkedOrder.soulmark = linkedOrder.soulmark || donation.soulmark;
      linkedOrder.updated_at = now;
      registry.orders = orders;
    }

    writeRegistry(registry);

    res.json({
      verified: true,
      entry: donation,
      order_id: linkedOrderId || null
    });
  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// --------------------------------------------------
// 5. PUBLIC DONATIONS VIEW
// --------------------------------------------------
app.get("/donations", (req, res) => {
  try {
    const registry = readRegistry();
    res.json({ donations: registry.donations || [] });
  } catch (err) {
    console.error("DONATIONS READ ERROR:", err);
    res.status(500).json({ error: "Failed to read registry" });
  }
});

// --------------------------------------------------
// 6. USERNAME AVAILABILITY
// --------------------------------------------------
app.get("/check-username/:username", (req, res) => {
  const rawUsername = req.params.username;

  if (!rawUsername) {
    return res.status(400).json({
      available: false,
      message: "Username cannot be empty."
    });
  }

  const username = rawUsername.toLowerCase();
  const registry = readRegistry();

  const taken = (registry.identities || []).some(
    i => (i.username || "").toLowerCase() === username
  );

  res.json({ available: !taken });
});

// --------------------------------------------------
// UPDATED ENDPOINT: /register
// Supports BOTH donor and non-donor signups
// --------------------------------------------------
app.post("/register", (req, res) => {
  const {
    name,
    email,
    username,
    soulmark,
    displayIdentity,
    showDonationAmount
  } = req.body;

  if (!email || !username) {
    return res.status(400).json({
      success: false,
      message: "Email and username are required."
    });
  }

  const isDonorSignup = soulmark && soulmark !== "null" && soulmark !== null;

  const registry = readRegistry();
  const identities = registry.identities || [];

  const canonicalUsername = username.toLowerCase();
  const canonicalEmail = email.toLowerCase();

  // Username conflict check
  const conflict = identities.find(
    i => (i.username || "").toLowerCase() === canonicalUsername
  );

  if (conflict) {
    return res.status(409).json({
      success: false,
      message: "Username already taken."
    });
  }

  const now = new Date().toISOString();

  // Create new identity
  const newIdentity = {
    identity_id: "ias-" + crypto.randomUUID(),
    username: canonicalUsername,
    email: canonicalEmail,
    soulmarks: [],
    registered_since: now,
    displayIdentity: displayIdentity || "username",
    showDonationAmount: !!showDonationAmount
  };

  // If donor signup, attach SoulMark
  if (isDonorSignup) {
    newIdentity.soulmarks.push(soulmark);
  }

  identities.push(newIdentity);
  registry.identities = identities;

  // If donor signup, update donations table too
  if (isDonorSignup) {
    const donations = registry.donations || [];
    donations.forEach(d => {
      if (d.email && d.email.toLowerCase() === canonicalEmail) {
        d.username_created = true;
        d.identity_username = canonicalUsername;
      }
    });
    registry.donations = donations;
  }

  writeRegistry(registry);

  return res.json({
    success: true,
    identity: {
      username: canonicalUsername,
      email: canonicalEmail,
      soulmarks: newIdentity.soulmarks,
      identity_id: newIdentity.identity_id,
      donor: isDonorSignup
    }
  });
  });

// --------------------------------------------------
// 8. START SERVER
// --------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});