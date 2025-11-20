// -----------------------------------------------
// FundTrackerAI Backend — With SoulMarkⓈ Minting
// + Device-Token Registration (Option 1)
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
// 0. APP SETUP
// -----------------------------------------------
const app = express();
app.use(express.json());
app.use(cors());

// ENV VARS
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL;
const SOULMARK_SECRET = process.env.SOULMARK_SECRET;

if (!STRIPE_SECRET_KEY || !FRONTEND_URL || !SOULMARK_SECRET) {
  console.warn(
    "⚠️  Missing one or more env vars: STRIPE_SECRET_KEY, FRONTEND_URL, SOULMARK_SECRET"
  );
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

// Resolve path relative to THIS FILE (server.js)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// registry.json lives next to server.js
const registryFile = path.join(__dirname, "registry.json");
console.log("📁 Registry path:", registryFile);

// Ensure registry.json exists and has correct structure
function ensureRegistry() {
  try {
    if (!fs.existsSync(registryFile)) {
      console.log("🆕 Creating new registry.json");
      const initial = { donations: [], users: [] };
      fs.writeFileSync(registryFile, JSON.stringify(initial, null, 2), "utf8");
      return initial;
    } else {
      const raw = fs.readFileSync(registryFile, "utf8");
      let json = JSON.parse(raw);

      if (!Array.isArray(json.donations)) json.donations = [];
      if (!Array.isArray(json.users)) json.users = [];

      // Normalize & rewrite
      fs.writeFileSync(registryFile, JSON.stringify(json, null, 2), "utf8");
      return json;
    }
  } catch (err) {
    console.error("⚠️ registry.json invalid, reinitializing:", err.message);
    const reset = { donations: [], users: [] };
    fs.writeFileSync(registryFile, JSON.stringify(reset, null, 2), "utf8");
    return reset;
  }
}

// -----------------------------------------------
// 1. ROOT PING
// -----------------------------------------------
app.get("/", (req, res) => {
  res.send("FundTrackerAI backend is running.");
});

// -----------------------------------------------
// 2. CREATE CHECKOUT SESSION
// -----------------------------------------------
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { name, email, amount } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Donation" },
            unit_amount: amount * 100 // from dollars to cents
          },
          quantity: 1
        }
      ],
      // capture the donor name for later
      metadata: {
        donor_name: name || ""
      },
      success_url: `${FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/index.html`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("SESSION ERROR:", err);
    res.status(500).json({ error: "Session creation failed" });
  }
});

// -----------------------------------------------
// 3. VERIFY PAYMENT + MINT SOULMARKⓈ
// -----------------------------------------------
app.get("/verify-donation/:id", async (req, res) => {
  try {
    const json = ensureRegistry();

    const session = await stripe.checkout.sessions.retrieve(req.params.id);

    // validate payment
    if (!session || session.payment_status !== "paid") {
      return res.json({ verified: false, reason: "unpaid_or_missing" });
    }

    const email = session.customer_details?.email || "unknown";
    const name =
      (session.metadata && session.metadata.donor_name) ||
      session.customer_details?.name ||
      "Donor";

    const amount = session.amount_total;
    const now = new Date().toISOString();
    const nonce = crypto.randomUUID();

    // generate SoulMarkⓈ
    const soulmark = crypto
      .createHash("sha256")
      .update(email + now + SOULMARK_SECRET + nonce)
      .digest("hex");

    // write event into registry
    const entry = {
      id: session.id,
      email,
      name,
      amount,
      timestamp: now,
      soulmark
    };

    json.donations.push(entry);
    fs.writeFileSync(registryFile, JSON.stringify(json, null, 2));

    // return everything so success.html can show basic receipt
    res.json({ verified: true, entry });
  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// -----------------------------------------------
// 4. REGISTER USER (device-token passwordless)
// -----------------------------------------------
app.post("/register", (req, res) => {
  try {
    const { username, email, soulmark } = req.body;

    if (!username || !email) {
      return res
        .status(400)
        .json({ error: "username and email are required" });
    }

    const json = ensureRegistry();
    if (!Array.isArray(json.users)) json.users = [];

    // normalize for comparison
    const targetEmail = email.toLowerCase();

    let user = json.users.find(
      (u) => u.email && u.email.toLowerCase() === targetEmail
    );

    if (user) {
      // Existing identity — attach new SoulMark if needed
      if (soulmark && !user.soulmarks.includes(soulmark)) {
        user.soulmarks.push(soulmark);
      }
      // always allow username update (alias evolution)
      user.username = username;
    } else {
      // New identity — create device-bound token
      const token = crypto.randomUUID();
      user = {
        username,
        email,
        token,
        soulmarks: soulmark ? [soulmark] : [],
        createdAt: new Date().toISOString()
      };
      json.users.push(user);
    }

    fs.writeFileSync(registryFile, JSON.stringify(json, null, 2));

    res.json({
      ok: true,
      user: {
        username: user.username,
        email: user.email
      },
      token: user.token
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// -----------------------------------------------
// 5. READ ALL DONATIONS
// -----------------------------------------------
app.get("/donations", (req, res) => {
  try {
    const json = ensureRegistry();
    res.json({ donations: json.donations || [] });
  } catch (err) {
    console.error("READ ERROR:", err);
    res.status(500).json({ error: "Failed to read registry" });
  }
});

// -----------------------------------------------
// 6. START SERVER
// -----------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});