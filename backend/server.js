import express from "express";
import Stripe from "stripe";
import fs from "fs";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// ENV
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL;

const stripe = new Stripe(STRIPE_SECRET_KEY);

// Registry file path
const registryFile = path.join(process.cwd(), "backend", "registry.json");

// 1. CREATE CHECKOUT SESSION
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "FundTracker Donation" },
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

// 2. VERIFY DONATION
app.get("/verify-donation/:id", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);

    if (!session || session.payment_status !== "paid") {
      return res.status(400).json({ verified: false });
    }

    // Record donation
    const entry = {
      id: session.id,
      amount: session.amount_total,
      email: session.customer_details?.email || "unknown",
      timestamp: new Date().toISOString()
    };

    const current = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    current.donations.push(entry);
    fs.writeFileSync(registryFile, JSON.stringify(current, null, 2));

    res.json({ verified: true, entry });

  } catch (err) {
    console.error("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// START SERVER
app.listen(10000, () => {
  console.log("Backend running on port 10000");
});