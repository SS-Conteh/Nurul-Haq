const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { ordinal, gradeFor, ageFromDob, rankDescending } = require("./reportCardHelpers");

const LOGO_PATH = path.join(__dirname, "..", "assets", "logo.jpeg");
const STAMP_PATH = path.join(__dirname, "..", "assets", "stamp.png");
// Arabic-capable font for subject names printed partly in Arabic (e.g.
// "Anahwu النحو والصرف"). pdfkit/fontkit can embed and draw the glyphs, but
// pdfkit does not run a real Arabic text-shaping/BiDi engine, so joined
// cursive letterforms and right-to-left reordering will not be perfect —
// this is the closest practical match without a full shaping library.
const ARABIC_FONT_PATH = path.join(__dirname, "..", "assets", "NotoNaskhArabic-Regular.ttf");

// ── Portrait A4 layout, sized to land the table at ~full page width, ──
// exactly mirroring the school's paper template (same column grouping,
// same header wording, same 9-cell grading key, same blue grid/lavender
// bands, same signature + stamp block).
const SUBJECT_COL = 90;
const MAX_COL = 20;
const TERM_SUBCOLS = [23, 23, 22, 21]; // TEST, EXAM, MN, RNK
const TERM_GROUP_W = TERM_SUBCOLS.reduce((a, b) => a + b, 0);
const YEARLY_SUBCOLS = [50, 24, 22, 30, 40]; // Total Score, Mean, Rank, Grade, Remarks
const YEARLY_GROUP_W = YEARLY_SUBCOLS.reduce((a, b) => a + b, 0);
const TABLE_WIDTH = SUBJECT_COL + MAX_COL + TERM_GROUP_W * 3 + YEARLY_GROUP_W;

const ROW_H = 15;
const CELL_SIZE = 7.3;
const HEAD_SIZE = 6.8;

// ── Palette — sampled directly from the paper template, with score text ──
// brightened a step past the sampled value so pass/fail reads clearly.
const LAVENDER = "#d9d9f6"; // header banner / section-title bands
const GRID = "#0000c0"; // every rule and cell border on the sheet
const PASS_COLOR = "#0000ff"; // score >= 50% — brighter blue than the grid
const FAIL_COLOR = "#ff0000"; // score < 50%
const BLACK = "#000000";
const MUTED_GRAY = "#808080"; // footer timestamp line

const gradeColor = (pct) => (pct >= 50 ? PASS_COLOR : FAIL_COLOR);
const ARABIC_RE = /[\u0600-\u06FF]/;

