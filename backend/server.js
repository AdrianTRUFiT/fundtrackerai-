// -----------------------------------------------
// FundTrackerAI Backend — Donation + Identity Engine
// JSON Registry Version (Backend B)
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
  console.warn("⚠️ Missing env vars: STRIPE_SECRET_KEY, FRONTEND_URL, SOULMARK_SECRET");
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

// Resolve path relative to THIS FILE
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// registry.json lives next to server.js
const registryFile = path.join(__dirname, "registry.json");

// -----------------------------------------------
// 1. Ensure registry.json is valid
// -----------------------------------------------
function ensureRegistry() {
  try {
    if (!fs.existsSync(registryFile)) {
      console.log("🆕 Creating fresh registry.json");
      fs.writeFileSync(
        registryFile,
        JSON.stringify({ donations: [], identities: [] }, null, 2),
        "utf8"
      );
      return;
    }

    const raw = fs.readFileSync(registryFile, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed.donations) parsed.donations = [];
    if (!parsed.identities) parsed.identities = [];

    fs.writeFileSync(registryFile, JSON.stringify(parsed, null, 2));

  } catch (err) {
    console.error("⚠️ registry.json corrupted — resetting.", err);
    fs.writeFileSync(
      registryFile,
      JSON.stringify({ donations: [], identities: [] }, null, 2),
      "utf8"
    );
  }
}

ensureRegistry();

// -----------------------------------------------
// Helpers
// -----------------------------------------------
function readRegistry() {
  ensureRegistry();
  return JSON.parse(fs.readFileSync(registryFile, "utf8"));
}

function writeRegistry(data) {
  fs.writeFileSync(registryFile, JSON.stringify(data, null, 2));
}

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

    if (!name || !email || !amount) {
      return res.status(400).json({ error: "Missing name, email, or amount" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Donation" },
            unit_amount: amount * 100
          },
          quantity: 1
        }
      ],
      success_url: `${FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/index.html`,
      metadata: { name }
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
    const session = await stripe.checkout.sessions.retrieve(req.params.id);

    if (!session || session.payment_status !== "paid") {
      return res.json({ verified: false });
    }

    const name = session.metadata?.name || "";
    const email = session.customer_details?.email || "unknown";
    const amount = session.amount_total;

    const now = new Date().toISOString();
    const nonce = crypto.randomUUID();

    const soulmark = crypto
      .createHash("sha256")
      .update(email + now + SOULMARK_SECRET + nonce)
      .digest("hex");

    const entry = {
      id: session.id,
      name,
      email,
      amount,
      timestamp: now,
      soulmark,
      username_created: false,
      identity_username: null
    };

    const data = readRegistry();
    data.donations.push(entry);
    writeRegistry(data);

    res.json({ verified: true, entry });

  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// -----------------------------------------------
// 5. USERNAME CHECK
// -----------------------------------------------
app.get("/check-username/:username", (req, res) => {
  const username = req.params.username.toLowerCase();
  const data = readRegistry();

  const exists = data.identities.some(
    (u) => u.username.toLowerCase() === username
  );

  res.json({ available: !exists });
});

// -----------------------------------------------
// 6. REGISTER USERNAME
// -----------------------------------------------
app.post("/register-username", (req, res) => {
  const { email, username, soulmark } = req.body;

  if (!email || !username || !soulmark) {
    return res.status(400).json({ success: false, message: "Missing fields." });
  }

  const data = readRegistry();

  const taken = data.identities.find(
    (u) =>
      u.username.toLowerCase() === username.toLowerCase() &&
      u.email.toLowerCase() !== email.toLowerCase()
  );

  if (taken) {
    return res.status(409).json({ success: false, message: "Username taken." });
  }

  let identity = data.identities.find(
    (i) => i.email.toLowerCase() === email.toLowerCase()
  );

  if (!identity) {
    identity = {
      identity_id: "ias-" + crypto.randomUUID(),
      email,
      username,
      soulmarks: [soulmark],
      registered_since: new Date().toISOString()
    };
    data.identities.push(identity);
  } else {
    identity.username = username;
    if (!identity.soulmarks.includes(soulmark)) {
      identity.soulmarks.push(soulmark);
    }
  }

  data.donations.forEach((d) => {
    if (d.email.toLowerCase() === email.toLowerCase()) {
      d.username_created = true;
      d.identity_username = username;
    }
  });

  writeRegistry(data);

  res.json({
    success: true,
    identity: {
      username,
      email,
      soulmark,
      identity_id: identity.identity_id
    }
  });
});

// -----------------------------------------------
// 7. READ DONATIONS (User Receipts Page)
// -----------------------------------------------
app.get("/donations", (req, res) => {
  const data = readRegistry();
  res.json(data.donations);
});

// -----------------------------------------------
// 8. READ IDENTITIES (Soul Registry Page)
// -----------------------------------------------
app.get("/identities", (req, res) => {
  const data = readRegistry();
  res.json(data.identities);
});

// -----------------------------------------------
// 9. START SERVER
// -----------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
