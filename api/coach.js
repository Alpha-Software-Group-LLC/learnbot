import admin from 'firebase-admin';

// Initialize Firebase Admin (uses GOOGLE_APPLICATION_CREDENTIALS env var or explicit config)
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

// In-memory rate limiting (resets when serverless function cold starts, which is fine)
const globalCounter = { count: 0, resetDate: '' };
const userLimits = new Map();

// === CONFIGURATION (override via Vercel env vars) ===
const DAILY_GLOBAL_BUDGET = parseInt(process.env.DAILY_API_BUDGET) || 2000;
const USER_HOURLY_LIMIT = parseInt(process.env.USER_HOURLY_LIMIT) || 10;
const KILL_SWITCH = process.env.API_KILL_SWITCH === 'true';

async function verifyAuth(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  try {
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded;
  } catch (err) {
    console.error('Auth verification failed:', err.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // === KILL SWITCH ===
  if (KILL_SWITCH) {
    return res.status(503).json({ error: 'AI features are temporarily paused. Try again later!' });
  }

  // === AUTH VERIFICATION ===
  const authUser = await verifyAuth(req);
  if (!authUser) {
    return res.status(401).json({ error: 'Please log in to use the AI coach.' });
  }

  const { prompt, mode } = req.body;
  if (!prompt || !mode) return res.status(400).json({ error: 'Missing prompt or mode' });

  // Use verified UID from token, not client-provided userId
  const verifiedUid = authUser.uid;

  // === VALIDATE MODE (before charging anything) ===
  const VALID_MODES = ['quiz', 'flashcards', 'summary', 'explain'];
  if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: 'Invalid mode' });

  // === TOKEN ECONOMY ENFORCEMENT (server-authoritative) ===
  // Quizzes & flashcards are heavier, so they cost more. Pro users are unlimited.
  // Tokens are reserved atomically here and refunded below if the AI call fails.
  const tokenCost = (mode === 'quiz' || mode === 'flashcards') ? 2 : 1;
  const userRef = db.collection('users').doc(verifiedUid);
  let isProUser = false;
  let tokensRemaining = null;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw { code: 'NO_USER' };
      const data = snap.data();
      if (data.isPro) { isProUser = true; return; }
      const balance = typeof data.learnTokens === 'number' ? data.learnTokens : 0;
      if (balance < tokenCost) throw { code: 'INSUFFICIENT', balance };
      tokensRemaining = balance - tokenCost;
      tx.update(userRef, { learnTokens: tokensRemaining, updatedAt: new Date().toISOString() });
    });
  } catch (e) {
    if (e && e.code === 'INSUFFICIENT') {
      return res.status(402).json({ error: 'Not enough tokens for this action. Earn more by studying or grab a token pack.', tokensRemaining: e.balance });
    }
    if (e && e.code === 'NO_USER') {
      return res.status(404).json({ error: 'User account not found.' });
    }
    console.error('Token enforcement error:', e);
    return res.status(500).json({ error: 'Could not verify token balance' });
  }

  // Refund reserved tokens if we charged the user but the AI call ultimately fails.
  const refundTokens = async () => {
    if (isProUser || tokensRemaining === null) return;
    try {
      await userRef.update({
        learnTokens: admin.firestore.FieldValue.increment(tokenCost),
        updatedAt: new Date().toISOString()
      });
      tokensRemaining += tokenCost;
    } catch (refundErr) {
      console.error('Token refund failed:', refundErr.message);
    }
  };

  // === GLOBAL DAILY BUDGET ===
  const today = new Date().toISOString().split('T')[0];
  if (globalCounter.resetDate !== today) {
    globalCounter.count = 0;
    globalCounter.resetDate = today;
  }
  if (globalCounter.count >= DAILY_GLOBAL_BUDGET) {
    await refundTokens();
    return res.status(429).json({ error: 'LearnBot is resting — too many students today! Try again tomorrow.', tokensRemaining });
  }

  // === PER-USER HOURLY LIMIT (using verified UID) ===
  const now = Date.now();
  if (!userLimits.has(verifiedUid)) userLimits.set(verifiedUid, []);
  const userHistory = userLimits.get(verifiedUid).filter(t => t > now - 3600000);
  userLimits.set(verifiedUid, userHistory);
  if (userHistory.length >= USER_HOURLY_LIMIT) {
    await refundTokens();
    return res.status(429).json({ error: 'Slow down! Take a break and try again in a bit.', tokensRemaining });
  }
  userHistory.push(now);
  globalCounter.count++;

  // === TRUNCATE INPUT ===
  const safePrompt = prompt.substring(0, 2000);

  const prompts = {
    quiz: `You are a study coach. Based on the following notes/topic, generate a quiz with exactly 5 multiple-choice questions. Each question should have 4 options (A-D) with one correct answer. Format your response as JSON only, no markdown, no backticks: {"questions":[{"q":"question text","options":["A) ...","B) ...","C) ...","D) ..."],"correct":0,"explanation":"brief explanation"}]}. Notes/Topic: ${safePrompt}`,
    flashcards: `You are a study coach. Based on the following notes/topic, generate exactly 8 flashcards that cover the key concepts. Format your response as JSON only, no markdown, no backticks: {"cards":[{"front":"term or question","back":"definition or answer"}]}. Notes/Topic: ${safePrompt}`,
    summary: `You are a study coach. Based on the following notes/topic, create a concise study summary with key takeaways. Format your response as JSON only, no markdown, no backticks: {"title":"topic title","sections":[{"heading":"section heading","points":["key point 1","key point 2"]}],"keyTerms":[{"term":"term","definition":"definition"}]}. Notes/Topic: ${safePrompt}`,
    explain: `You are a study coach. The student is confused about the following topic. Explain it simply using an analogy, then give a concrete example. Format your response as JSON only, no markdown, no backticks: {"topic":"topic name","simpleExplanation":"explanation in simple terms","analogy":"real-world analogy","example":"concrete example","commonMistakes":["mistake 1","mistake 2"]}. Notes/Topic: ${safePrompt}`
  };

  const systemPrompt = prompts[mode];

  const maxTokens = (mode === 'quiz' || mode === 'flashcards') ? 1500 : 800;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: systemPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic error:', response.status, errText);
      await refundTokens();
      if (response.status === 429) return res.status(429).json({ error: 'AI is busy, try again in a moment.', tokensRemaining });
      return res.status(500).json({ error: 'AI service error', tokensRemaining });
    }

    const data = await response.json();
    const text = data.content?.map(i => i.text || '').join('') || '';
    const clean = text.replace(/```json|```/g, '').trim();

    // Log for monitoring
    const inTok = data.usage?.input_tokens || 0;
    const outTok = data.usage?.output_tokens || 0;
    const cost = (inTok * 3 + outTok * 15) / 1000000;
    console.log(`[AI] ${mode} user=${verifiedUid.substring(0,8)} cost=$${cost.toFixed(4)} daily=${globalCounter.count}/${DAILY_GLOBAL_BUDGET}`);

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error('Parse error:', clean.substring(0, 200));
      await refundTokens();
      return res.status(500).json({ error: 'Failed to parse AI response', tokensRemaining });
    }

    return res.status(200).json({ result: parsed, tokensRemaining, isPro: isProUser });
  } catch (err) {
    console.error('Coach error:', err);
    await refundTokens();
    return res.status(500).json({ error: 'Internal server error', tokensRemaining });
  }
}
