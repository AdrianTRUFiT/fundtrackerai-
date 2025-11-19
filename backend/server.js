// -----------------------------------------------
// FundTrackerAI Backend — With SoulMark Minting
// -----------------------------------------------

import express from "express";
import Stripe from "stripe";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";

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
const SOULMARK_SECRET = process.env.SOULMARK_SECRET;   // NEW

const stripe = new Stripe(STRIPE_SECRET_KEY);

// registry.json is inside backend/
const registryFile = path.join(process.cwd(), "backend", "registry.json");

console.log("📁 Registry path:", registryFile);

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
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Donation" },
            unit_amount: 100
          },
          quantity: 1
        }
      ],
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
// 3. VERIFY PAYMENT + MINT SOULMARK
// -----------------------------------------------
app.get("/verify-donation/:id", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);

    // 3A — validate payment
    if (!session || session.payment_status !== "paid") {
      return res.json({ verified: false });
    }

    const email = session.customer_details?.email || "unknown";
    const amount = session.amount_total;
    const now = new Date().toISOString();
    const nonce = crypto.randomUUID();

    // 3B — generate SoulMark
    const soulmark = crypto
      .createHash("sha256")
      .update(email + now + SOULMARK_SECRET + nonce)
      .digest("hex");

    // 3C — write event into registry
    const entry = {
      id: session.id,
      email,
      amount,
      timestamp: now,
      soulmark
    };

    const json = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    json.donations.push(entry);
    fs.writeFileSync(registryFile, JSON.stringify(json, null, 2));

    // return everything so success.html can display it
    res.json({ verified: true, entry });

  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// -----------------------------------------------
// 4. READ ALL DONATIONS
// -----------------------------------------------
app.get("/donations", (req, res) => {
  try {
    const json = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    res.json(json);
  } catch (err) {
    console.error("READ ERROR:", err);
    res.status(500).json({ error: "Failed to read registry" });
  }
});

// -----------------------------------------------
// 5. START SERVER
// -----------------------------------------------
app.listen(10000, () => {
  console.log("Backend running on port 10000");
});