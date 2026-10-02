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
const MODEL = process.env.OPENAI_MODEL || "gpt-6-luna";

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
      .select("subject term total classId")
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
  const avg = grades.length ? Math.round(grades.reduce((n, g) => n + Number(g.total || 0), 0) / grades.length) : null;

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
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ message: "Nurul AI is not connected yet. Add OPENAI_API_KEY to the backend environment on Render to activate it." });
  }

  try {
    const context = await buildSchoolContext(req.user);
    const system = `You are Nurul AI, the private assistant inside Nurul-Haq Islamic Academy's school management system. Be concise, practical and professional. Never invent school figures. You may use only the supplied school context. The user's access scope is ${context.accessScope}: junior means Nursery/Primary/JSS only, senior means SSS only, all means the complete school. Never reveal information outside that scope. If the question needs a record not present in context, say that the user should open the relevant module. Do not make disciplinary, financial, admissions or academic decisions on behalf of the school; provide analysis and options. Current school context:\n${JSON.stringify(context, null, 2)}`;
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: MODEL, instructions: system, input: message, max_output_tokens: 700 }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(502).json({ message: data?.error?.message || "The AI service could not answer right now." });
    res.json({ answer: data.output_text || "The AI service returned no answer." });
  } catch (err) {
    res.status(502).json({ message: err.message || "AI service unavailable." });
  }
});

module.exports = router;
