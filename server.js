const express = require("express");
const cors = require("cors");
const pdfParse = require("pdf-parse");

const app = express();
app.use(cors());
app.options("*", cors());
app.use(express.json());
app.use(express.static(__dirname)); // serve index.html from same server

// 🔐 PUT YOUR REAL OPENROUTER API KEY HERE
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.warn("WARNING: OPENROUTER_API_KEY is not set.");
}

// ---------- Helper: OpenRouter call ----------

// ---------- Helper: OpenRouter TEXT call (for translation) ----------
async function callOpenRouterText({ model, messages, temperature = 0.2 }) {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + OPENROUTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    const msg = data?.error?.message || "OpenRouter error";
    throw new Error(msg);
  }
  return data?.choices?.[0]?.message?.content || "";
}


async function callOpenRouterJSON({ model, messages, temperature = 0.2 }) {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + OPENROUTER_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      response_format: { type: "json_object" }
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    const msg = data?.error?.message || "OpenRouter error";
    const code = data?.error?.code || resp.status;
    throw new Error(`OpenRouter failed (${code}): ${msg}`);
  }
  const content = data?.choices?.[0]?.message?.content || "";
  return content;
}

// ---------- Helper: fetch pdf -> text (limited) ----------
async function fetchPdfText(url, maxChars = 18000) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Failed to download PDF: " + url);
  const buf = Buffer.from(await r.arrayBuffer());
  const parsed = await pdfParse(buf);
  const text = (parsed.text || "").replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  return text.slice(0, maxChars);
}

// ---------- Official-ish sources (hard-mapped for reliability) ----------
// TNPSC Group IV (latest 3 papers we used for style extraction)
// 2025: from TNPSC Answer Keys page (tentative keys hosted 21/07/2025; question booklet PDFs)
const SOURCES = {
  "TNPSC_GROUP_IV": [
    // 2025
    "https://tnpsc.gov.in/Tentative/Document/07_2025_GENEARAL_ENGLISH_GS.pdf",
    "https://tnpsc.gov.in/Tentative/Document/07_2025_GENEAL_TAMIL_GS.pdf",
    // 2024
    "https://tnpsc.gov.in/Tentative/Document/01_2024_GR_IV_GENERAL_ENGLISH.pdf",
    "https://tnpsc.gov.in/Tentative/Document/01_2024_GR_IV_GENERAL_TAMIL.pdf",
    // 2022 (older but official-style)
    "https://tnpsc.gov.in/Tentative/Document/CCS4T_2022_OPT.pdf",
  ],
};

function detectExamKey(examName) {
  const name = (examName || "").toLowerCase();
  if (name.includes("tnpsc") && name.includes("group iv")) return "TNPSC_GROUP_IV";
  if (name.includes("tnpsc") && name.includes("group 4")) return "TNPSC_GROUP_IV";
  if (name.includes("tamil nadu") && name.includes("group iv")) return "TNPSC_GROUP_IV";
  return null;
}

// ---------- Difficulty profiles ----------
const DIFFICULTY_PROMPTS = {
  easy: `
DIFFICULTY: EASY
- Direct, factual questions
- One-step reasoning only
- Clearly incorrect distractors
- Suitable for beginners
`,
  moderate: `
DIFFICULTY: MODERATE
- Concept-based questions
- Application of knowledge
- Plausible distractors
- Standard competitive exam level
`,
  hard: `
DIFFICULTY: HARD
- Multi-step reasoning
- Close distractors (2 options may appear correct)
- Conceptual traps and edge cases
- Previous-year-question style
- Suitable for top-performing candidates
`
};

function examDefaults(examKey) {
  if (examKey === "TNPSC_GROUP_IV") {
    return {
      durationMinutes: 180, // real exam duration
      totalQuestions: 200,
      sections: [
        { name: "Language", count: 100 },
        { name: "General Studies", count: 75 },
        { name: "Aptitude", count: 25 },
      ],
    };
  }
  // fallback
  return {
    durationMinutes: 60,
    totalQuestions: 50,
    sections: [
      { name: "General", count: 20 },
      { name: "Quant", count: 15 },
      { name: "Reasoning", count: 15 },
    ],
  };
}