function cellRect(doc, x, y, w, h, text, opts = {}) {
  const { align = "center", bold = false, size = CELL_SIZE, fill = null, valign = "middle", color = BLACK } = opts;
  if (fill) {
    doc.save().rect(x, y, w, h).fill(fill).restore();
  }
  doc.lineWidth(0.6).rect(x, y, w, h).stroke(GRID);
  if (text !== undefined && text !== null && text !== "") {
    const str = String(text);
    const font = ARABIC_RE.test(str) && doc._arabicFontOk ? "Arabic" : bold ? "Helvetica-Bold" : "Helvetica";
    doc.font(font).fontSize(size).fillColor(color);
    const textY = valign === "middle" ? y + (h - size) / 2 + 1 : y + 2;
    doc.text(str, x + 1, textY, { width: w - 2, align });
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

// Draws the school's real stamp image, scaled to fit inside the given
// box and centered — replaces the earlier vector-drawn approximation.
function drawOfficialStamp(doc, cx, cy, r) {
  if (!fs.existsSync(STAMP_PATH)) return;
  const size = r * 2;
  doc.image(STAMP_PATH, cx - r, cy - r, { fit: [size, size], align: "center", valign: "center" });
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

  function yearlyStatsFor(studentId, subject) {
    const rows = gradesFor(studentId, subject);
    let total = 0, termCount = 0;
    rows.forEach((g) => {
      if (g) { total += ((g.test || 0) + (g.examScore || 0)) / 2; termCount += 1; }
    });
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

  const rows = subjects.map((subject) => {
    const [t1, t2, t3] = gradesFor(student._id, subject);
    const termCell = (g, idx) => {
      if (!g) return { test: "", exam: "", mn: "0.0", rnk: "-" };
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

  // ═══════════════ DRAW THE PDF — exact replica of the paper template ═══════════════
  const doc = sharedDoc || new PDFDocument({ size: "A4", margin: 20 });
  if (!isBulk) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=ReportCard-${(student.admissionNo || student.name || "student").replace(/\s+/g, "_")}.pdf`,
    );
    doc.pipe(res);
  }

  if (doc._arabicFontOk === undefined) {
    try {
      if (fs.existsSync(ARABIC_FONT_PATH)) {
        doc.registerFont("Arabic", ARABIC_FONT_PATH);
        doc._arabicFontOk = true;
      } else {
        doc._arabicFontOk = false;
      }
    } catch (e) {
      doc._arabicFontOk = false;
    }
  }

  const pageW = doc.page.width;
  const marginX = doc.page.margins.left;
  const usableW = pageW - marginX * 2;
  const hasLogo = fs.existsSync(LOGO_PATH);

  let y = 24;

  // ── Header banner: lavender box, blue border, crest on each side ──
  const bannerH = 88;
  doc.save().rect(marginX, y, usableW, bannerH).fill(LAVENDER).restore();
  doc.lineWidth(1.4).rect(marginX, y, usableW, bannerH).stroke(GRID);

  const logoSize = 70;
  if (hasLogo) {
    doc.image(LOGO_PATH, marginX + 12, y + (bannerH - logoSize) / 2, { fit: [logoSize, logoSize], align: "center", valign: "center" });
    doc.image(LOGO_PATH, marginX + usableW - logoSize - 12, y + (bannerH - logoSize) / 2, { fit: [logoSize, logoSize], align: "center", valign: "center" });
  }

  const textX = marginX + logoSize + 20;
  const textW = usableW - (logoSize + 20) * 2;
  doc.font("Helvetica-Bold").fontSize(16).fillColor(BLACK)
    .text((settings.schoolName || "Nurul-Haq Islamic Academy").toUpperCase(), textX, y + 12, { width: textW, align: "center" });
  doc.font("Helvetica").fontSize(8.5).fillColor(BLACK)
    .text((settings.address || "New Jersey, Angola").toUpperCase(), textX, y + 33, { width: textW, align: "center" });
  doc.font("Helvetica").fontSize(8.5).fillColor(BLACK)
    .text(`Motto: ${settings.motto || "Knowledge and Perseverance"}`, textX, y + 46, { width: textW, align: "center" });
  doc.font("Helvetica").fontSize(8.5).fillColor(BLACK)
    .text(`Moblie: ${settings.phone || ""}`, textX, y + 59, { width: textW, align: "center" });

  y += bannerH + 8;

  // ── Title line ──
  const titleText = `(${session}) ${termLabel.toUpperCase()} PUPIL'S PROGRESS REPORT SHEET`;
  doc.font("Helvetica-Bold").fontSize(14).fillColor(BLACK)
    .text(titleText, marginX, y, { width: usableW, align: "center" });
  y += 22;

  // ── Student info block (plain text, no card/border — matches the paper) ──
  const photoW = 68, photoH = 78;
  const infoTop = y;
  const colGap = 8;
  const colW = (usableW - photoW - colGap * 3) / 3;
  const col1X = marginX;
  const lineH = 14.6;

  const col1 = [
    ["Name", (student.name || "").toUpperCase()],
    ["Age", ageFromDob(student.dob)],
    ["Date Of Birth", student.dob || "-"],
    ["Sex", student.gender || "-"],
    ["Class", classDoc?.name || "-"],
    ["Admission No.", student.admissionNo || "-"],
    ["Class Teacher", classDoc?.classTeacherName || "-"],
  ];
  const col2 = [
    ["Terminal Duration", settings.terminalDuration || ""],
    ["Term Begins", settings.termBegins || "-"],
    ["Term End", settings.termEnd || "-"],
    ["Next Term Begins", settings.nextTermBegins || "-"],
    ["No. of Times Late", String(attendanceCounts.late ?? 0)],
    ["No. in Class", String(classSize)],
  ];
  const col3 = [
    ["No. of Times Present", String(attendanceCounts.present ?? 0)],
    ["No. of Times Absent", String(attendanceCounts.absent ?? 0)],
    ["Total Score Obtainable", obtainable.toFixed(1)],
    ["Total Score Obtained", obtained.toFixed(1)],
    ["Average Percentage", avgPct.toFixed(1)],
    ["Position", overallRank ? ordinal(overallRank) : "-"],
  ];

  function drawInfoCol(items, x, w, colored) {
    let iy = infoTop;
    const labelFont = "Helvetica-Bold";
    const labelSize = 8.6;
    const valueSize = 8.6;
    const gap = 5;
    items.forEach(([label, value]) => {
      doc.font(labelFont).fontSize(labelSize);
      const labelW = Math.min(doc.widthOfString(label) + gap, w * 0.62);
      doc.fillColor(BLACK).text(label, x, iy, { width: labelW, lineBreak: false });
      const isPct = colored && label === "Average Percentage";
      const color = isPct ? gradeColor(avgPct) : BLACK;
      const valueW = w - labelW;
      doc.font("Helvetica").fontSize(valueSize).fillColor(color)
        .text(String(value), x + labelW, iy, { width: valueW });
      const lines = Math.ceil(doc.widthOfString(String(value)) / valueW) || 1;
      iy += lineH * Math.max(1, lines);
    });
    return iy;
  }

  drawInfoCol(col1, col1X, colW, false);
  drawInfoCol(col2, col1X + colW + colGap, colW, false);
  drawInfoCol(col3, col1X + (colW + colGap) * 2, colW, true);

  // Photo box — plain bordered rectangle, top-right
  const photoX = marginX + usableW - photoW;
  doc.lineWidth(0.8).rect(photoX, infoTop, photoW, photoH).stroke(BLACK);
  const photoSrc = resolvePhotoImage(student.avatarUrl);
  if (photoSrc) {
    doc.save();
    doc.rect(photoX + 1, infoTop + 1, photoW - 2, photoH - 2).clip();
    doc.image(photoSrc, photoX + 1, infoTop + 1, { cover: [photoW - 2, photoH - 2], align: "center", valign: "center" });
    doc.restore();
  } else {
    doc.font("Helvetica").fontSize(7).fillColor(MUTED_GRAY).text("PHOTO", photoX, infoTop + photoH / 2 - 4, { width: photoW, align: "center" });
  }

  y = infoTop + Math.max(lineH * 8, photoH) + 8;

  // ── Academic performance table — one continuous blue-bordered block ──
  const tableX = marginX + (usableW - TABLE_WIDTH) / 2;
  let ty = y;
  const tableTopY = ty;

  cellRect(doc, tableX, ty, TABLE_WIDTH, ROW_H, "ACADEMIC PERFORMANCE", { bold: true, size: 8.5, fill: LAVENDER });
  ty += ROW_H;

  const groupHeaderH = ROW_H;
  const subHeaderH = ROW_H;
  let gx = tableX;
  cellRect(doc, gx, ty, SUBJECT_COL, groupHeaderH + subHeaderH, "SUBJECT", { bold: true, size: 14, fill: "#ffffff" });
  gx += SUBJECT_COL;
  cellRect(doc, gx, ty, MAX_COL, groupHeaderH + subHeaderH, "MAX", { bold: true, size: HEAD_SIZE, fill: "#ffffff" });
  gx += MAX_COL;
  ["FIRST TERM", "SECOND TERM", "THIRD TERM"].forEach((label) => {
    cellRect(doc, gx, ty, TERM_GROUP_W, groupHeaderH, label, { bold: true, size: HEAD_SIZE, fill: "#ffffff" });
    gx += TERM_GROUP_W;
  });
  cellRect(doc, gx, ty, YEARLY_GROUP_W, groupHeaderH, "YEARLY", { bold: true, size: HEAD_SIZE, fill: "#ffffff" });

  let sy = ty + groupHeaderH;
  gx = tableX + SUBJECT_COL + MAX_COL;
  const termTestLabels = [["TEST", "EXAM"], ["TEST", "EXAM"], ["TEST", "EXAM"]];
  for (let i = 0; i < 3; i++) {
    [termTestLabels[i][0], termTestLabels[i][1], "MN", "RNK"].forEach((label, idx) => {
      const w = TERM_SUBCOLS[idx];
      cellRect(doc, gx, sy, w, subHeaderH, label, { bold: true, size: HEAD_SIZE, fill: "#ffffff" });
      gx += w;
    });
  }
  ["TOTAL SCORE", "MEAN", "RANK", "GRADE", "REMARKS"].forEach((label, idx) => {
    const w = YEARLY_SUBCOLS[idx];
    cellRect(doc, gx, sy, w, subHeaderH, label, { bold: true, size: HEAD_SIZE, fill: "#ffffff" });
    gx += w;
  });

  ty += groupHeaderH + subHeaderH;

  rows.forEach((r) => {
    let x = tableX;
    cellRect(doc, x, ty, SUBJECT_COL, ROW_H, r.subject, { align: "left", size: CELL_SIZE, bold: false, color: BLACK });
    x += SUBJECT_COL;
    cellRect(doc, x, ty, MAX_COL, ROW_H, r.max, { size: CELL_SIZE });
    x += MAX_COL;
    [r.t1, r.t2, r.t3].forEach((cell) => {
      cellRect(doc, x, ty, TERM_SUBCOLS[0], ROW_H, cell.test, { size: CELL_SIZE, color: cell.test !== "" ? gradeColor(Number(cell.test)) : BLACK }); x += TERM_SUBCOLS[0];
      cellRect(doc, x, ty, TERM_SUBCOLS[1], ROW_H, cell.exam, { size: CELL_SIZE, color: cell.exam !== "" ? gradeColor(Number(cell.exam)) : BLACK }); x += TERM_SUBCOLS[1];
      cellRect(doc, x, ty, TERM_SUBCOLS[2], ROW_H, cell.mn, { size: CELL_SIZE, color: cell.test !== "" ? gradeColor(Number(cell.mn)) : BLACK }); x += TERM_SUBCOLS[2];
      cellRect(doc, x, ty, TERM_SUBCOLS[3], ROW_H, cell.rnk, { size: CELL_SIZE, color: BLACK }); x += TERM_SUBCOLS[3];
    });
    cellRect(doc, x, ty, YEARLY_SUBCOLS[0], ROW_H, r.total, { size: CELL_SIZE, color: BLACK }); x += YEARLY_SUBCOLS[0];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[1], ROW_H, r.mean, { size: CELL_SIZE, color: gradeColor(Number(r.mean)) }); x += YEARLY_SUBCOLS[1];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[2], ROW_H, r.rank, { size: CELL_SIZE, color: BLACK }); x += YEARLY_SUBCOLS[2];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[3], ROW_H, r.grade, { size: CELL_SIZE, color: BLACK }); x += YEARLY_SUBCOLS[3];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[4], ROW_H, r.remark, { size: CELL_SIZE, color: BLACK });
    ty += ROW_H;
  });

  {
    let x = tableX;
    cellRect(doc, x, ty, SUBJECT_COL + MAX_COL, ROW_H, "TOTAL MARKS", { bold: true, size: CELL_SIZE });
    x += SUBJECT_COL + MAX_COL;
    const subjCount = subjects.length || 1;
    [
      [colTotals.t1a, colTotals.t1b, (colTotals.t1a + colTotals.t1b) / (2 * subjCount)],
      [colTotals.t2a, colTotals.t2b, (colTotals.t2a + colTotals.t2b) / (2 * subjCount)],
      [colTotals.t3a, colTotals.t3b, (colTotals.t3a + colTotals.t3b) / (2 * subjCount)],
    ].forEach(([a, b, mn]) => {
      cellRect(doc, x, ty, TERM_SUBCOLS[0], ROW_H, a || "", { bold: true, size: CELL_SIZE, color: a ? gradeColor(a / subjCount) : BLACK }); x += TERM_SUBCOLS[0];
      cellRect(doc, x, ty, TERM_SUBCOLS[1], ROW_H, b || "", { bold: true, size: CELL_SIZE, color: b ? gradeColor(b / subjCount) : BLACK }); x += TERM_SUBCOLS[1];
      cellRect(doc, x, ty, TERM_SUBCOLS[2], ROW_H, mn ? mn.toFixed(1) : "", { bold: true, size: CELL_SIZE, color: a + b ? gradeColor(mn) : BLACK }); x += TERM_SUBCOLS[2];
      cellRect(doc, x, ty, TERM_SUBCOLS[3], ROW_H, ""); x += TERM_SUBCOLS[3];
    });
    cellRect(doc, x, ty, YEARLY_SUBCOLS[0], ROW_H, obtained.toFixed(1), { bold: true, size: CELL_SIZE }); x += YEARLY_SUBCOLS[0];
    cellRect(doc, x, ty, YEARLY_SUBCOLS[1] + YEARLY_SUBCOLS[2] + YEARLY_SUBCOLS[3] + YEARLY_SUBCOLS[4], ROW_H, "");
    ty += ROW_H;
  }
  {
    let x = tableX;
    cellRect(doc, x, ty, SUBJECT_COL + MAX_COL, ROW_H, "PERCENTAGE", { bold: true, size: CELL_SIZE });
    x += SUBJECT_COL + MAX_COL;
    const subjCount = subjects.length || 1;
    const pctOf = (a, b) => (a + b ? ((a + b) / (2 * subjCount)).toFixed(1) : "0.0");
    [
      [colTotals.t1a, colTotals.t1b],
      [colTotals.t2a, colTotals.t2b],
      [colTotals.t3a, colTotals.t3b],
    ].forEach(([a, b]) => {
      cellRect(doc, x, ty, TERM_SUBCOLS[0] + TERM_SUBCOLS[1], ROW_H, ""); x += TERM_SUBCOLS[0] + TERM_SUBCOLS[1];
      cellRect(doc, x, ty, TERM_SUBCOLS[2], ROW_H, pctOf(a, b), { bold: true, size: CELL_SIZE, color: a + b ? gradeColor((a + b) / (2 * subjCount)) : BLACK }); x += TERM_SUBCOLS[2];
      cellRect(doc, x, ty, TERM_SUBCOLS[3], ROW_H, ""); x += TERM_SUBCOLS[3];
    });
    cellRect(doc, x, ty, YEARLY_SUBCOLS[0], ROW_H, "");
    cellRect(doc, x + YEARLY_SUBCOLS[0], ty, YEARLY_SUBCOLS[1], ROW_H, avgPct.toFixed(1), { bold: true, size: CELL_SIZE, color: obtainable ? gradeColor(avgPct) : BLACK });
    cellRect(doc, x + YEARLY_SUBCOLS[0] + YEARLY_SUBCOLS[1], ty, YEARLY_SUBCOLS[2], ROW_H, overallRank ? ordinal(overallRank) : "-", { bold: true, size: CELL_SIZE });
    cellRect(doc, x + YEARLY_SUBCOLS[0] + YEARLY_SUBCOLS[1] + YEARLY_SUBCOLS[2], ty, YEARLY_SUBCOLS[3] + YEARLY_SUBCOLS[4], ROW_H, "");
    ty += ROW_H;
  }

  cellRect(doc, tableX, ty, TABLE_WIDTH, ROW_H, "KEYS TO RATING", { bold: true, size: 8, fill: LAVENDER });
  ty += ROW_H;

  // Column widths are NOT equal on the paper sheet — each cell is only as
  // wide as its own text needs (measured proportions from the original).
  const keys = [
    ["100-75 (EXCELLENT)", 82], ["74-70 (V. GOOD)", 69], ["69-65 (V. GOOD)", 69], ["64-60 (V. GOOD)", 69],
    ["59-55 (GOOD)", 59], ["54-50 (GOOD)", 59], ["49-45 (FAIR)", 53], ["44-40 (FAIR)", 54], ["39-0 (FAIL)", 47],
  ];
  const weightSum = keys.reduce((s, [, wgt]) => s + wgt, 0);
  let kx = tableX;
  keys.forEach(([k, wgt]) => {
    const cw = (wgt / weightSum) * TABLE_WIDTH;
    cellRect(doc, kx, ty, cw, ROW_H, k, { align: "left", size: 6.9, color: BLACK });
    kx += cw;
  });
  ty += ROW_H;

  doc.lineWidth(1.4).rect(tableX, tableTopY, TABLE_WIDTH, ty - tableTopY).stroke(GRID);

  ty += 8;

  // ── Comments / signatures box + official stamp box, side by side ──
  const commentH = 88;
  const stampBoxW = 96;
  const gapCS = 8;
  const commentsW = TABLE_WIDTH - stampBoxW - gapCS;

  doc.lineWidth(1.2).rect(tableX, ty, commentsW, commentH).stroke(GRID);
  const cPad = 10;
  let cy = ty + cPad + 4;
  const dateX = tableX + commentsW - 96;

  doc.font("Helvetica-Bold").fontSize(8.8).fillColor(BLACK).text("Class Teacher's Comments:", tableX + cPad, cy, { lineBreak: false });
  doc.font("Helvetica").fillColor(BLACK).text("  Good, Keep improving", tableX + cPad + 148, cy, { lineBreak: false });
  doc.font("Helvetica-Bold").text("Sign.:", tableX + cPad + 300, cy, { lineBreak: false });
  doc.font("Helvetica").text(" ________________", tableX + cPad + 322, cy, { lineBreak: false });
  doc.font("Helvetica-Bold").text("Date:", dateX, cy, { lineBreak: false });
  doc.font("Helvetica").text(" " + new Date().toLocaleDateString("en-GB"), dateX + 26, cy);
  cy += 14;
  doc.moveTo(tableX + cPad, cy).lineTo(tableX + commentsW - cPad, cy).lineWidth(0.5).stroke(MUTED_GRAY);
  cy += 14;

  doc.font("Helvetica-Bold").fontSize(8.8).fillColor(BLACK).text("Principal's Comments:", tableX + cPad, cy, { lineBreak: false });
  doc.font("Helvetica").fillColor(BLACK).text("  Good, Keep improving", tableX + cPad + 128, cy, { lineBreak: false });
  doc.font("Helvetica-Bold").text("Sign.:", tableX + cPad + 300, cy, { lineBreak: false });
  doc.font("Helvetica").text(" ________________", tableX + cPad + 322, cy, { lineBreak: false });
  doc.font("Helvetica-Bold").text("Date:", dateX, cy, { lineBreak: false });
  doc.font("Helvetica").text(" " + new Date().toLocaleDateString("en-GB"), dateX + 26, cy);
  cy += 14;
  doc.moveTo(tableX + cPad, cy).lineTo(tableX + commentsW - cPad, cy).lineWidth(0.5).stroke(MUTED_GRAY);
  cy += 14;

  const statusText = settings.promotionStatusNote || "-";
  doc.font("Helvetica-Bold").fontSize(8.8).fillColor(BLACK).text("Promotion Status:", tableX + cPad, cy, { lineBreak: false });
  doc.font("Helvetica").text(" " + statusText, tableX + cPad + 92, cy, { width: commentsW - cPad * 2 - 92 });
  cy += 14;
  doc.moveTo(tableX + cPad, cy).lineTo(tableX + commentsW - cPad, cy).lineWidth(0.5).stroke(MUTED_GRAY);
  cy += 12;

  doc.font("Helvetica").fontSize(8).fillColor(MUTED_GRAY)
    .text(`Date printed: ${new Date().toString().split(" GMT")[0]}  |  Any alteration invalidates this statement`, tableX + cPad, cy, { width: commentsW - cPad * 2, align: "center" });

  const stampX = tableX + commentsW + gapCS;
  drawOfficialStamp(doc, stampX + stampBoxW / 2, ty + commentH / 2, Math.min(stampBoxW, commentH) / 2 + 4);

  if (!isBulk) doc.end();
}

module.exports = generateReportCard;
