import admin from 'firebase-admin';

// Initialize Firebase Admin
if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
    : null;

  admin.initializeApp(
    serviceAccount
      ? { credential: admin.credential.cert(serviceAccount) }
      : { projectId: process.env.FIREBASE_PROJECT_ID || 'learnbot-93edf' }
  );
}

const db = admin.firestore();

const REFERRAL_REWARD = 10; // tokens granted to both referrer and new user

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // === AUTH VERIFICATION — the caller is the newly-signed-up user ===
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  let newUserId;
  try {
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    newUserId = decoded.uid;
  } catch (err) {
    console.error('Auth verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid auth token' });
  }

  const referralCode = (req.body && typeof req.body.referralCode === 'string')
    ? req.body.referralCode.trim().toLowerCase()
    : '';
  if (!referralCode) {
    return res.status(400).json({ error: 'Missing referral code' });
  }

  try {
    const newUserRef = db.collection('users').doc(newUserId);
    const newUserSnap = await newUserRef.get();
    if (!newUserSnap.exists) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    // Idempotency — only ever credit a given new user once.
    if (newUserSnap.data().referralCredited === true) {
      return res.status(200).json({ credited: false, message: 'Referral already credited' });
    }

    // Resolve the referrer by their public referral code.
    const referrerQuery = await db.collection('users')
      .where('referralCode', '==', referralCode)
      .limit(1)
      .get();

    if (referrerQuery.empty) {
      // Mark as processed so we don't re-query on every retry, but no reward.
      await newUserRef.update({ referralCredited: true, updatedAt: new Date().toISOString() });
      return res.status(200).json({ credited: false, message: 'Referral code not found' });
    }

    const referrerRef = referrerQuery.docs[0].ref;

    // Block self-referral.
    if (referrerRef.id === newUserId) {
      await newUserRef.update({ referralCredited: true, updatedAt: new Date().toISOString() });
      return res.status(200).json({ credited: false, message: 'Cannot refer yourself' });
    }

    // Atomically credit both parties exactly once.
    let newBalance = null;
    await db.runTransaction(async (tx) => {
      const freshNew = await tx.get(newUserRef);
      if (!freshNew.exists) throw { code: 'NO_USER' };
      if (freshNew.data().referralCredited === true) throw { code: 'ALREADY' };

      const freshReferrer = await tx.get(referrerRef);
      if (!freshReferrer.exists) throw { code: 'NO_REFERRER' };

      const newUserTokens = typeof freshNew.data().learnTokens === 'number' ? freshNew.data().learnTokens : 0;
      newBalance = newUserTokens + REFERRAL_REWARD;

      const ts = new Date().toISOString();
      tx.update(newUserRef, {
        learnTokens: newBalance,
        referredBy: referralCode,
        referralCredited: true,
        updatedAt: ts
      });
      tx.update(referrerRef, {
        learnTokens: admin.firestore.FieldValue.increment(REFERRAL_REWARD),
        referralCount: admin.firestore.FieldValue.increment(1),
        updatedAt: ts
      });
    });

    return res.status(200).json({ credited: true, reward: REFERRAL_REWARD, tokensRemaining: newBalance });

  } catch (e) {
    if (e && e.code === 'ALREADY') {
      return res.status(200).json({ credited: false, message: 'Referral already credited' });
    }
    if (e && (e.code === 'NO_USER' || e.code === 'NO_REFERRER')) {
      return res.status(404).json({ error: 'Account not found.' });
    }
    console.error('Referral error:', e);
    return res.status(500).json({ error: 'Referral processing failed' });
  }
}
