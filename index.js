"use strict";

/* =====================================================
   DEXTER-LIBRARY PAYMENT API
   Express + Firebase Admin + PayChangu

   Payment: MK500
   Access: 5 days

   Successful payment flow:
   PayChangu
       -> Render callback
       -> Verify with PayChangu
       -> Update Firebase
       -> Redirect to materials.html
===================================================== */

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
const crypto = require("crypto");

const app = express();

const PORT = Number(process.env.PORT) || 10000;

const PAYCHANGU_SECRET_KEY =
    process.env.PAYCHANGU_SECRET_KEY || "";

const BASE_URL = (
    process.env.RENDER_BASE_URL ||
    "https://library-api-el4r.onrender.com"
).replace(/\/+$/, "");

const WEBSITE_URL =
    "https://gibsondexter.github.io/nalikule-book-access-website";

const MATERIALS_URL =
    `${WEBSITE_URL}/materials.html`;

const PAYMENT_URL =
    `${WEBSITE_URL}/payment.html`;

const PAYMENT_AMOUNT = 500;

const PAYMENT_CURRENCY = "MWK";

const ACCESS_DURATION_MS =
    5 * 24 * 60 * 60 * 1000;

const PAYCHANGU_PAYMENT_URL =
    "https://api.paychangu.com/payment";

const PAYCHANGU_VERIFY_URL =
    "https://api.paychangu.com/verify-payment/";

/* =====================================================
   MIDDLEWARE
===================================================== */

const allowedOrigins = [
    "https://gibsondexter.github.io",
    "http://localhost:3000",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
];

app.use(cors({
    origin: function (origin, callback) {
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

app.use(express.json({
    limit: "1mb"
}));

app.use(express.urlencoded({
    extended: false,
    limit: "1mb"
}));

/* =====================================================
   REQUEST LOGGING

   Do not log authorization headers or secret keys.
===================================================== */

app.use((req, res, next) => {
    console.log(
        `${new Date().toISOString()} ${req.method} ${req.path}`
    );

    res.setHeader("Cache-Control", "no-store");

    next();
});

/* =====================================================
   FIREBASE ADMIN INITIALIZATION
===================================================== */

let db = null;

try {
    const serviceAccountText =
        process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccountText) {
        throw new Error(
            "FIREBASE_SERVICE_ACCOUNT is missing."
        );
    }

    const serviceAccount =
        JSON.parse(serviceAccountText);

    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(
                serviceAccount
            )
        });
    }

    db = admin.firestore();

    console.log(
        "Firebase Admin initialized successfully."
    );

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
        service: "DEXTER-LIBRARY Payment API",
        message: "Payment API is running."
    });
});

app.get("/health", (req, res) => {
    res.status(
        db && PAYCHANGU_SECRET_KEY ? 200 : 503
    ).json({
        success: Boolean(
            db && PAYCHANGU_SECRET_KEY
        ),

        service: "DEXTER-LIBRARY Payment API",

        firebaseReady: Boolean(db),

        payChanguConfigured:
            Boolean(PAYCHANGU_SECRET_KEY),

        timestamp: new Date().toISOString()
    });
});

/* =====================================================
   CONFIGURATION CHECK
===================================================== */

function configurationReady() {
    return Boolean(
        db &&
        PAYCHANGU_SECRET_KEY
    );
}

function requireConfiguration(res) {
    if (!db) {
        res.status(503).json({
            success: false,
            message: "Firebase is not ready."
        });

        return false;
    }

    if (!PAYCHANGU_SECRET_KEY) {
        res.status(503).json({
            success: false,
            message: "PayChangu is not configured."
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
                message: "Please sign in before continuing."
            });
        }

        const idToken =
            authorization.substring(7).trim();

        if (!idToken) {
            return res.status(401).json({
                success: false,
                message: "Your login token is missing."
            });
        }

        const decodedToken =
            await admin.auth().verifyIdToken(idToken);

        req.studentUid = decodedToken.uid;

        req.authEmail =
            decodedToken.email || "";

        return next();

    } catch (error) {
        console.error(
            "Student authentication failed:",
            error.message
        );

        return res.status(401).json({
            success: false,
            message: "Your login session is invalid."
        });
    }
}

