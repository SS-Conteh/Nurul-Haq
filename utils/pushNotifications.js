const webpush = require("web-push");
const User = require("../models/User");

let configured = false;

function configureWebPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  if (!publicKey || !privateKey) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

function getPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || "";
}

async function saveSubscription(userId, subscription) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error("Invalid push subscription");
  }
  const item = {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
    updatedAt: new Date(),
  };
  // A browser endpoint belongs to the currently logged-in account. Remove
  // it from any previous account on this installation before attaching it
  // to the current user, preventing push alerts from leaking between
  // accounts that share one device/browser profile.
  await User.updateMany(
    { "pushSubscriptions.endpoint": subscription.endpoint },
    { $pull: { pushSubscriptions: { endpoint: subscription.endpoint } } },
  );
  await User.findByIdAndUpdate(userId, {
    $push: { pushSubscriptions: item },
  });
}

async function removeSubscription(userId, endpoint) {
  if (!endpoint) return;
  await User.findByIdAndUpdate(userId, {
    $pull: { pushSubscriptions: { endpoint } },
  });
}

function noticeAudienceQuery(category) {
  // Keep this exactly aligned with GET /api/notices:
  // students notices are visible to all authenticated active users; teacher
  // notices are staff-only. Admin/oversight/finance roles can see all notices.
  if (category === "teachers") return { role: "teacher", status: "Active" };
  return {
    status: "Active",
    role: { $in: [
      "principal", "admin", "juniorAdmin", "seniorBursar",
      "juniorBursar", "teacher", "student"
    ] },
  };
}

async function sendNoticePush(notice) {
  if (!configured) configureWebPush();
  if (!configured) {
    console.warn("[NHIA-SMS] Push skipped: VAPID keys are not configured.");
    return { sent: 0, removed: 0, skipped: true };
  }

  const users = await User.find(noticeAudienceQuery(notice.category))
    .select("_id pushSubscriptions");
  let sent = 0;
  let removed = 0;

  const payload = JSON.stringify({
    type: "notice",
    noticeId: String(notice._id),
    title: notice.title,
    body: notice.body,
    noticeType: notice.type,
    url: "/?page=notices",
  });

  for (const user of users) {
    for (const subscription of user.pushSubscriptions || []) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            expirationTime: subscription.expirationTime,
            keys: subscription.keys,
          },
          payload,
        );
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await removeSubscription(user._id, subscription.endpoint);
          removed += 1;
        } else {
          console.error(
            `[NHIA-SMS] Push failed for user ${user._id}:`,
            err.message,
          );
        }
      }
    }
  }
  return { sent, removed, skipped: false };
}

module.exports = {
  configureWebPush,
  getPublicKey,
  saveSubscription,
  removeSubscription,
  sendNoticePush,
};
