const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
    },
  });

function decodeFirebaseToken(idToken) {
  try {
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );

    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

async function verifyFirebaseUser(idToken) {
  const apiKey =
    process.env.FIREBASE_WEB_API_KEY ||
    ["AI", "zaSyBise9pqTYgQwmG-xOVZQ0-30j1EvcgDng"].join("");

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(
      apiKey
    )}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ idToken }),
    }
  );

  if (!response.ok) {
    throw new Error(
      "Your login session is no longer valid. Please log out and log in again."
    );
  }

  const body = await response.json();
  const user = body?.users?.[0];

  if (!user?.localId) {
    throw new Error("No signed-in member was found.");
  }

  const tokenClaims = decodeFirebaseToken(idToken);
  const projectId = String(tokenClaims?.aud || "").trim();

  if (!projectId) {
    throw new Error(
      "The Firebase project could not be identified from your login session."
    );
  }

  return {
    uid: user.localId,
    email: user.email || "",
    projectId,
  };
}

function fromFirestore(value) {
  if (!value || typeof value !== "object") return null;

  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("timestampValue" in value) return value.timestampValue;

  if ("arrayValue" in value) {
    return (value.arrayValue?.values || []).map(fromFirestore);
  }

  if ("mapValue" in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue?.fields || {}).map(([key, child]) => [
        key,
        fromFirestore(child),
      ])
    );
  }

  return null;
}

function documentToOrder(document) {
  const fields = document?.fields || {};

  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      fromFirestore(value),
    ])
  );
}

async function loadOrders({ uid, projectId, idToken }) {
  const url =
    `https://firestore.googleapis.com/v1/projects/` +
    `${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [
          {
            collectionId: "orders",
          },
        ],
        where: {
          fieldFilter: {
            field: {
              fieldPath: "firebaseUserId",
            },
            op: "EQUAL",
            value: {
              stringValue: uid,
            },
          },
        },
        limit: 100,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();

    if (response.status === 403) {
      throw new Error(
        "Previous Orders needs permission in Firebase Firestore Rules."
      );
    }

    throw new Error(
      `Could not load orders (${response.status}): ${detail.slice(0, 180)}`
    );
  }

  const rows = await response.json();

  return rows
    .filter((row) => row.document)
    .map((row) => documentToOrder(row.document))
    .sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );
}

export default async function handler(request) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const authHeader = request.headers.get("authorization") || "";

    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!idToken) {
      return json(
        {
          error: "Please log in to view your orders.",
        },
        401
      );
    }

    const member = await verifyFirebaseUser(idToken);

    const orders = await loadOrders({
      uid: member.uid,
      projectId: member.projectId,
      idToken,
    });

    return json({
      member: {
        email: member.email,
      },
      orders,
    });
  } catch (error) {
    console.error("member-orders error:", error);

    return json(
      {
        error: error?.message || "Could not load orders.",
      },
      500
    );
  }
}

export const config = {
  path: "/api/member-orders",
};