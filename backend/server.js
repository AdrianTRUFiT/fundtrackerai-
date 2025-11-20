// -----------------------------------------------
// FundTrackerAI Backend — Donations + Identity
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

// -----------------------------------------------
// 0. APP + ENV SETUP
// -----------------------------------------------
const app = express();
app.use(express.json());
app.use(cors());

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL;
const SOULMARK_SECRET = process.env.SOULMARK_SECRET || "change-me";

if (!STRIPE_SECRET_KEY || !FRONTEND_URL || !SOULMARK_SECRET) {
  console.warn(
    "⚠️  Missing env vars. Required: STRIPE_SECRET_KEY, FRONTEND_URL, SOULMARK_SECRET"
  );
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

// ESM-friendly __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// registry.json lives NEXT TO server.js
const registryFile = path.join(__dirname, "registry.json");
console.log("📁 Registry path:", registryFile);

// -----------------------------------------------
// 1. REGISTRY HELPERS
// -----------------------------------------------
function ensureRegistry() {
  try {
    if (!fs.existsSync(registryFile)) {
      console.log("🆕 Creating new registry.json");
      const initial = { donations: [], identities: [] };
      fs.writeFileSync(registryFile, JSON.stringify(initial, null, 2), "utf8");
      return;
    }

    const raw = fs.readFileSync(registryFile, "utf8");
    const parsed = JSON.parse(raw);

    // If old format, upgrade it
    if (!parsed.donations || !Array.isArray(parsed.donations)) {
      parsed.donations = [];
    }
    if (!parsed.identities || !Array.isArray(parsed.identities)) {
      parsed.identities = [];
    }

    fs.writeFileSync(
      registryFile,
      JSON.stringify(
        { donations: parsed.donations, identities: parsed.identities },
        null,
        2
      ),
      "utf8"
    );
  } catch (err) {
    console.error("⚠️ registry.json invalid, resetting:", err.message);
    const fallback = { donations: [], identities: [] };
    fs.writeFileSync(registryFile, JSON.stringify(fallback, null, 2), "utf8");
  }
}

function readRegistry() {
  ensureRegistry();
  const raw = fs.readFileSync(registryFile, "utf8");
  return JSON.parse(raw);
}

function writeRegistry(data) {
  fs.writeFileSync(registryFile, JSON.stringify(data, null, 2), "utf8");
}

// Run once at startup
ensureRegistry();

// -----------------------------------------------
// 2. ROOT PING
// -----------------------------------------------
app.get("/", (req, res) => {
  res.send("FundTrackerAI backend is running.");
});

// -----------------------------------------------
// 3. CREATE CHECKOUT SESSION
// -----------------------------------------------
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { name, email, amount } = req.body;

    if (!name || !email || !amount || amount < 1) {
      return res
        .status(400)
        .json({ error: "Name, email, and valid amount are required." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "FundTrackerAI Donation" },
            unit_amount: amount * 100, // dollars → cents
          },
          quantity: 1,
        },
      ],
      metadata: { name },
      success_url: `${FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/index.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("SESSION ERROR:", err);
    res.status(500).json({ error: "Session creation failed" });
  }
});

// -----------------------------------------------
// 4. VERIFY PAYMENT + MINT SOULMARK
// -----------------------------------------------
app.get("/verify-donation/:id", async (req, res) => {
  try {
    const sessionId = req.params.id;
    if (!sessionId) {
      return res.json({ verified: false, reason: "missing_session_id" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session || session.payment_status !== "paid") {
      return res.json({ verified: false, reason: "unpaid_or_missing" });
    }

    const registry = readRegistry();

    // Idempotency: if already recorded, just return existing entry
    const existing = registry.donations.find((d) => d.id === session.id);
    if (existing) {
      return res.json({ verified: true, entry: existing });
    }

    const email =
      session.customer_details?.email ||
      session.customer_email ||
      "unknown@example.com";
    const name = session.metadata?.name || "Donor";
    const amount = session.amount_total || 0;
    const now = new Date().toISOString();
    const nonce = crypto.randomUUID();

    const soulmark = crypto
      .createHash("sha256")
      .update(email + now + SOULMARK_SECRET + nonce)
      .digest("hex");

    const entry = {
      id: session.id,
      email,
      name,
      amount,
      timestamp: now,
      soulmark,
      username_created: false,
      identity_username: null,
    };

    registry.donations.push(entry);
    writeRegistry(registry);

    res.json({ verified: true, entry });
  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// -----------------------------------------------
// 5. USERNAME + IDENTITY ENDPOINTS
// -----------------------------------------------

// GET /check-username/:username
// username is full form, e.g. "jane@iascendai"
app.get("/check-username/:username", (req, res) => {
  try {
    const rawUsername = req.params.username;
    if (!rawUsername) {
      return res
        .status(400)
        .json({ available: false, message: "Username required." });
    }

    const username = rawUsername.toLowerCase();
    const registry = readRegistry();

    const taken = registry.identities.some(
      (i) => (i.username || "").toLowerCase() === username
    );

    res.json({ available: !taken });
  } catch (err) {
    console.error("CHECK USERNAME ERROR:", err);
    res.status(500).json({ available: false, message: "Server error." });
  }
});

// POST /register-username
// body: { email, username, soulmark }
app.post("/register-username", (req, res) => {
  try {
    const { email, username, soulmark } = req.body;

    if (!email || !username || !soulmark) {
      return res.status(400).json({
        success: false,
        message: "email, username, and soulmark are required.",
      });
    }

    const cleanUsername = String(username).toLowerCase();
    const cleanEmail = String(email).toLowerCase();

    const registry = readRegistry();

    // 1. Prevent username hijack by different email
    const usernameOwner = registry.identities.find(
      (i) => (i.username || "").toLowerCase() === cleanUsername
    );
    if (usernameOwner && usernameOwner.email.toLowerCase() !== cleanEmail) {
      return res.status(409).json({
        success: false,
        message: "Username is already taken by another identity.",
      });
    }

    // 2. Find or create identity by email
    let identity = registry.identities.find(
      (i) => (i.email || "").toLowerCase() === cleanEmail
    );
    let created = false;

    if (!identity) {
      identity = {
        identity_id: `ias-id-${crypto.randomUUID()}`,
        username: cleanUsername,
        email,
        soulmarks: [soulmark],
        registered_since: new Date().toISOString(),
      };
      registry.identities.push(identity);
      created = true;
    } else {
      identity.username = cleanUsername; // allow upgrade to username
      if (!identity.soulmarks.includes(soulmark)) {
        identity.soulmarks.push(soulmark);
      }
    }

    // 3. Update all donations for this email
    let updatedCount = 0;
    registry.donations.forEach((d) => {
      if ((d.email || "").toLowerCase() === cleanEmail) {
        d.username_created = true;
        d.identity_username = cleanUsername;
        updatedCount++;
      }
    });

    writeRegistry(registry);

    console.log(
      `✅ Identity ${created ? "created" : "updated"} for ${email}. Donations updated: ${updatedCount}`
    );

    res.status(created ? 201 : 200).json({
      success: true,
      message: created
        ? "Identity created successfully."
        : "Identity updated successfully.",
      identity: {
        ias_username: identity.username,
        ias_email: identity.email,
        ias_soulmark: soulmark,
        ias_identity_id: identity.identity_id,
      },
    });
  } catch (err) {
    console.error("REGISTER USERNAME ERROR:", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// -----------------------------------------------
// 6. DONATION REGISTRY READ (for dashboards)
// -----------------------------------------------
app.get("/donations", (req, res) => {
  try {
    const registry = readRegistry();
    res.json({ donations: registry.donations || [] });
  } catch (err) {
    console.error("READ DONATIONS ERROR:", err);
    res.status(500).json({ error: "Failed to read registry" });
  }
});

// (Optional) expose identities list internally later if needed.
// For now we keep it private, so no /identities route.

// -----------------------------------------------
// 7. START SERVER
// -----------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 FundTrackerAI backend running on port ${PORT}`);
});