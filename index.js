"use strict";

/* =====================================================
   DEXTER-LIBRARY PAYMENT API
   Express + Firebase Admin + PayChangu
===================================================== */

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;

const PAYCHANGU_SECRET_KEY =
    process.env.PAYCHANGU_SECRET_KEY || "";

const BASE_URL = (
    process.env.RENDER_BASE_URL ||
    "https://library-api-el4r.onrender.com"
).replace(/\/+$/, "");

const WEBSITE_URL =
    "https://gibsondexter.github.io/nalikule-book-access-website";

const PAYMENT_AMOUNT = 500;
const PAYMENT_CURRENCY = "MWK";
const ACCESS_DURATION_MS = 5 * 24 * 60 * 60 * 1000;

/* =====================================================
   CORS CONFIGURATION
===================================================== */

const allowedOrigins = [
    "https://gibsondexter.github.io",
    "http://localhost:3000",
    "http://127.0.0.1:5500",
    "http://localhost:5500"
];

app.use(cors({
    origin: function (origin, callback) {
        // Requests without Origin are normally server-to-server
        // or direct browser navigation requests.
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        console.warn("CORS blocked origin:", origin);

        return callback(
            new Error("Origin not allowed by CORS.")
        );
    },

    methods: ["GET", "POST", "OPTIONS"],

    allowedHeaders: [
        "Content-Type",
        "Authorization"
    ],

    optionsSuccessStatus: 204
}));

app.use(express.json({ limit: "1mb" }));

/* =====================================================
   FIREBASE ADMIN INITIALIZATION
===================================================== */

let db = null;

try {
    const serviceAccountText =
        process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccountText) {
        throw new Error(
            "FIREBASE_SERVICE_ACCOUNT environment variable is missing."
        );
    }

    const serviceAccount =
        JSON.parse(serviceAccountText);

    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }

    db = admin.firestore();

    console.log("Firebase Admin initialized successfully.");

} catch (error) {
    console.error(
        "Firebase initialization failed:",
        error.message
    );
}

/* =====================================================
   BASIC ENDPOINTS
===================================================== */

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
        payChanguConfigured: Boolean(PAYCHANGU_SECRET_KEY),
        timestamp: new Date().toISOString()
    });
});

/* =====================================================
   REQUEST LOGGING
===================================================== */

app.use((req, res, next) => {
    console.log(
        `${new Date().toISOString()} ${req.method} ${req.path}`
    );

    next();
});

/* =====================================================
   CENTRALIZED ERROR HANDLING
===================================================== */

app.use((err, req, res, next) => {
    console.error(
        "Request processing error:",
        err.message
    );

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).json({
        success: false,
        message: "The server could not process your request."
    });
});

/* =====================================================
   CONFIGURATION CHECK
===================================================== */

function requireConfiguration(res) {
    if (!db) {
        res.status(503).json({
            success: false,
            message:
                "Firebase is not ready. Please contact the administrator."
        });

        return false;
    }

    if (!PAYCHANGU_SECRET_KEY) {
        res.status(503).json({
            success: false,
            message:
                "PayChangu is not configured on the server."
        });

        return false;
    }

    return true;
}

/* =====================================================
   FIREBASE AUTHENTICATION
===================================================== */

async function authenticateStudent(req, res, next) {
    try {
        const authorization =
            req.headers.authorization || "";

        if (!authorization.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message:
                    "Please sign in before continuing."
            });
        }

        const idToken =
            authorization.substring(7).trim();

        if (!idToken) {
            return res.status(401).json({
                success: false,
                message:
                    "Your login token is missing. Please sign in again."
            });
        }

        const decodedToken =
            await admin.auth().verifyIdToken(idToken);

        req.studentUid = decodedToken.uid;
        req.authEmail = decodedToken.email || "";

        return next();

    } catch (error) {
        console.error(
            "Firebase authentication failed:",
            error.message
        );

        return res.status(401).json({
            success: false,
            message:
                "Your login session is invalid. Please sign in again."
        });
    }
}

/* =====================================================
   PAYMENT REFERENCE VALIDATION
===================================================== */

function validTxRef(value) {
    return (
        typeof value === "string" &&
        /^DEXLIB-\d{13}-[a-f0-9]{8}$/i.test(value)
    );
}

/* =====================================================
   VERIFY PAYMENT DIRECTLY WITH PAYCHANGU
===================================================== */

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

/* =====================================================
   INSPECT PAYCHANGU VERIFICATION RESPONSE
===================================================== */

