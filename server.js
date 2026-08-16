require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const path = require("path");
const connectDB = require("./config/db");
const { notFound, errorHandler } = require("./middleware/errorHandler");

const app = express();

// ── Middleware ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression()); // gzip every response (the ~200kb app.js bundle, JSON, etc.)

// ALLOWED_ORIGINS: comma-separated list, e.g.
//   ALLOWED_ORIGINS=https://your-app.vercel.app,http://localhost:3000
// Falls back to CLIENT_ORIGIN (single value) for backwards compatibility,
// and to "*" (allow all) if neither is set.
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  process.env.CLIENT_ORIGIN ||
  ""
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin:
      allowedOrigins.length === 0
        ? "*"
        : (origin, callback) => {
            // Allow non-browser requests (no Origin header) and any listed origin.
            if (!origin || allowedOrigins.includes(origin))
              return callback(null, true);
            callback(new Error(`CORS blocked for origin: ${origin}`));
          },
    credentials: true,
  }),
);
app.use(express.json({ limit: "8mb" }));
if (process.env.NODE_ENV !== "production") app.use(morgan("dev"));

// ── API routes ──
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/students", require("./routes/students"));
app.use("/api/teachers", require("./routes/teachers"));
app.use("/api/admins", require("./routes/admins"));
app.use("/api/classes", require("./routes/classes"));
app.use("/api/grades", require("./routes/grades"));
app.use("/api/attendance", require("./routes/attendance"));
app.use("/api/notices", require("./routes/notices"));
app.use("/api/events", require("./routes/events"));
app.use("/api/assignments", require("./routes/assignments"));
app.use("/api/finance", require("./routes/finance"));
app.use("/api/exams", require("./routes/exams"));
app.use("/api/library", require("./routes/library"));
app.use("/api/messages", require("./routes/messages"));
app.use("/api/behavior", require("./routes/behavior"));
app.use("/api/timetable", require("./routes/timetable"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/promotions", require("./routes/promotions"));

app.get("/api/health", (req, res) =>
  res.json({ status: "ok", service: "Nurul-Haq Islamic Academy SMS API" }),
);

// ── Serve the frontend (optional: lets you run everything from one server) ──
const frontendPath = path.join(__dirname, "..", "frontend");
app.use(
  express.static(frontendPath, {
    etag: true,
    setHeaders: (res, filePath) => {
      if (
        filePath.endsWith(".html") ||
        filePath.endsWith(".js") ||
        filePath.endsWith(".css")
      ) {
        // Always revalidate — the browser still skips the download on a 304
        // if nothing changed, but it will NEVER show stale app code the way
        // a long max-age would after an update like this one.
        res.setHeader("Cache-Control", "no-cache");
      } else {
        // Images/fonts change rarely and staleness there is harmless.
        res.setHeader("Cache-Control", "public, max-age=86400");
      }
    },
  }),
);
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(frontendPath, "index.html"));
});

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[NHIA-SMS] API server running on http://localhost:${PORT}`);
    startKeepAlive();
  });
});

// ── Keep-alive self-ping ──
// Render's free tier spins the service down after ~15 minutes of no
// inbound traffic; the next real request then pays a slow cold-start
// (the whole app + DB reconnect from scratch, often 10-30+ seconds).
// While in production, ping our own /api/health endpoint regularly so
// Render always sees recent traffic and never spins down.
function startKeepAlive() {
  if (process.env.NODE_ENV !== "production") return;

  // Render sets this automatically; SELF_URL is a manual override/fallback.
  const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
  if (!selfUrl) {
    console.warn(
      "[NHIA-SMS] Keep-alive skipped: no RENDER_EXTERNAL_URL or SELF_URL set. " +
        "The service WILL spin down after ~15 min idle and cold-start on the next visit.",
    );
    return;
  }

  // 7 minutes, well under Render's 15-minute idle limit, so a single
  // slow/failed ping still leaves margin before the next attempt.
  const PING_INTERVAL_MS = 7 * 60 * 1000;
  // If a ping fails, retry quickly instead of waiting the full interval —
  // otherwise one dropped ping doubles the gap and spins the service down.
  const RETRY_DELAY_MS = 30 * 1000;
  const url = `${selfUrl.replace(/\/$/, "")}/api/health`;

  function ping() {
    const startedAt = new Date().toISOString();
    fetch(url)
      .then((res) => {
        console.log(
          `[NHIA-SMS] Keep-alive ping @ ${startedAt} -> ${res.status}`,
        );
        setTimeout(ping, PING_INTERVAL_MS);
      })
      .catch((err) => {
        console.error(
          `[NHIA-SMS] Keep-alive ping @ ${startedAt} FAILED (retrying in 30s):`,
          err.message,
        );
        setTimeout(ping, RETRY_DELAY_MS);
      });
  }

  setTimeout(ping, PING_INTERVAL_MS);
  console.log(`[NHIA-SMS] Keep-alive enabled, pinging ${url} every 7 min`);
}
