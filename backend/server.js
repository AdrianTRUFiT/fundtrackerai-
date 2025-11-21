// -----------------------------------------------
// FundTrackerAI Backend — Donations + Identities + Subscriptions
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
app.use(cors());
app.use(express.json());

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL; // e.g. https://fundtrackerai.vercel.app
const SOULMARK_SECRET = process.env.SOULMARK_SECRET || "CHANGE_ME_SOULMARK_SECRET";

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

// ---------- REGISTRY HELPERS ----------
function ensureRegistry() {
  try {
    if (!fs.existsSync(registryFile)) {
      console.log("🆕 Creating registry.json");
      const initial = { donations: [], identities: [], subscriptions: [] };
      fs.writeFileSync(registryFile, JSON.stringify(initial, null, 2), "utf8");
      return;
    }

    const raw = fs.readFileSync(registryFile, "utf8") || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("⚠️ registry.json invalid JSON, backing up and resetting.");
      fs.writeFileSync(
        registryFile + ".backup-" + Date.now(),
        raw,
        "utf8"
      );
      const reset = { donations: [], identities: [], subscriptions: [] };
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
    if (!Array.isArray(parsed.subscriptions)) {
      parsed.subscriptions = [];
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
    const parsed = JSON.parse(raw);
    return {
      donations: parsed.donations || [],
      identities: parsed.identities || [],
      subscriptions: parsed.subscriptions || []
    };
  } catch (err) {
    console.error("READ registry error:", err);
    return { donations: [], identities: [], subscriptions: [] };
  }
}

function writeRegistry(data) {
  try {
    const safe = {
      donations: data.donations || [],
      identities: data.identities || [],
      subscriptions: data.subscriptions || []
    };
    fs.writeFileSync(registryFile, JSON.stringify(safe, null, 2), "utf8");
  } catch (err) {
    console.error("WRITE registry error:", err);
  }
}

// ---------- 1. ROOT PING ----------
app.get("/", (req, res) => {
  res.send("FundTrackerAI backend is running.");
});

// ---------- 2. CREATE ONE-TIME CHECKOUT SESSION (DONATIONS) ----------
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { name, email, amount } = req.body;

    if (!email || !amount || amount < 1) {
      return res.status(400).json({ error: "Missing or invalid amount/email." });
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

// ---------- 3. VERIFY PAYMENT + MINT SOULMARKⓈ ----------
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
    let donation = registry.donations.find(d => d.id === session.id);

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
        identity_username: null
      };
      registry.donations.push(donation);
      writeRegistry(registry);
    } else {
      // Ensure fields are filled even if created by older code
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
        writeRegistry(registry);
      }
    }

    res.json({ verified: true, entry: donation });
  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ---------- 4. PUBLIC DONATIONS VIEW ----------
app.get("/donations", (req, res) => {
  try {
    const registry = readRegistry();
    res.json({ donations: registry.donations || [] });
  } catch (err) {
    console.error("DONATIONS READ ERROR:", err);
    res.status(500).json({ error: "Failed to read registry" });
  }
});

// ---------- 5. USERNAME AVAILABILITY ----------
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

// ---------- 6. REGISTER USERNAME + IDENTITY ----------
app.post("/register-username", (req, res) => {
  const { email, username, soulmark } = req.body;

  if (!email || !username || !soulmark) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields: email, username, soulmark."
    });
  }

  const canonicalUsername = username.toLowerCase();
  const canonicalEmail = email.toLowerCase();

  const registry = readRegistry();
  const identities = registry.identities || [];
  const donations = registry.donations || [];

  // Check if username is taken by a different email
  const conflict = identities.find(
    i =>
      (i.username || "").toLowerCase() === canonicalUsername &&
      (i.email || "").toLowerCase() !== canonicalEmail
  );

  if (conflict) {
    return res.status(409).json({
      success: false,
      message: "Username is already taken by another identity."
    });
  }

  // Find or create identity by email
  let identity = identities.find(
    i => (i.email || "").toLowerCase() === canonicalEmail
  );

  const now = new Date().toISOString();

  if (!identity) {
    identity = {
      identity_id: "ias-" + crypto.randomUUID(),
      username: canonicalUsername,
      email,
      soulmarks: [soulmark],
      registered_since: now
    };
    identities.push(identity);
  } else {
    identity.username = canonicalUsername;
    if (!Array.isArray(identity.soulmarks)) {
      identity.soulmarks = [];
    }
    if (!identity.soulmarks.includes(soulmark)) {
      identity.soulmarks.push(soulmark);
    }
  }

  // Update all donations for this email
  let updatedCount = 0;
  donations.forEach(d => {
    if (d.email && d.email.toLowerCase() === canonicalEmail) {
      d.username_created = true;
      d.identity_username = canonicalUsername;
      updatedCount++;
    }
  });

  registry.identities = identities;
  registry.donations = donations;
  writeRegistry(registry);

  console.log(
    `Identity registered for ${email} (${canonicalUsername}), ` +
    `${updatedCount} donation(s) updated.`
  );

  res.json({
    success: true,
    message: "Identity registered successfully.",
    identity: {
      ias_username: identity.username,
      ias_email: identity.email,
      ias_soulmark: soulmark,
      ias_identity_id: identity.identity_id
    }
  });
});