/* =====================================================
   TRANSACTION REFERENCE VALIDATION
===================================================== */

function validTxRef(value) {
    return (
        typeof value === "string" &&
        /^DEXLIB-\d{13}-[a-f0-9]{8}$/i.test(value)
    );
}

/* =====================================================
   NETWORK RETRY HELPER

   Retries only transient failures.
   Checkout creation is deliberately not retried
   automatically because that could create duplicate
   payment sessions.
===================================================== */

function isTransientNetworkError(error) {
    const status = error.response?.status;

    return (
        !error.response ||
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status >= 500
    );
}

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

/* =====================================================
   VERIFY TRANSACTION WITH PAYCHANGU

   Read-only verification can be retried safely.
===================================================== */

async function verifyWithPayChangu(txRef) {
    let lastError;

    const maximumAttempts = 3;

    for (
        let attempt = 1;
        attempt <= maximumAttempts;
        attempt++
    ) {
        try {
            console.log(
                `PayChangu verification attempt ${attempt}/${maximumAttempts}:`,
                txRef
            );

            const response = await axios.get(
                PAYCHANGU_VERIFY_URL +
                    encodeURIComponent(txRef),

                {
                    headers: {
                        Authorization:
                            `Bearer ${PAYCHANGU_SECRET_KEY}`,

                        Accept: "application/json"
                    },

                    timeout: 45000,

                    validateStatus: status =>
                        status >= 200 && status < 300
                }
            );

            return response.data;

        } catch (error) {
            lastError = error;

            console.error(
                "PayChangu verification request failed:",
                JSON.stringify({
                    txRef: txRef,
                    attempt: attempt,
                    httpStatus: error.response?.status || null,
                    code: error.code || null,
                    message: error.message
                })
            );

            if (
                attempt >= maximumAttempts ||
                !isTransientNetworkError(error)
            ) {
                break;
            }

            await sleep(attempt * 1000);
        }
    }

    throw lastError || new Error(
        "PayChangu verification failed."
    );
}

/* =====================================================
   NORMALISE PAYCHANGU VERIFICATION RESPONSE

   Official verification responses contain fields such
   as status, tx_ref, currency and amount inside data.

   Handle common nested response variations as well.
===================================================== */

function extractTransaction(verification) {
    let current = verification;

    for (let depth = 0; depth < 5; depth++) {
        if (!current || typeof current !== "object") {
            return {};
        }

        if (
            current.tx_ref ||
            current.transaction_reference
        ) {
            return current;
        }

        if (current.transaction) {
            current = current.transaction;
            continue;
        }

        if (current.data) {
            current = current.data;
            continue;
        }

        break;
    }

    return current || {};
}

/* =====================================================
   INSPECT PAYCHANGU VERIFICATION RESPONSE
===================================================== */

function inspectVerification(verification, txRef) {
    const transaction =
        extractTransaction(verification);

    const providerStatus = String(
        verification?.status || ""
    ).toLowerCase();

    const transactionStatus = String(
        transaction.status || ""
    ).toLowerCase();

    const currency = String(
        transaction.currency || ""
    ).toUpperCase();

    const reference = String(
        transaction.tx_ref ||
        transaction.transaction_reference ||
        ""
    ).trim();

    const amount = Number(
        transaction.amount
    );

    const paid = (
        providerStatus === "success" &&

        transactionStatus === "success" &&

        reference === txRef &&

        currency === PAYMENT_CURRENCY &&

        Number.isFinite(amount) &&

        amount >= PAYMENT_AMOUNT
    );

    return {
        paid,

        transaction,

        providerStatus,

        transactionStatus,

        amount,

        currency,

        reference
    };
}

/* =====================================================
   SAVE VERIFIED PAYMENT AND FIVE-DAY EXPIRY

   Rules:
   - Only call after successful provider verification.
   - Existing paidAt is preserved.
   - Repeated callbacks do not extend access.
   - Expiry is calculated from the original paidAt.
===================================================== */

