const fs = require('fs');

const filePath = './utils/generateReportCard.js';
let content = fs.readFileSync(filePath, 'utf8');

const startMarker = '// ═══════════════ DRAW THE PDF';
const startIndex = content.indexOf(startMarker);

if (startIndex === -1) {
  console.error("Could not find start marker");
  process.exit(1);
}

const headContent = content.substring(0, startIndex);

const newPdfCode = `// ═══════════════ DRAW THE PDF — "Classic" theme ═══════════════
  const doc = sharedDoc || new PDFDocument({ size: "A4", margin: 24 });
  if (!isBulk) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      \`attachment; filename=ReportCard-\${(student.admissionNo || student.name || "student").replace(/\\s+/g, "_")}.pdf\`,
    );
    doc.pipe(res);
  }

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const marginX = doc.page.margins.left;
  const usableW = pageW - marginX * 2;
  const hasLogo = fs.existsSync(LOGO_PATH);

  // ── Palette ──
  const COLOR_PASS = "#0000ff"; // blue
  const COLOR_FAIL = "#ff0000"; // red
  const NAVY = "#000000"; // Using black for most text
  const BORDER = "#0000ff"; // blue border

  function roundedFillStroke(x, y, w, h, r, fill, stroke, lw = 1) {
    const rr = doc.roundedRect(x, y, w, h, r);
    if (fill && stroke) rr.fillAndStroke(fill, stroke);
    else if (fill) rr.fill(fill);
    else if (stroke) rr.lineWidth(lw).stroke(stroke);
  }

  // Helper for cells
  function drawCell(x, y, w, h, text, opts = {}) {
    const { align = "center", bold = false, size = CELL_SIZE, color = "#000", border = BORDER } = opts;
    doc.rect(x, y, w, h).lineWidth(1).stroke(border);
    if (text !== undefined && text !== null && text !== "") {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);
      const textY = y + (h - size) / 2 + 1;
      doc.text(String(text), x + 1, textY, { width: w - 2, align });
    }
  }

  let y = 24;

  // ── Header Box ──
  const headerH = 70;
  doc.rect(marginX, y, usableW, headerH).lineWidth(1.5).stroke(BORDER);
  
  if (hasLogo) {
    // Left Logo
    doc.image(LOGO_PATH, marginX + 5, y + 5, { fit: [60, 60], align: "center", valign: "center" });
    // Right Logo
    doc.image(LOGO_PATH, marginX + usableW - 65, y + 5, { fit: [60, 60], align: "center", valign: "center" });
  }

  const textX = marginX + 70;
  const textW = usableW - 140;
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#000")
    .text((settings.schoolName || "NURUL-HAQ ISLAMIC ACADEMY").toUpperCase(), textX, y + 10, { width: textW, align: "center" });
  doc.font("Helvetica").fontSize(9).fillColor("#000")
    .text((settings.address || "NEW JERSEY, ANGOLA").toUpperCase(), textX, y + 28, { width: textW, align: "center" });
  doc.font("Helvetica").fontSize(9).fillColor("#000")
    .text(\`Motto: \${settings.motto || "Knowledge and Perseverance"}\`, textX, y + 40, { width: textW, align: "center" });
  doc.font("Helvetica").fontSize(9).fillColor("#000")
    .text(\`Moblie: \${settings.phone || "+23279481354 / +23278221886"}\`, textX, y + 52, { width: textW, align: "center" });

  y += headerH + 15;

  // ── Title ──
  const titleText = \`(2025/2026) THIRD TERM PUPIL'S PROGRESS REPORT SHEET\`; // hardcoded based on PDF or dynamic
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#000");
  doc.text(titleText, marginX, y, { width: usableW, align: "center" });
  y += 20;

  // ── Student info block ──
  const photoW = 60, photoH = 75;
  const photoX = marginX + usableW - photoW;
  
  const col1X = marginX;
  const col1W = 200;
  const col2X = marginX + 170;
  const col2W = 150;
  const col3X = marginX + 340;
  const col3W = 130;

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
    ["Terminal Duration", settings.terminalDuration || "__________"],
    ["Term Begins", settings.termBegins || "01/01/0001"],
    ["Term End", settings.termEnd || "01/01/0001"],
    ["Next Term Begins", settings.nextTermBegins || "01/01/0001"],
    ["No. of Times Late", String(attendanceCounts.late ?? 0)],
    ["No. in Class", String(classSize)],
  ];
  const col3 = [
    ["No. of Times Present", String(attendanceCounts.present ?? "-14")],
    ["No. of Times Absent", String(attendanceCounts.absent ?? "14")],
    ["Total Score Obtainable", obtainable.toFixed(1)],
    ["Total Score Obtained", obtained.toFixed(1)],
    ["Average Percentage", avgPct.toFixed(1)],
    ["Position", overallRank ? ordinal(overallRank) : "-"],
  ];

  function drawSimpleInfoCol(items, x, isHighlight) {
    let iy = y;
    items.forEach(([label, value]) => {
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#000")
        .text(label, x, iy, { width: 100, continued: false });
      
      let valColor = "#000";
      if (isHighlight && label === "Average Percentage") valColor = COLOR_PASS;
      
      doc.font("Helvetica").fontSize(8).fillColor(valColor)
        .text(String(value), x + 85, iy, { width: 100 });
      iy += 12;
    });
  }

  drawSimpleInfoCol(col1, col1X, false);
  drawSimpleInfoCol(col2, col2X, false);
  drawSimpleInfoCol(col3, col3X, true);

  // Photo box
  const photoSrc = resolvePhotoImage(student.avatarUrl);
  if (photoSrc) {
    doc.save();
    doc.rect(photoX, y, photoW, photoH).clip();
    doc.image(photoSrc, photoX, y, { cover: [photoW, photoH], align: "center", valign: "center" });
    doc.restore();
  }

  y += Math.max(col1.length * 12, photoH) + 5;

  // ── Academic performance table ──
  const tableX = marginX;
  let ty = y;

  // Section label 
  doc.rect(tableX, ty, TABLE_WIDTH, 14).lineWidth(1).stroke(BORDER).fillAndStroke("#e6e6ff", BORDER);
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#000")
    .text("ACADEMIC PERFORMANCE", tableX, ty + 3, { width: TABLE_WIDTH, align: "center" });
  ty += 14;

  const tableTopY = ty;
  const groupHeaderH = ROW_H;
  const subHeaderH = ROW_H;
  
  let gx = tableX;
  doc.rect(gx, ty, SUBJECT_COL, groupHeaderH + subHeaderH).lineWidth(1).stroke(BORDER);
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#000").text("SUBJECT", gx, ty + 10, { width: SUBJECT_COL, align: "center" });
  gx += SUBJECT_COL;
  
  doc.rect(gx, ty, MAX_COL, groupHeaderH + subHeaderH).lineWidth(1).stroke(BORDER);
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#000").text("MAX", gx, ty + 10, { width: MAX_COL, align: "center" });
  gx += MAX_COL;

  ["FIRST TERM", "SECOND TERM", "THIRD TERM"].forEach((label) => {
    drawCell(gx, ty, TERM_GROUP_W, groupHeaderH, label, { bold: true, size: 8, color: "#000" });
    gx += TERM_GROUP_W;
  });
  drawCell(gx, ty, YEARLY_GROUP_W, groupHeaderH, "YEARLY", { bold: true, size: 8, color: "#000" });

  let sy = ty + groupHeaderH;
  gx = tableX + SUBJECT_COL + MAX_COL;
  let termNum = 1;
  for (let i = 0; i < 3; i++) {
    [\`TEST \${termNum}\`, \`TEST \${termNum+1}\`, "MN", "RNK"].forEach((label, idx) => {
      const w = TERM_SUBCOLS[idx];
      drawCell(gx, sy, w, subHeaderH, label, { bold: true, size: 7, color: "#000" });
      gx += w;
    });
    termNum += 2;
  }
  ["TOTAL\\nSCORE", "MEAN", "RANK", "GRADE", "REMARKS"].forEach((label, idx) => {
    const w = YEARLY_SUBCOLS[idx];
    drawCell(gx, sy, w, subHeaderH, label.replace("\\\\n", "\\n"), { bold: true, size: 7, color: "#000" });
    gx += w;
  });

  ty += groupHeaderH + subHeaderH;

  const gColor = (val) => {
    const n = Number(val);
    if(isNaN(n)) return "#000";
    return n >= 50 ? COLOR_PASS : COLOR_FAIL;
  };

  rows.forEach((r, idx) => {
    let x = tableX;
    drawCell(x, ty, SUBJECT_COL, ROW_H, r.subject, { align: "left", size: 8, color: "#000" }); x += SUBJECT_COL;
    drawCell(x, ty, MAX_COL, ROW_H, r.max, { size: 8, color: "#000" }); x += MAX_COL;
    
    [r.t1, r.t2, r.t3].forEach((cell) => {
      drawCell(x, ty, TERM_SUBCOLS[0], ROW_H, cell.test, { size: 8, color: gColor(cell.test) }); x += TERM_SUBCOLS[0];
      drawCell(x, ty, TERM_SUBCOLS[1], ROW_H, cell.exam, { size: 8, color: gColor(cell.exam) }); x += TERM_SUBCOLS[1];
      drawCell(x, ty, TERM_SUBCOLS[2], ROW_H, cell.mn, { size: 8, color: gColor(cell.mn) }); x += TERM_SUBCOLS[2];
      drawCell(x, ty, TERM_SUBCOLS[3], ROW_H, cell.rnk, { size: 8, color: "#000" }); x += TERM_SUBCOLS[3];
    });
    
    drawCell(x, ty, YEARLY_SUBCOLS[0], ROW_H, r.total, { size: 8, color: "#000" }); x += YEARLY_SUBCOLS[0];
    const meanColor = r.mean !== "0.0" ? gColor(r.mean) : "#000";
    drawCell(x, ty, YEARLY_SUBCOLS[1], ROW_H, r.mean, { size: 8, color: meanColor }); x += YEARLY_SUBCOLS[1];
    drawCell(x, ty, YEARLY_SUBCOLS[2], ROW_H, r.rank, { size: 8, color: "#000" }); x += YEARLY_SUBCOLS[2];
    drawCell(x, ty, YEARLY_SUBCOLS[3], ROW_H, r.grade, { size: 8, color: "#000" }); x += YEARLY_SUBCOLS[3];
    drawCell(x, ty, YEARLY_SUBCOLS[4], ROW_H, r.remark, { size: 8, color: "#000" });
    ty += ROW_H;
  });

  // TOTAL MARKS row
  {
    let x = tableX;
    drawCell(x, ty, SUBJECT_COL + MAX_COL, ROW_H, "TOTAL MARKS", { bold: true, size: 8, align: "left" });
    x += SUBJECT_COL + MAX_COL;
    const subjCount = subjects.length || 1;
    [
      [colTotals.t1a, colTotals.t1b, (colTotals.t1a + colTotals.t1b) / (2 * subjCount)],
      [colTotals.t2a, colTotals.t2b, (colTotals.t2a + colTotals.t2b) / (2 * subjCount)],
      [colTotals.t3a, colTotals.t3b, (colTotals.t3a + colTotals.t3b) / (2 * subjCount)],
    ].forEach(([a, b, mn]) => {
      drawCell(x, ty, TERM_SUBCOLS[0], ROW_H, a || "0", { size: 8, color: gColor(a) }); x += TERM_SUBCOLS[0];
      drawCell(x, ty, TERM_SUBCOLS[1], ROW_H, b || "0", { size: 8, color: gColor(b) }); x += TERM_SUBCOLS[1];
      drawCell(x, ty, TERM_SUBCOLS[2], ROW_H, mn ? mn.toFixed(1) : "0.0", { size: 8, color: gColor(mn) }); x += TERM_SUBCOLS[2];
      drawCell(x, ty, TERM_SUBCOLS[3], ROW_H, "", { size: 8 }); x += TERM_SUBCOLS[3];
    });
    drawCell(x, ty, YEARLY_SUBCOLS[0], ROW_H, obtained.toFixed(0), { size: 8 }); x += YEARLY_SUBCOLS[0];
    drawCell(x, ty, YEARLY_SUBCOLS[1], ROW_H, (obtained / subjCount).toFixed(0), { size: 8 }); x += YEARLY_SUBCOLS[1];
    drawCell(x, ty, YEARLY_SUBCOLS[2] + YEARLY_SUBCOLS[3] + YEARLY_SUBCOLS[4], ROW_H, "", { size: 8 });
    ty += ROW_H;
  }
  
  // PERCENTAGE row
  {
    let x = tableX;
    drawCell(x, ty, SUBJECT_COL + MAX_COL, ROW_H, "PERCENTAGE", { bold: true, size: 8, align: "left" });
    x += SUBJECT_COL + MAX_COL;
    const subjCount = subjects.length || 1;
    const pctOf = (a, b) => (a + b ? ((a + b) / (2 * subjCount)).toFixed(1) : "0.0");
    [
      [colTotals.t1a, colTotals.t1b],
      [colTotals.t2a, colTotals.t2b],
      [colTotals.t3a, colTotals.t3b],
    ].forEach(([a, b]) => {
      drawCell(x, ty, TERM_SUBCOLS[0], ROW_H, a ? (a / subjCount).toFixed(1) : ".0", { size: 8, color: gColor(a/subjCount) }); x += TERM_SUBCOLS[0];
      drawCell(x, ty, TERM_SUBCOLS[1], ROW_H, b ? (b / subjCount).toFixed(1) : ".0", { size: 8, color: gColor(b/subjCount) }); x += TERM_SUBCOLS[1];
      let p = pctOf(a, b);
      drawCell(x, ty, TERM_SUBCOLS[2], ROW_H, p !== "0.0" ? p : "NaN", { size: 8, color: gColor(p) }); x += TERM_SUBCOLS[2];
      drawCell(x, ty, TERM_SUBCOLS[3], ROW_H, "0th", { size: 8 }); x += TERM_SUBCOLS[3];
    });
    drawCell(x, ty, YEARLY_SUBCOLS[0], ROW_H, "", { size: 8 }); x += YEARLY_SUBCOLS[0];
    drawCell(x, ty, YEARLY_SUBCOLS[1], ROW_H, avgPct.toFixed(1), { size: 8, color: gColor(avgPct) }); x += YEARLY_SUBCOLS[1];
    drawCell(x, ty, YEARLY_SUBCOLS[2], ROW_H, overallRank ? ordinal(overallRank) : "-", { size: 8 }); x += YEARLY_SUBCOLS[2];
    drawCell(x, ty, YEARLY_SUBCOLS[3] + YEARLY_SUBCOLS[4], ROW_H, "", { size: 8 });
    ty += ROW_H;
  }

  ty += 5;

  // ── Keys to rating ──
  drawCell(tableX, ty, TABLE_WIDTH, ROW_H, "KEYS TO RATING", { bold: true, size: 8 });
  ty += ROW_H;
  const keysStr = "100-75 (EXCELLENT) | 74-70 (V. GOOD) | 69-65 (V. GOOD) | 64-60 (V. GOOD) | 59-55 (GOOD) | 54-50 (GOOD) | 49-45 (FAIR) | 44-40 (FAIR) | 39-0 (FAIL)".replace(/ \\| /g, ") ");
  drawCell(tableX, ty, TABLE_WIDTH, ROW_H, keysStr, { size: 7.5 });
  ty += ROW_H + 5;

  // ── Comments & Signatures ──
  const commentsH = 65;
  doc.rect(tableX, ty, TABLE_WIDTH, commentsH).lineWidth(1).stroke(BORDER);
  
  let cy = ty + 10;
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#000").text("Class Teacher's Comments:", tableX + 5, cy);
  doc.font("Helvetica").fontSize(9).text("Good, Keep improving", tableX + 140, cy);
  
  doc.font("Helvetica-Bold").fontSize(9).text("Sign.:", tableX + 270, cy);
  doc.font("Helvetica").text("_________________________", tableX + 300, cy);
  
  doc.font("Helvetica-Bold").fontSize(9).text("Date:", tableX + 460, cy);
  doc.font("Helvetica").text("20/07/2026", tableX + 490, cy);
  
  cy += 20;
  
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#000").text("Principal's Comments:", tableX + 5, cy);
  doc.font("Helvetica").fontSize(9).text("Good, Keep improving", tableX + 140, cy);
  
  doc.font("Helvetica-Bold").fontSize(9).text("Sign.:", tableX + 270, cy);
  doc.font("Helvetica").text("_________________________", tableX + 300, cy);
  
  doc.font("Helvetica-Bold").fontSize(9).text("Date:", tableX + 460, cy);
  doc.font("Helvetica").text("20/07/2026", tableX + 490, cy);
  
  cy += 20;
  
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#000").text("Promotion Status:", tableX + 5, cy);
  doc.font("Helvetica").fontSize(9).text("PROMOTED TO J S S 2. CONGRATULATIONS", tableX + 100, cy);
  
  // Stamp
  const stampX = tableX + TABLE_WIDTH - 60;
  const stampY = ty + 30;
  doc.circle(stampX, stampY, 25).lineWidth(1).stroke(BORDER);
  doc.circle(stampX, stampY, 23).lineWidth(1).stroke(BORDER);
  doc.font("Helvetica-Bold").fontSize(5).fillColor(BORDER)
    .text("NURUL-HAQ ISLAMIC ACADEMY", stampX - 22, stampY - 15, { width: 44, align: "center" });
  doc.text("Official Stamp", stampX - 22, stampY - 5, { width: 44, align: "center" });
  doc.text("PRINCIPAL", stampX - 22, stampY + 5, { width: 44, align: "center" });
  
  ty += commentsH + 10;
  
  doc.font("Helvetica").fontSize(8).fillColor("#888")
    .text(\`Date printed: \${new Date().toString().split(" GMT")[0]} | Any alteration invalidates this statement\`, tableX, ty, { width: TABLE_WIDTH, align: "center" });

  if (!isBulk) doc.end();
}

module.exports = generateReportCard;
`;

fs.writeFileSync(filePath, headContent + newPdfCode);
console.log("Successfully replaced PDF logic.");
