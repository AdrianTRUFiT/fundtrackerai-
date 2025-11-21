// -----------------------------------------------
// FundTrackerAI Backend — Donations + Identities
// Phase-1 Anti-Fraud Locks Enabled
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

// ---------- HELPERS ----------

// Ensure registry file exists and has both arrays
function ensureRegistry() {
  try {
    if (!fs.existsSync(registryFile)) {
      console.log("🆕 Creating registry.json");
      const initial = { donations: [], identities: [] };
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
      const reset = { donations: [], identities: [] };
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
    return { donations: [], identities: [] };
  }
}

function writeRegistry(data) {
  try {
    fs.writeFileSync(registryFile, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("WRITE registry error:", err);
  }
}

// Very small Phase-1 disposable email gate
function isDisposableEmail(email) {
  if (!email || !email.includes("@")) return false;
  const domain = email.split("@")[1].toLowerCase();

  const bannedDomains = [
    "mailinator.com",
    "10minutemail.com",
    "tempmail.com",
    "guerrillamail.com",
    "trashmail.com",
    "yopmail.com",
    "sharklasers.com"
  ];

  return bannedDomains.some(d => domain === d || domain.endsWith("." + d));
}

// ---------- 1. ROOT PING ----------
app.get("/", (req, res) => {
  res.send("FundTrackerAI backend is running.");
});

// ---------- 2. CREATE CHECKOUT SESSION ----------
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
            unit_amount: amount * 100 // amount in cents
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

// ---------- 3. VERIFY PAYMENT + MINT SOULMARK ----------
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
      session.customer_details?.name || session.metadata?.donorName || "";

    const amount = session.amount_total || 0;
    const now = new Date().toISOString();

    const registry = readRegistry();
    let donation = registry.donations.find(d => d.id === session.id);

    if (!donation) {
      // Mint new SoulMark — primary identity anchor
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
      // Normalize older records
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
// Phase-1 anti-fraud:
//  - One email → one lifetime identity
//  - Username frozen after first successful registration
//  - SoulMark must already exist in donations[] for that email
//  - Simple disposable-email block
app.post("/register-username", (req, res) => {
  const { email, username, soulmark, device_id } = req.body || {};

  if (!email || !username || !soulmark) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields: email, username, soulmark."
    });
  }

  const canonicalUsername = username.toLowerCase();
  const canonicalEmail = email.toLowerCase();

  // Disposable email guard (Phase-1)
  if (isDisposableEmail(email)) {
    return res.status(400).json({
      success: false,
      message:
        "Disposable or temporary email addresses are not supported for identity registration."
    });
  }

  const registry = readRegistry();
  const identities = registry.identities || [];
  const donations = registry.donations || [];

  // 6A. SoulMark must belong to this email (hard anchor)
  const ownsSoulmark = donations.some(
    d =>
      d.soulmark === soulmark &&
      d.email &&
      d.email.toLowerCase() === canonicalEmail
  );

  if (!ownsSoulmark) {
    return res.status(400).json({
      success: false,
      message:
        "SoulMark does not belong to this email or is not found in the ledger."
    });
  }

  // 6B. Username can never be reused by a different email
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

  // 6C. Find existing identity by email (one email → one identity)
  let identity = identities.find(
    i => (i.email || "").toLowerCase() === canonicalEmail
  );

  const now = new Date().toISOString();

  if (!identity) {
    // New identity
    identity = {
      identity_id: "ias-" + crypto.randomUUID(),
      username: canonicalUsername,
      email,
      soulmarks: [soulmark],
      registered_since: now,
      device_ids: [] // reserved for future behavioral anti-fraud
    };

    if (device_id && !identity.device_ids.includes(device_id)) {
      identity.device_ids.push(device_id);
    }

    identities.push(identity);
  } else {
    // Existing identity: enforce username freeze
    const existingUsername = (identity.username || "").toLowerCase();

    if (existingUsername && existingUsername !== canonicalUsername) {
      // Email already bound to a different username → hard stop
      return res.status(409).json({
        success: false,
        message:
          "This email is already bound to a different username and cannot be reassigned."
      });
    }

    // If no username was ever set (legacy), allow first-time set
    identity.username = canonicalUsername;

    // SoulMark history list
    if (!Array.isArray(identity.soulmarks)) {
      identity.soulmarks = [];
    }
    if (!identity.soulmarks.includes(soulmark)) {
      identity.soulmarks.push(soulmark);
    }

    // Attach optional device_id for future anti-fraud (no blocking yet)
    if (!Array.isArray(identity.device_ids)) {
      identity.device_ids = [];
    }
    if (device_id && !identity.device_ids.includes(device_id)) {
      identity.device_ids.push(device_id);
    }
  }

  // 6D. Update all donations for this email with identity_username
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
    `Identity registered for ${email} (${canonicalUsername}), ${updatedCount} donation(s) updated.`
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

// ---------- 7. START SERVER ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});