async function markPaymentAsPaid(
    paymentRef,
    inspection
) {
    return db.runTransaction(async transaction => {
        const snapshot =
            await transaction.get(paymentRef);

        if (!snapshot.exists) {
            throw new Error(
                "Payment record does not exist."
            );
        }

        const payment = snapshot.data();

        let paidAt = payment.paidAt;

        if (
            !paidAt ||
            typeof paidAt.toMillis !== "function"
        ) {
            paidAt = admin.firestore.Timestamp.now();
        }

        const expiryMs =
            paidAt.toMillis() + ACCESS_DURATION_MS;

        const accessExpiresAt =
            admin.firestore.Timestamp.fromMillis(
                expiryMs
            );

        transaction.set(
            paymentRef,

            {
                status: "PAID",

                amountPaid: inspection.amount,

                currency: inspection.currency,

                verifiedTxRef: inspection.reference,

                paidAt: paidAt,

                approvedAt: paidAt,

                verifiedAt:
                    admin.firestore.Timestamp.now(),

                accessExpiresAt: accessExpiresAt,

                accessDurationDays: 5,

                lastVerificationStatus: "success"

            },

            {
                merge: true
            }
        );

        return {
            status: "PAID",

            paidAt: paidAt,

            accessExpiresAt: accessExpiresAt,

            accessActive:
                Date.now() < expiryMs
        };
    });
}

/* =====================================================
   REDIRECT HELPERS
===================================================== */

function redirectToPayment(res, status, txRef) {
    const target = new URL(PAYMENT_URL);

    target.searchParams.set("status", status);

    if (txRef) {
        target.searchParams.set("tx_ref", txRef);
    }

    return res.redirect(302, target.toString());
}

function redirectToMaterials(res, txRef) {
    const target = new URL(MATERIALS_URL);

    target.searchParams.set(
        "payment",
        "success"
    );

    target.searchParams.set(
        "tx_ref",
        txRef
    );

    return res.redirect(302, target.toString());
}

/* =====================================================
   CREATE PAYCHANGU CHECKOUT
===================================================== */

app.post(
    "/api/create-checkout",

    authenticateStudent,

    async (req, res) => {
        console.log("Checkout request received.");

        if (!requireConfiguration(res)) {
            return;
        }

        let paymentRef = null;

        try {
            const uid = req.studentUid;

            const studentSnapshot = await db
                .collection("students")
                .doc(uid)
                .get();

            if (!studentSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    message: "Your student profile was not found."
                });
            }

            const student =
                studentSnapshot.data();

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

            const txRef =
                "DEXLIB-" +
                Date.now() +
                "-" +
                crypto.randomBytes(4).toString("hex");

            paymentRef = db
                .collection("payments")
                .doc(txRef);

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

            const response = await axios.post(
                PAYCHANGU_PAYMENT_URL,

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
                        PAYMENT_URL,

                    customization: {
                        title: "DEXTER-LIBRARY Access",

                        description:
                            "Five-day library access"
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

                    timeout: 45000
                }
            );

            const responseData =
                response.data;

            const checkoutUrl =
                responseData?.data?.checkout_url;

            if (
                String(
                    responseData?.status || ""
                ).toLowerCase() !== "success" ||

                typeof checkoutUrl !== "string" ||

                !checkoutUrl.startsWith("https://")
            ) {
                console.error(
                    "Unexpected PayChangu checkout response:",
                    JSON.stringify(responseData)
                );

                throw new Error(
                    "PayChangu did not return a valid checkout URL."
                );
            }

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
                JSON.stringify({
                    httpStatus:
                        error.response?.status || null,

                    providerResponse:
                        error.response?.data || null,

                    code:
                        error.code || null,

                    message:
                        error.message
                })
            );

            if (paymentRef) {
                try {
                    await paymentRef.set(
                        {
                            checkoutError:
                                String(
                                    error.message ||
                                    "Checkout failed"
                                ),

                            checkoutFailedAt:
                                admin.firestore.FieldValue.serverTimestamp()
                        },

                        {
                            merge: true
                        }
                    );
                } catch (updateError) {
                    console.error(
                        "Could not record checkout error:",
                        updateError.message
                    );
                }
            }

            return res.status(502).json({
                success: false,

                message:
                    "Unable to create the payment session. Please try again."
            });
        }
    }
);