// ===================================================
// 7. SUBSCRIPTIONS: ENTERPRISE LAYER (C)
// ===================================================

// 7.1 CREATE SUBSCRIPTION CHECKOUT SESSION
// Body: { email, planId, appName?, tier?, successPath?, cancelPath? }
app.post("/create-subscription-session", async (req, res) => {
  try {
    const {
      email,
      planId,      // Stripe Price ID (e.g. price_123...)
      appName,     // e.g. "LawAidAI"
      tier,        // e.g. "Premium"
      successPath, // e.g. "subscription-success.html"
      cancelPath   // e.g. "index.html"
    } = req.body;

    if (!email || !planId) {
      return res.status(400).json({ error: "Missing email or planId." });
    }

    const successPage = successPath || "subscription-success.html";
    const cancelPage = cancelPath || "index.html";

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [
        {
          price: planId,
          quantity: 1
        }
      ],
      success_url: `${FRONTEND_URL}/${successPage}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/${cancelPage}`,
      metadata: {
        appName: appName || "",
        tier: tier || ""
      },
      subscription_data: {
        metadata: {
          appName: appName || "",
          tier: tier || ""
        }
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("SUBSCRIPTION SESSION ERROR:", err);
    res.status(500).json({ error: "Subscription session creation failed" });
  }
});

// 7.2 VERIFY SUBSCRIPTION SESSION & RECORD TO REGISTRY
// Frontend will call: /verify-subscription/:session_id
app.get("/verify-subscription/:id", async (req, res) => {
  const sessionId = req.params.id;

  try {
    ensureRegistry();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (
      !session ||
      session.mode !== "subscription" ||
      session.payment_status !== "paid"
    ) {
      return res.json({
        verified: false,
        reason: "unpaid_or_not_subscription"
      });
    }

    const email =
      session.customer_details?.email ||
      session.customer_email ||
      "unknown@example.com";

    const appName = session.metadata?.appName || "";
    const tier = session.metadata?.tier || "";
    const stripeSubscriptionId = session.subscription
      ? session.subscription.toString()
      : null;

    let subscriptionDetails = null;
    if (stripeSubscriptionId) {
      subscriptionDetails = await stripe.subscriptions.retrieve(
        stripeSubscriptionId
      );
    }

    const registry = readRegistry();
    const subscriptions = registry.subscriptions || [];

    const nowIso = new Date().toISOString();

    const baseRecord = {
      subscription_id: stripeSubscriptionId,
      email,
      app: appName,
      tier,
      price_id:
        subscriptionDetails?.items?.data?.[0]?.price?.id || null,
      status: subscriptionDetails?.status || "active",
      current_period_end: subscriptionDetails?.current_period_end
        ? new Date(
            subscriptionDetails.current_period_end * 1000
          ).toISOString()
        : null,
      cancel_at_period_end: !!subscriptionDetails?.cancel_at_period_end,
      created_at: nowIso,
      updated_at: nowIso,
      checkout_session_id: session.id
    };

    let existing = subscriptions.find(
      s => s.subscription_id === stripeSubscriptionId
    );

    if (existing) {
      // Update existing record
      existing = Object.assign(existing, {
        ...baseRecord,
        created_at: existing.created_at || baseRecord.created_at
      });
    } else {
      subscriptions.push(baseRecord);
      existing = baseRecord;
    }

    registry.subscriptions = subscriptions;
    writeRegistry(registry);

    res.json({
      verified: true,
      subscription: existing
    });
  } catch (err) {
    console.error("VERIFY SUBSCRIPTION ERROR:", err);
    res.status(500).json({ error: "Subscription verification failed" });
  }
});

// 7.3 PUBLIC / INTERNAL VIEW OF SUBSCRIPTIONS
app.get("/subscriptions", (req, res) => {
  try {
    const registry = readRegistry();
    res.json({ subscriptions: registry.subscriptions || [] });
  } catch (err) {
    console.error("SUBSCRIPTIONS READ ERROR:", err);
    res.status(500).json({ error: "Failed to read subscriptions" });
  }
});

// ---------- 8. START SERVER ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});