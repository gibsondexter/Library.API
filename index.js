"use strict";

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
const crypto = require("crypto");

const app = express();

app.use(cors({
    origin: [
        "https://gibsondexter.github.io"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

const PORT = process.env.PORT || 10000;

const PAYCHANGU_SECRET_KEY =
    process.env.PAYCHANGU_SECRET_KEY;

const BASE_URL =
    process.env.RENDER_BASE_URL ||
    "https://payment-api-j375.onrender.com";

const WEBSITE_URL =
    "https://gibsondexter.github.io/nalikule-book-access-website";

const PAYMENT_AMOUNT = 500;
const PAYMENT_CURRENCY = "MWK";

let db;

/* ------------------------------------------
   FIREBASE ADMIN INITIALIZATION
------------------------------------------ */

try {
    const serviceAccountText =
        process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccountText) {
        throw new Error(
            "FIREBASE_SERVICE_ACCOUNT is missing in Render."
        );
    }

    const serviceAccount = JSON.parse(serviceAccountText);

    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }

    db = admin.firestore();

    console.log("Firebase Admin initialized.");

} catch (error) {
    console.error(
        "Firebase initialization error:",
        error.message
    );
}

/* ------------------------------------------
   HEALTH CHECK
------------------------------------------ */

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "DEXTER-LIBRARY Payment API is running."
    });
});

app.get("/health", (req, res) => {
    res.json({
        success: true,
        service: "DEXTER-LIBRARY Payment API",
        firebaseReady: Boolean(db),
        payChanguConfigured: Boolean(PAYCHANGU_SECRET_KEY)
    });
});

/* ------------------------------------------
   REQUIRE CONFIGURATION
------------------------------------------ */

function requireConfiguration(res) {
    if (!db) {
        res.status(503).json({
            success: false,
            message: "Firebase is not configured on the server."
        });

        return false;
    }

    if (!PAYCHANGU_SECRET_KEY) {
        res.status(503).json({
            success: false,
            message: "PayChangu is not configured on the server."
        });

        return false;
    }

    return true;
}

/* ------------------------------------------
   VERIFY FIREBASE LOGIN
------------------------------------------ */

async function authenticateStudent(req, res, next) {
    try {
        const authorization = req.headers.authorization || "";

        if (!authorization.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Please log in to continue."
            });
        }

        const idToken = authorization.substring(7);

        const decodedToken =
            await admin.auth().verifyIdToken(idToken);

        req.studentUid = decodedToken.uid;
        req.authEmail = decodedToken.email || "";

        next();

    } catch (error) {
        console.error("Authentication error:", error.message);

        return res.status(401).json({
            success: false,
            message: "Your login session is invalid. Please log in again."
        });
    }
}

/* ------------------------------------------
   CREATE PAYCHANGU CHECKOUT
------------------------------------------ */

