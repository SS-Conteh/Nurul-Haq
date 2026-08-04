const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { ordinal, gradeFor, ageFromDob, rankDescending } = require("./reportCardHelpers");

const LOGO_PATH = path.join(__dirname, "..", "assets", "logo.jpeg");

// ── Portrait A4 layout ──
// The report card used to be landscape (usable width ~794pt). Printed in
// portrait instead (usable width ~547pt at a 24pt margin), so every column
// below is scaled down to ~0.71x of its old landscape width to still fit
// the page, with font sizes trimmed slightly to match.
const SUBJECT_COL = 106;
const MAX_COL = 23;
const TERM_SUBCOLS = [18, 18, 23, 23]; // Test, Exam, MN, RNK
const TERM_GROUP_W = TERM_SUBCOLS.reduce((a, b) => a + b, 0);
const YEARLY_SUBCOLS = [34, 28, 24, 24, 55]; // Total, Mean, Rank, Grade, Remarks
const YEARLY_GROUP_W = YEARLY_SUBCOLS.reduce((a, b) => a + b, 0);
const TABLE_WIDTH = SUBJECT_COL + MAX_COL + TERM_GROUP_W * 3 + YEARLY_GROUP_W;

const ROW_H = 14.5;
const CELL_SIZE = 6.3; // data cell font size (was 7 in the wider landscape layout)
const HEAD_SIZE = 5.7; // sub-header font size (was 6.5)

// Per the school's instruction: any percentage/grade value below 50% is
// shown in red, 50% and above in blue.
const COLOR_FAIL = "#dc2626";
const COLOR_PASS = "#1d4ed8";
const gradeColor = (pct) => (pct >= 50 ? COLOR_PASS : COLOR_FAIL);

function cellRect(doc, x, y, w, h, text, opts = {}) {
  const { align = "center", bold = false, size = CELL_SIZE, fill = null, valign = "middle", color = "#000" } = opts;
  if (fill) {
    doc.save().rect(x, y, w, h).fill(fill).restore();
  }
  doc.rect(x, y, w, h).stroke("#000");
  if (text !== undefined && text !== null) {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);
    const textY = valign === "middle" ? y + (h - size) / 2 + 1 : y + 2;
    doc.text(String(text), x + 1, textY, { width: w - 2, align });
  }
}

// Student photos are stored as base64 data URLs (e.g.
// "data:image/jpeg;base64,...") straight on the User document, the same
// way every other photo in this app is stored — never as a filesystem
// path. This decodes that data URL into an image buffer pdfkit can draw.
// (Falls back to treating the value as a real file path, in case any
// older/seeded record still has one.)
function resolvePhotoImage(avatarUrl) {
  if (!avatarUrl) return null;
  const match = /^data:image\/\w+;base64,(.+)$/.exec(avatarUrl);
  if (match) {
    try {
      return Buffer.from(match[1], "base64");
    } catch (e) {
      return null;
    }
  }
  if (fs.existsSync(avatarUrl)) return avatarUrl;
  return null;
}

async function computeRoster(Grade, User, student, classId, subjects, terms) {
  // All classmates (including this student) sharing the same class, used
  // for per-subject / per-term ranking exactly like the paper report card.
  const classmates = await User.find({ role: "student", classId }).select("_id");
  const classmateIds = classmates.map((c) => c._id);
  const allGrades = await Grade.find({
    student: { $in: classmateIds },
    subject: { $in: subjects },
    term: { $in: terms },
  });
  return { classmateIds, allGrades, classSize: classmateIds.length };
}

/**
 * Streams the report card PDF straight to the Express response.
 * `terms` = [termStringT1, termStringT2, termStringT3] as stored on Grade docs
 * (e.g. "Term 1 · 2026"); `termLabel` = which one is "current" for the title.
 */
