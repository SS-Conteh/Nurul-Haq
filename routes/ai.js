const express = require("express");
const { protect } = require("../middleware/auth");
const User = require("../models/User");
const SchoolClass = require("../models/SchoolClass");
const Grade = require("../models/Grade");
const Fee = require("../models/Fee");
const Expense = require("../models/Expense");
const BankTransaction = require("../models/BankTransaction");
const Settings = require("../models/Settings");
const { sectionScope, levelsForScope } = require("../utils/accessScope");

const router = express.Router();
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

async function buildSchoolContext(user) {
  const settings = await Settings.findOne().lean();
  const scope = sectionScope(user);
  const levels = levelsForScope(scope);
  const classFilter = levels ? { level: { $in: levels } } : {};
  const classes = await SchoolClass.find(classFilter).select("name level classGroup").lean();
  const classIds = classes.map((c) => c._id);
  const studentFilter = { role: "student" };
  if (levels) studentFilter.classId = { $in: classIds };

  const [students, teachers, grades, fees, expenses, bank] = await Promise.all([
    User.countDocuments(studentFilter),
    levels
      ? User.countDocuments({ role: "teacher", $or: [{ levelsTaught: { $in: levels } }, { level: { $in: levels } }] })
      : User.countDocuments({ role: "teacher" }),
    Grade.find(levels ? { classId: { $in: classIds }, academicYear: settings?.academicYear || "" } : { academicYear: settings?.academicYear || "" })
      .select("subject term test examScore total classId")
      .lean(),
    Fee.find({ academicYear: settings?.academicYear || "", student: { $in: await User.find(studentFilter).distinct("_id") } })
      .select("amount status term")
      .lean(),
    Expense.find({ academicYear: settings?.academicYear || "", ...(scope === "all" ? {} : { section: scope === "junior" ? "Junior" : "Senior" }) })
      .select("total status category section")
      .lean(),
    BankTransaction.find(scope === "all" ? {} : { section: scope === "junior" ? "Junior" : "Senior" })
      .select("type amount section academicYear")
      .lean(),
  ]);

  const byLevel = {};
  classes.forEach((c) => { byLevel[c.level] = (byLevel[c.level] || 0) + 1; });
  const paid = fees.reduce((n, f) => n + Number(f.amount || 0), 0);
  const expensePaid = expenses.filter((e) => e.status === "Paid").reduce((n, e) => n + Number(e.total || 0), 0);
  const deposits = bank.filter((b) => b.type === "Deposit").reduce((n, b) => n + Number(b.amount || 0), 0);
  const withdrawals = bank.filter((b) => b.type === "Withdrawal").reduce((n, b) => n + Number(b.amount || 0), 0);
  const avg = grades.length ? Math.round((grades.reduce((n, g) => n + ((Number(g.test) + Number(g.examScore)) / 2), 0) / grades.length + Number.EPSILON) * 10) / 10 : null;

  return {
    accessScope: scope,
    academicYear: settings?.academicYear || "",
    currentTerm: settings?.currentTerm || "",
    classesByLevel: byLevel,
    studentCount: students,
    teacherCount: teachers,
    gradeRecords: grades.length,
    overallGradeAverage: avg,
    feesCollected: paid,
    expensesPaid: expensePaid,
    bankDeposits: deposits,
    bankWithdrawals: withdrawals,
    bankBalanceMovement: deposits - withdrawals,
  };
}

router.post("/ask", protect, async (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ message: "Enter a question for Nurul AI." });
  if (message.length > 3000) return res.status(400).json({ message: "Please keep the question below 3,000 characters." });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ message: "Nurul AI is not connected yet. Add GEMINI_API_KEY to the backend environment on Render." });
  }

  try {
    const context = await buildSchoolContext(req.user);
    const system = `You are Nurul AI, the private assistant inside Nurul-Haq Islamic Academy's school management system. Be concise, practical and professional. Never invent school figures. You may use only the supplied school context. The user's access scope is ${context.accessScope}: junior means Nursery/Primary/JSS only, senior means SSS only, all means the complete school. Never reveal information outside that scope. If the question needs a record not present in context, say that the user should open the relevant module. Do not make disciplinary, financial, admissions or academic decisions on behalf of the school; provide analysis and options. Current school context:\n${JSON.stringify(context, null, 2)}`;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: message }] }],
        generationConfig: { maxOutputTokens: 700 },
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const providerMessage = data?.error?.message || "Gemini did not provide details.";
      const status = response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 ? 502 : response.status;
      let message = providerMessage;
      if (response.status === 400 || response.status === 401 || response.status === 403) message = "Gemini rejected the API key or request. Check that GEMINI_API_KEY is valid and the Generative Language API is enabled.";
      else if (response.status === 404) message = `Gemini model '${MODEL}' was not found. Set GEMINI_MODEL to a model available to your API key (for example gemini-3.6-flash).`;
      else if (response.status === 429) message = "Gemini free-tier quota/rate limit has been reached. Check your project's Gemini API limits in Google AI Studio and try again after the quota resets.";
      else if (response.status >= 500) message = "Gemini is temporarily unavailable. Please try again shortly.";
      console.error("Gemini API error", response.status, providerMessage);
      return res.status(status).json({ message });
    }
    const answer = (data?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("\n").trim();
    if (!answer) return res.status(502).json({ message: "Gemini returned no text. Please rephrase the question and try again." });
    return res.json({ answer });
  } catch (err) {
    console.error("Nurul AI request failed:", err.message);
    res.status(502).json({ message: err.name === "TimeoutError" ? "Gemini took too long to respond. Please try again." : "Nurul AI could not connect to Gemini. Check the backend logs and try again." });
  }
});

module.exports = router;