app.post(
    "/api/create-checkout",
    authenticateStudent,
    async (req, res) => {

        if (!requireConfiguration(res)) return;

        try {
            const uid = req.studentUid;

            /*
             * Never trust the student's submitted name,
             * email, registration number, or amount.
             * Retrieve the profile from Firestore.
             */

            const studentRef =
                db.collection("students").doc(uid);

            const studentSnapshot = await studentRef.get();

            if (!studentSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    message: "Your student profile was not found."
                });
            }

            const student = studentSnapshot.data();

            const firstName =
                String(student.firstName || "").trim();

            const lastName =
                String(student.lastName || "").trim();

            const regNumber =
                String(student.regNumber || "").trim();

            const email =
                String(req.authEmail || student.email || "").trim();

            if (!firstName || !lastName || !regNumber || !email) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Your name, registration number, or email is missing. Please contact the administrator."
                });
            }

            /*
             * Unique reference for this payment.
             */

            const txRef =
                "DEXLIB-" +
                Date.now() +
                "-" +
                crypto.randomBytes(4).toString("hex");

            /*
             * Create a pending Firestore payment record.
             */

            const paymentRef =
                db.collection("payments").doc(txRef);

            await paymentRef.set({
                uid: uid,
                name: `${firstName} ${lastName}`,
                firstName: firstName,
                lastName: lastName,
                email: email,
                regNumber: regNumber,
                transactionId: txRef,
                tx_ref: txRef,
                amount: PAYMENT_AMOUNT,
                currency: PAYMENT_CURRENCY,
                status: "PENDING",
                createdAt:
                    admin.firestore.FieldValue.serverTimestamp(),
                provider: "PayChangu"
            });

            /*
             * Create a fresh PayChangu checkout session.
             *
             * The API accepts first_name, last_name,
             * email, amount, currency and tx_ref.
             */

            const paymentResponse = await axios.post(
                "https://api.paychangu.com/payment",
                {
                    amount: String(PAYMENT_AMOUNT),
                    currency: PAYMENT_CURRENCY,
                    tx_ref: txRef,
                    first_name: firstName,
                    last_name: lastName,
                    email: email,

                    callback_url:
                        `${BASE_URL}/paychangu/callback`,

                    return_url:
                        `${WEBSITE_URL}/payment-result.html`,

                    customization: {
                        title: "DEXTER-LIBRARY Access",
                        description:
                            "Library access registration fee"
                    },

                    meta: {
                        student_uid: uid,
                        reg_number: regNumber,
                        payment_type: "library_access"
                    }
                },
                {
                    headers: {
                        Authorization:
                            `Bearer ${PAYCHANGU_SECRET_KEY}`,
                        Accept: "application/json",
                        "Content-Type": "application/json"
                    },
                    timeout: 30000
                }
            );

            const responseData = paymentResponse.data;

            const checkoutUrl =
                responseData &&
                responseData.data &&
                responseData.data.checkout_url;

            if (
                responseData.status !== "success" ||
                !checkoutUrl
            ) {
                throw new Error(
                    "PayChangu did not return a checkout URL."
                );
            }

            /*
             * Save the reference and checkout details.
             */

            await paymentRef.update({
                checkoutUrl: checkoutUrl,
                checkoutCreatedAt:
                    admin.firestore.FieldValue.serverTimestamp()
            });

            return res.json({
                success: true,
                checkoutUrl: checkoutUrl,
                tx_ref: txRef,
                amount: PAYMENT_AMOUNT,
                currency: PAYMENT_CURRENCY
            });

        } catch (error) {
            console.error(
                "Checkout creation failed:",
                error.response?.data || error.message
            );

            return res.status(500).json({
                success: false,
                message:
                    error.response?.data?.message ||
                    "Unable to create your payment. Please try again."
            });
        }
    }
);

/* ------------------------------------------
   VERIFY PAYMENT DIRECTLY WITH PAYCHANGU
------------------------------------------ */

async function verifyWithPayChangu(txRef) {
    const response = await axios.get(
        "https://api.paychangu.com/verify-payment/" +
        encodeURIComponent(txRef),
        {
            headers: {
                Authorization:
                    `Bearer ${PAYCHANGU_SECRET_KEY}`,
                Accept: "application/json"
            },
            timeout: 30000
        }
    );

    return response.data;
}

/* ------------------------------------------
   CHECK A PAYMENT STATUS
------------------------------------------ */