// ---------- Existing translate endpoint ----------
app.post("/translate", async (req, res) => {
  try {
    const { text, targetLanguage } = req.body;
    if (!text || !targetLanguage) {
      return res.status(400).json({ error: "Missing text or targetLanguage" });
    }

    const prompt =
      "Translate the following text into " +
      targetLanguage +
      ". Use simple, clear language.\n\n" +
      text;

    const translated = await callOpenRouterText({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    });

    res.json({ translated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- NEW: generate paper ----------
app.post("/generate-paper", async (req, res) => {
  try {
    const {
      examName,
      language = "English",
      difficulty = "moderate",
      // allow overriding counts; default: real counts for TNPSC Group IV
      totalQuestions,
      maxQuestionsPerBatch = 25
    } = req.body || {};

    if (!examName) return res.status(400).json({ error: "Missing examName" });

    const examKey = detectExamKey(examName);
    const defaults = examDefaults(examKey);

    const targetTotal = Math.min(
      Math.max(10, Number(totalQuestions || defaults.totalQuestions)),
      200
    );

    // Extract style text from 3+ official PDFs if we have them
    let styleCorpus = "";
    if (examKey && SOURCES[examKey]) {
      const urls = SOURCES[examKey].slice(0, 3); // "at least 3"
      const texts = [];
      for (const u of urls) {
        try {
          texts.push(await fetchPdfText(u, 14000));
        } catch (err) {
          // keep going if one fails
          texts.push("");
        }
      }
      styleCorpus = texts.filter(Boolean).join("\n\n---\n\n").slice(0, 35000);
    }

    const extraInstructions = `
Generate a fresh mock paper for: ${examName}.
Language of questions: ${language}.

${DIFFICULTY_PROMPTS[difficulty] || DIFFICULTY_PROMPTS.moderate}

STRICT RULES:
- Do NOT copy questions verbatim from any source.
- Create NEW questions that match the style, difficulty, and distribution.
- MCQ options must be plausible. One correct answer only.
- Return JSON ONLY in the exact schema.

Schema:
{
  "durationMinutes": number,
  "questions": [
    {
      "section": "Language|General Studies|Aptitude|Reasoning|Quant|General",
      "text": "question text",
      "options": ["A","B","C","D"],
      "answerIndex": 0
    }
  ]
}

If the exam is TNPSC Group IV:
- Total questions target: 200
- Sections: 100 Language, 75 General Studies, 25 Aptitude
- Level: SSLC/10th standard
- Keep questions exam-like and practical.

If you cannot generate all in one go, still output valid JSON.
`;

    // We'll generate in batches to avoid timeouts and huge outputs.
    const batches = [];
    let remaining = targetTotal;

    // Decide section distribution
    const sectionPlan = defaults.sections.map(s => ({ ...s }));
    const sum = sectionPlan.reduce((a, b) => a + b.count, 0);
    // scale if user asked fewer than real 200
    if (targetTotal !== sum) {
      const scale = targetTotal / sum;
      let adjusted = sectionPlan.map(s => ({
        name: s.name,
        count: Math.max(1, Math.round(s.count * scale))
      }));
      // fix rounding drift
      let drift = targetTotal - adjusted.reduce((a,b)=>a+b.count,0);
      let i = 0;
      while (drift !== 0 && i < 1000) {
        const idx = i % adjusted.length;
        if (drift > 0) { adjusted[idx].count++; drift--; }
        else if (adjusted[idx].count > 1) { adjusted[idx].count--; drift++; }
        i++;
      }
      sectionPlan.splice(0, sectionPlan.length, ...adjusted);
    }

    // Flatten section targets into a queue for batching
    const sectionQueue = [];
    for (const s of sectionPlan) {
      for (let i = 0; i < s.count; i++) sectionQueue.push(s.name);
    }

    // Create batches with roughly mixed sections
    while (remaining > 0) {
      const batchSize = Math.min(remaining, Number(maxQuestionsPerBatch) || 25);
      const batchSections = sectionQueue.splice(0, batchSize);

      // Compose a section request summary
      const counts = {};
      for (const s of batchSections) counts[s] = (counts[s] || 0) + 1;
      const sectionRequest = Object.entries(counts)
        .map(([k,v]) => `${k}: ${v}`)
        .join(", ");

      const system = "You are an exam-paper setter. Output STRICT JSON only.";
      const user = `
${extraInstructions}

Batch target size: ${batchSize}
Batch section distribution: ${sectionRequest}

Style reference corpus (do not copy; only infer style):
${styleCorpus ? styleCorpus : "(no corpus available)"}
`;

      const raw = await callOpenRouterJSON({
        model: "openai/gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.3
      });

      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        throw new Error("Model did not return valid JSON.");
      }

      const qs = Array.isArray(obj.questions) ? obj.questions : [];
      // normalize & clamp to 4 options
      const cleaned = qs.slice(0, batchSize).map(q => ({
        section: String(q.section || "General"),
        text: String(q.text || "").trim(),
        options: Array.isArray(q.options) ? q.options.slice(0,4).map(String) : ["A","B","C","D"],
        answerIndex: Math.min(3, Math.max(0, Number(q.answerIndex || 0)))
      })).filter(q => q.text && q.options.length === 4);

      batches.push(...cleaned);
      remaining -= batchSize;
    }

    // Final output
    res.json({
      durationMinutes: defaults.durationMinutes,
      questions: batches.slice(0, targetTotal)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