/* =====================================================
   VERIFY PAYMENT FROM STUDENT PORTAL

   Requires a valid Firebase login and verifies that
   the payment belongs to the signed-in student.
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
            ).trim();

            if (!validTxRef(txRef)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid payment reference."
                });
            }

            const paymentRef =
                db.collection("payments").doc(txRef);

            const paymentSnapshot =
                await paymentRef.get();

            if (!paymentSnapshot.exists) {
                return res.status(404).json({
                    success: false,
                    message: "Payment record not found."
                });
            }

            const payment =
                paymentSnapshot.data();

            if (payment.uid !== req.studentUid) {
                return res.status(403).json({
                    success: false,
                    message: "You cannot access this payment."
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
                console.warn(
                    "Payment not confirmed:",
                    JSON.stringify({
                        txRef: txRef,

                        providerStatus:
                            inspection.providerStatus,

                        transactionStatus:
                            inspection.transactionStatus,

                        referenceMatches:
                            inspection.reference === txRef,

                        currency:
                            inspection.currency,

                        amount:
                            inspection.amount
                    })
                );

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

            const expiryMs =
                updatedPayment.accessExpiresAt.toMillis();

            return res.json({
                success: true,

                paid: true,

                status: "PAID",

                amount: inspection.amount,

                currency: inspection.currency,

                tx_ref: txRef,

                regNumber: payment.regNumber,

                accessActive:
                    Date.now() < expiryMs,

                accessExpiresAt: expiryMs
            });

        } catch (error) {
            console.error(
                "Student payment verification failed:",
                JSON.stringify({
                    httpStatus:
                        error.response?.status || null,

                    providerResponse:
                        error.response?.data || null,

                    code:
                        error.code || null,

                    message:
                        error.message
                })
            );

            return res.status(502).json({
                success: false,

                message:
                    "Payment verification could not be completed. Please retry."
            });
        }
    }
);

/* =====================================================
   CHECK STUDENT LIBRARY ACCESS

   Use this endpoint from materials.html to check
   the signed-in student's active five-day access.

   The page must call this endpoint before displaying
   protected materials.
===================================================== */

app.get(
    "/api/access-status",

    authenticateStudent,

    async (req, res) => {
        if (!requireConfiguration(res)) {
            return;
        }

        try {
            const snapshot = await db
                .collection("payments")
                .where("uid", "==", req.studentUid)
                .where("status", "==", "PAID")
                .get();

            const now = Date.now();

            let activePayment = null;

            for (const document of snapshot.docs) {
                const payment = document.data();

                let expiryMs = 0;

                if (
                    payment.accessExpiresAt &&
                    typeof payment.accessExpiresAt.toMillis ===
                        "function"
                ) {
                    expiryMs =
                        payment.accessExpiresAt.toMillis();

                } else if (
                    payment.paidAt &&
                    typeof payment.paidAt.toMillis ===
                        "function"
                ) {
                    expiryMs =
                        payment.paidAt.toMillis() +
                        ACCESS_DURATION_MS;
                }

                if (
                    expiryMs > now &&
                    (
                        !activePayment ||
                        expiryMs >
                            activePayment.accessExpiresAt
                    )
                ) {
                    activePayment = {
                        tx_ref:
                            payment.tx_ref ||
                            document.id,

                        accessExpiresAt: expiryMs
                    };
                }
            }

            if (!activePayment) {
                return res.json({
                    success: true,

                    accessActive: false,

                    message:
                        "No active five-day library access was found."
                });
            }

            return res.json({
                success: true,

                accessActive: true,

                tx_ref: activePayment.tx_ref,

                accessExpiresAt:
                    activePayment.accessExpiresAt
            });

        } catch (error) {
            console.error(
                "Library access check failed:",
                error.message
            );

            return res.status(500).json({
                success: false,

                message:
                    "Unable to check library access."
            });
        }
    }
);

/* =====================================================
   PAYCHANGU CALLBACK

   Accepts GET and POST.

   Never trusts the callback status alone.
   Always verifies the transaction directly.

   Successful verification:
       Firebase = PAID
       Access expiry = original paidAt + 5 days
       Redirect = materials.html
===================================================== */