function inspectVerification(verification, txRef) {
    const transaction = verification?.data || {};

    const status = String(
        transaction.status || ""
    ).toLowerCase();

    const currency = String(
        transaction.currency || ""
    ).toUpperCase();

    const reference = String(
        transaction.tx_ref || ""
    );

    const amount = Number(
        transaction.amount
    );

    const paid =
        String(verification?.status || "").toLowerCase() ===
            "success" &&

        status === "success" &&

        reference === txRef &&

        currency === PAYMENT_CURRENCY &&

        Number.isFinite(amount) &&

        amount >= PAYMENT_AMOUNT;

    return {
        paid,
        transaction,
        amount,
        currency,
        reference
    };
}

/* =====================================================
   RECORD VERIFIED PAYMENT
===================================================== */

async function markPaymentAsPaid(
    paymentRef,
    inspection
) {
    const snapshot = await paymentRef.get();

    if (!snapshot.exists) {
        throw new Error(
            "Payment record does not exist."
        );
    }

    const existingPayment = snapshot.data();

    // Preserve the original successful payment time.
    // Repeated verification must not extend access.

    if (
        existingPayment.status === "PAID" &&
        existingPayment.paidAt
    ) {
        return existingPayment;
    }

    const paidAt =
        admin.firestore.FieldValue.serverTimestamp();

    await paymentRef.update({
        status: "PAID",

        amountPaid: inspection.amount,

        currency: inspection.currency,

        verifiedTxRef: inspection.reference,

        paidAt: paidAt,

        approvedAt: paidAt,

        verifiedAt: paidAt
    });

    const updatedSnapshot =
        await paymentRef.get();

    return updatedSnapshot.data();
}

/* =====================================================
   CREATE PAYCHANGU CHECKOUT
===================================================== */

app.post(
    "/api/create-checkout",
    authenticateStudent,
    async (req, res) => {
        console.log(
            "Checkout request received."
        );

        if (!requireConfiguration(res)) {
            return;
        }

        let paymentRef = null;

        try {
            const uid = req.studentUid;

            // Load the authenticated student's profile.

            const studentSnapshot = await db
                .collection("students")
                .doc(uid)
                .get();

            if (!studentSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Your student profile was not found."
                });
            }

            const student = studentSnapshot.data();

            const firstName = String(
                student.firstName || ""
            ).trim();

            const lastName = String(
                student.lastName || ""
            ).trim();

            const regNumber = String(
                student.regNumber || ""
            ).trim();

            const email = String(
                req.authEmail ||
                student.email ||
                ""
            ).trim();

            if (
                !firstName ||
                !lastName ||
                !regNumber ||
                !email
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Your student name, registration number or email is missing."
                });
            }

            // Create a unique payment reference.

            const txRef =
                "DEXLIB-" +
                Date.now() +
                "-" +
                crypto.randomBytes(4).toString("hex");

            paymentRef = db
                .collection("payments")
                .doc(txRef);

            // Save the pending payment before contacting PayChangu.

            await paymentRef.set({
                uid: uid,

                studentId: uid,

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

                provider: "PayChangu",

                createdAt:
                    admin.firestore.FieldValue.serverTimestamp()
            });

            console.log(
                "Pending payment saved:",
                txRef
            );

            // Request a checkout session from PayChangu.

            const response = await axios.post(
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
                            "Library access fee"
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

            const responseData = response.data;

            const checkoutUrl =
                responseData?.data?.checkout_url;

            if (
                String(responseData?.status || "").toLowerCase() !==
                    "success" ||

                typeof checkoutUrl !== "string" ||

                !checkoutUrl.startsWith("https://")
            ) {
                console.error(
                    "Unexpected PayChangu response:",
                    JSON.stringify(responseData)
                );

                throw new Error(
                    "PayChangu did not return a valid checkout URL."
                );
            }

            // Save the checkout URL for administrative troubleshooting.

            await paymentRef.update({
                checkoutUrl: checkoutUrl,

                checkoutCreatedAt:
                    admin.firestore.FieldValue.serverTimestamp()
            });

            console.log(
                "PayChangu checkout created:",
                txRef
            );

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
                error.response?.status || "",

                error.response?.data ||
                error.message
            );

            if (paymentRef) {
                try {
                    await paymentRef.update({
                        checkoutError: String(
                            error.message ||
                            "Checkout failed"
                        ),

                        checkoutFailedAt:
                            admin.firestore.FieldValue.serverTimestamp()
                    });
                } catch (updateError) {
                    console.error(
                        "Could not record checkout error:",
                        updateError.message
                    );
                }
            }

            // Do not expose secret keys or full internal error details.

            const payChanguMessage =
                error.response?.data?.message;

            return res.status(500).json({
                success: false,

                message:
                    typeof payChanguMessage === "string"
                        ? payChanguMessage
                        : "Unable to create your payment. Please try again."
            });
        }
    }
);

