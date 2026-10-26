const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log("MongoDB error:", err.message));

const User = mongoose.model(
  "User",
  new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    phone: String,
    password: String,
  })
);

const Payment = mongoose.model(
  "Payment",
  new mongoose.Schema({
    email: String,
    phone: String,
    amountKES: Number,
    checkoutRequestID: String,
    status: { type: String, default: "pending" },
    receipt: String,
    createdAt: { type: Date, default: Date.now },
  })
);

app.get("/", (req, res) => res.send("Elite backend is running"));

app.post("/signup", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: "Fill in all fields" });
    }
    const hashed = await bcrypt.hash(password, 10);
    await User.create({ name, email, phone, password: hashed });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: "Email already registered" });
    }
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "Wrong email or password" });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: "Wrong email or password" });
    res.json({ success: true, name: user.name });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ---------- M-Pesa (Daraja sandbox) ----------
const DARAJA = "https://sandbox.safaricom.co.ke";
const SHORTCODE = "174379";
const PASSKEY =
  "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";

async function getToken() {
  const auth = Buffer.from(
    process.env.DARAJA_KEY + ":" + process.env.DARAJA_SECRET
  ).toString("base64");
  const r = await fetch(
    DARAJA + "/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: "Basic " + auth } }
  );
  const data = await r.json();
  return data.access_token;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

function cleanPhone(phone) {
  let p = String(phone).replace(/\D/g, "");
  if (p.startsWith("0")) p = "254" + p.slice(1);
  if (p.startsWith("7") || p.startsWith("1")) p = "254" + p;
  return p;
}

app.post("/deposit", async (req, res) => {
  try {
    const { email, phone, amount } = req.body;
    const amountKES = Math.round(Number(amount));
    if (!email || !phone || !amountKES || amountKES < 1) {
      return res.status(400).json({ error: "Enter phone and amount" });
    }
    const msisdn = cleanPhone(phone);
    const token = await getToken();
    const ts = timestamp();
    const password = Buffer.from(SHORTCODE + PASSKEY + ts).toString("base64");
    const callbackUrl =
      (process.env.PUBLIC_URL || "https://my-elite-backend-q62s.onrender.com") +
      "/mpesa/callback";

    const r = await fetch(DARAJA + "/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        BusinessShortCode: SHORTCODE,
        Password: password,
        Timestamp: ts,
        TransactionType: "CustomerPayBillOnline",
        Amount: amountKES,
        PartyA: msisdn,
        PartyB: SHORTCODE,
        PhoneNumber: msisdn,
        CallBackURL: callbackUrl,
        AccountReference: "Elite",
        TransactionDesc: "Elite deposit",
      }),
    });
    const data = await r.json();

    if (data.ResponseCode === "0") {
      await Payment.create({
        email,
        phone: msisdn,
        amountKES,
        checkoutRequestID: data.CheckoutRequestID,
      });
      return res.json({
        success: true,
        message: "Check your phone and enter your M-Pesa PIN",
      });
    }
    res.status(400).json({
      error: data.errorMessage || data.CustomerMessage || "M-Pesa request failed",
    });
  } catch (err) {
    console.log("Deposit error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/mpesa/callback", async (req, res) => {
  try {
    const cb = req.body.Body.stkCallback;
    const update = { status: cb.ResultCode === 0 ? "paid" : "failed" };
    if (cb.ResultCode === 0 && cb.CallbackMetadata) {
      const item = cb.CallbackMetadata.Item.find(
        (i) => i.Name === "MpesaReceiptNumber"
      );
      if (item) update.receipt = item.Value;
    }
    await Payment.findOneAndUpdate(
      { checkoutRequestID: cb.CheckoutRequestID },
      update
    );
  } catch (err) {
    console.log("Callback error:", err.message);
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

app.get("/payments", async (req, res) => {
  const list = await Payment.find({ email: req.query.email })
    .sort({ createdAt: -1 })
    .limit(10);
  res.json(list);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));