app.get(
    "/api/verify/:txRef",
    authenticateStudent,
    async (req, res) => {

        if (!requireConfiguration(res)) return;

        try {
            const txRef = String(req.params.txRef || "");

            const paymentRef =
                db.collection("payments").doc(txRef);

            const paymentSnapshot = await paymentRef.get();

            if (!paymentSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    message: "Payment record not found."
                });
            }

            const payment = paymentSnapshot.data();

            /*
             * Students can only check their own payment.
             */

            if (payment.uid !== req.studentUid) {
                return res.status(403).json({
                    success: false,
                    message: "You cannot access this payment record."
                });
            }

            /*
             * Reuse verified PAID status.
             */

            if (payment.status === "PAID") {
                return res.json({
                    success: true,
                    paid: true,
                    status: "PAID",
                    amount: payment.amount,
                    regNumber: payment.regNumber
                });
            }

            /*
             * Ask PayChangu for the real transaction status.
             */

            const verification =
                await verifyWithPayChangu(txRef);

            const transaction = verification.data || {};

            const verifiedStatus =
                String(transaction.status || "").toLowerCase();

            const verifiedAmount =
                Number(transaction.amount);

            const verifiedCurrency =
                String(transaction.currency || "").toUpperCase();

            const verifiedReference =
                String(transaction.tx_ref || "");

            const paymentSucceeded =
                verification.status === "success" &&
                verifiedStatus === "success" &&
                verifiedReference === txRef &&
                verifiedCurrency === PAYMENT_CURRENCY &&
                verifiedAmount >= PAYMENT_AMOUNT;

            if (paymentSucceeded) {

                await paymentRef.update({
                    status: "PAID",
                    amountPaid: verifiedAmount,
                    currency: verifiedCurrency,
                    verifiedTxRef: verifiedReference,
                    approvedAt:
                        admin.firestore.FieldValue.serverTimestamp()
                });

                return res.json({
                    success: true,
                    paid: true,
                    status: "PAID",
                    amount: verifiedAmount,
                    regNumber: payment.regNumber
                });
            }

            return res.json({
                success: true,
                paid: false,
                status: payment.status || "PENDING",
                message:
                    "PayChangu has not confirmed a successful payment."
            });

        } catch (error) {
            console.error(
                "Payment verification error:",
                error.response?.data || error.message
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to verify the payment at this time."
            });
        }
    }
);

/* ------------------------------------------
   PAYCHANGU CALLBACK
------------------------------------------ */

app.get("/paychangu/callback", async (req, res) => {

    if (!requireConfiguration(res)) return;

    try {
        const txRef = String(req.query.tx_ref || "");

        if (!txRef) {
            return res.redirect(
                `${WEBSITE_URL}/payment-result.html?status=missing_reference`
            );
        }

        const paymentRef =
            db.collection("payments").doc(txRef);

        const paymentSnapshot = await paymentRef.get();

        if (!paymentSnapshot.exists) {
            return res.redirect(
                `${WEBSITE_URL}/payment-result.html?status=not_found`
            );
        }

        /*
         * Always verify server-side. Do not trust
         * the status in the redirect URL.
         */

        const verification =
            await verifyWithPayChangu(txRef);

        const transaction = verification.data || {};

        const verifiedStatus =
            String(transaction.status || "").toLowerCase();

        const verifiedAmount =
            Number(transaction.amount);

        const verifiedCurrency =
            String(transaction.currency || "").toUpperCase();

        const verifiedReference =
            String(transaction.tx_ref || "");

        const isPaid =
            verification.status === "success" &&
            verifiedStatus === "success" &&
            verifiedReference === txRef &&
            verifiedCurrency === PAYMENT_CURRENCY &&
            verifiedAmount >= PAYMENT_AMOUNT;

        if (isPaid) {
            await paymentRef.update({
                status: "PAID",
                amountPaid: verifiedAmount,
                currency: verifiedCurrency,
                verifiedTxRef: verifiedReference,
                approvedAt:
                    admin.firestore.FieldValue.serverTimestamp()
            });
        }

        return res.redirect(
            `${WEBSITE_URL}/payment-result.html` +
            `?tx_ref=${encodeURIComponent(txRef)}` +
            `&status=${isPaid ? "success" : "pending"}`
        );

    } catch (error) {
        console.error(
            "PayChangu callback error:",
            error.response?.data || error.message
        );

        return res.redirect(
            `${WEBSITE_URL}/payment-result.html?status=verification_error`
        );
    }
});

/* ------------------------------------------
   START SERVER
------------------------------------------ */

app.listen(PORT, () => {
    console.log(
        `DEXTER-LIBRARY Payment API running on port ${PORT}`
    );
});