/* =====================================================
   VERIFY A PAYMENT
===================================================== */

app.get(
    "/api/verify/:txRef",
    authenticateStudent,
    async (req, res) => {
        if (!requireConfiguration(res)) {
            return;
        }

        try {
            const txRef = String(
                req.params.txRef || ""
            );

            if (!validTxRef(txRef)) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid payment reference."
                });
            }

            const paymentRef =
                db.collection("payments").doc(txRef);

            const paymentSnapshot =
                await paymentRef.get();

            if (!paymentSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Payment record not found."
                });
            }

            const payment =
                paymentSnapshot.data();

            // Only the student who created the payment may verify it.

            if (payment.uid !== req.studentUid) {
                return res.status(403).json({
                    success: false,
                    message:
                        "You cannot access this payment record."
                });
            }

            const verification =
                await verifyWithPayChangu(txRef);

            const inspection =
                inspectVerification(
                    verification,
                    txRef
                );

            if (!inspection.paid) {
                return res.json({
                    success: true,

                    paid: false,

                    status:
                        payment.status || "PENDING",

                    message:
                        "PayChangu has not confirmed a successful payment."
                });
            }

            const updatedPayment =
                await markPaymentAsPaid(
                    paymentRef,
                    inspection
                );

            const paidAt =
                updatedPayment.paidAt;

            const paidAtMs =
                paidAt &&
                typeof paidAt.toMillis === "function"
                    ? paidAt.toMillis()
                    : 0;

            const accessExpiresAt =
                paidAtMs
                    ? paidAtMs + ACCESS_DURATION_MS
                    : null;

            const accessActive =
                Boolean(accessExpiresAt) &&
                Date.now() < accessExpiresAt;

            return res.json({
                success: true,

                paid: true,

                status: "PAID",

                amount: inspection.amount,

                currency: inspection.currency,

                tx_ref: txRef,

                regNumber: payment.regNumber,

                accessActive: accessActive,

                accessExpiresAt: accessExpiresAt
            });

        } catch (error) {
            console.error(
                "Payment verification failed:",
                error.response?.status || "",

                error.response?.data ||
                error.message
            );

            return res.status(500).json({
                success: false,

                message:
                    "Unable to verify the payment. Please try again."
            });
        }
    }
);

/* =====================================================
   PAYCHANGU CALLBACK
===================================================== */

app.get(
    "/paychangu/callback",
    async (req, res) => {
        if (!requireConfiguration(res)) {
            return;
        }

        try {
            const txRef = String(
                req.query.tx_ref || ""
            );

            if (!validTxRef(txRef)) {
                return res.redirect(
                    `${WEBSITE_URL}/payment-result.html?status=invalid_reference`
                );
            }

            const paymentRef =
                db.collection("payments").doc(txRef);

            const paymentSnapshot =
                await paymentRef.get();

            if (!paymentSnapshot.exists) {
                return res.redirect(
                    `${WEBSITE_URL}/payment-result.html?status=not_found`
                );
            }

            const payment =
                paymentSnapshot.data();

            if (!payment.uid) {
                return res.redirect(
                    `${WEBSITE_URL}/payment-result.html?status=invalid_payment`
                );
            }

            // Do not trust the callback query alone.
            // Verify the transaction directly with PayChangu.

            const verification =
                await verifyWithPayChangu(txRef);

            const inspection =
                inspectVerification(
                    verification,
                    txRef
                );

            if (!inspection.paid) {
                return res.redirect(
                    `${WEBSITE_URL}/payment-result.html` +
                    `?tx_ref=${encodeURIComponent(txRef)}` +
                    `&status=pending`
                );
            }

            await markPaymentAsPaid(
                paymentRef,
                inspection
            );

            return res.redirect(
                `${WEBSITE_URL}/payment-result.html` +
                `?tx_ref=${encodeURIComponent(txRef)}` +
                `&status=success`
            );

        } catch (error) {
            console.error(
                "PayChangu callback failed:",
                error.response?.status || "",

                error.response?.data ||
                error.message
            );

            return res.redirect(
                `${WEBSITE_URL}/payment-result.html?status=verification_error`
            );
        }
    }
);

/* =====================================================
   404 HANDLER
===================================================== */

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "API endpoint not found.",
        path: req.path
    });
});

/* =====================================================
   START SERVER
===================================================== */

app.listen(PORT, () => {
    console.log(
        `DEXTER-LIBRARY Payment API running on port ${PORT}`
    );

    console.log(
        "Website:",
        WEBSITE_URL
    );

    console.log(
        "Payment amount:",
        PAYMENT_AMOUNT,
        PAYMENT_CURRENCY
    );

    console.log(
        "Allowed website origin:",
        "https://gibsondexter.github.io"
    );
});