async function generateReportCard(res, { student, classDoc, subjects, terms, termLabel, session, settings, attendanceCounts, Grade, User, doc: sharedDoc, isBulk = false }) {
  const { allGrades, classSize } = await computeRoster(Grade, User, student, classDoc?._id, subjects, terms);

  // Group grades by subject -> by term
  function gradesFor(studentId, subject) {
    return terms.map((t) => allGrades.find((g) => String(g.student) === String(studentId) && g.subject === subject && g.term === t) || null);
  }

  // Per-subject, per-term rank across the class (by that term's MN)
  function termRank(subject, termIdx, studentId) {
    const values = allGrades.filter((g) => g.subject === subject && g.term === terms[termIdx]);
    const byStudent = new Map();
    values.forEach((g) => byStudent.set(String(g.student), ((g.test || 0) + (g.examScore || 0)) / 2));
    // Only rank students who have a value for this term
    const entries = [...byStudent.entries()];
    if (!entries.length) return null;
    const sorted = entries.sort((a, b) => b[1] - a[1]);
    let rank = 0, lastVal = null, seen = 0;
    for (const [sid, val] of sorted) {
      seen += 1;
      if (val !== lastVal) { rank = seen; lastVal = val; }
      if (sid === String(studentId)) return rank;
    }
    return null;
  }

  // Yearly per-subject mean across all classmates, for the YEARLY rank column
  function yearlyStatsFor(studentId, subject) {
    const rows = gradesFor(studentId, subject);
    let total = 0, termCount = 0;
    rows.forEach((g) => {
      if (g) { total += ((g.test || 0) + (g.examScore || 0)) / 2; termCount += 1; }
    });
    // mean = the average of this subject's per-term totals (each already a
    // 0-100 percentage), NOT total/termCount*2 — that used to silently
    // halve every mean (e.g. a 75% average was scored as if it were 37.5%,
    // which is well below FAIL) and misassign the letter grade as a result.
    const mean = termCount ? total / termCount : 0;
    return { total, mean, termCount };
  }
  function yearlyRank(subject, studentId) {
    const ids = [...new Set(allGrades.filter((g) => g.subject === subject).map((g) => String(g.student)))];
    const withMean = ids.map((sid) => [sid, yearlyStatsFor(sid, subject).mean]);
    if (!withMean.length) return null;
    const sorted = withMean.sort((a, b) => b[1] - a[1]);
    let rank = 0, lastVal = null, seen = 0;
    for (const [sid, val] of sorted) {
      seen += 1;
      if (val !== lastVal) { rank = seen; lastVal = val; }
      if (sid === String(studentId)) return rank;
    }
    return null;
  }

  // ── Build the per-subject rows for THIS student ──
  const rows = subjects.map((subject) => {
    const [t1, t2, t3] = gradesFor(student._id, subject);
    const termCell = (g, idx) => {
      if (!g) return { test: "", exam: "", mn: "0.0", rnk: "-" };
      // MN = the plain average of the actual Test and Exam scores entered
      // for this term — e.g. Test 60, Exam 89 -> MN = (60+89)/2 = 74.5.
      const mn = ((g.test || 0) + (g.examScore || 0)) / 2;
      const rnk = termRank(subject, idx, student._id);
      return { test: g.test ?? "", exam: g.examScore ?? "", mn: mn.toFixed(1), rnk: rnk ? ordinal(rnk) : "-" };
    };
    const { total, mean } = yearlyStatsFor(student._id, subject);
    const rnkY = yearlyRank(subject, student._id);
    const { grade, remark } = gradeFor(mean);
    return {
      subject,
      max: 100,
      t1: termCell(t1, 0),
      t2: termCell(t2, 1),
      t3: termCell(t3, 2),
      total: total.toFixed(1).replace(/\.0$/, ""),
      mean: mean.toFixed(1),
      rank: rnkY ? ordinal(rnkY) : "-",
      grade,
      remark,
    };
  });

  // ── Overall totals ──
  // Each subject-term combination is worth 100: Test and Exam are both raw
  // scores out of 100, so the combination's actual contribution is their
  // average (cell.mn), not their raw sum (which can run up to 200).
  let obtainable = 0, obtained = 0;
  const colTotals = { t1a: 0, t1b: 0, t2a: 0, t2b: 0, t3a: 0, t3b: 0 };
  rows.forEach((r) => {
    [r.t1, r.t2, r.t3].forEach((cell) => {
      if (cell.test !== "" || cell.exam !== "") {
        obtainable += 100;
        obtained += Number(cell.mn) || 0;
      }
    });
    colTotals.t1a += Number(r.t1.test) || 0;
    colTotals.t1b += Number(r.t1.exam) || 0;
    colTotals.t2a += Number(r.t2.test) || 0;
    colTotals.t2b += Number(r.t2.exam) || 0;
    colTotals.t3a += Number(r.t3.test) || 0;
    colTotals.t3b += Number(r.t3.exam) || 0;
  });
  const avgPct = obtainable ? (obtained / obtainable) * 100 : 0;

  // Overall class position, ranked by each classmate's own average percentage
  const classmateAverages = new Map();
  const allStudentIds = [...new Set(allGrades.map((g) => String(g.student)))];
  allStudentIds.forEach((sid) => {
    let obt = 0, obtn = 0;
    subjects.forEach((subject) => {
      terms.forEach((t) => {
        const g = allGrades.find((x) => String(x.student) === sid && x.subject === subject && x.term === t);
        if (g) { obtn += ((g.test || 0) + (g.examScore || 0)) / 2; obt += 100; }
      });
    });
    classmateAverages.set(sid, obt ? (obtn / obt) * 100 : 0);
  });
  let overallRank = null;
  {
    const sorted = [...classmateAverages.entries()].sort((a, b) => b[1] - a[1]);
    let rank = 0, lastVal = null, seen = 0;
    for (const [sid, val] of sorted) {
      seen += 1;
      if (val !== lastVal) { rank = seen; lastVal = val; }
      if (sid === String(student._id)) overallRank = rank;
    }
  }

  // ═══════════════ DRAW THE PDF ═══════════════
  // In bulk mode the caller already created/piped/will-end a single shared
  // PDFDocument spanning every student — we just draw this student's page(s)
  // onto it. In single mode we own the whole lifecycle as before.
  // Portrait A4 (the school asked for portrait, not the previous landscape).
  const doc = sharedDoc || new PDFDocument({ size: "A4", margin: 24 });
  if (!isBulk) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=ReportCard-${(student.admissionNo || student.name || "student").replace(/\s+/g, "_")}.pdf`,
    );
    doc.pipe(res);
  }

  const pageW = doc.page.width;
  const marginX = doc.page.margins.left;
  const usableW = pageW - marginX * 2;
  const hasLogo = fs.existsSync(LOGO_PATH);

  // ── Header: logos + school block ──
  let y = 24;
  if (hasLogo) {
    doc.image(LOGO_PATH, marginX, y, { width: 52, height: 52 });
    doc.image(LOGO_PATH, marginX + usableW - 52, y, { width: 52, height: 52 });
  }
  doc.font("Helvetica-Bold").fontSize(15).fillColor("#1a2b4a")
    .text((settings.schoolName || "Nurul-Haq Islamic Academy").toUpperCase(), marginX, y + 2, { width: usableW, align: "center" });
  doc.font("Helvetica").fontSize(8.5).fillColor("#333")
    .text((settings.address || "").toUpperCase(), marginX, y + 21, { width: usableW, align: "center" });
  doc.fontSize(8).text(`Motto: ${settings.motto || "Knowledge and Perseverance"}`, marginX, y + 33, { width: usableW, align: "center" });
  doc.text(`Moblie: ${settings.phone || ""}`, marginX, y + 44, { width: usableW, align: "center" });

  y += 60;
  doc.moveTo(marginX, y).lineTo(marginX + usableW, y).lineWidth(1.2).stroke("#1a2b4a");
  y += 8;

  doc.font("Helvetica-Bold").fontSize(11).fillColor("#000")
    .text(`(${session}) ${termLabel.toUpperCase()} PUPIL'S PROGRESS REPORT SHEET`, marginX, y, { width: usableW, align: "center" });
  y += 20;

  // ── Student info block (3 columns of label/value pairs) + photo box ──
  const infoTop = y;
  const photoW = 62, photoH = 72;
  const colW = (usableW - photoW - 16) / 3;

  const col1 = [
    ["Name", (student.name || "").toUpperCase()],
    ["Age", ageFromDob(student.dob).replace(" years, ", "y ").replace(" months and ", "m ").replace(" days", "d")],
    ["Date Of Birth", student.dob || "-"],
    ["Sex", student.gender || "-"],
    ["Class", classDoc?.name || "-"],
    ["Admission No.", student.admissionNo || "-"],
    ["Class Teacher", classDoc?.classTeacherName || "-"],
  ];
  const col2 = [
    ["Terminal Duration", settings.terminalDuration || "-"],
    ["Term Begins", settings.termBegins || "-"],
    ["Term End", settings.termEnd || "-"],
    ["Next Term Begins", settings.nextTermBegins || "-"],
    ["No. of Times Late", String(attendanceCounts.late ?? 0)],
    ["No. in Class", String(classSize)],
  ];
  const col3 = [
    ["No. of Times Present", String(attendanceCounts.present ?? 0)],
    ["No. of Times Absent", String(attendanceCounts.absent ?? 0)],
    ["Total Obtainable", obtainable.toFixed(1)],
    ["Total Obtained", obtained.toFixed(1)],
    ["Average %", avgPct.toFixed(1)],
    ["Position", overallRank ? ordinal(overallRank) : "-"],
  ];

  function drawInfoCol(items, x, w) {
    let iy = infoTop;
    items.forEach(([label, value]) => {
      doc.font("Helvetica-Bold").fontSize(7.2).fillColor("#000").text(`${label}:`, x, iy, { width: w * 0.5, continued: false });
      doc.font("Helvetica").fontSize(7.2).text(String(value), x + w * 0.5, iy, { width: w * 0.5 });
      iy += 13.5;
    });
    return iy;
  }

  const b1 = drawInfoCol(col1, marginX, colW);
  const b2 = drawInfoCol(col2, marginX + colW + 8, colW);
  const b3 = drawInfoCol(col3, marginX + colW * 2 + 16, colW);

  // Photo box — the student's actual profile photo, decoded from the
  // base64 data URL stored on their account (falls back to a placeholder
  // if they don't have one yet).
  const photoX = marginX + usableW - photoW;
  doc.rect(photoX, infoTop, photoW, photoH).stroke("#000");
  const photoSrc = resolvePhotoImage(student.avatarUrl);
  if (photoSrc) {
    doc.image(photoSrc, photoX + 2, infoTop + 2, { width: photoW - 4, height: photoH - 4, fit: [photoW - 4, photoH - 4] });
  } else {
    doc.font("Helvetica").fontSize(7).fillColor("#888").text("PHOTO", photoX, infoTop + photoH / 2 - 4, { width: photoW, align: "center" });
  }

  y = Math.max(b1, b2, b3) + 6;

  // ── Academic performance table ──
  const tableX = marginX + (usableW - TABLE_WIDTH) / 2;
  let ty = y;

  doc.font("Helvetica-Bold").fontSize(8).fillColor("#000")
    .text("ACADEMIC PERFORMANCE", tableX, ty, { width: TABLE_WIDTH, align: "center" });
  ty += 13;

  // Header row A (grouped) — Subject & Max span two rows visually by just
  // drawing their text once vertically centered across both header rows.
  const groupHeaderH = ROW_H;
  const subHeaderH = ROW_H;
  let gx = tableX;
  cellRect(doc, gx, ty, SUBJECT_COL, groupHeaderH + subHeaderH, "SUBJECT", { bold: true, size: HEAD_SIZE, fill: "#dfe7f5" });
  gx += SUBJECT_COL;
  cellRect(doc, gx, ty, MAX_COL, groupHeaderH + subHeaderH, "MAX", { bold: true, size: HEAD_SIZE, fill: "#dfe7f5" });
  gx += MAX_COL;
  ["1ST TERM", "2ND TERM", "3RD TERM"].forEach((label) => {
    cellRect(doc, gx, ty, TERM_GROUP_W, groupHeaderH, label, { bold: true, size: HEAD_SIZE, fill: "#dfe7f5" });
    gx += TERM_GROUP_W;
  });
  cellRect(doc, gx, ty, YEARLY_GROUP_W, groupHeaderH, "YEARLY", { bold: true, size: HEAD_SIZE, fill: "#dfe7f5" });

  // Header row B (sub-columns)
  let sy = ty + groupHeaderH;
  gx = tableX + SUBJECT_COL + MAX_COL;
  for (let i = 0; i < 3; i++) {
    ["TEST", "EXAM", "MN", "RNK"].forEach((label, idx) => {
      const w = TERM_SUBCOLS[idx];
      cellRect(doc, gx, sy, w, subHeaderH, label, { bold: true, size: HEAD_SIZE, fill: "#eef2fa" });
      gx += w;
    });
  }
  ["TOTAL", "MEAN", "RANK", "GRADE", "REMARKS"].forEach((label, idx) => {
    const w = YEARLY_SUBCOLS[idx];
    cellRect(doc, gx, sy, w, subHeaderH, label, { bold: true, size: HEAD_SIZE, fill: "#eef2fa" });
    gx += w;
  });

  ty += groupHeaderH + subHeaderH;

  // Data rows
  rows.forEach((r) => {
    let x = tableX;
    cellRect(doc, x, ty, SUBJECT_COL, ROW_H, r.subject, { align: "left", size: CELL_SIZE });
    x += SUBJECT_COL;
    cellRect(doc, x, ty, MAX_COL, ROW_H, r.max, { size: CELL_SIZE });
    x += MAX_COL;
    [r.t1, r.t2, r.t3].forEach((cell) => {
      cellRect(doc, x, ty, TERM_SUBCOLS[0], ROW_H, cell.test, { size: CELL_SIZE, color: cell.test !== "" ? gradeColor(Number(cell.test)) : "#000" }); x += TERM_SUBCOLS[0];
      cellRect(doc, x, ty, TERM_SUBCOLS[1], ROW_H, cell.exam, { size: CELL_SIZE, color: cell.exam !== "" ? gradeColor(Number(cell.exam)) : "#000" }); x += TERM_SUBCOLS[1];
      cellRect(doc, x, ty, TERM_SUBCOLS[2], ROW_H, cell.mn, {
        size: CELL_SIZE,
        bold: true,
        color: cell.test !== "" ? gradeColor(Number(cell.mn)) : "#000",
      }); x += TERM_SUBCOLS[2];
      cellRect(doc, x, ty, TERM_SUBCOLS[3], ROW_H, cell.rnk, { size: CELL_SIZE }); x += TERM_SUBCOLS[3];
    });
    cellRect(doc, x, ty, YEARLY_SUBCOLS[0], ROW_H, r.total, { size: CELL_SIZE }); x += YEARLY_SUBCOLS[0];
    const hasAnyGrade = r.t1.test !== "" || r.t2.test !== "" || r.t3.test !== "";
    const meanColor = hasAnyGrade ? gradeColor(Number(r.mean)) : "#000";
    cellRect(doc, x, ty, YEARLY_SUBCOLS[1], ROW_H, r.mean, { size: CELL_SIZE, bold: true, color: meanColor }); x += YEARLY_SUBCOLS[1];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[2], ROW_H, r.rank, { size: CELL_SIZE }); x += YEARLY_SUBCOLS[2];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[3], ROW_H, r.grade, { size: CELL_SIZE, bold: true, color: meanColor }); x += YEARLY_SUBCOLS[3];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[4], ROW_H, r.remark, { size: 5.3 });
    ty += ROW_H;
  });

  // TOTAL MARKS row
  {
    let x = tableX;
    cellRect(doc, x, ty, SUBJECT_COL + MAX_COL, ROW_H, "TOTAL MARKS", { bold: true, size: CELL_SIZE, fill: "#f3f5fa" });
    x += SUBJECT_COL + MAX_COL;
    // Average total per subject for the term (a genuine 0-100 percentage).
    // colTotals holds the raw sum of Test scores and the raw sum of Exam
    // scores (each subject contributing up to 100 to each), so averaging
    // per subject means dividing by 2*subjCount, not just subjCount.
    const subjCount = subjects.length || 1;
    [
      [colTotals.t1a, colTotals.t1b, (colTotals.t1a + colTotals.t1b) / (2 * subjCount)],
      [colTotals.t2a, colTotals.t2b, (colTotals.t2a + colTotals.t2b) / (2 * subjCount)],
      [colTotals.t3a, colTotals.t3b, (colTotals.t3a + colTotals.t3b) / (2 * subjCount)],
    ].forEach(([a, b, mn]) => {
      cellRect(doc, x, ty, TERM_SUBCOLS[0], ROW_H, a || "", { bold: true, size: CELL_SIZE, fill: "#f3f5fa" }); x += TERM_SUBCOLS[0];
      cellRect(doc, x, ty, TERM_SUBCOLS[1], ROW_H, b || "", { bold: true, size: CELL_SIZE, fill: "#f3f5fa" }); x += TERM_SUBCOLS[1];
      cellRect(doc, x, ty, TERM_SUBCOLS[2], ROW_H, mn ? mn.toFixed(1) : "", { bold: true, size: CELL_SIZE, fill: "#f3f5fa", color: a + b ? gradeColor(mn) : "#000" }); x += TERM_SUBCOLS[2];
      cellRect(doc, x, ty, TERM_SUBCOLS[3], ROW_H, "", { fill: "#f3f5fa" }); x += TERM_SUBCOLS[3];
    });
    cellRect(doc, x, ty, YEARLY_SUBCOLS[0], ROW_H, obtained.toFixed(1), { bold: true, size: CELL_SIZE, fill: "#f3f5fa" }); x += YEARLY_SUBCOLS[0];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[1] + YEARLY_SUBCOLS[2] + YEARLY_SUBCOLS[3] + YEARLY_SUBCOLS[4], ROW_H, "", { fill: "#f3f5fa" });
    ty += ROW_H;
  }
  // PERCENTAGE row
  {
    let x = tableX;
    cellRect(doc, x, ty, SUBJECT_COL + MAX_COL, ROW_H, "PERCENTAGE", { bold: true, size: CELL_SIZE, fill: "#f3f5fa" });
    x += SUBJECT_COL + MAX_COL;
    const subjCount = subjects.length || 1;
    const pctOf = (a, b) => (a + b ? ((a + b) / (2 * subjCount)).toFixed(1) : "0.0");
    [
      [colTotals.t1a, colTotals.t1b],
      [colTotals.t2a, colTotals.t2b],
      [colTotals.t3a, colTotals.t3b],
    ].forEach(([a, b]) => {
      cellRect(doc, x, ty, TERM_SUBCOLS[0] + TERM_SUBCOLS[1], ROW_H, "", { fill: "#f3f5fa" }); x += TERM_SUBCOLS[0] + TERM_SUBCOLS[1];
      cellRect(doc, x, ty, TERM_SUBCOLS[2], ROW_H, pctOf(a, b), { bold: true, size: CELL_SIZE, fill: "#f3f5fa", color: a + b ? gradeColor((a + b) / (2 * subjCount)) : "#000" }); x += TERM_SUBCOLS[2];
      cellRect(doc, x, ty, TERM_SUBCOLS[3], ROW_H, "", { fill: "#f3f5fa" }); x += TERM_SUBCOLS[3];
    });
    cellRect(doc, x, ty, YEARLY_SUBCOLS[0], ROW_H, avgPct.toFixed(1), { bold: true, size: CELL_SIZE, fill: "#f3f5fa", color: obtainable ? gradeColor(avgPct) : "#000" }); x += YEARLY_SUBCOLS[0];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[1] + YEARLY_SUBCOLS[2] + YEARLY_SUBCOLS[3] + YEARLY_SUBCOLS[4], ROW_H, "", { fill: "#f3f5fa" });
    ty += ROW_H;
  }

  ty += 6;

  // ── Keys to rating ── (two rows of 5/4 now that the table is narrower —
  // one row of 9 no longer fits a portrait-width table).
  const keys = [
    "100-75 EXCELLENT", "74-70 V.GOOD", "69-65 V.GOOD", "64-60 V.GOOD", "59-55 GOOD",
    "54-50 GOOD", "49-45 FAIR", "44-40 FAIR", "39-0 FAIL",
  ];
  const keysRow1 = keys.slice(0, 5);
  const keysRow2 = keys.slice(5);
  let keyW = TABLE_WIDTH / 5;
  let kx = tableX;
  keysRow1.forEach((k) => {
    cellRect(doc, kx, ty, keyW, ROW_H, k, { size: 5.6, bold: true, fill: "#fafafa" });
    kx += keyW;
  });
  ty += ROW_H;
  kx = tableX;
  keysRow2.forEach((k) => {
    cellRect(doc, kx, ty, keyW, ROW_H, k, { size: 5.6, bold: true, fill: "#fafafa" });
    kx += keyW;
  });
  // Leave the 5th slot on row 2 blank so both rows line up under the table.
  cellRect(doc, kx, ty, keyW, ROW_H, "", { fill: "#fafafa" });
  ty += ROW_H + 12;

  // ── Comments / signatures ──
  // Uses fractions of TABLE_WIDTH (rather than fixed pixel offsets tuned
  // for the old, much wider landscape table) so it scales correctly at
  // portrait width: label + comment on one line, Sign./Date stacked
  // beneath it on the next line — comfortably fits either way.
  const signX = tableX;
  const dateX = tableX + TABLE_WIDTH - 118;

  doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#000").text("Class Teacher's Comments:", tableX, ty);
  doc.font("Helvetica").text("Good, Keep improving", tableX + 118, ty);
  ty += 14;
  doc.font("Helvetica-Bold").text("Sign.:", signX, ty);
  doc.font("Helvetica").text("_______________", signX + 30, ty);
  doc.font("Helvetica-Bold").text("Date:", dateX, ty);
  doc.font("Helvetica").text(new Date().toLocaleDateString("en-GB"), dateX + 28, ty);
  ty += 18;

  doc.font("Helvetica-Bold").text("Principal's Comments:", tableX, ty);
  doc.font("Helvetica").text("Good, Keep improving", tableX + 118, ty);
  ty += 14;
  doc.font("Helvetica-Bold").text("Sign.:", signX, ty);
  doc.font("Helvetica").text("_______________", signX + 30, ty);
  doc.font("Helvetica-Bold").text("Date:", dateX, ty);
  doc.font("Helvetica").text(new Date().toLocaleDateString("en-GB"), dateX + 28, ty);
  ty += 18;

  doc.font("Helvetica-Bold").text("Promotion Status:", tableX, ty);
  doc.font("Helvetica").text(settings.promotionStatusNote || "-", tableX + 100, ty);

  // Official stamp (school logo clipped to a circle, bottom-right)
  if (hasLogo) {
    const r = 26;
    const cx = tableX + TABLE_WIDTH - r - 4;
    const cy = ty - 4;
    doc.save();
    doc.circle(cx, cy, r).clip();
    doc.image(LOGO_PATH, cx - r, cy - r, { width: r * 2, height: r * 2 });
    doc.restore();
    doc.circle(cx, cy, r).stroke("#1a2b4a");
  }

  ty += 26;
  doc.font("Helvetica").fontSize(6.5).fillColor("#555")
    .text(`Date printed: ${new Date().toString().split(" GMT")[0]}  |  Any alteration invalidates this statement`, tableX, ty, { width: TABLE_WIDTH, align: "center" });

  if (!isBulk) doc.end();
}

module.exports = generateReportCard;
