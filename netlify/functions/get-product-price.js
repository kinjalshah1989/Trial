const admin = require("firebase-admin");

// Start Firebase Admin only once
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
      "base64"
    ).toString("utf8")
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

const MIN_PRICE = 79;
const MAX_PRICE = 149;

function createRandomPrice(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function cleanProductId(value = "") {
  return value
    .replace(/\.[^/.]+$/, "") // Remove .jpg, .png, etc.
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-");
}

exports.handler = async function (event) {
  try {
    const requestedProductId =
      event.queryStringParameters?.productId;

    const productId = cleanProductId(requestedProductId);

    if (!productId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Product ID is required.",
        }),
      };
    }

    const productRef = db.collection("products").doc(productId);

    const price = await db.runTransaction(async (transaction) => {
      const productSnapshot = await transaction.get(productRef);

      // The product already has a price
      if (productSnapshot.exists) {
        return productSnapshot.data().price;
      }

      // Create one random price
      const newPrice = createRandomPrice(
        MIN_PRICE,
        MAX_PRICE
      );

      // Save the price permanently
      transaction.set(productRef, {
        productId,
        price: newPrice,
        currency: "USD",
        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      return newPrice;
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        productId,
        price,
        currency: "USD",
      }),
    };
  } catch (error) {
    console.error("Price creation error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Unable to load product price.",
      }),
    };
  }
};
