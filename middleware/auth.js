const jwt = require("jsonwebtoken");
const User = require("../models/User");

// Verifies the JWT and attaches the full user document to req.user
async function protect(req, res, next) {
  try {
    let token;
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
      token = header.split(" ")[1];
    }
    if (!token) {
      return res
        .status(401)
        .json({ message: "Not authorized, no token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) {
      return res
        .status(401)
        .json({ message: "User belonging to this token no longer exists" });
    }
    req.user = user;
    next();
  } catch (err) {
    return res
      .status(401)
      .json({ message: "Not authorized, token invalid or expired" });
  }
}

// Restricts a route to a set of roles, e.g. authorize('principal','teacher')
// Admins are a full-access role — anywhere a route allows the
// Principal, a System Admin is implicitly allowed too, so this doesn't have
// to be repeated at every call site.
function authorize(...roles) {
  const effectiveRoles = roles.includes("principal")
    ? [...roles, "admin"]
    : roles;
  return (req, res, next) => {
    if (!req.user || !effectiveRoles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ message: "You do not have permission to perform this action" });
    }
    next();
  };
}

module.exports = { protect, authorize };
