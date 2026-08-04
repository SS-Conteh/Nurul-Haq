function ordinal(n) {
  if (!Number.isFinite(n)) return "-";
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Matches the grading bands printed on the school's report card exactly:
// 75-100 A1 (Excellent), 70-74 B2, 65-69 B3, 60-64 C4 (V. Good),
// 55-59 C5, 50-54 C6 (Good), 45-49 D7, 40-44 E8 (Fair), 0-39 F9 (Fail)
function gradeFor(mean) {
  if (mean >= 75) return { grade: "A1", remark: "EXCELLENT" };
  if (mean >= 70) return { grade: "B2", remark: "V. GOOD" };
  if (mean >= 65) return { grade: "B3", remark: "V. GOOD" };
  if (mean >= 60) return { grade: "C4", remark: "V. GOOD" };
  if (mean >= 55) return { grade: "C5", remark: "GOOD" };
  if (mean >= 50) return { grade: "C6", remark: "GOOD" };
  if (mean >= 45) return { grade: "D7", remark: "FAIR" };
  if (mean >= 40) return { grade: "E8", remark: "FAIR" };
  return { grade: "F9", remark: "FAIL" };
}

// "15 June 2011" -> "15 years, 2 months and 10 days" (as of today)
function ageFromDob(dobStr) {
  if (!dobStr) return "-";
  const dob = new Date(dobStr);
  if (isNaN(dob.getTime())) return "-";
  const now = new Date();
  let years = now.getFullYear() - dob.getFullYear();
  let months = now.getMonth() - dob.getMonth();
  let days = now.getDate() - dob.getDate();
  if (days < 0) {
    months -= 1;
    const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    days += prevMonth.getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return `${years} years, ${months} months and ${days} days`;
}

// Dense-ish competition ranking: highest value first, ties share a rank.
function rankDescending(items, valueFn) {
  const sorted = [...items].sort((a, b) => valueFn(b) - valueFn(a));
  const ranks = new Map();
  let rank = 0;
  let lastValue = null;
  let seen = 0;
  for (const item of sorted) {
    seen += 1;
    const v = valueFn(item);
    if (v !== lastValue) {
      rank = seen;
      lastValue = v;
    }
    ranks.set(item, rank);
  }
  return ranks;
}

module.exports = { ordinal, gradeFor, ageFromDob, rankDescending };