async function handlePayChanguCallback(req, res) {
    console.log(
        "PayChangu callback received:",
        req.method
    );

    if (!configurationReady()) {
        console.error(
            "Callback cannot run: configuration is not ready."
        );

        return redirectToPayment(
            res,
            "verification_error"
        );
    }

    try {
        const candidates = [
            req.query?.tx_ref,
            req.body?.tx_ref,

            req.query?.transaction_reference,
            req.body?.transaction_reference,

            req.query?.transactionReference,
            req.body?.transactionReference
        ];

        const txRef = String(
            candidates.find(value =>
                typeof value === "string" &&
                value.trim() !== ""
            ) || ""
        ).trim();

        const callbackStatus = String(
            req.query?.status ||
            req.body?.status ||
            ""
        ).toLowerCase();

        console.log(
            "Callback reference:",
            txRef || "(missing)"
        );

        console.log(
            "Callback reported status:",
            callbackStatus || "(not supplied)"
        );

        if (!validTxRef(txRef)) {
            console.error(
                "Callback reference is missing or invalid."
            );

            return redirectToPayment(
                res,
                "invalid_reference"
            );
        }

        const paymentRef =
            db.collection("payments").doc(txRef);

        const paymentSnapshot =
            await paymentRef.get();

        if (!paymentSnapshot.exists) {
            console.error(
                "Callback payment record not found:",
                txRef
            );

            return redirectToPayment(
                res,
                "not_found",
                txRef
            );
        }

        const payment =
            paymentSnapshot.data();

        if (!payment.uid) {
            console.error(
                "Payment record has no UID:",
                txRef
            );

            return redirectToPayment(
                res,
                "invalid_payment",
                txRef
            );
        }

        console.log(
            "Verifying callback transaction with PayChangu:",
            txRef
        );

        const verification =
            await verifyWithPayChangu(txRef);

        const inspection =
            inspectVerification(
                verification,
                txRef
            );

        if (!inspection.paid) {
            console.warn(
                "Callback payment has not been verified:",
                JSON.stringify({
                    txRef: txRef,

                    providerStatus:
                        inspection.providerStatus,

                    transactionStatus:
                        inspection.transactionStatus,

                    referenceMatches:
                        inspection.reference === txRef,

                    currency:
                        inspection.currency,

                    amount:
                        inspection.amount
                })
            );

            return redirectToPayment(
                res,
                "pending",
                txRef
            );
        }

        const updatedPayment =
            await markPaymentAsPaid(
                paymentRef,
                inspection
            );

        console.log(
            "Payment verified and saved as PAID:",
            txRef
        );

        console.log(
            "Access expires at:",
            updatedPayment.accessExpiresAt
                .toDate()
                .toISOString()
        );

        console.log(
            "Redirecting verified student to materials."
        );

        return redirectToMaterials(
            res,
            txRef
        );

    } catch (error) {
        console.error(
            "PayChangu callback processing failed:",
            JSON.stringify({
                httpStatus:
                    error.response?.status || null,

                providerResponse:
                    error.response?.data || null,

                code:
                    error.code || null,

                message:
                    error.message
            })
        );

        return redirectToPayment(
            res,
            "verification_error"
        );
    }
}

app.get(
    "/paychangu/callback",
    handlePayChanguCallback
);

app.post(
    "/paychangu/callback",
    handlePayChanguCallback
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
   CENTRAL ERROR HANDLER
===================================================== */

app.use((err, req, res, next) => {
    console.error(
        "Unhandled request error:",
        err.message
    );

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).json({
        success: false,

        message:
            "The server could not process your request."
    });
});

/* =====================================================
   START SERVER
===================================================== */

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `DEXTER-LIBRARY Payment API running on port ${PORT}`
    );

    console.log(
        "Render base URL:",
        BASE_URL
    );

    console.log(
        "Website:",
        WEBSITE_URL
    );

    console.log(
        "Firebase ready:",
        Boolean(db)
    );

    console.log(
        "PayChangu configured:",
        Boolean(PAYCHANGU_SECRET_KEY)
    );

    console.log(
        "Payment amount:",
        PAYMENT_AMOUNT,
        PAYMENT_CURRENCY
    );

    console.log(
        "Successful payment redirect:",
        MATERIALS_URL
    );

    console.log(
        "Access duration: 5 days"
    );
});
